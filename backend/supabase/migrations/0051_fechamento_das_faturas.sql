-- Quem enxerga a fatura, quem a fecha e quem a marca como paga.

BEGIN;

ALTER TABLE public.cleaner_billing       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaner_invoices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaner_invoice_items ENABLE ROW LEVEL SECURITY;

-- O combinado é do anfitrião: é ele quem escolhe o dia. A diarista lê, porque
-- saber quando fecha é metade da informação — sem isso ela não sabe se a
-- limpeza de ontem entra neste mês ou no próximo.
CREATE POLICY billing_dono ON public.cleaner_billing
  FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

CREATE POLICY billing_diarista_le ON public.cleaner_billing
  FOR SELECT TO authenticated USING (cleaner_id = auth.uid() OR public.is_admin());

-- A fatura é dos DOIS. Só de leitura pelos dois lados: fechar e marcar como
-- paga passam por função, porque são transições de estado com efeito colateral
-- (marcar as limpezas como cobradas, gravar o comprovante) e um UPDATE solto
-- deixaria os dois lados fora de sincronia.
CREATE POLICY faturas_partes_leem ON public.cleaner_invoices
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR cleaner_id = auth.uid() OR public.is_admin());

CREATE POLICY itens_partes_leem ON public.cleaner_invoice_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.cleaner_invoices f
     WHERE f.id = cleaner_invoice_items.invoice_id
       AND (f.owner_id = auth.uid() OR f.cleaner_id = auth.uid() OR public.is_admin())
  ));

-- ------------------------------------------------------------- fechamento
--
-- A regra do que entra é uma frase: tudo o que ainda não foi cobrado até o dia
-- do fechamento. Não há aritmética de datas para acertar, e por isso não há
-- buraco possível entre uma fatura e a seguinte — se uma limpeza foi lançada
-- com atraso, ela entra na próxima em vez de sumir.
CREATE OR REPLACE FUNCTION public.fechar_fatura_diarista(
  _owner_id   uuid,
  _cleaner_id uuid,
  _ate        date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _fim     date := COALESCE(_ate, public.app_today());
  _mes     date := date_trunc('month', COALESCE(_ate, public.app_today()))::date;
  _fatura  uuid;
  _inicio  date;
  _total   numeric(12,2);
BEGIN
  INSERT INTO public.cleaner_invoices (owner_id, cleaner_id, periodo_inicio, periodo_fim, total)
  VALUES (_owner_id, _cleaner_id, _fim, _fim, 0)
  RETURNING id INTO _fatura;

  -- Limpezas concluídas e ainda não cobradas.
  WITH pegas AS (
    UPDATE public.cleaning_tasks t
       SET invoice_id = _fatura
      FROM public.properties p
     WHERE p.id = t.property_id
       AND p.owner_id = _owner_id
       AND t.cleaner_id = _cleaner_id
       AND t.status = 'completed'
       AND t.invoice_id IS NULL
       AND t.checkout_date <= _fim
    RETURNING t.checkout_date, t.property_id, p.name AS imovel, t.turnover_price
  )
  INSERT INTO public.cleaner_invoice_items (invoice_id, kind, descricao, data, property_id, valor)
  SELECT _fatura, 'limpeza', 'Limpeza — ' || imovel, checkout_date, property_id,
         COALESCE(turnover_price, 0)
    FROM pegas;

  -- Extras já aprovados pelo anfitrião. Os pendentes ficam de fora de
  -- propósito: cobrar o que ele ainda não aprovou transformaria a fatura numa
  -- discussão em vez de um fechamento.
  WITH pegos AS (
    UPDATE public.cleaner_fees f
       SET invoice_id = _fatura
     WHERE f.owner_id = _owner_id
       AND f.cleaner_id = _cleaner_id
       AND f.status = 'approved'
       AND f.invoice_id IS NULL
    RETURNING f.description, f.reference_month, f.property_id, f.amount
  )
  INSERT INTO public.cleaner_invoice_items (invoice_id, kind, descricao, data, property_id, valor)
  SELECT _fatura, 'extra', COALESCE(NULLIF(description, ''), 'Reembolso'),
         reference_month, property_id, COALESCE(amount, 0)
    FROM pegos;

  -- Reposição de insumos: valor fixo do mês, uma linha por imóvel com o
  -- combinado aceito.
  --
  -- Diferente das limpezas, isto não nasce de um evento que se possa marcar
  -- como cobrado — é assinatura mensal. A primeira versão confiava em "fecha
  -- uma vez por mês" e cobrava em dobro assim que alguém usasse o "Fechar
  -- agora" depois do fechamento automático. O `NOT EXISTS` abaixo é a marca de
  -- cobrança que faltava: se já existe linha de insumos daquele imóvel no mês,
  -- não entra outra.
  INSERT INTO public.cleaner_invoice_items (invoice_id, kind, descricao, data, property_id, valor)
  SELECT _fatura, 'insumos', 'Reposição de insumos — ' || p.name, _mes, p.id, a.supplies_monthly_price
    FROM public.cleaner_agreements a
    JOIN public.properties p ON p.id = a.property_id
   WHERE a.owner_id = _owner_id
     AND a.cleaner_id = _cleaner_id
     AND a.status = 'accepted'
     AND COALESCE(a.supplies_enabled, false)
     AND COALESCE(a.supplies_monthly_price, 0) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.cleaner_invoice_items i
         JOIN public.cleaner_invoices f2 ON f2.id = i.invoice_id
        WHERE f2.owner_id = _owner_id
          AND f2.cleaner_id = _cleaner_id
          AND f2.status <> 'cancelada'
          AND i.kind = 'insumos'
          AND i.property_id = p.id
          AND i.data = _mes
     );

  SELECT COALESCE(SUM(valor), 0), MIN(COALESCE(data, _fim))
    INTO _total, _inicio
    FROM public.cleaner_invoice_items WHERE invoice_id = _fatura;

  -- Mês sem nada feito não vira fatura de R$ 0,00. Uma cobrança vazia chegando
  -- todo mês ensina os dois lados a ignorar o aviso — inclusive nos meses em
  -- que ele importa.
  IF _total <= 0 THEN
    DELETE FROM public.cleaner_invoices WHERE id = _fatura;
    RETURN NULL;
  END IF;

  UPDATE public.cleaner_invoices
     SET total = _total, periodo_inicio = LEAST(_inicio, _fim)
   WHERE id = _fatura;

  RETURN _fatura;
