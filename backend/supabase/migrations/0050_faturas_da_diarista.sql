-- Faturas mensais entre o anfitrião e a diarista.
--
-- Hoje o acerto acontece fora do produto: ele soma as limpezas de cabeça, ela
-- confere pela agenda, e o comprovante do Pix mora no WhatsApp de alguém. Isso
-- funciona até o mês em que os dois lembram números diferentes — e aí não há
-- nada para conferir, porque nunca existiu um documento.
--
-- A fatura é esse documento: fecha sozinha no dia combinado, com o que foi
-- feito, e guarda o comprovante do pagamento onde os dois conseguem ver.

BEGIN;

-- ---------------------------------------------------------------- combinado
-- O dia de fechamento é do PAR (anfitrião, diarista), e não do imóvel.
--
-- Quem tem três apartamentos com a mesma diarista paga uma pessoa, não três
-- contratos. Guardar o dia no imóvel produziria três faturas para o mesmo
-- acerto — e a conversa "quanto eu te devo esse mês" voltaria a ser feita de
-- cabeça, somando as três.
CREATE TABLE IF NOT EXISTS public.cleaner_billing (
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Até 28, e não até 31, porque fevereiro não tem dia 30: um fechamento
  -- marcado para 31 simplesmente nunca chegaria em quatro meses do ano, e o
  -- sintoma seria "a fatura não fechou" sem nada no log para explicar.
  closing_day smallint NOT NULL DEFAULT 5 CHECK (closing_day BETWEEN 1 AND 28),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, cleaner_id)
);

-- ------------------------------------------------------------------ fatura
DO $$ BEGIN
  CREATE TYPE public.fatura_status AS ENUM ('fechada', 'paga', 'cancelada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.cleaner_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  periodo_inicio   date NOT NULL,
  periodo_fim      date NOT NULL,
  status           public.fatura_status NOT NULL DEFAULT 'fechada',
  total            numeric(12,2) NOT NULL DEFAULT 0,
  fechada_em       timestamptz NOT NULL DEFAULT now(),
  paga_em          timestamptz,
  comprovante_path text,
  observacao       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT periodo_coerente CHECK (periodo_fim >= periodo_inicio)
);

CREATE INDEX IF NOT EXISTS cleaner_invoices_dono ON public.cleaner_invoices (owner_id, fechada_em DESC);
CREATE INDEX IF NOT EXISTS cleaner_invoices_diarista ON public.cleaner_invoices (cleaner_id, fechada_em DESC);

-- ------------------------------------------------------------------- itens
-- Cópia, não referência.
--
-- O valor da limpeza muda: o combinado é renegociado, o imóvel é renomeado, a
-- tarefa é corrigida. Uma fatura que lê os preços de hoje mudaria de total
-- sozinha, e a fatura de março passaria a mostrar o preço de junho. Um acerto
-- fechado precisa ficar parado.
CREATE TABLE IF NOT EXISTS public.cleaner_invoice_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES public.cleaner_invoices(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('limpeza', 'insumos', 'extra')),
  descricao    text NOT NULL,
  data         date,
  property_id  uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  valor        numeric(12,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cleaner_invoice_items_fatura ON public.cleaner_invoice_items (invoice_id);

-- ------------------------------------------------------- marca de cobrança
-- O que impede a mesma limpeza de entrar em duas faturas.
--
-- Sem esta coluna, o fechamento teria de deduzir o que já foi cobrado a partir
-- das datas das faturas anteriores — e qualquer buraco nessa conta cobra duas
-- vezes ou não cobra nunca. Com ela, a regra é uma linha: entra o que ainda
-- não tem fatura.
ALTER TABLE public.cleaning_tasks
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.cleaner_invoices(id) ON DELETE SET NULL;

ALTER TABLE public.cleaner_fees
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.cleaner_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cleaning_tasks_sem_fatura
  ON public.cleaning_tasks (cleaner_id, completed_at) WHERE invoice_id IS NULL;

CREATE INDEX IF NOT EXISTS cleaner_fees_sem_fatura
  ON public.cleaner_fees (cleaner_id, reference_month) WHERE invoice_id IS NULL;

COMMIT;
