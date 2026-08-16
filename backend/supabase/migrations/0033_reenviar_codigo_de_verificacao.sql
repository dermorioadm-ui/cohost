-- =============================================================================
-- 0033 — "Não recebi o código" — pedido de reenvio
-- =============================================================================
-- SMS de verificação se perde: chega atrasado, cai na caixa de spam do e-mail,
-- ou simplesmente não vem. Hoje a única saída do anfitrião é esperar os 10
-- minutos expirarem e ativar tudo de novo, digitando a senha outra vez.
--
-- QUEM REENVIA É O WORKER, NÃO O PAINEL. O botão de reenviar existe na página
-- do Airbnb, e quem tem aquela sessão aberta é o agente. O painel só consegue
-- PEDIR; o agente vê o pedido no polling que já faz, clica em reenviar lá, e
-- chama verification-request de novo com prazo novo.
--
-- Por isso a coluna se chama `resend_requested_at` e não `resent_at`: ela
-- registra o pedido, não o ato. O ato só se comprova quando o agente reabre o
-- desafio.
--
-- DOIS FREIOS, e nenhum é capricho:
--
--   * 30 segundos entre pedidos. O anfitrião que não recebe aperta o botão
--     cinco vezes em dois segundos — é o reflexo de todo mundo. Cada aperto
--     vira um SMS de verdade lá no Airbnb.
--   * 3 pedidos por desafio. Plataforma nenhuma manda código infinitamente:
--     passa a tratar como abuso e bloqueia o envio, ou pior, a conta. Melhor
--     dizer "recomece" na terceira do que descobrir o limite deles na quinta.
-- =============================================================================

ALTER TABLE public.credentials
  ADD COLUMN IF NOT EXISTS resend_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS resend_count        integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.credentials.resend_requested_at IS
  'Quando o anfitrião PEDIU reenvio. Não é quando foi reenviado: quem reenvia '
  'é o worker, que tem a sessão do Airbnb aberta. Limpa quando o agente reabre '
  'o desafio via hermes_report_challenge.';


