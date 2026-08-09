-- =============================================================================
-- 0014 — Storage
-- =============================================================================
-- Buckets PRIVADOS. A foto da limpeza é a prova datada do estado do imóvel —
-- ela não pode ficar em URL pública adivinhável. O acesso é por signed URL
-- gerada sob demanda para quem tem direito.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('cleaning-photos', 'cleaning-photos', false, 10485760,
   ARRAY['image/jpeg','image/png','image/webp','image/heic']),
  ('fee-receipts',    'fee-receipts',    false,  5242880,
   ARRAY['image/jpeg','image/png','image/webp','application/pdf']),
  ('avatars',         'avatars',         false,  2097152,
   ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- cleaning-photos — caminho: <task_id>/<arquivo>
-- Quem envia: a diarista designada. Quem lê: diarista, dono do imóvel, admin.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_cleaning_photo(_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.cleaning_tasks t
    JOIN public.properties p ON p.id = t.property_id
    WHERE t.id::text = split_part(_object_name, '/', 1)
      AND (t.cleaner_id = auth.uid() OR p.owner_id = auth.uid() OR public.is_admin())
  );
$$;

CREATE POLICY "cleaning-photos: envio pela diarista da tarefa"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cleaning-photos'
    AND EXISTS (
      SELECT 1 FROM public.cleaning_tasks t
      WHERE t.id::text = split_part(name, '/', 1)
        AND t.cleaner_id = auth.uid()
    )
  );

CREATE POLICY "cleaning-photos: leitura por quem tem direito"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'cleaning-photos' AND public.can_access_cleaning_photo(name));

CREATE POLICY "cleaning-photos: diarista substitui a própria"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cleaning-photos'
    AND EXISTS (
      SELECT 1 FROM public.cleaning_tasks t
      WHERE t.id::text = split_part(name, '/', 1) AND t.cleaner_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- fee-receipts — caminho: <fee_id>/<arquivo>
-- -----------------------------------------------------------------------------
CREATE POLICY "fee-receipts: diarista envia"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'fee-receipts'
    AND EXISTS (
      SELECT 1 FROM public.cleaner_fees f
      WHERE f.id::text = split_part(name, '/', 1) AND f.cleaner_id = auth.uid()
    )
  );

CREATE POLICY "fee-receipts: partes leem"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'fee-receipts'
    AND EXISTS (
      SELECT 1 FROM public.cleaner_fees f
      WHERE f.id::text = split_part(name, '/', 1)
        AND (f.cleaner_id = auth.uid() OR f.owner_id = auth.uid() OR public.is_admin())
    )
  );

-- -----------------------------------------------------------------------------
-- avatars — caminho: <user_id>/<arquivo>
-- -----------------------------------------------------------------------------
CREATE POLICY "avatars: dono gerencia o próprio"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = split_part(name, '/', 1))
  WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = split_part(name, '/', 1));
