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
