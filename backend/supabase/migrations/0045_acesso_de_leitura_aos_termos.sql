-- 0045 — Quem pode LER os termos assinados.
--
-- O bucket `termos` nasceu privado e sem policy nenhuma na 0043. Privado sem
-- policy nao e "seguro", e inacessivel: nem o dono do imovel conseguia baixar
-- o proprio documento. O termo existia, o PDF estava gravado, e a unica copia
-- que chegava a alguem era o anexo do e-mail — que e justamente a copia que
-- some quando a pessoa apaga a mensagem ou troca de caixa.
--
-- O caminho do arquivo e `{property_id}/{uuid}/termo.pdf`. O primeiro segmento
-- e a chave da autorizacao: quem e dono daquele imovel le os arquivos daquela
-- pasta.

-- A coluna vai QUALIFICADA (`storage.objects.name`). Sem isso, dentro do
-- subquery o `name` resolve para `properties.name` — o nome do imovel — e a
-- policy passa a comparar o id do imovel com o primeiro pedaco do nome dele.
-- O Postgres aceita calado, e o dono nao le termo nenhum.
--
-- O guard de formato vem ANTES do cast, e o AND curto-circuita. Sem ele, um
-- arquivo no bucket cujo primeiro segmento nao seja UUID faria o `::uuid`
-- lancar — e policy que lanca nao devolve "nao autorizado", ela derruba a
-- consulta inteira. O dono deixaria de ver TODOS os termos por causa de um
-- arquivo com nome estranho.
DROP POLICY IF EXISTS termos_dono_le ON storage.objects;
CREATE POLICY termos_dono_le ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'termos'
    AND (storage.foldername(storage.objects.name))[1]
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.properties p
        WHERE p.id = ((storage.foldername(storage.objects.name))[1])::uuid
          AND p.owner_id = auth.uid()
      )
    )
  );

-- A diarista le o que ela assinou, e so isso. Ela nao e dona do imovel, entao
-- a policy acima nao a alcanca — e um documento que a pessoa assina e nao pode
-- reler depois nao e um documento dela.
DROP POLICY IF EXISTS termos_signatario_le ON storage.objects;
CREATE POLICY termos_signatario_le ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'termos'
    AND EXISTS (
      SELECT 1 FROM public.assinaturas a
      WHERE a.signer_user_id = auth.uid()
        AND (a.pdf_path = storage.objects.name OR a.assinatura_path = storage.objects.name)
    )
  );

-- Nao ha policy de INSERT, UPDATE ou DELETE de proposito: quem escreve e a
-- Edge Function com service_role, depois de montar o PDF. Documento assinado
-- que o interessado pode sobrescrever nao prova nada.
