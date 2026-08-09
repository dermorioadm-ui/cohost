-- HospedePay — schema completo. Cole no SQL Editor do Supabase e rode uma vez.
-- Gerado a partir de supabase/migrations/*.sql


-- ═══════════════════════════════════════════════════════
-- 0001_foundation.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0001 — Fundação: extensões, timezone da aplicação, helpers e auditoria
-- =============================================================================
-- Regra de ouro deste backend: TUDO que é "hoje" usa o fuso da aplicação
-- (America/Sao_Paulo), nunca UTC. No app antigo, `new Date().toISOString()`
-- fazia o sistema virar o dia às 21h no Brasil — o botão "concluir limpeza"
-- sumia à noite. Aqui a data corrente vem sempre de app_today().
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- -----------------------------------------------------------------------------
-- Configuração da aplicação (chave/valor). Evita recompilar função pra trocar
-- um parâmetro operacional.
-- -----------------------------------------------------------------------------
CREATE TABLE public.app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_settings (key, value, description) VALUES
  ('timezone',                'America/Sao_Paulo', 'Fuso usado em toda regra de negócio'),
  ('ical_sync_interval_min',  '30',                'Minutos entre sincronizações de calendário'),
  ('ical_lookback_days',      '3',                 'Dias no passado que a sync ainda considera'),
  ('ical_lookahead_days',     '365',               'Dias no futuro que a sync importa'),
  ('condo_notify_enabled',    'true',              'Enviar e-mail à portaria a cada reserva'),
  ('guest_session_ttl_hours', '720',               'Validade do token de sessão do hóspede (30d)'),
  ('cleaner_invite_ttl_days', '30',                'Validade do link de convite da diarista'),
  ('trial_days',              '7',                 'Dias de teste da assinatura');

-- -----------------------------------------------------------------------------
-- Helpers de tempo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_tz()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT value FROM public.app_settings WHERE key = 'timezone'),
    'America/Sao_Paulo'
  );
$$;

-- Data corrente no fuso da aplicação. Use SEMPRE isto, nunca CURRENT_DATE.
CREATE OR REPLACE FUNCTION public.app_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE public.app_tz())::date;
$$;

-- Timestamp local (sem tz) no fuso da aplicação.
CREATE OR REPLACE FUNCTION public.app_now()
RETURNS timestamp
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE public.app_tz());
$$;

CREATE OR REPLACE FUNCTION public.app_setting(_key text, _default text DEFAULT NULL)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value FROM public.app_settings WHERE key = _key), _default);
$$;

-- -----------------------------------------------------------------------------
-- Token opaco, criptograficamente aleatório. Base das sessões de hóspede e
-- dos convites de diarista (nunca usamos dado pessoal como credencial).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_token(_bytes int DEFAULT 32)
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.gen_random_bytes(_bytes), 'hex');
$$;

-- Hash para guardar token em repouso (nunca gravamos o token em claro).
CREATE OR REPLACE FUNCTION public.hash_token(_token text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(_token, 'sha256'), 'hex');
$$;

-- -----------------------------------------------------------------------------
-- updated_at automático
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Normalização de telefone -> E.164 (dígitos, com DDI).
-- Brasil é o default quando o número vem sem +.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_phone(_phone text, _default_ddi text DEFAULT '55')
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  digits text;
BEGIN
  IF _phone IS NULL OR btrim(_phone) = '' THEN
    RETURN NULL;
  END IF;

  digits := regexp_replace(_phone, '[^0-9]', '', 'g');

  IF digits = '' THEN
    RETURN NULL;
  END IF;

  -- Já veio com + : confiamos no DDI informado.
  IF btrim(_phone) LIKE '+%' THEN
    RETURN digits;
  END IF;

  -- 10 ou 11 dígitos = número nacional brasileiro sem DDI (DDD + número).
  IF length(digits) IN (10, 11) THEN
    RETURN _default_ddi || digits;
  END IF;

  RETURN digits;
END;
$$;

-- -----------------------------------------------------------------------------
-- Trilha de auditoria — quem mexeu em quê. Alimentada por triggers nas
-- tabelas sensíveis e por gravação explícita nas edge functions.
-- -----------------------------------------------------------------------------
CREATE TABLE public.audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_entity  ON public.audit_log (entity, entity_id, created_at DESC);
CREATE INDEX idx_audit_log_actor   ON public.audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_log_created ON public.audit_log (created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  public.audit_log IS 'Trilha de auditoria. Só admin e service_role leem.';
COMMENT ON TABLE  public.app_settings IS 'Parâmetros operacionais. Só service_role escreve.';
COMMENT ON FUNCTION public.app_today() IS 'Data de hoje no fuso da aplicação. Use sempre esta, nunca CURRENT_DATE.';

-- ═══════════════════════════════════════════════════════
-- 0002_identity.sql
-- ═══════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════
-- 0003_connections.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0003 — Vínculo dono ↔ diarista, com convite por link mágico
-- =============================================================================
-- No backend antigo o convite ia por e-mail e a diarista tinha que abrir a
-- caixa, criar senha e voltar. É o maior ralo de ativação do produto: diarista
-- não usa e-mail. Aqui o convite vira um TOKEN opaco que viaja por onde você
-- quiser (wa.me manual hoje, Cloud API depois) e resolve o acesso em um toque.
--
-- O token nunca é gravado em claro — guardamos só o hash.
-- =============================================================================

CREATE TYPE public.invite_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');

CREATE TABLE public.cleaner_invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  cleaner_name      text NOT NULL,
  cleaner_email     text,
  cleaner_phone_e164 text,

  token_hash        text NOT NULL UNIQUE,
  status            public.invite_status NOT NULL DEFAULT 'pending',

  -- Imóvel que passa a ser dela quando aceitar. NULL = convite sem imóvel.
  property_id       uuid REFERENCES public.properties(id) ON DELETE SET NULL,

  accepted_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at       timestamptz,
  expires_at        timestamptz NOT NULL,
  last_sent_at      timestamptz,
  send_count        int NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cleaner_invites_contact_required
    CHECK (cleaner_email IS NOT NULL OR cleaner_phone_e164 IS NOT NULL)
);

CREATE INDEX idx_cleaner_invites_owner  ON public.cleaner_invites (owner_id, status);
CREATE INDEX idx_cleaner_invites_status ON public.cleaner_invites (status, expires_at);

CREATE TRIGGER trg_cleaner_invites_updated_at
  BEFORE UPDATE ON public.cleaner_invites
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.cleaner_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cleaner_invites: dono gerencia os seus"
  ON public.cleaner_invites FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "cleaner_invites: admin lê tudo"
  ON public.cleaner_invites FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- connections — o vínculo ativo. Uma diarista pode atender vários donos.
-- -----------------------------------------------------------------------------
CREATE TABLE public.connections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invite_id   uuid REFERENCES public.cleaner_invites(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, cleaner_id)
);

CREATE INDEX idx_connections_owner   ON public.connections (owner_id) WHERE active;
CREATE INDEX idx_connections_cleaner ON public.connections (cleaner_id) WHERE active;

CREATE TRIGGER trg_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connections: participantes leem"
  ON public.connections FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR cleaner_id = auth.uid());

CREATE POLICY "connections: dono desativa"
  ON public.connections FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "connections: admin lê tudo"
  ON public.connections FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Quem eu posso ver? Usado pelas policies de perfil cruzado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.connected_user_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cleaner_id FROM public.connections WHERE owner_id = _user_id AND active
  UNION
  SELECT owner_id   FROM public.connections WHERE cleaner_id = _user_id AND active;
$$;

REVOKE EXECUTE ON FUNCTION public.connected_user_ids(uuid) FROM anon;

-- Dono e diarista precisam ver nome/telefone um do outro — e SÓ isso.
-- Por isso é uma função com colunas explícitas, não uma policy na profiles.
CREATE OR REPLACE FUNCTION public.connected_profiles()
RETURNS TABLE (
  user_id    uuid,
  full_name  text,
  email      text,
  phone_e164 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id, p.full_name, p.email, p.phone_e164
  FROM public.profiles p
  WHERE p.user_id IN (SELECT public.connected_user_ids(auth.uid()));
$$;

GRANT EXECUTE ON FUNCTION public.connected_profiles() TO authenticated;

-- -----------------------------------------------------------------------------
-- Aceite do convite. Roda como service_role a partir da edge function
-- cleaner-accept, que já validou o token.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_cleaner_invite(_token text, _cleaner_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _invite public.cleaner_invites%ROWTYPE;
  _conn_id uuid;
BEGIN
  SELECT * INTO _invite
  FROM public.cleaner_invites
  WHERE token_hash = public.hash_token(_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'convite_invalido' USING ERRCODE = 'P0002';
  END IF;

  IF _invite.status = 'accepted' AND _invite.accepted_by = _cleaner_id THEN
    SELECT id INTO _conn_id FROM public.connections
    WHERE owner_id = _invite.owner_id AND cleaner_id = _cleaner_id;
    RETURN _conn_id;                       -- idempotente
  END IF;

  IF _invite.status <> 'pending' THEN
    RAISE EXCEPTION 'convite_ja_usado' USING ERRCODE = 'P0002';
  END IF;

  IF _invite.expires_at < now() THEN
    UPDATE public.cleaner_invites SET status = 'expired' WHERE id = _invite.id;
    RAISE EXCEPTION 'convite_expirado' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_cleaner_id, 'cleaner')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.connections (owner_id, cleaner_id, invite_id)
  VALUES (_invite.owner_id, _cleaner_id, _invite.id)
  ON CONFLICT (owner_id, cleaner_id)
    DO UPDATE SET active = true, updated_at = now()
  RETURNING id INTO _conn_id;

  UPDATE public.cleaner_invites
  SET status = 'accepted', accepted_by = _cleaner_id, accepted_at = now()
  WHERE id = _invite.id;

  -- O imóvel do convite passa a ser dela. Só quando está sem ninguém: um
  -- convite não tira o imóvel de outra diarista que já esteja atendendo.
  IF _invite.property_id IS NOT NULL THEN
    UPDATE public.properties
    SET cleaner_id = _cleaner_id, updated_at = now()
    WHERE id = _invite.property_id
      AND owner_id = _invite.owner_id
      AND cleaner_id IS NULL;
  END IF;

  -- Toda tarefa pendente do dono sem diarista passa a ser dela.
  -- Depende do UPDATE acima: é ele que faz esta condição casar.
  UPDATE public.cleaning_tasks t
  SET cleaner_id = _cleaner_id, updated_at = now()
  FROM public.properties pr
  WHERE t.property_id = pr.id
    AND pr.owner_id = _invite.owner_id
    AND pr.cleaner_id = _cleaner_id
    AND t.status = 'pending'
    AND t.cleaner_id IS DISTINCT FROM _cleaner_id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (_cleaner_id, 'cleaner', 'invite.accepted', 'cleaner_invites', _invite.id::text,
          jsonb_build_object('owner_id', _invite.owner_id,
                             'property_id', _invite.property_id));

  RETURN _conn_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_cleaner_invite(text, uuid) FROM anon, authenticated;

COMMENT ON FUNCTION public.accept_cleaner_invite(text, uuid) IS
  'Aceita convite e cria vínculo. Só service_role (chamada pela edge function cleaner-accept).';

-- ═══════════════════════════════════════════════════════
-- 0004_properties.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0004 — Imóveis, fontes de calendário e o "cérebro" da assistente
-- =============================================================================

CREATE TYPE public.ical_provider AS ENUM ('airbnb', 'booking', 'vrbo', 'other');

CREATE TABLE public.properties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  name              text NOT NULL,
  property_type     text NOT NULL DEFAULT 'apartment',

  -- Endereço
  address           text,
  street_number     text,
  apt_number        text,
  block             text,
  neighborhood      text,
  city              text,
  state             text,
  zip_code          text,

  -- Condomínio / portaria
  condo_name        text,
  condo_email       text,
  condo_notify      boolean NOT NULL DEFAULT true,

  -- Operação
  checkin_time      time NOT NULL DEFAULT '15:00',
  checkout_time     time NOT NULL DEFAULT '11:00',
  turnover_price    numeric(10,2) NOT NULL DEFAULT 0 CHECK (turnover_price >= 0),
  self_clean        boolean NOT NULL DEFAULT false,

  -- Assistente do hóspede.
  -- Campos estruturados em JSONB (chave -> valor). ai_prompt é derivado.
  ai_config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_prompt         text,
  ai_enabled        boolean NOT NULL DEFAULT true,

  -- Link público do chat. Slug rotacionável: se vazar, você gira sem trocar o
  -- id interno nem quebrar as reservas já cadastradas.
  public_slug       text NOT NULL UNIQUE DEFAULT lower(substr(public.generate_token(8), 1, 12)),

  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_properties_owner   ON public.properties (owner_id) WHERE archived_at IS NULL;
CREATE INDEX idx_properties_cleaner ON public.properties (cleaner_id) WHERE archived_at IS NULL;
CREATE INDEX idx_properties_slug    ON public.properties (public_slug);

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "properties: dono gerencia"
  ON public.properties FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "properties: diarista lê as atribuídas"
  ON public.properties FOR SELECT TO authenticated
  USING (cleaner_id = auth.uid());

CREATE POLICY "properties: admin lê tudo"
  ON public.properties FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Monta o prompt da assistente a partir do JSONB, em ordem estável.
-- Guardar estruturado (em vez de um blob de texto) permite editar um campo,
-- validar obrigatórios e mostrar no painel o que falta preencher.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.build_ai_prompt(_config jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT string_agg(line, E'\n' ORDER BY ord)
  FROM (
    VALUES
      (1,  'address',    '📍 Endereço completo'),
      (2,  'access',     '🔑 Como acessar o imóvel'),
      (3,  'lock',       '🔐 Senha da fechadura / chave'),
      (4,  'wifi',       '📶 Wi-Fi (rede e senha)'),
      (5,  'appliances', '🚿 Equipamentos e uso'),
      (6,  'rules',      '📋 Regras da casa'),
      (7,  'parking',    '🚗 Estacionamento'),
      (8,  'amenities',  '🏊 Áreas comuns / lazer'),
      (9,  'checkout',   '🧳 Instruções de saída'),
      (10, 'emergency',  '📞 WhatsApp do responsável (urgências)'),
      (11, 'extra',      '💡 Outras informações')
  ) AS f(ord, key, label)
  CROSS JOIN LATERAL (
    SELECT label || ': ' || btrim(_config ->> f.key) AS line
  ) l
  WHERE nullif(btrim(COALESCE(_config ->> f.key, '')), '') IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.tg_properties_sync_prompt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.ai_prompt   := public.build_ai_prompt(NEW.ai_config);
  NEW.condo_email := lower(nullif(btrim(NEW.condo_email), ''));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_properties_sync_prompt
  BEFORE INSERT OR UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_properties_sync_prompt();

-- -----------------------------------------------------------------------------
-- Fontes de calendário — uma linha por plataforma, com estado de sincronização.
--
-- No backend antigo eram três colunas soltas e nenhum registro de erro: se o
-- feed do Booking caísse, ninguém ficava sabendo. Aqui cada fonte guarda o
-- último sucesso, o último erro e a contagem de falhas — é isso que permite
-- avisar o cliente "seu calendário parou" antes dele cancelar.
-- -----------------------------------------------------------------------------
CREATE TABLE public.property_ical_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  provider          public.ical_provider NOT NULL,
  url               text NOT NULL,
  active            boolean NOT NULL DEFAULT true,

  last_synced_at    timestamptz,
  last_success_at   timestamptz,
  last_error        text,
  consecutive_fails int NOT NULL DEFAULT 0,
  events_last_sync  int,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (property_id, provider),
  CONSTRAINT ical_url_is_http CHECK (url ~* '^https?://')
);

CREATE INDEX idx_ical_sources_property ON public.property_ical_sources (property_id) WHERE active;
CREATE INDEX idx_ical_sources_stale    ON public.property_ical_sources (last_synced_at NULLS FIRST) WHERE active;
CREATE INDEX idx_ical_sources_failing  ON public.property_ical_sources (consecutive_fails)
  WHERE active AND consecutive_fails > 0;

CREATE TRIGGER trg_ical_sources_updated_at
  BEFORE UPDATE ON public.property_ical_sources
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.property_ical_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ical_sources: dono gerencia"
  ON public.property_ical_sources FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_ical_sources.property_id AND p.owner_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_ical_sources.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "ical_sources: admin lê tudo"
  ON public.property_ical_sources FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Nome de exibição do imóvel — mesma regra em todo lugar (app, e-mail, painel).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.property_display_name(_property public.properties)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    nullif(btrim(_property.name), ''),
    nullif(btrim(concat_ws(' ',
      _property.condo_name,
      CASE WHEN _property.block      IS NOT NULL THEN 'Bl. ' || _property.block      END,
      CASE WHEN _property.apt_number IS NOT NULL THEN 'Ap. ' || _property.apt_number END
    )), ''),
    _property.address,
    'Imóvel'
  );
$$;

-- ═══════════════════════════════════════════════════════
-- 0005_reservations.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0005 — Reservas
-- =============================================================================
-- Esta tabela não existia no backend antigo: o iCal virava tarefa de limpeza
-- direto, e a reserva se perdia. Isso causava três problemas concretos:
--
--   1. A portaria só era avisada se o hóspede preenchesse o formulário do chat.
--      Sem a reserva como entidade, não havia "toda reserva" para notificar.
--   2. A deduplicação era por (property_id, checkout_date). Duas reservas com a
--      mesma data de saída colidiam, e se a data mudasse a identidade sumia.
--      Aqui a chave é o UID do próprio evento iCal — que é estável.
--   3. Não dava para saber se uma reserva foi cancelada ou só saiu da janela.
--      Agora comparamos last_seen_at com a última sincronização da fonte.
-- =============================================================================

CREATE TYPE public.reservation_status AS ENUM ('confirmed', 'cancelled');

CREATE TABLE public.reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  source_id          uuid REFERENCES public.property_ical_sources(id) ON DELETE SET NULL,
  provider           public.ical_provider NOT NULL DEFAULT 'other',

  -- UID do VEVENT. Estável entre sincronizações — é a identidade da reserva.
  external_uid       text NOT NULL,

  checkin_date       date NOT NULL,
  checkout_date      date NOT NULL,
  guest_label        text,            -- SUMMARY do iCal ("Reserved", nome, etc.)
  reservation_url    text,            -- quando a plataforma expõe

  status             public.reservation_status NOT NULL DEFAULT 'confirmed',

  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz,

  -- Notificação à portaria: carimbo idempotente. Enquanto for NULL, o job
  -- job-notify-condo ainda tem trabalho a fazer nesta reserva.
  condo_notified_at  timestamptz,
  condo_notify_error text,

  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (property_id, external_uid),
  CONSTRAINT reservations_dates_sane CHECK (checkout_date >= checkin_date)
);

CREATE INDEX idx_reservations_property   ON public.reservations (property_id, checkout_date);
CREATE INDEX idx_reservations_checkout   ON public.reservations (checkout_date)
  WHERE status = 'confirmed';
CREATE INDEX idx_reservations_checkin    ON public.reservations (checkin_date)
  WHERE status = 'confirmed';
CREATE INDEX idx_reservations_pending_condo
  ON public.reservations (created_at)
  WHERE status = 'confirmed' AND condo_notified_at IS NULL;

CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reservations: dono lê as suas"
  ON public.reservations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = reservations.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "reservations: diarista lê as dos imóveis dela"
  ON public.reservations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = reservations.property_id AND p.cleaner_id = auth.uid()
  ));

CREATE POLICY "reservations: admin lê tudo"
  ON public.reservations FOR SELECT TO authenticated
  USING (public.is_admin());

-- Escrita só por service_role (job de sincronização). Sem policy de INSERT/UPDATE
-- para authenticated: reserva é fato importado, ninguém digita à mão.

COMMENT ON COLUMN public.reservations.external_uid IS
  'UID do VEVENT no feed iCal. Chave de deduplicação — estável quando as datas mudam.';
COMMENT ON COLUMN public.reservations.condo_notified_at IS
  'Carimbo de idempotência do e-mail à portaria. NULL = ainda não avisado.';

-- ═══════════════════════════════════════════════════════
-- 0006_cleaning_tasks.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0006 — Tarefas de limpeza
-- =============================================================================

CREATE TYPE public.cleaning_status AS ENUM ('pending', 'completed', 'cancelled');

CREATE TABLE public.cleaning_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  reservation_id  uuid REFERENCES public.reservations(id) ON DELETE CASCADE,
  cleaner_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  checkout_date   date NOT NULL,
  checkout_time   time,
  next_checkin_date date,            -- quando há reserva emendada; ela precisa saber
  guest_label     text,

  status          public.cleaning_status NOT NULL DEFAULT 'pending',
  turnover_price  numeric(10,2) NOT NULL DEFAULT 0 CHECK (turnover_price >= 0),

  completed_at    timestamptz,
  completed_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  photo_path      text,              -- caminho no bucket (não URL pública)
  photo_taken_at  timestamptz,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Uma tarefa por reserva. Para tarefas manuais (sem reserva), a chave abaixo.
  UNIQUE (reservation_id)
);

-- Evita duplicata de tarefa manual no mesmo imóvel/dia.
CREATE UNIQUE INDEX uq_cleaning_manual_per_day
  ON public.cleaning_tasks (property_id, checkout_date)
  WHERE reservation_id IS NULL;

CREATE INDEX idx_cleaning_cleaner_date ON public.cleaning_tasks (cleaner_id, checkout_date)
  WHERE status <> 'cancelled';
CREATE INDEX idx_cleaning_property_date ON public.cleaning_tasks (property_id, checkout_date);
CREATE INDEX idx_cleaning_pending ON public.cleaning_tasks (checkout_date)
  WHERE status = 'pending';

CREATE TRIGGER trg_cleaning_tasks_updated_at
  BEFORE UPDATE ON public.cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.cleaning_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cleaning_tasks: dono lê as suas"
  ON public.cleaning_tasks FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = cleaning_tasks.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "cleaning_tasks: dono atualiza as suas"
  ON public.cleaning_tasks FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = cleaning_tasks.property_id AND p.owner_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = cleaning_tasks.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "cleaning_tasks: dono cria tarefa avulsa"
  ON public.cleaning_tasks FOR INSERT TO authenticated
  WITH CHECK (
    reservation_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = cleaning_tasks.property_id AND p.owner_id = auth.uid()
    )
  );

CREATE POLICY "cleaning_tasks: diarista lê as dela"
  ON public.cleaning_tasks FOR SELECT TO authenticated
  USING (cleaner_id = auth.uid());

CREATE POLICY "cleaning_tasks: diarista atualiza as dela"
  ON public.cleaning_tasks FOR UPDATE TO authenticated
  USING (cleaner_id = auth.uid())
  WITH CHECK (cleaner_id = auth.uid());

CREATE POLICY "cleaning_tasks: admin lê tudo"
  ON public.cleaning_tasks FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- A diarista só pode mexer no que é dela mexer. Sem isso, a policy de UPDATE
-- deixaria ela reescrever preço da diária ou remanejar a tarefa para outra
-- pessoa. Aqui ela altera status, foto e observação — nada além.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_cleaning_tasks_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_owner boolean;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;                                   -- service_role / admin
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = NEW.property_id AND p.owner_id = auth.uid()
  ) INTO _is_owner;

  IF _is_owner THEN
    RETURN NEW;
  END IF;

  -- Daqui pra baixo: é a diarista.
  NEW.property_id     := OLD.property_id;
  NEW.reservation_id  := OLD.reservation_id;
  NEW.cleaner_id      := OLD.cleaner_id;
  NEW.checkout_date   := OLD.checkout_date;
  NEW.checkout_time   := OLD.checkout_time;
  NEW.turnover_price  := OLD.turnover_price;
  NEW.guest_label     := OLD.guest_label;

  -- Carimba conclusão de forma confiável (não confia no relógio do celular).
  IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF NEW.status <> 'completed' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;

  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path AND NEW.photo_path IS NOT NULL THEN
    NEW.photo_taken_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cleaning_tasks_guard
  BEFORE UPDATE ON public.cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_cleaning_tasks_guard();

-- -----------------------------------------------------------------------------
-- Reserva → tarefa. Uma reserva confirmada gera exatamente uma tarefa na data
-- de saída; cancelada derruba a tarefa se ela ainda estiver pendente (se já foi
-- limpa, mantém — o trabalho aconteceu e precisa ser pago).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_reservation_to_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop public.properties%ROWTYPE;
  _next_checkin date;
BEGIN
  SELECT * INTO _prop FROM public.properties WHERE id = NEW.property_id;
  IF NOT FOUND OR _prop.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN
    DELETE FROM public.cleaning_tasks
    WHERE reservation_id = NEW.id AND status = 'pending';
    RETURN NEW;
  END IF;

  -- Próxima entrada no mesmo imóvel: a diarista precisa saber quanto tempo tem.
  SELECT MIN(r.checkin_date) INTO _next_checkin
  FROM public.reservations r
  WHERE r.property_id = NEW.property_id
    AND r.status = 'confirmed'
    AND r.id <> NEW.id
    AND r.checkin_date >= NEW.checkout_date;

  INSERT INTO public.cleaning_tasks (
    property_id, reservation_id, cleaner_id,
    checkout_date, checkout_time, next_checkin_date, guest_label, turnover_price
  ) VALUES (
    NEW.property_id, NEW.id,
    CASE WHEN _prop.self_clean THEN _prop.owner_id ELSE _prop.cleaner_id END,
    NEW.checkout_date, _prop.checkout_time, _next_checkin, NEW.guest_label,
    CASE WHEN _prop.self_clean THEN 0 ELSE _prop.turnover_price END
  )
  ON CONFLICT (reservation_id) DO UPDATE SET
    checkout_date     = EXCLUDED.checkout_date,
    next_checkin_date = EXCLUDED.next_checkin_date,
    guest_label       = COALESCE(EXCLUDED.guest_label, public.cleaning_tasks.guest_label),
    updated_at        = now()
  WHERE public.cleaning_tasks.status = 'pending';   -- não remexe tarefa já concluída

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservation_to_task
  AFTER INSERT OR UPDATE OF status, checkout_date, checkin_date, guest_label
  ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_reservation_to_task();

-- -----------------------------------------------------------------------------
-- Trocou a diarista do imóvel? As tarefas pendentes acompanham.
-- Mudou horário de saída? Idem. (No app antigo isso era um UPDATE solto dentro
-- do loop de sincronização, e só rodava quando a sync rodava.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_property_propagate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.cleaner_id IS DISTINCT FROM OLD.cleaner_id
     OR NEW.self_clean IS DISTINCT FROM OLD.self_clean THEN
    UPDATE public.cleaning_tasks
    SET cleaner_id = CASE WHEN NEW.self_clean THEN NEW.owner_id ELSE NEW.cleaner_id END,
        updated_at = now()
    WHERE property_id = NEW.id AND status = 'pending';
  END IF;

  IF NEW.checkout_time IS DISTINCT FROM OLD.checkout_time THEN
    UPDATE public.cleaning_tasks
    SET checkout_time = NEW.checkout_time, updated_at = now()
    WHERE property_id = NEW.id AND status = 'pending';
  END IF;

  IF NEW.turnover_price IS DISTINCT FROM OLD.turnover_price THEN
    UPDATE public.cleaning_tasks
    SET turnover_price = CASE WHEN NEW.self_clean THEN 0 ELSE NEW.turnover_price END,
        updated_at = now()
    WHERE property_id = NEW.id AND status = 'pending';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_property_propagate
  AFTER UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_property_propagate();

-- ═══════════════════════════════════════════════════════
-- 0007_cleaner_fees.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0007 — Taxa fixa de reposição de produtos
-- =============================================================================
-- A diarista lança o que precisa repor, o dono aprova ou rejeita antes de pagar.
-- Diferença para o backend antigo: a taxa agora tem COMPETÊNCIA (mês de
-- referência). Sem isso, o fechamento financeiro somava taxas de todos os meses
-- do histórico dentro do mês que você estivesse olhando.
-- =============================================================================

CREATE TYPE public.fee_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE public.fee_category AS ENUM (
  'cleaning_products',
  'kitchen_supplies',
  'batteries',
  'laundry',
  'toiletries',
  'other'
);

CREATE TABLE public.cleaner_fees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id   uuid REFERENCES public.properties(id) ON DELETE CASCADE,

  -- Mês de competência. Sempre o dia 1 do mês.
  reference_month date NOT NULL DEFAULT date_trunc('month', public.app_today())::date,

  categories    public.fee_category[] NOT NULL DEFAULT '{}',
  description   text,
  amount        numeric(10,2) NOT NULL CHECK (amount >= 0),

  status        public.fee_status NOT NULL DEFAULT 'pending',
  decided_at    timestamptz,
  decided_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_note text,

  receipt_path  text,                       -- comprovante opcional no bucket

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fee_month_is_first_day CHECK (date_trunc('month', reference_month) = reference_month),
  CONSTRAINT fee_has_content CHECK (
    cardinality(categories) > 0 OR nullif(btrim(description), '') IS NOT NULL
  )
);

CREATE INDEX idx_fees_owner_month   ON public.cleaner_fees (owner_id, reference_month, status);
CREATE INDEX idx_fees_cleaner_month ON public.cleaner_fees (cleaner_id, reference_month);
CREATE INDEX idx_fees_pending       ON public.cleaner_fees (owner_id) WHERE status = 'pending';

CREATE TRIGGER trg_cleaner_fees_updated_at
  BEFORE UPDATE ON public.cleaner_fees
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.cleaner_fees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fees: diarista lê as suas"
  ON public.cleaner_fees FOR SELECT TO authenticated
  USING (cleaner_id = auth.uid());

CREATE POLICY "fees: diarista lança para dono conectado"
  ON public.cleaner_fees FOR INSERT TO authenticated
  WITH CHECK (
    cleaner_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.cleaner_id = auth.uid() AND c.owner_id = cleaner_fees.owner_id AND c.active
    )
  );

CREATE POLICY "fees: diarista edita enquanto pendente"
  ON public.cleaner_fees FOR UPDATE TO authenticated
  USING (cleaner_id = auth.uid() AND status = 'pending')
  WITH CHECK (cleaner_id = auth.uid());

CREATE POLICY "fees: diarista apaga enquanto pendente"
  ON public.cleaner_fees FOR DELETE TO authenticated
  USING (cleaner_id = auth.uid() AND status = 'pending');

CREATE POLICY "fees: dono lê as suas"
  ON public.cleaner_fees FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY "fees: dono decide"
  ON public.cleaner_fees FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "fees: admin lê tudo"
  ON public.cleaner_fees FOR SELECT TO authenticated
  USING (public.is_admin());

-- Dono só mexe na decisão; diarista só mexe no conteúdo. E editar um lançamento
-- já decidido devolve ele para 'pending' (o dono precisa reaprovar).
CREATE OR REPLACE FUNCTION public.tg_cleaner_fees_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.owner_id THEN
    -- Dono: só status e nota da decisão.
    NEW.categories      := OLD.categories;
    NEW.description     := OLD.description;
    NEW.amount          := OLD.amount;
    NEW.property_id     := OLD.property_id;
    NEW.reference_month := OLD.reference_month;
    NEW.cleaner_id      := OLD.cleaner_id;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.decided_at := now();
      NEW.decided_by := auth.uid();
    END IF;

  ELSIF auth.uid() = OLD.cleaner_id THEN
    -- Diarista: conteúdo. Qualquer alteração reabre a aprovação.
    NEW.owner_id   := OLD.owner_id;
    NEW.cleaner_id := OLD.cleaner_id;
    NEW.status     := 'pending';
    NEW.decided_at := NULL;
    NEW.decided_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cleaner_fees_guard
  BEFORE UPDATE ON public.cleaner_fees
  FOR EACH ROW EXECUTE FUNCTION public.tg_cleaner_fees_guard();

-- ═══════════════════════════════════════════════════════
-- 0008_guests.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0008 — Hóspedes: cadastro, termo de responsabilidade e sessão de chat
-- =============================================================================
-- Correção de segurança em relação ao backend antigo:
--
--   guest_chat_sessions / guest_chat_messages tinham
--     CREATE POLICY ... TO anon, authenticated USING (true)
--   ou seja: qualquer pessoa com a chave pública (que está no bundle JS) podia
--   baixar nome e WhatsApp de TODOS os hóspedes de TODOS os imóveis, mais o
--   histórico completo de conversa — que contém senha de fechadura, Wi-Fi e
--   endereço, porque é isso que a assistente responde.
--
-- Aqui NÃO existe policy para anon em nenhuma destas tabelas. O hóspede fala
-- com o backend por uma edge function que valida um token de sessão opaco e
-- acessa o banco com service_role. Dono e admin leem pelas policies normais.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Versões do termo de responsabilidade.
-- Guardar a versão aceita é o que dá valor probatório ao aceite: se você mudar
-- a redação daqui a seis meses, precisa saber qual texto aquele hóspede viu.
-- -----------------------------------------------------------------------------
CREATE TABLE public.term_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version      text NOT NULL,
  locale       text NOT NULL DEFAULT 'pt',
  title        text NOT NULL,
  body         text NOT NULL,
  active       boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, locale)
);

CREATE UNIQUE INDEX uq_term_active_per_locale
  ON public.term_versions (locale) WHERE active;

ALTER TABLE public.term_versions ENABLE ROW LEVEL SECURITY;

-- O termo é público por natureza: o hóspede precisa lê-lo antes de aceitar.
CREATE POLICY "terms: leitura pública do termo ativo"
  ON public.term_versions FOR SELECT TO anon, authenticated
  USING (active);

CREATE POLICY "terms: admin gerencia"
  ON public.term_versions FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

INSERT INTO public.term_versions (version, locale, title, body, active) VALUES
('1.0', 'pt', 'Termo de Responsabilidade',
'Declaro que cadastrei todas as pessoas que irão se hospedar no imóvel, respeitando o limite de ocupação informado pelo anfitrião.

Estou ciente de que o imóvel permanecerá sob minha responsabilidade durante todo o período da hospedagem, e que responderei por eventuais danos causados por mim ou por meus acompanhantes.

Estou ciente de que será realizada uma vistoria ao término da estadia.

Declaro que as informações prestadas neste cadastro são verdadeiras.', true),

('1.0', 'en', 'Statement of Responsibility',
'I declare that I have registered every person who will be staying at the property, respecting the occupancy limit set by the host.

I understand that the property remains under my responsibility for the entire duration of the stay, and that I am liable for any damage caused by me or my companions.

I understand that an inspection will be carried out at the end of the stay.

I declare that the information provided in this registration is true.', true),

('1.0', 'es', 'Término de Responsabilidad',
'Declaro que registré a todas las personas que se hospedarán en el inmueble, respetando el límite de ocupación informado por el anfitrión.

Soy consciente de que el inmueble permanecerá bajo mi responsabilidad durante todo el período de la estancia, y que responderé por eventuales daños causados por mí o por mis acompañantes.

Soy consciente de que se realizará una inspección al término de la estancia.

Declaro que la información proporcionada en este registro es verdadera.', true);

-- -----------------------------------------------------------------------------
-- Cadastro de estadia (um por grupo de hóspedes)
-- -----------------------------------------------------------------------------
CREATE TABLE public.guest_registrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  reservation_id    uuid REFERENCES public.reservations(id) ON DELETE SET NULL,

  checkin_date      date NOT NULL,
  checkout_date     date NOT NULL,

  -- Aceite do termo
  term_version_id   uuid NOT NULL REFERENCES public.term_versions(id),
  term_accepted_at  timestamptz NOT NULL DEFAULT now(),
  term_accepted_ip  inet,
  term_user_agent   text,

  locale            text NOT NULL DEFAULT 'pt',
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guest_reg_dates_sane CHECK (checkout_date > checkin_date)
);

CREATE INDEX idx_guest_reg_property ON public.guest_registrations (property_id, checkin_date DESC);
CREATE INDEX idx_guest_reg_reservation ON public.guest_registrations (reservation_id);

ALTER TABLE public.guest_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guest_reg: dono lê"
  ON public.guest_registrations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = guest_registrations.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "guest_reg: admin lê"
  ON public.guest_registrations FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Pessoas da estadia (todas, não só quem reservou)
-- -----------------------------------------------------------------------------
CREATE TABLE public.guest_people (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  uuid NOT NULL REFERENCES public.guest_registrations(id) ON DELETE CASCADE,

  full_name        text NOT NULL,
  email            text,
  phone_e164       text,
  document_type    text CHECK (document_type IN ('cpf', 'passport', 'rg', 'other')),
  document_number  text,
  is_primary       boolean NOT NULL DEFAULT false,

  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_people_reg ON public.guest_people (registration_id);
CREATE UNIQUE INDEX uq_guest_people_primary
  ON public.guest_people (registration_id) WHERE is_primary;

ALTER TABLE public.guest_people ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guest_people: dono lê"
  ON public.guest_people FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.guest_registrations gr
    JOIN public.properties p ON p.id = gr.property_id
    WHERE gr.id = guest_people.registration_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "guest_people: admin lê"
  ON public.guest_people FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Sessão de chat do hóspede — autenticada por token opaco, guardado como hash.
-- -----------------------------------------------------------------------------
CREATE TABLE public.guest_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  registration_id  uuid REFERENCES public.guest_registrations(id) ON DELETE SET NULL,

  token_hash       text NOT NULL UNIQUE,
  guest_name       text NOT NULL,
  guest_phone_e164 text,
  locale           text NOT NULL DEFAULT 'pt',

  message_count    int NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  expires_at       timestamptz NOT NULL,

  created_ip       inet,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_sessions_property ON public.guest_sessions (property_id, created_at DESC);
CREATE INDEX idx_guest_sessions_expiry   ON public.guest_sessions (expires_at);

CREATE TRIGGER trg_guest_sessions_updated_at
  BEFORE UPDATE ON public.guest_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.guest_sessions ENABLE ROW LEVEL SECURITY;

-- Sem policy para anon. O hóspede nunca fala direto com o banco.
CREATE POLICY "guest_sessions: dono lê as do imóvel dele"
  ON public.guest_sessions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = guest_sessions.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "guest_sessions: admin lê"
  ON public.guest_sessions FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Mensagens
-- -----------------------------------------------------------------------------
CREATE TABLE public.guest_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content      text NOT NULL,
  token_usage  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_messages_session ON public.guest_messages (session_id, created_at);

ALTER TABLE public.guest_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guest_messages: dono lê as do imóvel dele"
  ON public.guest_messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.guest_sessions s
    JOIN public.properties p ON p.id = s.property_id
    WHERE s.id = guest_messages.session_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "guest_messages: admin lê"
  ON public.guest_messages FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Resolve o token de sessão. Só service_role chama (edge function guest-chat).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_guest_session(_token text)
RETURNS TABLE (
  session_id      uuid,
  property_id     uuid,
  guest_name      text,
  locale          text,
  registration_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.property_id, s.guest_name, s.locale, s.registration_id
  FROM public.guest_sessions s
  WHERE s.token_hash = public.hash_token(_token)
    AND s.expires_at > now()
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_guest_session(text) FROM anon, authenticated;

COMMENT ON TABLE public.guest_sessions IS
  'Sessão do hóspede. Sem acesso anônimo direto — tudo passa pela edge function guest-chat.';

-- ═══════════════════════════════════════════════════════
-- 0009_porter.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0009 — Portaria digital (Kiper/Porter)
-- =============================================================================
-- Correção crítica em relação ao backend antigo: a function register-porter-guest
-- era pública (verify_jwt=false) e aceitava propertyId + dados de qualquer
-- origem, sem vínculo com reserva ou sessão. Como ela cadastra a pessoa como
-- MORADOR no sistema de acesso do prédio (com permissão de abertura de porta),
-- qualquer um que tivesse o link /chat/<id> podia liberar acesso a quem quisesse.
--
-- Aqui o cadastro na portaria só acontece a partir de um guest_registration
-- existente, criado com sessão válida. A edge function nunca aceita propertyId
-- avulso do cliente.
-- =============================================================================

CREATE TYPE public.porter_sync_status AS ENUM (
  'pending', 'registered', 'failed', 'no_integration', 'skipped'
);

CREATE TABLE public.porter_accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               uuid NOT NULL UNIQUE REFERENCES public.properties(id) ON DELETE CASCADE,
  owner_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Credenciais da portaria. Nunca saem para o cliente: as policies abaixo
  -- não dão SELECT nem para o dono. Só service_role lê, na hora de chamar a API.
  porter_token              text NOT NULL,
  porter_application_key    text NOT NULL,
  porter_account_local_id   text NOT NULL,
  porter_user_context_id    text NOT NULL,
  porter_user_partner_context_id text NOT NULL,
  porter_condo_person_context_id text NOT NULL,
  porter_condominium_gmt    text NOT NULL DEFAULT '-3',
  porter_profile_id         int  NOT NULL DEFAULT 16,

  active                    boolean NOT NULL DEFAULT true,
  last_ok_at                timestamptz,
  last_error                text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_porter_accounts_owner ON public.porter_accounts (owner_id) WHERE active;

CREATE TRIGGER trg_porter_accounts_updated_at
  BEFORE UPDATE ON public.porter_accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.porter_accounts ENABLE ROW LEVEL SECURITY;

-- O dono pode criar/atualizar/apagar a integração, mas NÃO pode ler os
-- segredos de volta. O painel mostra só "configurada / não configurada",
-- que vem da view porter_status abaixo.
CREATE POLICY "porter_accounts: dono grava"
  ON public.porter_accounts FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = porter_accounts.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "porter_accounts: dono atualiza"
  ON public.porter_accounts FOR UPDATE TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

CREATE POLICY "porter_accounts: dono remove"
  ON public.porter_accounts FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

CREATE OR REPLACE VIEW public.porter_status
WITH (security_invoker = true) AS
SELECT
  pa.property_id,
  pa.owner_id,
  pa.active,
  pa.last_ok_at,
  (pa.last_error IS NOT NULL) AS has_error,
  pa.updated_at
FROM public.porter_accounts pa;

GRANT SELECT ON public.porter_status TO authenticated;

-- -----------------------------------------------------------------------------
-- Cadastro de cada pessoa na portaria
-- -----------------------------------------------------------------------------
CREATE TABLE public.porter_registrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  registration_id  uuid NOT NULL REFERENCES public.guest_registrations(id) ON DELETE CASCADE,
  person_id        uuid NOT NULL REFERENCES public.guest_people(id) ON DELETE CASCADE,

  status           public.porter_sync_status NOT NULL DEFAULT 'pending',
  attempts         int NOT NULL DEFAULT 0,
  response_body    text,
  response_status  int,

  access_from      timestamptz NOT NULL,
  access_until     timestamptz NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (person_id)
);

CREATE INDEX idx_porter_reg_property ON public.porter_registrations (property_id, created_at DESC);
CREATE INDEX idx_porter_reg_pending  ON public.porter_registrations (created_at)
  WHERE status = 'pending';

CREATE TRIGGER trg_porter_reg_updated_at
  BEFORE UPDATE ON public.porter_registrations
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.porter_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "porter_reg: dono lê"
  ON public.porter_registrations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = porter_registrations.property_id AND p.owner_id = auth.uid()
  ));

CREATE POLICY "porter_reg: admin lê"
  ON public.porter_registrations FOR SELECT TO authenticated
  USING (public.is_admin());

-- ═══════════════════════════════════════════════════════
-- 0010_notifications.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0010 — Outbox único de notificações (e-mail + WhatsApp)
-- =============================================================================
-- Um lugar só para tudo que sai do sistema. Vantagens sobre a fila de e-mail
-- antiga: você vê numa tabela por que a portaria não foi avisada, reenvia sem
-- duplicar (idempotency_key), e o WhatsApp entra no mesmo fluxo quando a Meta
-- liberar — sem reescrever nada.
-- =============================================================================

CREATE TYPE public.notification_channel AS ENUM ('email', 'whatsapp');

CREATE TYPE public.notification_status AS ENUM (
  'queued', 'sending', 'sent', 'failed', 'suppressed', 'cancelled'
);

CREATE TABLE public.notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          public.notification_channel NOT NULL,
  template         text NOT NULL,

  -- Destinatário: e-mail OU telefone, conforme o canal.
  to_email         text,
  to_phone_e164    text,
  to_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  locale           text NOT NULL DEFAULT 'pt',

  -- Não manda duas vezes a mesma coisa. Ex.: 'condo:<reservation_id>'
  idempotency_key  text UNIQUE,

  status           public.notification_status NOT NULL DEFAULT 'queued',
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 5,
  scheduled_for    timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  provider_message_id text,
  last_error       text,

  -- Rastreabilidade: de qual registro nasceu esta notificação
  entity           text,
  entity_id        text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_has_recipient CHECK (
    (channel = 'email'    AND to_email      IS NOT NULL) OR
    (channel = 'whatsapp' AND to_phone_e164 IS NOT NULL)
  )
);

-- Índice do worker: o que está pronto para sair, mais antigo primeiro.
CREATE INDEX idx_notifications_due ON public.notifications (scheduled_for)
  WHERE status = 'queued';
CREATE INDEX idx_notifications_entity ON public.notifications (entity, entity_id);
CREATE INDEX idx_notifications_failed ON public.notifications (updated_at DESC)
  WHERE status = 'failed';

CREATE TRIGGER trg_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications: admin lê"
  ON public.notifications FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "notifications: usuário lê as próprias"
  ON public.notifications FOR SELECT TO authenticated
  USING (to_user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Lista de supressão (bounce, spam, descadastro). Consultada antes de enviar.
-- -----------------------------------------------------------------------------
CREATE TABLE public.suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel    public.notification_channel NOT NULL,
  address    text NOT NULL,
  reason     text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, address)
);

ALTER TABLE public.suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppressions: admin"
  ON public.suppressions FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- -----------------------------------------------------------------------------
-- Enfileirar. Respeita supressão e idempotência.
-- Devolve o id da notificação, ou NULL se foi suprimida/duplicada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_notification(
  _channel         public.notification_channel,
  _template        text,
  _payload         jsonb DEFAULT '{}'::jsonb,
  _to_email        text DEFAULT NULL,
  _to_phone        text DEFAULT NULL,
  _to_user_id      uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _locale          text DEFAULT 'pt',
  _entity          text DEFAULT NULL,
  _entity_id       text DEFAULT NULL,
  _scheduled_for   timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _addr text;
  _id   uuid;
BEGIN
  _to_email := lower(nullif(btrim(_to_email), ''));
  _to_phone := public.normalize_phone(_to_phone);
  _addr     := CASE WHEN _channel = 'email' THEN _to_email ELSE _to_phone END;

  IF _addr IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.suppressions s
    WHERE s.channel = _channel AND s.address = _addr
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notifications (
    channel, template, payload, to_email, to_phone_e164, to_user_id,
    idempotency_key, locale, entity, entity_id, scheduled_for
  ) VALUES (
    _channel, _template, _payload, _to_email, _to_phone, _to_user_id,
    _idempotency_key, _locale, _entity, _entity_id, _scheduled_for
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_notification FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Worker: pega um lote e marca como 'sending' de forma atômica.
-- SKIP LOCKED permite rodar vários workers sem enviar duplicado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_notifications(_limit int DEFAULT 25)
RETURNS SETOF public.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.notifications
    WHERE status = 'queued' AND scheduled_for <= now()
    ORDER BY scheduled_for
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notifications n
  SET status = 'sending', attempts = n.attempts + 1, updated_at = now()
  FROM due
  WHERE n.id = due.id
  RETURNING n.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_notifications(int) FROM anon, authenticated;

-- Backoff exponencial: 1min, 2min, 4min, 8min...
CREATE OR REPLACE FUNCTION public.fail_notification(_id uuid, _error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n public.notifications%ROWTYPE;
BEGIN
  SELECT * INTO _n FROM public.notifications WHERE id = _id;
  IF NOT FOUND THEN RETURN; END IF;

  IF _n.attempts >= _n.max_attempts THEN
    UPDATE public.notifications
    SET status = 'failed', last_error = _error, updated_at = now()
    WHERE id = _id;
  ELSE
    UPDATE public.notifications
    SET status        = 'queued',
        last_error    = _error,
        scheduled_for = now() + make_interval(secs => 60 * power(2, _n.attempts)::int),
        updated_at    = now()
    WHERE id = _id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fail_notification(uuid, text) FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- GATILHO DO PITCH: toda reserva confirmada avisa a portaria.
--
-- No backend antigo isso só saía se o hóspede preenchesse o formulário do chat.
-- Se ele não preenchesse — e a maioria não preenche — o condomínio nunca era
-- avisado, apesar de "avisamos a portaria a cada reserva" ser argumento de
-- venda. Agora nasce da reserva, que é o fato real.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_reservation_notify_condo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop  public.properties%ROWTYPE;
  _owner public.profiles%ROWTYPE;
BEGIN
  IF NEW.status <> 'confirmed' OR NEW.condo_notified_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF public.app_setting('condo_notify_enabled', 'true') <> 'true' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _prop FROM public.properties WHERE id = NEW.property_id;
  IF NOT FOUND OR _prop.condo_email IS NULL OR NOT _prop.condo_notify THEN
    RETURN NEW;
  END IF;

  -- Assinatura inativa não dispara comunicação em nome do cliente.
  IF NOT public.subscription_is_active(_prop.owner_id) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _owner FROM public.profiles WHERE user_id = _prop.owner_id;

  PERFORM public.enqueue_notification(
    'email',
    'condo-reservation',
    jsonb_build_object(
      'property_name', public.property_display_name(_prop),
      'condo_name',    _prop.condo_name,
      'block',         _prop.block,
      'apt_number',    _prop.apt_number,
      'owner_name',    _owner.full_name,
      'owner_phone',   _owner.phone_e164,
      'checkin_date',  NEW.checkin_date,
      'checkout_date', NEW.checkout_date,
      'checkin_time',  to_char(_prop.checkin_time,  'HH24:MI'),
      'checkout_time', to_char(_prop.checkout_time, 'HH24:MI'),
      'guest_label',   NEW.guest_label
    ),
    _prop.condo_email,
    NULL,
    _prop.owner_id,
    'condo:' || NEW.id::text,
    'pt',
    'reservations',
    NEW.id::text
  );

  UPDATE public.reservations SET condo_notified_at = now() WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservation_notify_condo
  AFTER INSERT OR UPDATE OF status ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_reservation_notify_condo();

-- -----------------------------------------------------------------------------
-- Limpeza concluída -> avisa o dono (e-mail sempre, WhatsApp quando ligado).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_cleaning_completed_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop  public.properties%ROWTYPE;
  _owner public.profiles%ROWTYPE;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _prop  FROM public.properties WHERE id = NEW.property_id;
  SELECT * INTO _owner FROM public.profiles   WHERE user_id = _prop.owner_id;

  PERFORM public.enqueue_notification(
    'email', 'cleaning-completed',
    jsonb_build_object(
      'property_name', public.property_display_name(_prop),
      'completed_at',  to_char(NEW.completed_at AT TIME ZONE public.app_tz(), 'DD/MM/YYYY HH24:MI'),
      'has_photo',     (NEW.photo_path IS NOT NULL)
    ),
    _owner.email, NULL, _prop.owner_id,
    'cleaning-done:' || NEW.id::text,
    COALESCE(_owner.locale, 'pt'),
    'cleaning_tasks', NEW.id::text
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cleaning_completed_notify
  AFTER UPDATE OF status ON public.cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_cleaning_completed_notify();

-- ═══════════════════════════════════════════════════════
-- 0011_billing_plans.sql
-- ═══════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════
-- 0012_activation.sql
-- ═══════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════
-- 0013_admin_panel.sql
-- ═══════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════
-- 0014_storage.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0014 — Storage
-- =============================================================================
-- Buckets PRIVADOS. A foto da limpeza é a prova datada do estado do imóvel —
-- ela não pode ficar em URL pública adivinhável. O acesso é por signed URL
-- gerada sob demanda para quem tem direito.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('cleaning-photos', 'cleaning-photos', false, 10485760,
   ARRAY['image/jpeg','image/png','image/webp','image/heic']),
  ('fee-receipts',    'fee-receipts',    false,  5242880,
   ARRAY['image/jpeg','image/png','image/webp','application/pdf']),
  ('avatars',         'avatars',         false,  2097152,
   ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- cleaning-photos — caminho: <task_id>/<arquivo>
-- Quem envia: a diarista designada. Quem lê: diarista, dono do imóvel, admin.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_cleaning_photo(_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.cleaning_tasks t
    JOIN public.properties p ON p.id = t.property_id
    WHERE t.id::text = split_part(_object_name, '/', 1)
      AND (t.cleaner_id = auth.uid() OR p.owner_id = auth.uid() OR public.is_admin())
  );
$$;

CREATE POLICY "cleaning-photos: envio pela diarista da tarefa"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cleaning-photos'
    AND EXISTS (
      SELECT 1 FROM public.cleaning_tasks t
      WHERE t.id::text = split_part(name, '/', 1)
        AND t.cleaner_id = auth.uid()
    )
  );

CREATE POLICY "cleaning-photos: leitura por quem tem direito"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'cleaning-photos' AND public.can_access_cleaning_photo(name));

CREATE POLICY "cleaning-photos: diarista substitui a própria"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cleaning-photos'
    AND EXISTS (
      SELECT 1 FROM public.cleaning_tasks t
      WHERE t.id::text = split_part(name, '/', 1) AND t.cleaner_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- fee-receipts — caminho: <fee_id>/<arquivo>
-- -----------------------------------------------------------------------------
CREATE POLICY "fee-receipts: diarista envia"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'fee-receipts'
    AND EXISTS (
      SELECT 1 FROM public.cleaner_fees f
      WHERE f.id::text = split_part(name, '/', 1) AND f.cleaner_id = auth.uid()
    )
  );

CREATE POLICY "fee-receipts: partes leem"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'fee-receipts'
    AND EXISTS (
      SELECT 1 FROM public.cleaner_fees f
      WHERE f.id::text = split_part(name, '/', 1)
        AND (f.cleaner_id = auth.uid() OR f.owner_id = auth.uid() OR public.is_admin())
    )
  );

-- -----------------------------------------------------------------------------
-- avatars — caminho: <user_id>/<arquivo>
-- -----------------------------------------------------------------------------
CREATE POLICY "avatars: dono gerencia o próprio"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = split_part(name, '/', 1))
  WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = split_part(name, '/', 1));

-- ═══════════════════════════════════════════════════════
-- 0015_jobs.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0015 — Jobs agendados (pg_cron -> edge functions via pg_net)
-- =============================================================================
-- É esta migration que torna verdadeiro o "funciona no automático".
--
-- No backend antigo a sincronização de calendário só rodava quando alguém abria
-- o app. O cliente que você quer — dono de 2-3 apartamentos que comprou para
-- esquecer — passa dias sem abrir. A reserva nova não virava tarefa, a
-- cancelada continuava na agenda da diarista, e a falha era silenciosa.
--
-- ANTES DE AGENDAR: preencha private.job_config (ver bloco no final).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

-- Configuração dos jobs. Fora de public: nem anon nem authenticated enxergam.
CREATE TABLE private.job_config (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  functions_url text NOT NULL,          -- https://<projeto>.supabase.co/functions/v1
  cron_secret   text NOT NULL,          -- mesmo valor de CRON_SECRET no .env
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.job_config ENABLE ROW LEVEL SECURITY;

-- Dispara uma edge function autenticada pelo segredo do cron.
CREATE OR REPLACE FUNCTION private.call_job(_path text, _body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, net
AS $$
DECLARE
  _cfg private.job_config%ROWTYPE;
BEGIN
  SELECT * INTO _cfg FROM private.job_config WHERE id = 1;

  IF NOT FOUND OR NOT _cfg.enabled THEN
    RAISE NOTICE 'job_config ausente ou desabilitado — job % ignorado', _path;
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url     := _cfg.functions_url || '/' || _path,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', _cfg.cron_secret
               ),
    body    := _body,
    timeout_milliseconds := 120000
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- Agendamentos
-- -----------------------------------------------------------------------------

-- Calendários: a cada 15 minutos. É o coração da promessa do produto.
SELECT cron.schedule(
  'sync-ical',
  '*/15 * * * *',
  $$ SELECT private.call_job('job-sync-ical'); $$
);

