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
