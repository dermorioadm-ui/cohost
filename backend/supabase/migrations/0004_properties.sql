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