-- Fila de notificações (e-mail/WhatsApp): a cada minuto.
SELECT cron.schedule(
  'process-outbox',
  '* * * * *',
  $$ SELECT private.call_job('job-process-outbox'); $$
);

-- Rede de segurança da portaria: se algum gatilho falhou, o job varre
-- reservas confirmadas ainda não avisadas. A cada 10 minutos.
SELECT cron.schedule(
  'notify-condo-sweep',
  '*/10 * * * *',
  $$ SELECT private.call_job('job-notify-condo'); $$
);

-- Assinaturas: expira trial vencido, marca inadimplente. 06:00 BRT = 09:00 UTC.
SELECT cron.schedule(
  'subscription-sweep',
  '0 9 * * *',
  $$ SELECT private.call_job('job-subscription-sweep'); $$
);

-- Relatório mensal para o dono. Dia 1, 09:00 BRT = 12:00 UTC.
-- É o que torna visível um produto que, funcionando, é invisível.
SELECT cron.schedule(
  'monthly-report',
  '0 12 1 * *',
  $$ SELECT private.call_job('job-monthly-report'); $$
);

-- Higiene: sessões de hóspede e convites vencidos. 04:00 BRT = 07:00 UTC.
SELECT cron.schedule(
  'housekeeping',
  '0 7 * * *',
  $$
    DELETE FROM public.guest_sessions WHERE expires_at < now() - interval '30 days';
    UPDATE public.cleaner_invites SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now();
    DELETE FROM public.audit_log WHERE created_at < now() - interval '180 days';
    DELETE FROM public.notifications
      WHERE status = 'sent' AND created_at < now() - interval '90 days';
  $$
);

