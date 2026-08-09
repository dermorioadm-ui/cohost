-- =============================================================================
-- 0013 — Painel administrativo: assinantes e indicadores
-- =============================================================================
-- Toda função aqui é SECURITY DEFINER e checa is_admin() na primeira linha.
-- Sem isso, SECURITY DEFINER furaria a RLS para qualquer usuário logado.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.assert_admin()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'acesso_negado: requer papel admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- MRR de um assinante, normalizado para valor mensal em centavos.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mrr_cents(_profile public.profiles)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _profile.subscription_status NOT IN ('active', 'past_due') THEN 0
    WHEN _profile.billing_cycle = 'annual' THEN (pl.annual_cents / 12)
    ELSE pl.monthly_cents
  END
  FROM public.plans pl
  WHERE pl.tier = _profile.plan;
$$;

-- =============================================================================
-- 1. LISTA DE ASSINANTES
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_subscribers(
  _search       text DEFAULT NULL,
  _status       public.subscription_status DEFAULT NULL,
  _plan         public.plan_tier DEFAULT NULL,
  _stuck_only   boolean DEFAULT false,
  _order_by     text DEFAULT 'created_at',   -- created_at | mrr | name | activation
  _limit        int  DEFAULT 50,
  _offset       int  DEFAULT 0
)
RETURNS TABLE (
  owner_id            uuid,
  full_name           text,
  email               text,
  phone_e164          text,
  plan                public.plan_tier,
  billing_cycle       text,
  subscription_status public.subscription_status,
  mrr_cents           int,
  trial_ends_at       timestamptz,
  current_period_end  timestamptz,
  days_to_trial_end   int,
  properties_count    bigint,
  properties_active   bigint,
  reservations_30d    bigint,
  cleanings_30d       bigint,
  stuck_step          text,
  is_activated        boolean,
  hours_since_signup  int,
  last_activity_at    timestamptz,
  referred_by         text,
  stripe_customer_id  text,
  signed_up_at        timestamptz,
  total_count         bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_admin();

  RETURN QUERY
  WITH base AS (
    SELECT
      oa.*,
      p.billing_cycle,
      p.current_period_end,
      p.stripe_customer_id,
      public.mrr_cents(p.*) AS mrr,
      ref.full_name         AS referrer_name,
      COALESCE(r30.cnt, 0)  AS res_30d,
      COALESCE(c30.cnt, 0)  AS clean_30d
    FROM public.owner_activation oa
    JOIN public.profiles p ON p.user_id = oa.owner_id
    LEFT JOIN public.profiles ref ON ref.user_id = p.referred_by_user_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt
      FROM public.reservations r
      JOIN public.properties pp ON pp.id = r.property_id
      WHERE pp.owner_id = oa.owner_id
        AND r.created_at > now() - interval '30 days'
        AND r.status = 'confirmed'
    ) r30 ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt
      FROM public.cleaning_tasks t
      JOIN public.properties pp ON pp.id = t.property_id
      WHERE pp.owner_id = oa.owner_id
        AND t.status = 'completed'
        AND t.completed_at > now() - interval '30 days'
    ) c30 ON true
    WHERE (_status IS NULL OR oa.subscription_status = _status)
      AND (_plan   IS NULL OR oa.plan = _plan)
      AND (NOT _stuck_only OR oa.stuck_step IS NOT NULL)
      AND (
        _search IS NULL OR _search = '' OR
        oa.full_name  ILIKE '%' || _search || '%' OR
        oa.email      ILIKE '%' || _search || '%' OR
        oa.phone_e164 ILIKE '%' || regexp_replace(_search, '[^0-9]', '', 'g') || '%'
      )
  ),
  counted AS (SELECT count(*) AS n FROM base)
  SELECT
    b.owner_id, b.full_name, b.email, b.phone_e164,
    b.plan, b.billing_cycle, b.subscription_status,
    b.mrr, b.trial_ends_at, b.current_period_end,
    CASE WHEN b.trial_ends_at IS NULL THEN NULL
         ELSE ceil(extract(epoch FROM (b.trial_ends_at - now())) / 86400)::int END,
    b.properties_count, b.properties_active,
    b.res_30d, b.clean_30d,
    b.stuck_step, b.is_activated, b.hours_since_signup, b.last_activity_at,
    b.referrer_name, b.stripe_customer_id, b.signed_up_at,
    (SELECT n FROM counted)
  FROM base b
  ORDER BY
    CASE WHEN _order_by = 'mrr'        THEN b.mrr        END DESC NULLS LAST,
    CASE WHEN _order_by = 'name'       THEN b.full_name  END ASC  NULLS LAST,
    CASE WHEN _order_by = 'activation' THEN b.hours_since_signup END DESC NULLS LAST,
    b.signed_up_at DESC
  LIMIT  greatest(1, least(_limit, 200))
  OFFSET greatest(0, _offset);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_subscribers TO authenticated;

