-- =============================================================================
-- 0002 — Identidade: papéis, perfis e assinatura
-- =============================================================================

CREATE TYPE public.app_role AS ENUM ('owner', 'cleaner', 'admin');

CREATE TYPE public.subscription_status AS ENUM (
  'trialing',    -- em teste, com acesso
  'active',      -- pagando
  'past_due',    -- cobrança falhou, ainda com acesso (carência)
  'canceled',    -- cancelou, acesso até o fim do período
  'expired'      -- sem acesso
);

CREATE TYPE public.plan_tier AS ENUM ('essencial', 'pro', 'ilimitado');

-- -----------------------------------------------------------------------------
-- user_roles
-- -----------------------------------------------------------------------------
CREATE TABLE public.user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE INDEX idx_user_roles_user ON public.user_roles (user_id);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER para não recursar na RLS da própria tabela.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;

CREATE POLICY "user_roles: dono lê o próprio"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "user_roles: admin lê tudo"
  ON public.user_roles FOR SELECT TO authenticated
  USING (public.is_admin());

-- Papel NÃO é auto-atribuível para 'admin'. Owner/cleaner sim, no cadastro.
CREATE POLICY "user_roles: usuário cria o próprio papel não-admin"
  ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND role <> 'admin');

CREATE POLICY "user_roles: admin gerencia"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- -----------------------------------------------------------------------------
-- profiles
--
-- ATENÇÃO: no backend antigo havia uma policy
--   "Anon can lookup referral codes" ... TO anon USING (referral_code IS NOT NULL)
-- RLS é por LINHA, não por coluna — aquilo entregava email, whatsapp, pix_key e
-- IDs do Stripe de todo afiliado para qualquer anônimo. Aqui profiles é fechado
-- e a consulta de código de indicação passa por RPC que devolve só o necessário.
-- -----------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

  full_name              text,
  email                  text,           -- sempre gravado em minúsculas (ver trigger abaixo)
  phone_e164             text,
  avatar_url             text,
  locale                 text NOT NULL DEFAULT 'pt',

  -- Assinatura
  plan                   public.plan_tier NOT NULL DEFAULT 'essencial',
  billing_cycle          text NOT NULL DEFAULT 'monthly'
                           CHECK (billing_cycle IN ('monthly', 'annual')),
  subscription_status    public.subscription_status NOT NULL DEFAULT 'trialing',
  trial_started_at       timestamptz,
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text,

  -- Indicação / financeiro do afiliado
  referral_code          text UNIQUE,
  referred_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  pix_key                text,

  -- Operação
  onboarding_completed_at timestamptz,
  last_seen_at           timestamptz,
  notes                  text,                       -- anotação interna do admin

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_user          ON public.profiles (user_id);
CREATE INDEX idx_profiles_email         ON public.profiles (lower(email));
CREATE INDEX idx_profiles_status        ON public.profiles (subscription_status);
CREATE INDEX idx_profiles_stripe_cust   ON public.profiles (stripe_customer_id);
CREATE INDEX idx_profiles_referred_by   ON public.profiles (referred_by_user_id);
CREATE INDEX idx_profiles_trial_ends    ON public.profiles (trial_ends_at)
  WHERE subscription_status = 'trialing';

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles: lê o próprio"
  ON public.profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "profiles: atualiza o próprio"
  ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "profiles: admin lê tudo"
  ON public.profiles FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "profiles: admin atualiza"
  ON public.profiles FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Colunas que o próprio usuário NUNCA pode alterar (plano, status, Stripe).
-- Quem muda isso é o webhook do Stripe, via service_role.
CREATE OR REPLACE FUNCTION public.tg_profiles_guard_billing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- service_role e admin passam livres.
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.plan                   := OLD.plan;
  NEW.subscription_status    := OLD.subscription_status;
  NEW.billing_cycle          := OLD.billing_cycle;
  NEW.trial_started_at       := OLD.trial_started_at;
  NEW.trial_ends_at          := OLD.trial_ends_at;
  NEW.current_period_end     := OLD.current_period_end;
  NEW.stripe_customer_id     := OLD.stripe_customer_id;
  NEW.stripe_subscription_id := OLD.stripe_subscription_id;
  NEW.referred_by_user_id    := OLD.referred_by_user_id;
  NEW.notes                  := OLD.notes;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_guard_billing
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_guard_billing();

-- Normaliza e-mail (minúsculo) e telefone (E.164) na entrada, para que a busca
-- por e-mail da diarista e o envio de WhatsApp nunca dependam de digitação.
CREATE OR REPLACE FUNCTION public.tg_profiles_normalize()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email      := lower(nullif(btrim(NEW.email), ''));
  NEW.phone_e164 := public.normalize_phone(NEW.phone_e164);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_normalize
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_normalize();

-- -----------------------------------------------------------------------------
-- Criação automática de perfil + trial no signup
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _trial_days int := COALESCE(public.app_setting('trial_days', '7')::int, 7);
  _code       text;
BEGIN
  -- Código de indicação curto e único.
  LOOP
    _code := upper(substr(public.generate_token(6), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = _code);
  END LOOP;

  INSERT INTO public.profiles (
    user_id, email, full_name, phone_e164,
    trial_started_at, trial_ends_at, subscription_status, referral_code
  ) VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    public.normalize_phone(NEW.raw_user_meta_data ->> 'whatsapp'),
    now(),
    now() + make_interval(days => _trial_days),
    'trialing',
    _code
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_handle_new_user();

-- -----------------------------------------------------------------------------
-- Acesso: um dono só usa o produto com assinatura viva.
-- Uma função só, usada por RLS, jobs e edge functions — sem regra duplicada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_is_active(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = _user_id
      AND (
        p.subscription_status = 'active'
        OR p.subscription_status = 'past_due'
        OR (p.subscription_status = 'trialing' AND p.trial_ends_at > now())
        OR (p.subscription_status = 'canceled' AND p.current_period_end > now())
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.subscription_is_active(uuid) FROM anon;

-- Consulta pública de código de indicação SEM expor a linha do perfil.
CREATE OR REPLACE FUNCTION public.lookup_referral(_code text)
RETURNS TABLE (referrer_user_id uuid, referrer_first_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id, split_part(COALESCE(p.full_name, ''), ' ', 1)
  FROM public.profiles p
  WHERE p.referral_code = upper(btrim(_code))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_referral(text) TO anon, authenticated;

COMMENT ON FUNCTION public.lookup_referral(text) IS
  'Resolve código de indicação devolvendo só id e primeiro nome. Substitui a policy anon em profiles.';
