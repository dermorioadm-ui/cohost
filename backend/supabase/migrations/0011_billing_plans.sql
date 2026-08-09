-- =============================================================================
-- 0011 — Planos, eventos de cobrança e limites
-- =============================================================================

CREATE TABLE public.plans (
  tier              public.plan_tier PRIMARY KEY,
  name              text NOT NULL,
  monthly_cents     int NOT NULL,
  annual_cents      int NOT NULL,
  currency          text NOT NULL DEFAULT 'BRL',
  max_properties    int,                       -- NULL = ilimitado
  stripe_price_monthly text,
  stripe_price_annual  text,
  active            boolean NOT NULL DEFAULT true,
  sort_order        int NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plans: leitura pública"
  ON public.plans FOR SELECT TO anon, authenticated
  USING (active);

CREATE POLICY "plans: admin gerencia"
  ON public.plans FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Preços em BRL. O plano de entrada aceita 3 imóveis: o público-alvo é o dono
-- com 2-3 apartamentos, e limitar a entrada em 1 empurrava exatamente ele para
-- o plano do meio.
INSERT INTO public.plans (tier, name, monthly_cents, annual_cents, max_properties, sort_order) VALUES
  ('essencial', 'Essencial',  11900,  119000,     3, 1),
  ('pro',       'Pro',        19900,  199000,    10, 2),
  ('ilimitado', 'Ilimitado',  34900,  349000,  NULL, 3);

CREATE OR REPLACE FUNCTION public.plan_limit(_user_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(pl.max_properties, 2147483647)
  FROM public.profiles p
  JOIN public.plans pl ON pl.tier = p.plan
  WHERE p.user_id = _user_id;
$$;

-- Impede estourar o limite do plano por qualquer caminho (app, API, bot).
CREATE OR REPLACE FUNCTION public.tg_enforce_property_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count int;
  _limit int;
BEGIN
  SELECT count(*) INTO _count
  FROM public.properties
  WHERE owner_id = NEW.owner_id AND archived_at IS NULL;

  _limit := COALESCE(public.plan_limit(NEW.owner_id), 0);

  IF _count >= _limit THEN
    RAISE EXCEPTION 'limite_do_plano_atingido: % de % imóveis', _count, _limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_property_limit
  BEFORE INSERT ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_enforce_property_limit();

-- -----------------------------------------------------------------------------
-- Eventos de cobrança — histórico auditável vindo do webhook do Stripe.
-- O backend antigo não tinha webhook nenhum: nenhum pagamento era reconciliado.
-- -----------------------------------------------------------------------------
CREATE TABLE public.billing_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  stripe_event_id    text UNIQUE,             -- idempotência do webhook
  type               text NOT NULL,
  amount_cents       int,
  currency           text,
  status             text,
  stripe_customer_id text,
  stripe_subscription_id text,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_events_user ON public.billing_events (user_id, occurred_at DESC);
CREATE INDEX idx_billing_events_type ON public.billing_events (type, occurred_at DESC);

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "billing_events: admin lê"
  ON public.billing_events FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "billing_events: usuário lê os próprios"
  ON public.billing_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());