-- -----------------------------------------------------------------------------
-- PASSO MANUAL PÓS-DEPLOY
--
-- Rode uma vez, com os valores reais do projeto:
--
--   INSERT INTO private.job_config (id, functions_url, cron_secret)
--   VALUES (1,
--     'https://SEU_PROJETO.supabase.co/functions/v1',
--     'MESMO_VALOR_DO_CRON_SECRET_DO_ENV'
--   )
--   ON CONFLICT (id) DO UPDATE
--     SET functions_url = EXCLUDED.functions_url,
--         cron_secret   = EXCLUDED.cron_secret,
--         updated_at    = now();
--
-- Conferir agendamentos:  SELECT * FROM cron.job;
-- Conferir execuções:     SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
-- -----------------------------------------------------------------------------

-- ═══════════════════════════════════════════════════════
-- 0016_function_grants.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0016 — Fechamento de privilégios de execução (correção importante)
-- =============================================================================
-- No Postgres, toda função nasce com EXECUTE concedido a PUBLIC. Um
--     REVOKE EXECUTE ON FUNCTION f FROM anon, authenticated;
-- NÃO remove o acesso, porque esses papéis continuam herdando o privilégio de
-- PUBLIC. As migrations anteriores usaram essa forma; esta corrige o padrão de
-- verdade:
--
--     REVOKE ... FROM PUBLIC  ->  depois GRANT explícito a quem precisa.
--
-- Sem isto, funções SECURITY DEFINER como resolve_guest_session() e
-- enqueue_notification() ficariam chamáveis por qualquer cliente anônimo com a
-- chave pública. O token de sessão do hóspede tem 32 bytes aleatórios (não é
-- adivinhável), mas "difícil de adivinhar" não é controle de acesso.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Somente service_role (edge functions e jobs). Ninguém mais.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
  internal_only text[] := ARRAY[
    'public.resolve_guest_session(text)',
    'public.accept_cleaner_invite(text, uuid)',
    'public.enqueue_notification(public.notification_channel, text, jsonb, text, text, uuid, text, text, text, text, timestamptz)',
    'public.claim_notifications(integer)',
    'public.fail_notification(uuid, text)',
    'public.generate_token(integer)',
    'public.hash_token(text)'
  ];