END $$;

REVOKE ALL ON FUNCTION public.fechar_fatura_diarista(uuid, uuid, date) FROM PUBLIC, anon, authenticated;

-- Varredura diária. Fecha o que tem o dia de hoje marcado como fechamento.
CREATE OR REPLACE FUNCTION public.fechar_faturas_do_dia() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _hoje  date := public.app_today();
  _par   record;
  _feitas integer := 0;
BEGIN
  FOR _par IN
    SELECT owner_id, cleaner_id FROM public.cleaner_billing
     WHERE closing_day = EXTRACT(DAY FROM _hoje)::int
  LOOP
    IF public.fechar_fatura_diarista(_par.owner_id, _par.cleaner_id, _hoje) IS NOT NULL THEN
      _feitas := _feitas + 1;
    END IF;
  END LOOP;
  RETURN _feitas;
END $$;

REVOKE ALL ON FUNCTION public.fechar_faturas_do_dia() FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------- ações do dono
-- Fechar agora, sem esperar o dia. Serve para o mês em que a diarista sai, e
-- para o anfitrião conferir o formato antes de confiar no automático.
CREATE OR REPLACE FUNCTION public.fechar_fatura_agora(_cleaner_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.fechar_fatura_diarista(auth.uid(), _cleaner_id, public.app_today());
END $$;

REVOKE ALL ON FUNCTION public.fechar_fatura_agora(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fechar_fatura_agora(uuid) TO authenticated;

-- Marcar como paga, com o comprovante.
--
-- O `owner_id = auth.uid()` está no WHERE e o efeito é conferido depois: quem
-- não é dono da fatura não altera linha nenhuma, e recebe a recusa em vez de
-- um "ok" silencioso sobre zero linhas.
CREATE OR REPLACE FUNCTION public.marcar_fatura_paga(
  _fatura uuid,
  _comprovante_path text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _n integer;
BEGIN
  UPDATE public.cleaner_invoices
     SET status = 'paga',
         paga_em = now(),
         comprovante_path = COALESCE(_comprovante_path, comprovante_path),
         updated_at = now()
   WHERE id = _fatura AND owner_id = auth.uid() AND status <> 'cancelada';

  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n = 0 THEN
    RAISE EXCEPTION 'Fatura não encontrada' USING ERRCODE = '42501';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.marcar_fatura_paga(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_fatura_paga(uuid, text) TO authenticated;

COMMIT;
