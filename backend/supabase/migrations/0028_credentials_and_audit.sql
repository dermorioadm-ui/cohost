-- =============================================================================
-- 0028 — Credenciais do Airbnb (por conta) + audit_log + listing_id no iCal
-- =============================================================================
-- Credencial do host para acesso à sua própria conta Airbnb. Criptografada com
-- pgcrypto; NUNCA em plaintext. A chave identifica o DONO, não o imóvel: vazou,
-- expõe os imóveis daquele dono e de mais ninguém. Por isso é por conta.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  login             text NOT NULL,
  -- Chave que o agente (worker no PC) usa no header x-agent-key. Identifica o
  -- DONO, não o imóvel. Gerada por owner; vazou, expõe só os imóveis dele.
  agent_key         text UNIQUE NOT NULL,
  -- Guardado criptografado. A leitura é feita por get_credentials_for_owner(),
  -- que LOGA em audit_log. Nunca chega em plaintext a lugares não autorizados.
  password_encrypted  text NOT NULL,
  totp_seed_encrypted text,            -- opcional; semente TOTP se 2FA por app

  status            text NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'ativo', 'falhou')),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_credentials_owner ON public.credentials (owner_id);

ALTER TABLE public.credentials ENABLE ROW LEVEL SECURITY;

-- Só o dono acessa as próprias credenciais. Ninguém mais (nem admin por RLS
-- padrão) — admin, se precisar, usa SECURITY DEFINER explícito.
CREATE POLICY "credentials: dono gerencia"
  ON public.credentials FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- audit_log: toda leitura de credencial e toda ação sensível vira linha aqui.
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       text,                   -- 'agent' | auth.uid() | 'system'
  action      text NOT NULL,          -- ex: 'credentials:read'
  target      text,                   -- ex: owner_id
  owner_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_owner ON public.audit_log (owner_id, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log: dono le suas linhas"
  ON public.audit_log FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Função que devolve a credencial descriptografada E registra a leitura.
-- Usada pelo endpoint airbnb-agent (action=credentials). SECURITY DEFINER
-- porque precisa ler a tabela mesmo com RLS restrita e escrever em audit_log.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_credentials_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec      public.credentials%ROWTYPE;
  out_json jsonb;
BEGIN
  SELECT * INTO rec
  FROM public.credentials
  WHERE owner_id = p_owner
  ORDER BY updated_at DESC
  LIMIT 1;

  -- Registra a leitura independente de ter encontrado ou não.
  INSERT INTO public.audit_log (actor, action, target, owner_id)
  VALUES ('agent', 'credentials:read', p_owner::text, p_owner);

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  out_json := jsonb_build_object(
    'login', rec.login,
    'password', pgp_sym_decrypt(rec.password_encrypted::bytea, current_setting('app.encryption_key')),
    'totp_seed', CASE WHEN rec.totp_seed_encrypted IS NOT NULL
                  THEN pgp_sym_decrypt(rec.totp_seed_encrypted::bytea, current_setting('app.encryption_key'))
                  ELSE NULL END,
    'status', rec.status
  );
  RETURN out_json;
END;
$$;

REVOKE ALL ON FUNCTION public.get_credentials_for_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_credentials_for_owner(uuid) TO authenticated;

-- Resolve o owner a partir da agent_key (header x-agent-key). SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.resolve_owner_by_agent_key(p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT owner_id FROM public.credentials WHERE agent_key = p_key LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_owner_by_agent_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_owner_by_agent_key(text) TO authenticated;

-- Helper: criptografar ao inserir/atualizar (usado pelo backend, não pelo agente).
CREATE OR REPLACE FUNCTION public.encrypt_credential(p_secret text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN pgp_sym_encrypt(p_secret, current_setting('app.encryption_key'))::text;
END;
$$;

REVOKE ALL ON FUNCTION public.encrypt_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.encrypt_credential(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- listing_id: extraído do url do iCal do Airbnb (não digitado pelo dono).
-- Padrões: .../ical/<ID>.ics  |  .../calendar/ical/<ID>.ics
-- ---------------------------------------------------------------------------
ALTER TABLE public.property_ical_sources
  ADD COLUMN IF NOT EXISTS listing_id text;

CREATE INDEX IF NOT EXISTS idx_ical_sources_listing
  ON public.property_ical_sources (listing_id) WHERE listing_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.extract_listing_id(u text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  m text;
BEGIN
  IF u IS NULL THEN RETURN NULL; END IF;
  -- pega o último segmento .ics e extrai a parte antes da extensão
  m := (regexp_matches(u, '/ical/([0-9]+)\.ics'))[1];
  IF m IS NOT NULL THEN RETURN m; END IF;
  m := (regexp_matches(u, 'ical/([0-9A-Za-z_]+)\.ics'))[1];
  IF m IS NOT NULL THEN RETURN m; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_set_listing_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.listing_id := public.extract_listing_id(NEW.url);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ical_sources_listing_id ON public.property_ical_sources;
CREATE TRIGGER trg_ical_sources_listing_id
  BEFORE INSERT OR UPDATE OF url ON public.property_ical_sources
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_listing_id();
