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
