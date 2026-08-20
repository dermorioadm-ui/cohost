-- 0043 — Termos assinados a dedo.
--
-- Hoje o aceite do hospede e um checkbox, e a limpeza "aconteceu" porque
-- alguem apertou um botao. As duas coisas bastam para o app funcionar e nao
-- bastam para uma discussao: quando o hospede recebe gente que nao estava no
-- check-in, ou quando reclamam que o imovel estava sujo, o dono nao tem nada
-- alem de um registro que o proprio sistema criou.
--
-- Assinatura com o dedo e o que muda isso. Nao por ser mais bonita — por ser
-- um ato da pessoa, com traco, data, hora e origem.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('termos', 'termos', false, 5242880,
        ARRAY['image/png','image/jpeg','application/pdf'])
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE TYPE public.assinatura_kind AS ENUM ('cadastro_hospede', 'limpeza_concluida');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.assinaturas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             public.assinatura_kind NOT NULL,
  property_id      uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,

  registration_id  uuid REFERENCES public.guest_registrations(id) ON DELETE SET NULL,
  cleaning_task_id uuid REFERENCES public.cleaning_tasks(id) ON DELETE SET NULL,
  signer_user_id   uuid,

  signer_name      text NOT NULL,
  signer_doc       text,

  -- Quando a pessoa DIZ que o fato aconteceu, separado de quando ela assinou.
  -- A diarista assina as 19h a limpeza que fez as 11h; guardar so um carimbo
  -- transformaria a declaracao dela em outra coisa.
  declarado_em     timestamptz,
  assinado_em      timestamptz NOT NULL DEFAULT now(),

  term_version_id  uuid REFERENCES public.term_versions(id),
  -- O texto vai junto, e nao so a referencia: o dia em que alguem editar a
  -- versao do termo, os documentos ja assinados nao podem mudar de conteudo.
  term_texto       text NOT NULL,
  term_titulo      text NOT NULL,

  assinatura_path  text NOT NULL,
  pdf_path         text,
  pdf_enviado_para text,
  pdf_enviado_em   timestamptz,

  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assinaturas_imovel
  ON public.assinaturas (property_id, assinado_em DESC);
CREATE INDEX IF NOT EXISTS idx_assinaturas_tarefa
  ON public.assinaturas (cleaning_task_id) WHERE cleaning_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assinaturas_registro
  ON public.assinaturas (registration_id) WHERE registration_id IS NOT NULL;

-- Uma declaracao por limpeza. Duas assinaturas para a mesma faxina viram duas
-- versoes do mesmo fato, e o dono nao tem como saber qual vale.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assinaturas_uma_por_limpeza
  ON public.assinaturas (cleaning_task_id)
  WHERE cleaning_task_id IS NOT NULL;

ALTER TABLE public.assinaturas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assinaturas_dono_le ON public.assinaturas;
CREATE POLICY assinaturas_dono_le ON public.assinaturas
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.properties p
               WHERE p.id = property_id AND p.owner_id = auth.uid())
  );

-- A diarista le as dela: assinou, tem direito a ver o que assinou.
DROP POLICY IF EXISTS assinaturas_diarista_le ON public.assinaturas;
CREATE POLICY assinaturas_diarista_le ON public.assinaturas
  FOR SELECT TO authenticated
  USING (signer_user_id = auth.uid());

-- Nao existe policy de INSERT: quem grava e a Edge Function com service_role,
-- depois de montar o PDF. Assinatura que o cliente insere direto e assinatura
-- cujo texto o cliente escolhe.
COMMENT ON TABLE public.assinaturas IS
  'Termos assinados a dedo — cadastro do hospede e conclusao de limpeza. Guarda o TEXTO junto da assinatura, e nao so a referencia da versao: editar o termo amanha nao pode mudar o que alguem assinou ontem.';

ALTER TABLE public.cleaning_tasks
  ADD COLUMN IF NOT EXISTS assinatura_id uuid REFERENCES public.assinaturas(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.cleaning_tasks.assinatura_id IS
  'Declaracao assinada da diarista de que esta limpeza foi feita.';
