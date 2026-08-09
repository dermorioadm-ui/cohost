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
