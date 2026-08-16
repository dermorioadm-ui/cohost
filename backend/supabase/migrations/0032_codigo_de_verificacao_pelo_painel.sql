-- =============================================================================
-- 0032 — O código de verificação chega pelo painel
-- =============================================================================
-- Quando o agente tenta entrar na conta e o Airbnb pede um código por SMS ou
-- e-mail, ninguém do nosso lado consegue ler esse código: ele vai para o
-- celular do dono. Até aqui isso era um beco sem saída — 2FA por SMS "não tem
-- solução automática".
--
-- Tem solução, só que ela não é automática: é o dono digitando. O desenho:
--
--   1. dono salva login e senha no painel        -> status 'pendente'
--   2. agente pega a credencial e tenta entrar
--   3. Airbnb pede código                        -> agente chama `challenge`
--      status vira 'aguardando_codigo', com o tipo (sms/email) e uma DICA
--      mascarada do destino ("···· 3241"), para o dono saber onde procurar
--   4. o painel mostra o campo; o dono digita o código que recebeu
--   5. o agente, que está em laço curto, pega o código e conclui o login
--   6. agente confirma                           -> status 'ativo'
--
-- O QUE MANDA NO PRAZO: código de verificação do Airbnb morre em poucos
-- minutos, e a sessão do navegador do agente precisa continuar ABERTA na
-- mesma página o tempo todo — não dá para reiniciar o login e reaproveitar o
-- código. Por isso o TTL padrão é curto (10 min) e o agente deve consultar a
-- cada poucos segundos, não a cada 30. Expirou, vira 'falhou' com motivo
-- legível, e o agente abandona a sessão em vez de insistir.
--
-- O CÓDIGO NÃO É CIFRADO, e isso é escolha. São seis dígitos que valem por
-- minutos e servem uma vez só; cifrar isso seria teatro. A proteção real é
-- ser de uso único (a leitura apaga), ter validade curta, e não valer nada
-- fora da sessão de navegador que o pediu.
--
-- UNIFICAÇÃO: até agora o painel gravava em `hermes_credentials` (cofre do
-- Vault, 0025) e o agente lia de `credentials` (0030). Dois cofres que não se
-- falam — senha salva pelo painel era invisível para o worker. Esta migration
-- resolve porque o recurso obriga: o dono escreve o código de um lado e o
-- agente lê do outro, então tem de ser a MESMA tabela. `credentials` vence por
-- ser a que o worker já usa. As duas estão vazias, então não há migração de
-- dado — só de código.
-- =============================================================================

-- ---- 1. estado do desafio ---------------------------------------------------
ALTER TABLE public.credentials
  ADD COLUMN IF NOT EXISTS challenge_type       text,
  ADD COLUMN IF NOT EXISTS challenge_hint       text,
  ADD COLUMN IF NOT EXISTS challenge_asked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS challenge_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS challenge_code       text,
  ADD COLUMN IF NOT EXISTS challenge_code_at    timestamptz;

ALTER TABLE public.credentials DROP CONSTRAINT IF EXISTS credentials_status_check;
ALTER TABLE public.credentials ADD CONSTRAINT credentials_status_check
  CHECK (status IN ('pendente', 'aguardando_codigo', 'ativo', 'falhou'));

COMMENT ON COLUMN public.credentials.challenge_hint IS
  'Destino MASCARADO do código ("···· 3241"), como o Airbnb mostra. Serve para '
  'o dono saber em qual celular ou e-mail procurar. Nunca guarde aqui o '
  'telefone ou e-mail completo: a dica aparece na tela e não precisa deles.';

COMMENT ON COLUMN public.credentials.challenge_code IS
  'Código de uso único, em texto puro e de propósito: seis dígitos que valem '
  'minutos não ganham nada sendo cifrados. A proteção é a leitura apagar, a '
  'validade curta, e o código não valer fora da sessão que o pediu.';


-- ---- 2. o agente pede o código ---------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_report_challenge(
  p_owner uuid,
  p_type  text,
  p_hint  text DEFAULT NULL,
  p_ttl   integer DEFAULT 600
)
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
    -- Limpa código velho: se o dono digitou um código de uma tentativa
    -- anterior, ele já não serve e usá-lo queimaria a tentativa nova.
    challenge_code       = NULL,
    challenge_code_at    = NULL,
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


