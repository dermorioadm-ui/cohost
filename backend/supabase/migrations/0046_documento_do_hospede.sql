-- 0046 — Documento de identificacao do hospede.
--
-- O termo assinado so identifica alguem se o documento for real. Ate aqui o
-- cadastro pedia nome, e-mail e telefone: da para assinar um termo com esses
-- tres e nao apontar para pessoa nenhuma -- ha dois "Joao Silva" em qualquer
-- predio. CPF, ou passaporte para quem nao tem CPF, e o que transforma a
-- assinatura em identificacao.

ALTER TABLE public.guest_people
  ADD COLUMN IF NOT EXISTS nationality         text,
  ADD COLUMN IF NOT EXISTS document_photo_path text,
  ADD COLUMN IF NOT EXISTS phone_ddi           text;

COMMENT ON COLUMN public.guest_people.nationality IS
  'ISO 3166-1 alfa-2 da nacionalidade. "BR" para quem informou CPF.';

COMMENT ON COLUMN public.guest_people.document_photo_path IS
  'Caminho no bucket `documentos` da foto do documento. A portaria de alguns predios exige a imagem, e pedir depois significa perseguir o hospede que ja entrou.';

-- O DDI guardado em separado, e nao recalculado.
--
-- Sem ele a formatacao para a portaria volta a adivinhar, e com um erro pior
-- que o anterior: um celular espanhol (+34 612345678) fica com 11 digitos
-- depois do normalize_phone -- exatamente o comprimento de um brasileiro com
-- DDD. A regra "10 ou 11 digitos e Brasil" estava certa quando so havia
-- hospede brasileiro; com estrangeiro no cadastro ela manda
-- "+55 34 6123 45678" para a Kiper e o cadastro e recusado.
--
-- A ambiguidade nao se resolve olhando os digitos: 34612345678 e Espanha ou e
-- Uberlandia. Quem sabe a resposta e a pessoa que escolheu o pais.
COMMENT ON COLUMN public.guest_people.phone_ddi IS
  'DDI do telefone, como o hospede escolheu no formulario (sem o +). Guardado porque o comprimento do numero nao distingue "+34 612345678" de "+55 34 61234 5678".';

-- `document_type` era texto livre, o que produz "cpf", "CPF", "Cpf" e "c.p.f."
-- na mesma coluna e obriga quem consome a adivinhar.
ALTER TABLE public.guest_people
  DROP CONSTRAINT IF EXISTS guest_people_document_type_check;
ALTER TABLE public.guest_people
  ADD CONSTRAINT guest_people_document_type_check
  CHECK (document_type IS NULL OR document_type IN ('cpf', 'passaporte', 'rg', 'outro'));

-- Bucket das fotos. Privado: e documento de identidade de terceiro.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documentos', 'documentos', false, 8388608,
        ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Quem le. O caminho e `{property_id}/{registration_id}/{person_id}.{ext}`,
-- entao o primeiro segmento e a chave da autorizacao.
--
-- A coluna vai QUALIFICADA (`storage.objects.name`): sem isso, dentro do
-- subquery o `name` resolve para `properties.name` -- o nome do imovel -- e a
-- policy compara o id com o primeiro pedaco do nome dele. O Postgres aceita
-- calado e ninguem le nada. Aconteceu na 0045.
--
-- E o guard de formato vem antes do cast: arquivo cujo primeiro segmento nao
-- seja UUID faria o `::uuid` LANCAR, e policy que lanca derruba a consulta
-- inteira em vez de negar uma linha.
DROP POLICY IF EXISTS documentos_dono_le ON storage.objects;
CREATE POLICY documentos_dono_le ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documentos'
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

-- Sem policy de escrita: quem grava e a Edge Function com service_role, no
-- momento do cadastro. E sem policy para a diarista -- ela precisa saber a
-- hora da saida, nao o RG do hospede.
