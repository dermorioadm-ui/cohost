-- 0040 — A fila da portaria, com nome e botao.
--
-- A 0039 criou a tabela e o financeiro passou a CONTAR quantos pagaram. Contar
-- nao atende ninguem: alguem paga R$ 197, a linha entra com status `pago`, e o
-- unico aviso e um e-mail que depende do segredo ADMIN_NOTIFY_EMAIL estar
-- configurado. Se ele nao estiver — e hoje nao esta —, o cliente pagou e
-- ninguem no time ficou sabendo.
--
-- Servico cobrado precisa de fila visivel dentro do produto. E-mail e
-- notificacao; fila e o lugar onde o trabalho fica ate alguem fazer.

-- ---------------------------------------------------------------------------
-- 1. A fila
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_porter_fila(
  _status public.porter_setup_status DEFAULT NULL,
  _limit  integer DEFAULT 50,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  status         public.porter_setup_status,
  property_id    uuid,
  property_name  text,
  owner_id       uuid,
  owner_name     text,
  owner_email    text,
  owner_phone    text,
  condo_name     text,
  condo_system   text,
  amount_cents   integer,
  paid_at        timestamptz,
  contacted_at   timestamptz,
  implanted_at   timestamptz,
  notes          text,
  created_at     timestamptz,
  total_count    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.assert_admin();

  RETURN QUERY
  WITH base AS (
    SELECT r.*,
           p.name  AS pnome,
           pr.full_name AS onome,
           pr.email AS omail,
           pr.phone_e164 AS ofone
    FROM public.porter_setup_requests r
    JOIN public.properties p ON p.id = r.property_id
    LEFT JOIN public.profiles pr ON pr.user_id = r.owner_id
    WHERE _status IS NULL OR r.status = _status
  )
  SELECT b.id, b.status, b.property_id, b.pnome, b.owner_id, b.onome, b.omail,
         b.ofone, b.condo_name, b.condo_system, b.amount_cents, b.paid_at,
         b.contacted_at, b.implanted_at, b.notes, b.created_at,
         (SELECT count(*) FROM base)
  FROM base b
  -- Quem pagou primeiro espera ha mais tempo, e e quem esta pagando pela
  -- espera. Ordem por data de pagamento, nao por data do clique.
  ORDER BY
    CASE b.status
      WHEN 'pago' THEN 0 WHEN 'em_andamento' THEN 1
      WHEN 'interessado' THEN 2 WHEN 'implantado' THEN 3 ELSE 4
    END,
    COALESCE(b.paid_at, b.created_at)
  LIMIT greatest(1, least(_limit, 200)) OFFSET greatest(_offset, 0);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_porter_fila(public.porter_setup_status, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_porter_fila(public.porter_setup_status, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_porter_fila(public.porter_setup_status, integer, integer) IS
  'A fila de implantacao da portaria com nome, e-mail e telefone de quem pagou. Ordena por quem esta esperando ha mais tempo depois de pagar — nao pela data do clique, porque quem clicou e nao pagou nao esta esperando nada.';

-- ---------------------------------------------------------------------------
-- 2. Mover a fila
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_porter_avanca(
  _id     uuid,
  _status public.porter_setup_status,
  _notes  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _antes public.porter_setup_status;
BEGIN
  PERFORM public.assert_admin();

  SELECT status INTO _antes FROM public.porter_setup_requests WHERE id = _id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido de portaria nao encontrado' USING ERRCODE = 'no_data_found';
  END IF;

  -- `pago` nao se digita: quem marca pago e o webhook da Stripe, contra o
  -- evento real de pagamento. Um admin marcando pago na mao esconderia uma
  -- cobranca que nunca entrou, e a conciliacao do mes deixaria de fechar.
  IF _status = 'pago' AND _antes <> 'pago' THEN
    RAISE EXCEPTION 'Status "pago" so vem da confirmacao da Stripe' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.porter_setup_requests SET
    status       = _status,
    contacted_at = CASE WHEN _status = 'em_andamento' AND contacted_at IS NULL
                        THEN now() ELSE contacted_at END,
    implanted_at = CASE WHEN _status = 'implantado' THEN now()
                        -- Voltar de implantado limpa a data: uma linha marcada
                        -- como "em andamento" com data de implantacao mente
                        -- para quem for medir tempo de entrega depois.
                        WHEN _status <> 'implantado' THEN NULL
                        ELSE implanted_at END,
    notes        = COALESCE(NULLIF(btrim(_notes), ''), notes),
    updated_at   = now()
  WHERE id = _id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (auth.uid(), 'admin', 'porter_setup.status', 'porter_setup_requests', _id::text,
          jsonb_build_object('de', _antes, 'para', _status, 'notas', _notes));

  RETURN jsonb_build_object('ok', true, 'de', _antes, 'para', _status);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_porter_avanca(uuid, public.porter_setup_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_porter_avanca(uuid, public.porter_setup_status, text) TO authenticated;

COMMENT ON FUNCTION public.admin_porter_avanca(uuid, public.porter_setup_status, text) IS
  'Move um pedido de portaria na fila e deixa rastro no audit_log. Recusa marcar "pago" na mao: esse status pertence ao webhook da Stripe, e digita-lo aqui esconderia uma cobranca que nunca entrou.';
