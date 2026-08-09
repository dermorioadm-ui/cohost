-- =============================================================================
-- 0012 — Ativação: saber quem travou, e em qual passo
-- =============================================================================
-- Esta é a peça que faltava para operar em volume. Com 300 clientes você não
-- olha um por um: precisa de uma lista de quem parou e onde. É isso que muda a
-- função de quem você contratar — a pessoa não faz setup, ela destrava fila.
--
-- Um cliente está ATIVO quando:
--   1. tem imóvel cadastrado
--   2. o calendário está sincronizando de verdade (houve sucesso)
--   3. tem diarista que aceitou o convite (ou marcou self_clean)
--   4. confirmou a mensagem automática no Airbnb
-- =============================================================================

ALTER TABLE public.properties
  ADD COLUMN auto_message_confirmed_at timestamptz;

COMMENT ON COLUMN public.properties.auto_message_confirmed_at IS
  'Quando o dono confirmou que colou o link do chat na mensagem automática da plataforma.';

-- -----------------------------------------------------------------------------
-- Estado de ativação por imóvel
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.property_activation AS
SELECT
  p.id                       AS property_id,
  p.owner_id,
  public.property_display_name(p) AS property_name,
  p.created_at,

  (src.total > 0)            AS has_ical,
  (src.ok > 0)               AS ical_syncing,
  src.failing                AS ical_failing,
  COALESCE(res.total, 0)     AS reservations_count,

  (p.self_clean OR p.cleaner_id IS NOT NULL) AS has_cleaner,
  (p.auto_message_confirmed_at IS NOT NULL)  AS auto_message_done,
  (p.condo_email IS NOT NULL)                AS condo_configured,
  (nullif(btrim(COALESCE(p.ai_prompt, '')), '') IS NOT NULL) AS ai_configured,

  CASE
    WHEN src.total = 0                      THEN 'sem_ical'
    WHEN src.ok = 0                         THEN 'ical_nao_sincronizou'
    WHEN NOT (p.self_clean OR p.cleaner_id IS NOT NULL) THEN 'sem_diarista'
    WHEN p.auto_message_confirmed_at IS NULL THEN 'sem_mensagem_automatica'
    ELSE 'ativo'
  END AS blocked_at
FROM public.properties p
LEFT JOIN LATERAL (
  SELECT
    count(*)                                              AS total,
    count(*) FILTER (WHERE s.last_success_at IS NOT NULL)  AS ok,
    count(*) FILTER (WHERE s.consecutive_fails >= 3)       AS failing
  FROM public.property_ical_sources s
  WHERE s.property_id = p.id AND s.active
) src ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS total
  FROM public.reservations r
  WHERE r.property_id = p.id AND r.status = 'confirmed'
) res ON true
WHERE p.archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- Estado de ativação por cliente (dono) — a lista que a operação usa
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.owner_activation AS
SELECT
  pr.user_id                                  AS owner_id,
  pr.full_name,
  pr.email,
  pr.phone_e164,
  pr.plan,
  pr.subscription_status,
  pr.created_at                               AS signed_up_at,
  pr.trial_ends_at,

  COALESCE(pa.properties, 0)                  AS properties_count,
  COALESCE(pa.with_ical, 0)                   AS properties_with_ical,
  COALESCE(pa.syncing, 0)                     AS properties_syncing,
  COALESCE(pa.with_cleaner, 0)                AS properties_with_cleaner,
  COALESCE(pa.auto_msg, 0)                    AS properties_auto_message,
  COALESCE(pa.fully_active, 0)                AS properties_active,
  COALESCE(inv.pending_invites, 0)            AS pending_cleaner_invites,

  -- Passo em que o cliente está parado. NULL = ativado.
  CASE
    WHEN COALESCE(pa.properties, 0) = 0   THEN '1_sem_imovel'
    WHEN COALESCE(pa.with_ical, 0)  = 0   THEN '2_sem_ical'
    WHEN COALESCE(pa.syncing, 0)    = 0   THEN '3_ical_sem_sincronizar'
    WHEN COALESCE(pa.with_cleaner,0)= 0   THEN '4_sem_diarista'
    WHEN COALESCE(pa.auto_msg, 0)   = 0   THEN '5_sem_mensagem_automatica'
    ELSE NULL
  END AS stuck_step,

  (COALESCE(pa.fully_active, 0) > 0)          AS is_activated,

  -- Horas desde o cadastro: prioriza quem está travado há mais tempo.
  round(extract(epoch FROM (now() - pr.created_at)) / 3600)::int AS hours_since_signup,
  act.last_activity_at
FROM public.profiles pr
JOIN public.user_roles ur ON ur.user_id = pr.user_id AND ur.role = 'owner'
LEFT JOIN LATERAL (
  SELECT
    count(*)                                            AS properties,
    count(*) FILTER (WHERE v.has_ical)                  AS with_ical,
    count(*) FILTER (WHERE v.ical_syncing)              AS syncing,
    count(*) FILTER (WHERE v.has_cleaner)               AS with_cleaner,
    count(*) FILTER (WHERE v.auto_message_done)         AS auto_msg,
    count(*) FILTER (WHERE v.blocked_at = 'ativo')      AS fully_active
  FROM public.property_activation v
  WHERE v.owner_id = pr.user_id
) pa ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS pending_invites
  FROM public.cleaner_invites ci
  WHERE ci.owner_id = pr.user_id AND ci.status = 'pending' AND ci.expires_at > now()
) inv ON true
LEFT JOIN LATERAL (
  SELECT max(t.updated_at) AS last_activity_at
  FROM public.cleaning_tasks t
  JOIN public.properties p2 ON p2.id = t.property_id
  WHERE p2.owner_id = pr.user_id
) act ON true;

-- Views seguem a RLS de quem consulta? Views comuns rodam como o dono da view.
-- Como estas expõem dados de todos os clientes, o acesso é restrito ao admin
-- via GRANT + checagem explícita nas RPCs abaixo.
REVOKE ALL ON public.property_activation FROM anon, authenticated;
REVOKE ALL ON public.owner_activation    FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Cada dono enxerga a ativação dos PRÓPRIOS imóveis (para o guia de onboarding).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_activation()
RETURNS TABLE (
  property_id       uuid,
  property_name     text,
  has_ical          boolean,
  ical_syncing      boolean,
  ical_failing      bigint,
  reservations_count bigint,
  has_cleaner       boolean,
  auto_message_done boolean,
  condo_configured  boolean,
  ai_configured     boolean,
  blocked_at        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.property_id, v.property_name, v.has_ical, v.ical_syncing, v.ical_failing,
         v.reservations_count, v.has_cleaner, v.auto_message_done, v.condo_configured,
         v.ai_configured, v.blocked_at
  FROM public.property_activation v
  WHERE v.owner_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.my_activation() TO authenticated;