-- =============================================================================
-- 2. KPIs DO DASHBOARD
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r jsonb;
BEGIN
  PERFORM public.assert_admin();

  SELECT jsonb_build_object(
    'mrr_cents',            COALESCE(sum(public.mrr_cents(p.*)), 0),
    'arr_cents',            COALESCE(sum(public.mrr_cents(p.*)), 0) * 12,
    'subscribers_active',   count(*) FILTER (WHERE p.subscription_status IN ('active','past_due')),
    'subscribers_trialing', count(*) FILTER (WHERE p.subscription_status = 'trialing' AND p.trial_ends_at > now()),
    'subscribers_expired',  count(*) FILTER (WHERE p.subscription_status IN ('expired','canceled')),
    'subscribers_total',    count(*),
    'past_due',             count(*) FILTER (WHERE p.subscription_status = 'past_due'),
    'trial_ending_48h',     count(*) FILTER (
                              WHERE p.subscription_status = 'trialing'
                                AND p.trial_ends_at BETWEEN now() AND now() + interval '48 hours'),
    'new_7d',               count(*) FILTER (WHERE p.created_at > now() - interval '7 days'),
    'new_30d',              count(*) FILTER (WHERE p.created_at > now() - interval '30 days')
  ) INTO _r
  FROM public.profiles p
  JOIN public.user_roles ur ON ur.user_id = p.user_id AND ur.role = 'owner';

  SELECT _r || jsonb_build_object(
    'activated',        count(*) FILTER (WHERE oa.is_activated),
    'stuck',            count(*) FILTER (WHERE oa.stuck_step IS NOT NULL),
    'activation_rate',  CASE WHEN count(*) = 0 THEN 0
                             ELSE round(100.0 * count(*) FILTER (WHERE oa.is_activated) / count(*), 1) END
  ) INTO _r
  FROM public.owner_activation oa;

  SELECT _r || jsonb_build_object(
    'properties_total',  (SELECT count(*) FROM public.properties WHERE archived_at IS NULL),
    'cleaners_total',    (SELECT count(DISTINCT cleaner_id) FROM public.connections WHERE active),
    'reservations_30d',  (SELECT count(*) FROM public.reservations
                          WHERE created_at > now() - interval '30 days' AND status = 'confirmed'),
    'cleanings_30d',     (SELECT count(*) FROM public.cleaning_tasks
                          WHERE status = 'completed' AND completed_at > now() - interval '30 days'),
    'guest_sessions_30d',(SELECT count(*) FROM public.guest_sessions
                          WHERE created_at > now() - interval '30 days'),
    'guest_messages_30d',(SELECT count(*) FROM public.guest_messages
                          WHERE created_at > now() - interval '30 days' AND role = 'user')
  ) INTO _r;

  RETURN _r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_kpis() TO authenticated;

