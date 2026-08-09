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
