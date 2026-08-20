-- Comprovante do pagamento, e o fechamento automático no dia combinado.

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES ('comprovantes', 'comprovantes', false)
ON CONFLICT (id) DO NOTHING;

-- O primeiro segmento do caminho é o id da fatura, como no bucket de
-- reembolsos. E a coluna vai QUALIFICADA (`storage.objects.name`): dentro do
-- subconsulta, um `name` solto resolve para a coluna da tabela de dentro, a
-- policy é criada sem erro nenhum e passa a autorizar outra coisa.
DROP POLICY IF EXISTS "comprovantes: dono envia" ON storage.objects;
CREATE POLICY "comprovantes: dono envia" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'comprovantes'
    -- O formato é conferido ANTES do cast. Sem esta guarda, um arquivo com
    -- nome fora do padrão faria o `::uuid` lançar e derrubar a consulta
    -- inteira, em vez de recusar aquele arquivo.
    AND split_part(storage.objects.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.cleaner_invoices f
       WHERE f.id = split_part(storage.objects.name, '/', 1)::uuid
         AND f.owner_id = auth.uid()
    )
  );

-- Quem paga envia; os dois leem. É o ponto do pedido: a diarista precisa ver o
-- comprovante sem depender de alguém reenviar por WhatsApp.
DROP POLICY IF EXISTS "comprovantes: partes leem" ON storage.objects;
CREATE POLICY "comprovantes: partes leem" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'comprovantes'
    AND split_part(storage.objects.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.cleaner_invoices f
       WHERE f.id = split_part(storage.objects.name, '/', 1)::uuid
         AND (f.owner_id = auth.uid() OR f.cleaner_id = auth.uid() OR public.is_admin())
    )
  );

-- 8h no fuso da aplicação: a varredura roda depois de a noite terminar, então
-- a limpeza lançada tarde no dia do fechamento ainda entra na fatura daquele
-- dia, e não na do mês seguinte.
SELECT cron.schedule(
  'fechar-faturas',
  '0 8 * * *',
  $cron$ SELECT public.fechar_faturas_do_dia(); $cron$
);

COMMIT;