-- =============================================================================
-- 3. FUNIL DE ATIVAÇÃO — onde a fila entope
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_activation_funnel()
RETURNS TABLE (step text, label text, owners bigint, pct numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_admin();

  RETURN QUERY
  WITH total AS (SELECT count(*)::numeric AS n FROM public.owner_activation),
  steps AS (
    SELECT * FROM (VALUES
      ('1_sem_imovel',              'Pagou, não cadastrou imóvel'),
      ('2_sem_ical',                'Imóvel sem calendário'),
      ('3_ical_sem_sincronizar',    'Calendário não sincronizou'),
      ('4_sem_diarista',            'Sem diarista vinculada'),
      ('5_sem_mensagem_automatica', 'Falta a mensagem automática'),
      ('ativado',                   'Ativado')
    ) AS s(step, label)
  )
  SELECT
    s.step,
    s.label,
    count(oa.owner_id),
    CASE WHEN (SELECT n FROM total) = 0 THEN 0
         ELSE round(100.0 * count(oa.owner_id) / (SELECT n FROM total), 1) END
  FROM steps s
  LEFT JOIN public.owner_activation oa
    ON COALESCE(oa.stuck_step, 'ativado') = s.step
  GROUP BY s.step, s.label
  ORDER BY s.step;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_activation_funnel() TO authenticated;

-- =============================================================================
-- 4. SÉRIE TEMPORAL — cadastros, ativações e MRR por dia
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_timeseries(_days int DEFAULT 30)
RETURNS TABLE (
  day             date,
  signups         bigint,
  activated       bigint,
  cancellations   bigint,
  reservations    bigint,
  cleanings       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_admin();

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(
      public.app_today() - make_interval(days => greatest(1, least(_days, 365)) - 1),
      public.app_today(),
      interval '1 day'
    )::date AS d
  )
  SELECT
    days.d,
    (SELECT count(*) FROM public.profiles p
      JOIN public.user_roles ur ON ur.user_id = p.user_id AND ur.role = 'owner'
      WHERE (p.created_at AT TIME ZONE public.app_tz())::date = days.d),
    (SELECT count(*) FROM public.properties pr
      WHERE (pr.auto_message_confirmed_at AT TIME ZONE public.app_tz())::date = days.d),
    (SELECT count(*) FROM public.billing_events be
      WHERE be.type = 'customer.subscription.deleted'
        AND (be.occurred_at AT TIME ZONE public.app_tz())::date = days.d),
    (SELECT count(*) FROM public.reservations r
      WHERE (r.created_at AT TIME ZONE public.app_tz())::date = days.d
        AND r.status = 'confirmed'),
    (SELECT count(*) FROM public.cleaning_tasks t
      WHERE (t.completed_at AT TIME ZONE public.app_tz())::date = days.d)
  FROM days
  ORDER BY days.d;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_timeseries(int) TO authenticated;

-- =============================================================================
-- 5. SAÚDE DO SISTEMA — o que está quebrado agora
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_system_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_admin();

  RETURN jsonb_build_object(
    'ical_sources_total',   (SELECT count(*) FROM public.property_ical_sources WHERE active),
    'ical_sources_failing', (SELECT count(*) FROM public.property_ical_sources
                              WHERE active AND consecutive_fails >= 3),
    'ical_never_synced',    (SELECT count(*) FROM public.property_ical_sources
                              WHERE active AND last_success_at IS NULL),
    'ical_stale_2h',        (SELECT count(*) FROM public.property_ical_sources
                              WHERE active AND (last_synced_at IS NULL
                                                OR last_synced_at < now() - interval '2 hours')),
    'notifications_queued', (SELECT count(*) FROM public.notifications WHERE status = 'queued'),
    'notifications_failed', (SELECT count(*) FROM public.notifications
                              WHERE status = 'failed' AND updated_at > now() - interval '7 days'),
    'condo_pending',        (SELECT count(*) FROM public.reservations
                              WHERE status = 'confirmed' AND condo_notified_at IS NULL
                                AND created_at > now() - interval '7 days'),
    'porter_failed',        (SELECT count(*) FROM public.porter_registrations
                              WHERE status = 'failed' AND created_at > now() - interval '7 days'),
    'invites_pending',      (SELECT count(*) FROM public.cleaner_invites
                              WHERE status = 'pending' AND expires_at > now()),
    'checked_at',           now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_system_health() TO authenticated;

-- =============================================================================
-- 6. FECHAMENTO FINANCEIRO DO DONO
-- Corrige o bug do painel antigo: as diárias eram filtradas por mês, mas as
-- taxas de reposição não — o total do mês somava taxas de todo o histórico.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.owner_month_summary(
  _month date DEFAULT date_trunc('month', public.app_today())::date,
  _owner uuid DEFAULT NULL
)
RETURNS TABLE (
  cleaner_id       uuid,
  cleaner_name     text,
  cleanings        bigint,
  turnover_total   numeric,
  fees_total       numeric,
  subtotal         numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid   uuid := COALESCE(_owner, auth.uid());
  _start date := date_trunc('month', _month)::date;
  _end   date := (date_trunc('month', _month) + interval '1 month - 1 day')::date;
BEGIN
  IF _uid IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'acesso_negado' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH tasks AS (
    SELECT t.cleaner_id, count(*) AS n, sum(t.turnover_price) AS total
    FROM public.cleaning_tasks t
    JOIN public.properties p ON p.id = t.property_id
    WHERE p.owner_id = _uid
      AND t.status = 'completed'
      AND t.checkout_date BETWEEN _start AND _end
    GROUP BY t.cleaner_id
  ),
  fees AS (
    SELECT f.cleaner_id, sum(f.amount) AS total
    FROM public.cleaner_fees f
    WHERE f.owner_id = _uid
      AND f.status = 'approved'
      AND f.reference_month = _start          -- <- o filtro que faltava
    GROUP BY f.cleaner_id
  ),
  merged AS (
    SELECT COALESCE(t.cleaner_id, f.cleaner_id) AS cid,
           COALESCE(t.n, 0)     AS n,
           COALESCE(t.total, 0) AS turnover,
           COALESCE(f.total, 0) AS fees
    FROM tasks t
    FULL OUTER JOIN fees f ON f.cleaner_id = t.cleaner_id
  )
  SELECT
    m.cid,
    COALESCE(pr.full_name, pr.email, 'Sem diarista'),
    m.n, m.turnover, m.fees, (m.turnover + m.fees)
  FROM merged m
  LEFT JOIN public.profiles pr ON pr.user_id = m.cid
  ORDER BY (m.turnover + m.fees) DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.owner_month_summary(date, uuid) TO authenticated;

-- =============================================================================
-- 7. DETALHE DE UM ASSINANTE (drill-down do painel)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_subscriber_detail(_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r jsonb;
BEGIN
  PERFORM public.assert_admin();

  SELECT jsonb_build_object(
    'profile', to_jsonb(p.*) - 'pix_key',
    'activation', to_jsonb(oa.*),
    'properties', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',            v.property_id,
        'name',          v.property_name,
        'has_ical',      v.has_ical,
        'ical_syncing',  v.ical_syncing,
        'ical_failing',  v.ical_failing,
        'reservations',  v.reservations_count,
        'has_cleaner',   v.has_cleaner,
        'auto_message',  v.auto_message_done,
        'condo',         v.condo_configured,
        'ai',            v.ai_configured,
        'blocked_at',    v.blocked_at
      ) ORDER BY v.created_at)
      FROM public.property_activation v WHERE v.owner_id = _owner_id
    ), '[]'::jsonb),
    'cleaners', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_id', c.cleaner_id, 'name', cp.full_name, 'since', c.created_at))
      FROM public.connections c
      LEFT JOIN public.profiles cp ON cp.user_id = c.cleaner_id
      WHERE c.owner_id = _owner_id AND c.active
    ), '[]'::jsonb),
    'billing', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'type', be.type, 'amount_cents', be.amount_cents,
        'status', be.status, 'at', be.occurred_at) ORDER BY be.occurred_at DESC)
      FROM (SELECT * FROM public.billing_events
            WHERE user_id = _owner_id ORDER BY occurred_at DESC LIMIT 20) be
    ), '[]'::jsonb),
    'recent_notifications', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'template', n.template, 'channel', n.channel,
        'status', n.status, 'at', n.created_at) ORDER BY n.created_at DESC)
      FROM (SELECT * FROM public.notifications
            WHERE to_user_id = _owner_id ORDER BY created_at DESC LIMIT 20) n
    ), '[]'::jsonb)
  ) INTO _r
  FROM public.profiles p
  LEFT JOIN public.owner_activation oa ON oa.owner_id = p.user_id
  WHERE p.user_id = _owner_id;

  RETURN _r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_subscriber_detail(uuid) TO authenticated;
