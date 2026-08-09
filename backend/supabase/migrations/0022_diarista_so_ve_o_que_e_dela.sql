-- =============================================================================
-- 0022 — A diarista só enxerga o que é trabalho dela
-- =============================================================================
-- A policy "properties: diarista lê as atribuídas" dava SELECT na LINHA
-- INTEIRA do imóvel. RLS é por linha, não por coluna — então junto com o nome
-- e o bairro ela lia também:
--
--   ai_config -> lock  (código da fechadura)
--   ai_config -> wifi  (senha do Wi-Fi)
--   ai_prompt          (os dois acima, já concatenados em texto)
--   condo_email        (contato da portaria)
--
-- A tela dela pedia só nome e bairro, mas isso não protege nada: com o token
-- dela e a chave publicável, `select * from properties` devolvia tudo. É a
-- mesma classe de falha que o README descreve no produto antigo, onde a RLS
-- por linha entregava PIX e e-mail de afiliado numa consulta de indicação.
--
-- A troca: nenhuma policy de leitura em `properties` para ela, e uma função
-- SECURITY DEFINER que devolve só as colunas de que ela precisa para trabalhar
-- — onde é, a que horas sai o hóspede e quanto ela recebe.
--
-- `reservations` também sai: quem se hospeda e por quanto tempo é informação
-- do dono. A data de saída, que é o que ela precisa, já vem de cleaning_tasks.
-- =============================================================================

DROP POLICY IF EXISTS "properties: diarista lê as atribuídas" ON public.properties;
DROP POLICY IF EXISTS "reservations: diarista lê as dos imóveis dela" ON public.reservations;

CREATE OR REPLACE FUNCTION public.my_cleaning_properties()
RETURNS TABLE (
  id            uuid,
  owner_id      uuid,
  name          text,
  neighborhood  text,
  address       text,
  street_number text,
  block         text,
  apt_number    text,
  city          text,
  checkin_time  time,
  checkout_time time,
  turnover_price numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.owner_id, p.name, p.neighborhood, p.address, p.street_number,
         p.block, p.apt_number, p.city, p.checkin_time, p.checkout_time,
         p.turnover_price
  FROM public.properties p
  WHERE p.cleaner_id = auth.uid()
    AND p.archived_at IS NULL;
$$;

-- 0016 revogou EXECUTE de PUBLIC; a concessão precisa ser explícita.
REVOKE ALL ON FUNCTION public.my_cleaning_properties() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_cleaning_properties() TO authenticated;

COMMENT ON FUNCTION public.my_cleaning_properties() IS
  'Imóveis atribuídos à diarista logada, só com as colunas de trabalho. '
  'Nunca inclua ai_config, ai_prompt ou condo_email aqui: é justamente o que '
  'esta função existe para não entregar.';