BEGIN
  FOREACH fn IN ARRAY internal_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Usuário logado (a própria função já filtra por auth.uid() ou is_admin()).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
  authed_only text[] := ARRAY[
    'public.has_role(uuid, public.app_role)',
    'public.is_admin()',
    'public.assert_admin()',
    'public.subscription_is_active(uuid)',
    'public.connected_user_ids(uuid)',
    'public.connected_profiles()',
    'public.plan_limit(uuid)',
    'public.my_activation()',
    'public.owner_month_summary(date, uuid)',
    'public.admin_kpis()',
    'public.admin_activation_funnel()',
    'public.admin_system_health()',
    'public.admin_timeseries(integer)',
    'public.admin_subscriber_detail(uuid)',
    'public.admin_subscribers(text, public.subscription_status, public.plan_tier, boolean, text, integer, integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY authed_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Público de propósito: o hóspede consulta o código de indicação antes de ter
-- conta. Devolve só id e primeiro nome — nunca a linha do perfil.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.lookup_referral(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_referral(text) TO anon, authenticated, service_role;

-- Helpers puros usados dentro de views e policies: leitura inofensiva.
REVOKE ALL ON FUNCTION public.app_today() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_tz() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_now() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_setting(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_today() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_tz() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_now() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_setting(text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- Esquema private (config dos jobs) — inacessível fora do service_role.
-- -----------------------------------------------------------------------------
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.call_job(text, jsonb) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Tabelas de configuração: leitura só por quem precisa.
-- app_settings e audit_log têm RLS ligada e nenhuma policy permissiva, então já
-- estão fechadas para anon/authenticated — mas revogamos o privilégio de tabela
-- também, para não depender só da RLS.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.app_settings FROM anon, authenticated;
REVOKE ALL ON public.audit_log FROM anon;

-- Admin lê a auditoria pelo painel.
CREATE POLICY "audit_log: admin lê"
  ON public.audit_log FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT ON public.audit_log TO authenticated;

-- -----------------------------------------------------------------------------
-- Defaults para funções criadas depois desta migration: nascem fechadas.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMENT ON SCHEMA private IS
  'Configuração operacional (segredo do cron, URL das functions). Fora do PostgREST.';

-- ═══════════════════════════════════════════════════════
-- 0017_porter_job.sql
-- ═══════════════════════════════════════════════════════
-- =============================================================================
-- 0017 — Job da portaria digital
-- =============================================================================
-- A fila de porter_registrations é preenchida pelo guest-register; este job a
-- consome e chama a API da Kiper.
--
-- A cada 5 minutos: o hóspede acabou de se cadastrar e vai chegar no prédio.
-- Esperar 15 minutos seria tempo demais.
-- =============================================================================

SELECT cron.schedule(
  'porter-sync',
  '*/5 * * * *',
  $$ SELECT private.call_job('job-porter-sync'); $$
);

-- Índice para a varredura da fila: pendentes, mais antigos primeiro, sem
-- varrer o histórico inteiro de cadastros já processados.
CREATE INDEX IF NOT EXISTS idx_porter_reg_queue
  ON public.porter_registrations (created_at)
  WHERE status = 'pending';
