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
