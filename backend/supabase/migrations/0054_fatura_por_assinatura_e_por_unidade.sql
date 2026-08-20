-- Três correções na fatura, todas vindas da mesma pergunta: o que exatamente
-- está sendo cobrado?
--
-- 1) Só entra o checkout que ela ASSINOU. Antes bastava `status = completed`,
--    e completar não exige assinatura — havia caminho para a fatura cobrar uma
--    limpeza sem nenhuma declaração por trás. Agora a assinatura é o que
--    transforma o trabalho em linha de fatura, e o que não foi assinado fica
--    pendente para ela (ver `limpezas_pendentes_de_assinatura`).
--
-- 2) A taxa fixa de insumos conta uma vez por APARTAMENTO, não por anúncio.
--    Duplicar o imóvel cria outro anúncio do mesmo apartamento; com o acordo
--    replicado nos dois, a reposição do mesmo estoque era cobrada em dobro
--    todo mês. O `DISTINCT ON` agrupa pela unidade física.
--
-- 3) Os rótulos passam a dizer o que a linha é, em vez de repetir a categoria:
--    "Checkout assinado — <imóvel>", "Taxa fixa de insumos — <imóvel>",
--    "Compra por fora". A fatura é lida por duas pessoas que precisam
--    concordar sobre ela; nome vago é onde a discordância começa.

BEGIN;

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

  -- Checkouts assinados e ainda não cobrados.
  WITH pegas AS (
    UPDATE public.cleaning_tasks t
       SET invoice_id = _fatura
      FROM public.properties p
     WHERE p.id = t.property_id
       AND p.owner_id = _owner_id
       AND t.cleaner_id = _cleaner_id
       AND t.status = 'completed'
       AND t.assinatura_id IS NOT NULL
       AND t.invoice_id IS NULL
       AND t.checkout_date <= _fim
    RETURNING t.checkout_date, t.property_id, p.name AS imovel, t.turnover_price
  )
  INSERT INTO public.cleaner_invoice_items (invoice_id, kind, descricao, data, property_id, valor)
  SELECT _fatura, 'limpeza', 'Checkout assinado — ' || imovel, checkout_date, property_id,
         COALESCE(turnover_price, 0)
    FROM pegas;

  -- O que ela comprou por fora e o anfitrião já aprovou. Os pendentes ficam de
  -- fora: cobrar o que ele ainda não aprovou transforma a fatura numa
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
  SELECT _fatura, 'extra', COALESCE(NULLIF(description, ''), 'Compra por fora'),
         reference_month, property_id, COALESCE(amount, 0)
    FROM pegos;

  -- Taxa fixa: uma por apartamento por mês.
  --
  -- `DISTINCT ON` pela unidade física, e o `ORDER BY` escolhe o anúncio
  -- original quando existem dois — o nome que aparece na fatura é o que a
  -- pessoa reconhece, não o da cópia criada semana passada.
  INSERT INTO public.cleaner_invoice_items (invoice_id, kind, descricao, data, property_id, valor)
  SELECT DISTINCT ON (COALESCE(p.parent_property_id, p.id))
         _fatura, 'insumos', 'Taxa fixa de insumos — ' || p.name, _mes, p.id, a.supplies_monthly_price
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
         JOIN public.properties pi ON pi.id = i.property_id
        WHERE f2.owner_id = _owner_id
          AND f2.cleaner_id = _cleaner_id
          AND f2.status <> 'cancelada'
          AND i.kind = 'insumos'
          AND COALESCE(pi.parent_property_id, pi.id) = COALESCE(p.parent_property_id, p.id)
          AND i.data = _mes
     )
   ORDER BY COALESCE(p.parent_property_id, p.id), (p.parent_property_id IS NOT NULL), p.created_at;

  SELECT COALESCE(SUM(valor), 0), MIN(COALESCE(data, _fim))
    INTO _total, _inicio
    FROM public.cleaner_invoice_items WHERE invoice_id = _fatura;

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

-- O outro lado da regra: o que passou do dia e não foi assinado.
--
-- Sem isto, o checkout que ela esqueceu de assinar some da tela dela no dia
-- seguinte e reaparece como dinheiro que não veio no fim do mês. A pendência
-- existe para o esquecimento ser resolvido enquanto ainda é lembrança.
CREATE OR REPLACE FUNCTION public.limpezas_pendentes_de_assinatura()
RETURNS TABLE (
  id uuid, property_id uuid, imovel text, checkout_date date,
  turnover_price numeric, dias_atrasada integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.property_id, p.name, t.checkout_date,
         COALESCE(t.turnover_price, 0),
         (public.app_today() - t.checkout_date)::int
    FROM public.cleaning_tasks t
    JOIN public.properties p ON p.id = t.property_id
   WHERE t.cleaner_id = auth.uid()
     AND t.status <> 'cancelled'
     AND t.assinatura_id IS NULL
     AND t.checkout_date < public.app_today()
   ORDER BY t.checkout_date ASC;
$$;

REVOKE ALL ON FUNCTION public.limpezas_pendentes_de_assinatura() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.limpezas_pendentes_de_assinatura() TO authenticated;

COMMIT;