-- ---- 3. o dono digita -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_submit_challenge_code(p_owner uuid, p_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _c public.credentials%ROWTYPE; _limpo text;
BEGIN
  PERFORM public.assert_service_role();

  -- Só dígitos: o dono cola do SMS e vem com espaço, hífen ou "é o 123456".
  _limpo := regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g');
  IF length(_limpo) < 4 THEN RETURN 'codigo_invalido'; END IF;

  SELECT * INTO _c FROM public.credentials WHERE owner_id = p_owner;
  IF _c.id IS NULL THEN RETURN 'sem_credencial'; END IF;

  IF _c.status <> 'aguardando_codigo' THEN RETURN 'nao_esta_esperando'; END IF;

  -- Expirado é diferente de errado, e o dono precisa saber a diferença: no
  -- primeiro caso ele pede outro código, no segundo ele confere o que digitou.
  IF _c.challenge_expires_at IS NULL OR _c.challenge_expires_at < now() THEN
    UPDATE public.credentials
    SET status = 'falhou',
        last_error = 'O código expirou antes de ser usado. Tente ativar de novo.',
        challenge_code = NULL, updated_at = now()
    WHERE id = _c.id;
    RETURN 'expirado';
  END IF;

  UPDATE public.credentials
  SET challenge_code = _limpo, challenge_code_at = now(), updated_at = now()
  WHERE id = _c.id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id)
  VALUES (p_owner, 'owner', 'credentials:challenge_code', 'credentials', p_owner::text, p_owner);

  RETURN 'ok';
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_submit_challenge_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_submit_challenge_code(uuid, text) TO service_role;


-- ---- 4. o agente consome ----------------------------------------------------
-- Uso único: a leitura APAGA. Se o login falhar depois disso, o agente pede
-- outro código em vez de reusar — o Airbnb invalida o código no primeiro uso
-- de qualquer forma, e reusar só gastaria a tentativa.
CREATE OR REPLACE FUNCTION public.hermes_take_challenge_code(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _c public.credentials%ROWTYPE;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _c FROM public.credentials WHERE owner_id = p_owner;
  IF _c.id IS NULL THEN RETURN jsonb_build_object('estado', 'sem_credencial'); END IF;

  IF _c.status <> 'aguardando_codigo' THEN
    RETURN jsonb_build_object('estado', 'nao_esta_esperando', 'status', _c.status);
  END IF;

  IF _c.challenge_expires_at < now() THEN
    UPDATE public.credentials
    SET status = 'falhou',
        last_error = 'O dono não digitou o código a tempo.',
        challenge_code = NULL, updated_at = now()
    WHERE id = _c.id;
    RETURN jsonb_build_object('estado', 'expirado');
  END IF;

  IF _c.challenge_code IS NULL THEN
    RETURN jsonb_build_object('estado', 'aguardando',
      'expira_em', greatest(0, extract(epoch FROM _c.challenge_expires_at - now())::int));
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


-- ---- 5. entrou -------------------------------------------------------------
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
    challenge_type = NULL, challenge_hint = NULL,
    challenge_asked_at = NULL, challenge_expires_at = NULL,
    challenge_code = NULL, challenge_code_at = NULL,
    updated_at = now()
  WHERE owner_id = p_owner;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id)
  VALUES (NULL, 'agent', 'credentials:active', 'credentials', p_owner::text, p_owner);
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_mark_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_mark_active(uuid) TO service_role;


-- ---- 6. o painel pergunta como está -----------------------------------------
-- Não devolve challenge_code: o dono acabou de digitar, não precisa ler de
-- volta, e um endpoint que devolve código é um endpoint a menos para proteger.
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
                       END
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.hermes_credential_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_credential_state(uuid) TO service_role;


-- ---- 7. aposenta o cofre paralelo -------------------------------------------
-- hermes_credentials (0025) some do caminho do painel. Está vazia; se um dia
-- alguém restaurar um backup antigo, o comentário explica por que não usar.
COMMENT ON TABLE public.hermes_credentials IS
  'APOSENTADA na 0032. A credencial do canal vive em public.credentials, que é '
  'a que o worker lê. Manter duas era garantia de trocar a senha num lado e '
  'não no outro. Não escreva mais aqui.';
