-- =============================================================================
-- 0029 — Fila pull do agente (hermes_jobs) + log de mensagens (hermes_messages)
-- =============================================================================
-- A VPS/PC do operador fica SÓ DE SAÍDA. O agente PUXA jobs da fila (next-jobs)
-- e confirma (finish-job). Nada de push direto: se o PC cai, o job continua na
-- fila e é entregue ao voltar. Retentativa e visibilidade saem de graça.
-- =============================================================================

CREATE TYPE public.hermes_event AS ENUM (
  'mensagem_recebida', 'reserva_nova', 'limpeza_concluida', 'checkout_amanha'
);
CREATE TYPE public.hermes_job_status AS ENUM ('pendente', 'processado', 'falhou');

CREATE TABLE public.hermes_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- listing_id do imóvel (pode ser NULL no INSERT inicial; o gatilho preenche
  -- quando derivável de property_id).
  property_id  text,
  event_type   public.hermes_event NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       public.hermes_job_status NOT NULL DEFAULT 'pendente',
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX idx_hermes_jobs_pending
  ON public.hermes_jobs (owner_id, status, created_at)
  WHERE status = 'pendente';
CREATE INDEX idx_hermes_jobs_listing
  ON public.hermes_jobs (property_id) WHERE property_id IS NOT NULL;

ALTER TABLE public.hermes_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hermes_jobs: dono acessa os seus"
  ON public.hermes_jobs FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- hermes_messages: toda resposta do agente gravada para aparecer no painel.
-- ---------------------------------------------------------------------------
CREATE TABLE public.hermes_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id    text,
  guest_message  text,
  agent_reply    text,
  channel        text NOT NULL DEFAULT 'airbnb',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hermes_messages_owner
  ON public.hermes_messages (owner_id, created_at DESC);

ALTER TABLE public.hermes_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hermes_messages: dono le as suas"
  ON public.hermes_messages FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

GRANT INSERT ON public.hermes_messages TO authenticated;

-- ---------------------------------------------------------------------------
-- Gatilhos que ENCHEM a fila. Quem dispara é evento do nosso lado (reserva,
-- limpeza) — exatamente onde push faz sentido. O agente puxa depois.
-- ---------------------------------------------------------------------------

-- Reserva nova -> avisar boas-vindas / preparar contexto
CREATE OR REPLACE FUNCTION public.tg_enqueue_reserva_nova()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_listing text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'confirmed' THEN
    SELECT listing_id INTO v_listing
    FROM public.property_ical_sources
    WHERE property_id = NEW.property_id
    ORDER BY updated_at DESC LIMIT 1;

    INSERT INTO public.hermes_jobs (owner_id, property_id, event_type, payload)
    SELECT p.owner_id, v_listing, 'reserva_nova',
           jsonb_build_object(
             'reservation_id', NEW.id,
             'property_id', NEW.property_id,
             'checkin_date', NEW.checkin_date,
             'checkout_date', NEW.checkout_date
           )
    FROM public.properties p
    WHERE p.id = NEW.property_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_reserva_nova ON public.reservations;
CREATE TRIGGER trg_enqueue_reserva_nova
  AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_enqueue_reserva_nova();

-- Limpeza concluída -> avisar que o imóvel está pronto
CREATE OR REPLACE FUNCTION public.tg_enqueue_limpeza_concluida()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_listing text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'completed' AND NEW.status = 'completed' THEN
    SELECT listing_id INTO v_listing
    FROM public.property_ical_sources
    WHERE property_id = NEW.property_id
    ORDER BY updated_at DESC LIMIT 1;

    INSERT INTO public.hermes_jobs (owner_id, property_id, event_type, payload)
    SELECT p.owner_id, v_listing, 'limpeza_concluida',
           jsonb_build_object('cleaning_task_id', NEW.id, 'property_id', NEW.property_id)
    FROM public.properties p
    WHERE p.id = NEW.property_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_limpeza_concluida ON public.cleaning_tasks;
CREATE TRIGGER trg_enqueue_limpeza_concluida
  AFTER UPDATE ON public.cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_enqueue_limpeza_concluida();

-- checkout amanhã -> lembrete (varre diariamente; o pg_cron já existe no repo)
CREATE OR REPLACE FUNCTION public.enqueue_checkout_amanha()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT res.property_id, p.owner_id, p.id AS pid,
           (SELECT listing_id FROM public.property_ical_sources
            WHERE property_id = res.property_id ORDER BY updated_at DESC LIMIT 1) AS listing
    FROM public.reservations res
    JOIN public.properties p ON p.id = res.property_id
    WHERE res.status = 'confirmed'
      AND res.checkout_date = (current_date + interval '1 day')
  LOOP
    INSERT INTO public.hermes_jobs (owner_id, property_id, event_type, payload)
    VALUES (r.owner_id, r.listing, 'checkout_amanha',
            jsonb_build_object('property_id', r.pid, 'checkout_date', r.listing));
  END LOOP;
END;
$$;
