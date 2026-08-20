-- Duas coisas que o produto tratava como se não existissem.
--
-- 1) A CÓPIA de um imóvel é outro anúncio, não outro apartamento. Ela tem link
--    de hóspede próprio, iCal próprio e nome próprio — mas é a mesma cama, o
--    mesmo armário e o mesmo estoque de shampoo. Sem dizer isso ao banco, tudo
--    o que é por UNIDADE passa a contar duas vezes: a reposição de insumos
--    seria cobrada duas vezes no mês pelo mesmo apartamento.
--
-- 2) Nem todo imóvel fica em condomínio. Casa, sítio, kitnet de porta para a
--    rua — nesses não há síndico, não há e-mail do condomínio e não há portaria
--    para integrar. Pedir esses dados assim mesmo é o que faz o dono achar que
--    o cadastro dele está incompleto para sempre.

BEGIN;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS parent_property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS em_condominio boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.properties.parent_property_id IS
  'Quando preenchido, este anúncio é uma CÓPIA: outro anúncio, outro link de hóspede, outro iCal — mas o MESMO apartamento físico. O que é por unidade (reposição de insumos, portaria do prédio) conta uma vez só para o grupo.';

COMMENT ON COLUMN public.properties.em_condominio IS
  'Falso para casa, sítio ou qualquer imóvel sem condomínio e sem portaria.';

CREATE INDEX IF NOT EXISTS properties_unidade ON public.properties (parent_property_id)
  WHERE parent_property_id IS NOT NULL;

-- A unidade física de um anúncio. Cópia aponta para o original; original
-- aponta para si mesmo. É por este valor que se agrupa o que não pode contar
-- duas vezes.
CREATE OR REPLACE FUNCTION public.unidade_fisica(_property_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(p.parent_property_id, p.id) FROM public.properties p WHERE p.id = _property_id;
$$;

REVOKE ALL ON FUNCTION public.unidade_fisica(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unidade_fisica(uuid) TO authenticated;

COMMIT;