-- ---- 1. o anfitrião pede ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_request_resend(p_owner uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _c public.credentials%ROWTYPE;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _c FROM public.credentials WHERE owner_id = p_owner;
  IF _c.id IS NULL THEN RETURN 'sem_credencial'; END IF;

  -- Fora do desafio não há o que reenviar: o agente não está numa tela
  -- pedindo código, então o clique dele não teria onde acontecer.
  IF _c.status <> 'aguardando_codigo' THEN RETURN 'nao_esta_esperando'; END IF;

  IF _c.challenge_expires_at IS NULL OR _c.challenge_expires_at < now() THEN
    RETURN 'expirado';
  END IF;

  IF _c.resend_requested_at IS NOT NULL
     AND _c.resend_requested_at > now() - interval '30 seconds' THEN
    RETURN 'muito_cedo';
  END IF;

  IF _c.resend_count >= 3 THEN RETURN 'limite'; END IF;

  UPDATE public.credentials
  SET resend_requested_at = now(),
      resend_count        = resend_count + 1,
      updated_at          = now()
  WHERE id = _c.id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id, metadata)
  VALUES (p_owner, 'owner', 'credentials:resend_request', 'credentials', p_owner::text, p_owner,
          jsonb_build_object('tentativa', _c.resend_count + 1));

  RETURN 'ok';
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_request_resend(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_request_resend(uuid) TO service_role;


-- ---- 2. o agente vê o pedido no polling que já faz --------------------------
-- Sem endpoint novo de propósito: o worker já consulta a cada 3 s esperando o
-- código. Uma chave a mais na mesma resposta não custa chamada nenhuma, e um
-- endpoint separado seria mais uma coisa para o worker esquecer de chamar.
CREATE OR REPLACE FUNCTION public.hermes_take_challenge_code(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _c public.credentials%ROWTYPE; _reenviar boolean;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _c FROM public.credentials WHERE owner_id = p_owner;
  IF _c.id IS NULL THEN RETURN jsonb_build_object('estado', 'sem_credencial'); END IF;

  IF _c.status <> 'aguardando_codigo' THEN
    RETURN jsonb_build_object('estado', 'nao_esta_esperando', 'status', _c.status);
  END IF;

  IF _c.challenge_expires_at < now() THEN
    UPDATE public.credentials
    SET status = 'falhou', last_error = 'O dono nao digitou o codigo a tempo.',
        challenge_code = NULL, updated_at = now()
    WHERE id = _c.id;
    RETURN jsonb_build_object('estado', 'expirado');
  END IF;

  _reenviar := _c.resend_requested_at IS NOT NULL;

  IF _c.challenge_code IS NULL THEN
    RETURN jsonb_build_object(
      'estado',    'aguardando',
      'expira_em', greatest(0, extract(epoch FROM _c.challenge_expires_at - now())::int),
      -- O agente deve clicar em "reenviar" na página do Airbnb e chamar
      -- verification-request de novo, o que zera este sinal e o prazo.
      'reenviar',  _reenviar);
  END IF;

  UPDATE public.credentials
  SET challenge_code = NULL, status = 'pendente', updated_at = now()
  WHERE id = _c.id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id)
  VALUES (NULL, 'agent', 'credentials:challenge_consumed', 'credentials', p_owner::text, p_owner);

  RETURN jsonb_build_object('estado', 'ok', 'codigo', _c.challenge_code);
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_take_challenge_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_take_challenge_code(uuid) TO service_role;


-- ---- 3. reabrir o desafio limpa o pedido ------------------------------------
-- `resend_count` NÃO zera aqui: ele conta os reenvios DESTE desafio, e o
-- reenvio reabre o mesmo desafio. Zerar daria ao anfitrião reenvios infinitos
-- em ciclo, que é justamente o que o teto de 3 existe para impedir. Quem zera
-- é começar do zero — save_credential ou hermes_mark_active.
CREATE OR REPLACE FUNCTION public.hermes_report_challenge(
  p_owner uuid, p_type text, p_hint text DEFAULT NULL, p_ttl integer DEFAULT 600)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _n integer;
BEGIN
  PERFORM public.assert_service_role();

  UPDATE public.credentials SET
    status               = 'aguardando_codigo',
    challenge_type       = coalesce(nullif(p_type, ''), 'outro'),
    challenge_hint       = left(p_hint, 60),
    challenge_asked_at   = now(),
    challenge_expires_at = now() + make_interval(secs => greatest(60, least(p_ttl, 900))),
    challenge_code       = NULL,
    challenge_code_at    = NULL,
    resend_requested_at  = NULL,
    last_error           = NULL,
    updated_at           = now()
  WHERE owner_id = p_owner;

  GET DIAGNOSTICS _n = ROW_COUNT;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id, metadata)
  VALUES (NULL, 'agent', 'credentials:challenge', 'credentials', p_owner::text, p_owner,
          jsonb_build_object('tipo', p_type, 'dica', left(p_hint, 60)));

  RETURN _n > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_report_challenge(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_report_challenge(uuid, text, text, integer) TO service_role;


-- ---- 4. começar do zero zera o contador -------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_mark_active(p_owner uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.assert_service_role();

  UPDATE public.credentials SET
    status = 'ativo', last_error = NULL,
    challenge_type = NULL, challenge_hint = NULL, challenge_asked_at = NULL,
    challenge_expires_at = NULL, challenge_code = NULL, challenge_code_at = NULL,
    resend_requested_at = NULL, resend_count = 0,
    updated_at = now()
  WHERE owner_id = p_owner;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id)
  VALUES (NULL, 'agent', 'credentials:active', 'credentials', p_owner::text, p_owner);
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_mark_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_mark_active(uuid) TO service_role;


-- ---- 5. o painel enxerga o estado do reenvio --------------------------------
CREATE OR REPLACE FUNCTION public.hermes_credential_state(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _c public.credentials%ROWTYPE;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _c FROM public.credentials WHERE owner_id = p_owner;
  IF _c.id IS NULL THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'login',           _c.login,
    'status',          _c.status,
    'last_error',      _c.last_error,
    'last_read_at',    _c.last_read_at,
    'read_count',      _c.read_count,
    'created_at',      _c.created_at,
    'challenge_type',  _c.challenge_type,
    'challenge_hint',  _c.challenge_hint,
    'codigo_enviado',  _c.challenge_code IS NOT NULL,
    'expira_em',       CASE WHEN _c.challenge_expires_at IS NULL THEN NULL
                            ELSE greatest(0, extract(epoch FROM _c.challenge_expires_at - now())::int)
                       END,
    'reenvio_pedido',  _c.resend_requested_at IS NOT NULL,
    'reenvios_usados', _c.resend_count,
    -- Segundos que faltam para o botão destravar. O painel usa isto para
    -- desabilitar em vez de deixar o anfitrião apertar e tomar 'muito_cedo'.
    'reenvio_em',      CASE
                         WHEN _c.resend_requested_at IS NULL THEN 0
                         ELSE greatest(0, 30 - extract(epoch FROM now() - _c.resend_requested_at)::int)
                       END
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_credential_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_credential_state(uuid) TO service_role;
