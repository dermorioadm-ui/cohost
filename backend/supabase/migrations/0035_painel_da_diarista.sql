-- =============================================================================
-- 0035 — Painel da diarista: calendário, acordo e ganhos
-- =============================================================================
-- Três coisas que a diarista não tinha e o dono precisava que ela tivesse:
--
--   1. O CALENDÁRIO do imóvel. Ela só via a lista de saídas; não via o mês.
--      Sem o mês, não dá para planejar a semana nem entender por que um dia
--      tem duas limpezas.
--   2. O ACEITE do que foi combinado. Hoje o dono digita o valor da limpeza e
--      o valor da reposição, e a diarista descobre quanto vai receber quando o
--      dinheiro cai — ou não cai. O combinado existia só na conversa.
--   3. Os GANHOS. Ela fecha o mês somando na cabeça.
--
-- A 0022 tirou `reservations` da vista dela de propósito: "quem se hospeda e
-- por quanto tempo é informação do dono". Este arquivo NÃO desfaz aquilo. O
-- calendário que ela ganha aqui devolve ocupação e canal — as datas e se veio
-- do Airbnb ou do Booking — e nada mais. `guest_label`, `reservation_url` e
-- `raw` continuam fora do alcance dela, que é exatamente o que a 0022 protegia.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Calendário da diarista — ocupação sem identidade do hóspede
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_cleaning_calendar(_from date, _to date)
RETURNS TABLE (
  id            uuid,
  property_id   uuid,
  provider      public.ical_provider,
  checkin_date  date,
  checkout_date date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.property_id, r.provider, r.checkin_date, r.checkout_date
  FROM public.reservations r
  JOIN public.properties p ON p.id = r.property_id
  WHERE p.cleaner_id = auth.uid()
    AND p.archived_at IS NULL
    AND r.status = 'confirmed'
    -- Reserva que ENCOSTA na janela, não só a que começa nela: uma estadia
    -- que atravessa a virada do mês precisa aparecer nos dois meses.
    AND r.checkin_date  <= _to
    AND r.checkout_date >= _from;
$$;

REVOKE ALL ON FUNCTION public.my_cleaning_calendar(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_cleaning_calendar(date, date) TO authenticated;

COMMENT ON FUNCTION public.my_cleaning_calendar(date, date) IS
  'Ocupação dos imóveis da diarista logada: datas e canal, sem guest_label, '
  'reservation_url ou raw. Nunca acrescente coluna de identidade do hóspede '
  'aqui — é o limite que a 0022 estabeleceu.';

-- -----------------------------------------------------------------------------
-- 2. O combinado vira acordo com aceite
-- -----------------------------------------------------------------------------
-- Uma linha por (imóvel, diarista): é o combinado VIGENTE, não um histórico.
-- Quando o dono muda um dos valores, a linha volta para `pending` e ela aceita
-- de novo — porque o que ela aceitou foi aquele número, não o campo.
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.agreement_status AS ENUM ('pending', 'accepted', 'declined');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.cleaner_agreements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  owner_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  turnover_price         numeric(10,2) NOT NULL DEFAULT 0 CHECK (turnover_price >= 0),
  supplies_enabled       boolean       NOT NULL DEFAULT false,
  supplies_monthly_price numeric(10,2) NOT NULL DEFAULT 0 CHECK (supplies_monthly_price >= 0),

  status                 public.agreement_status NOT NULL DEFAULT 'pending',
  decided_at             timestamptz,
  decline_note           text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  UNIQUE (property_id, cleaner_id)
);

CREATE INDEX IF NOT EXISTS idx_agreements_cleaner
  ON public.cleaner_agreements (cleaner_id, status);
CREATE INDEX IF NOT EXISTS idx_agreements_owner
  ON public.cleaner_agreements (owner_id);

DROP TRIGGER IF EXISTS trg_cleaner_agreements_updated_at ON public.cleaner_agreements;
CREATE TRIGGER trg_cleaner_agreements_updated_at
  BEFORE UPDATE ON public.cleaner_agreements
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.cleaner_agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agreements: diarista lê os dela" ON public.cleaner_agreements;
CREATE POLICY "agreements: diarista lê os dela"
  ON public.cleaner_agreements FOR SELECT TO authenticated
  USING (cleaner_id = auth.uid());

DROP POLICY IF EXISTS "agreements: diarista responde os dela" ON public.cleaner_agreements;
CREATE POLICY "agreements: diarista responde os dela"
  ON public.cleaner_agreements FOR UPDATE TO authenticated
  USING (cleaner_id = auth.uid())
  WITH CHECK (cleaner_id = auth.uid());

DROP POLICY IF EXISTS "agreements: dono lê os seus" ON public.cleaner_agreements;
CREATE POLICY "agreements: dono lê os seus"
  ON public.cleaner_agreements FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "agreements: admin lê tudo" ON public.cleaner_agreements;
CREATE POLICY "agreements: admin lê tudo"
  ON public.cleaner_agreements FOR SELECT TO authenticated
  USING (public.is_admin());

-- Sem policy de INSERT para ninguém: a proposta nasce do gatilho abaixo, a
-- partir do imóvel. Diarista propondo o próprio salário não é o produto.

-- -----------------------------------------------------------------------------
-- A diarista responde — e responde só o que é dela responder.
--
-- Sem isto, a policy de UPDATE deixaria ela reescrever o próprio valor de
-- diária e depois marcar como aceito. É a mesma armadilha que a 0006 fechou
-- em cleaning_tasks, e pelo mesmo motivo: RLS autoriza a LINHA, não a COLUNA.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_cleaner_agreements_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() THEN
    RETURN NEW;                                   -- service_role / admin
  END IF;

  IF NEW.owner_id = auth.uid() THEN
    RETURN NEW;                                   -- o dono propõe
  END IF;

  -- Daqui pra baixo: é a diarista.
  NEW.property_id            := OLD.property_id;
  NEW.owner_id               := OLD.owner_id;
  NEW.cleaner_id             := OLD.cleaner_id;
  NEW.turnover_price         := OLD.turnover_price;
  NEW.supplies_enabled       := OLD.supplies_enabled;
  NEW.supplies_monthly_price := OLD.supplies_monthly_price;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.decided_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleaner_agreements_guard ON public.cleaner_agreements;
CREATE TRIGGER trg_cleaner_agreements_guard
  BEFORE UPDATE ON public.cleaner_agreements
  FOR EACH ROW EXECUTE FUNCTION public.tg_cleaner_agreements_guard();

-- -----------------------------------------------------------------------------
-- O imóvel propõe. Vincular diarista, mudar o valor da limpeza ou mexer na
-- reposição gera (ou reabre) a proposta.
--
-- Mudança que não altera nenhum dos três números NÃO reabre o aceite: pedir
-- de novo por causa de uma troca de bairro treina a diarista a apertar
-- "aceito" sem ler, e aí o aceite não vale nada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_property_proposes_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Diarista trocada (ou removida): a proposta da anterior não vale mais.
  -- É o combinado vigente; guardar o de quem saiu só confundiria as duas telas.
  DELETE FROM public.cleaner_agreements
  WHERE property_id = NEW.id
    AND cleaner_id IS DISTINCT FROM NEW.cleaner_id;

  IF NEW.cleaner_id IS NULL OR NEW.self_clean OR NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.cleaner_agreements (
    property_id, owner_id, cleaner_id,
    turnover_price, supplies_enabled, supplies_monthly_price
  ) VALUES (
    NEW.id, NEW.owner_id, NEW.cleaner_id,
    NEW.turnover_price, NEW.supplies_enabled, NEW.supplies_monthly_price
  )
  ON CONFLICT (property_id, cleaner_id) DO UPDATE
  SET turnover_price         = EXCLUDED.turnover_price,
      supplies_enabled       = EXCLUDED.supplies_enabled,
      supplies_monthly_price = EXCLUDED.supplies_monthly_price,
      status                 = 'pending',
      decided_at             = NULL,
      decline_note           = NULL,
      updated_at             = now()
  WHERE cleaner_agreements.turnover_price         IS DISTINCT FROM EXCLUDED.turnover_price
     OR cleaner_agreements.supplies_enabled       IS DISTINCT FROM EXCLUDED.supplies_enabled
     OR cleaner_agreements.supplies_monthly_price IS DISTINCT FROM EXCLUDED.supplies_monthly_price;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_proposes_agreement ON public.properties;
CREATE TRIGGER trg_property_proposes_agreement
  AFTER INSERT OR UPDATE OF cleaner_id, self_clean, turnover_price,
                            supplies_enabled, supplies_monthly_price, archived_at
  ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_property_proposes_agreement();

-- Imóveis que já têm diarista vinculada nascem com a proposta pendente —
-- senão a tela de aprovações abre vazia para quem já está trabalhando.
INSERT INTO public.cleaner_agreements (
  property_id, owner_id, cleaner_id,
  turnover_price, supplies_enabled, supplies_monthly_price
)
SELECT p.id, p.owner_id, p.cleaner_id,
       p.turnover_price, p.supplies_enabled, p.supplies_monthly_price
FROM public.properties p
WHERE p.cleaner_id IS NOT NULL
  AND NOT p.self_clean
  AND p.archived_at IS NULL
ON CONFLICT (property_id, cleaner_id) DO NOTHING;

COMMENT ON TABLE public.cleaner_agreements IS
  'Combinado VIGENTE entre dono e diarista por imóvel: quanto por limpeza e '
  'quanto por mês de reposição. Nasce do gatilho em properties; a diarista só '
  'pode mexer em status e decline_note.';

-- -----------------------------------------------------------------------------
-- 3. Ganhos — o mês fechado, sem ela somar na cabeça
-- -----------------------------------------------------------------------------
-- Três parcelas, e a diferença entre elas importa na tela:
--   diárias  — limpeza concluída, uma a uma
--   reposição— valor fixo do mês, só dos imóveis onde ela ACEITOU o combinado
--   compras  — reembolso do que ela adiantou, só o que o dono aprovou
--
-- A reposição conta o mês inteiro assim que aceita: é acerto fechado, não
-- proporcional ao número de limpezas — foi assim que a 0034 definiu.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_cleaning_earnings(_month date)
RETURNS TABLE (
  reference_month  date,
  cleanings_done   int,
  cleanings_total  numeric,
  supplies_total   numeric,
  fees_approved    numeric,
  fees_pending     numeric,
  total            numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT date_trunc('month', _month)::date AS ini,
           (date_trunc('month', _month) + interval '1 month - 1 day')::date AS fim
  ),
  limpezas AS (
    SELECT count(*)::int AS qtd, coalesce(sum(t.turnover_price), 0) AS valor
    FROM public.cleaning_tasks t, bounds b
    WHERE t.cleaner_id = auth.uid()
      AND t.status = 'completed'
      AND t.checkout_date BETWEEN b.ini AND b.fim
  ),
  reposicao AS (
    SELECT coalesce(sum(a.supplies_monthly_price), 0) AS valor
    FROM public.cleaner_agreements a
    WHERE a.cleaner_id = auth.uid()
      AND a.status = 'accepted'
      AND a.supplies_enabled
  ),
  compras AS (
    SELECT
      coalesce(sum(f.amount) FILTER (WHERE f.status = 'approved'), 0) AS aprovadas,
      coalesce(sum(f.amount) FILTER (WHERE f.status = 'pending'),  0) AS pendentes
    FROM public.cleaner_fees f, bounds b
    WHERE f.cleaner_id = auth.uid()
      AND f.reference_month = b.ini
  )
  SELECT b.ini, l.qtd, l.valor, r.valor, c.aprovadas, c.pendentes,
         l.valor + r.valor + c.aprovadas
  FROM bounds b, limpezas l, reposicao r, compras c;
$$;

REVOKE ALL ON FUNCTION public.my_cleaning_earnings(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_cleaning_earnings(date) TO authenticated;

COMMENT ON FUNCTION public.my_cleaning_earnings(date) IS
  'Fechamento do mês da diarista logada: diárias concluídas, reposição dos '
  'combinados aceitos e compras aprovadas. Compra pendente aparece à parte — '
  'não entra no total porque ainda pode ser recusada.';

-- -----------------------------------------------------------------------------
-- 4. Fechar os EXECUTE que o Postgres concede sozinho
-- -----------------------------------------------------------------------------
-- `REVOKE ... FROM PUBLIC` não basta: o projeto tem DEFAULT PRIVILEGES que dão
-- EXECUTE a `anon` e `authenticated` em toda função nova de `public`. Como
-- toda função aqui é SECURITY DEFINER, isso deixa cada uma exposta em
-- /rest/v1/rpc para visitante não logado — é o mesmo aviso que a 0027 já tinha
-- limpado uma vez.
--
-- Na prática o `anon` não leria nada (auth.uid() é NULL e o WHERE não casa com
-- ninguém), mas depender do filtro para compensar uma permissão indevida é
-- exatamente a aposta que a 0022 desfez. Aqui a permissão some.
REVOKE EXECUTE ON FUNCTION public.my_cleaning_calendar(date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.my_cleaning_earnings(date)       FROM anon;

-- Função de gatilho não é endpoint. Chamada direta por RPC nem funcionaria
-- (não existe NEW/OLD fora do gatilho), mas ela não tem por que estar listada.
REVOKE EXECUTE ON FUNCTION public.tg_cleaner_agreements_guard()   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_property_proposes_agreement() FROM PUBLIC, anon, authenticated;
