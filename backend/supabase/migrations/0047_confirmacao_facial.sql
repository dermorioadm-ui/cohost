-- Confirmação facial de quem assina o termo.
--
-- A coluna vive em `assinaturas`, e não em `guest_people`, porque o rosto não
-- é um atributo da pessoa cadastrada: é uma prova do ATO de assinar. Quem
-- assinou o termo de hoje pode voltar em dezembro e assinar outro; são dois
-- rostos, tirados em dois momentos, e cada um pertence ao seu documento.
--
-- Guardar na pessoa faria o segundo sobrescrever o primeiro — e o termo de
-- hoje passaria a exibir o rosto de dezembro, silenciosamente.
--
-- O arquivo vai para o bucket `termos`, na mesma pasta da assinatura e do PDF.
-- A policy `termos_dono_le` (migração 0045) já autoriza o dono do imóvel e o
-- admin pelo primeiro segmento do caminho, que é o property_id: o rosto herda
-- exatamente o mesmo alcance do documento a que pertence, sem regra nova para
-- alguém esquecer de manter alinhada.

ALTER TABLE public.assinaturas
  ADD COLUMN IF NOT EXISTS selfie_path text;

COMMENT ON COLUMN public.assinaturas.selfie_path IS
  'Caminho no bucket `termos` da foto do rosto de quem assinou, tirada logo '
  'após a assinatura. Imagem de rosto é dado pessoal sensível (LGPD art. 5º, '
  'II): o consentimento específico é colhido na tela de captura, e o uso '
  'declarado é apenas confirmar a autoria da assinatura.';
