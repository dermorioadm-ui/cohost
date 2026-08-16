-- =============================================================================
-- 0034 — Reposição de itens: o combinado com a diarista vira dado
-- =============================================================================
-- Papel higiênico, café, sabão, detergente, pilha. Hoje isso é um acordo verbal
-- que existe só na cabeça dos dois: o dono paga um valor fixo por mês e a
-- diarista repõe. Quando ela troca, ou quando a conta do mês chega, ninguém
-- lembra o que estava combinado nem por quanto.
--
-- Aqui o combinado passa a morar no imóvel: liga/desliga, valor mensal e a
-- lista do que ela repõe. A diarista lê a lista na agenda dela; o dono vê o
-- valor no Financeiro como despesa fixa do mês.
--
-- O que este recurso deliberadamente NÃO faz: controlar compra item a item, ou
-- exigir confirmação dela a cada limpeza. O acerto é por valor fechado — é
-- assim que funciona na prática, e transformar isso em checklist diário
-- carregaria a diarista com burocracia que ninguém pediu.
--
-- A lista fica em text[] e não em tabela própria: são cinco a dez itens por
-- imóvel, sem identidade, sem histórico e sem consulta cruzada. Uma tabela
-- filha aqui seria três JOINs para exibir o que cabe numa coluna.
-- =============================================================================

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS supplies_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supplies_monthly_price numeric(10,2) NOT NULL DEFAULT 0
    CHECK (supplies_monthly_price >= 0),
  ADD COLUMN IF NOT EXISTS supplies_items         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS supplies_notes         text;

COMMENT ON COLUMN public.properties.supplies_enabled IS
  'Reposição de itens combinada com a diarista, por valor fixo mensal.';
COMMENT ON COLUMN public.properties.supplies_monthly_price IS
  'Valor fixo mensal do combinado. Entra no Financeiro como despesa do mês.';
COMMENT ON COLUMN public.properties.supplies_items IS
  'O que ela repõe: papel higiênico, café, sabão… Aparece na agenda dela.';

-- Sugestão inicial de lista, para o dono não começar de uma caixa vazia. Fica
-- em app_settings porque é texto de produto — muda sem migration.
INSERT INTO public.app_settings (key, value, description) VALUES (
  'supplies_default_items',
  'Papel higiênico,Sabonete,Sabão líquido para as mãos,Detergente,Esponja,Saco de lixo,Café,Açúcar,Sal,Óleo,Pilha,Produto de limpeza geral',
  'Sugestão de itens de reposição, separados por vírgula, oferecida ao ligar o recurso.'
) ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- A diarista lê os imóveis por `my_cleaning_properties`, não pela tabela — a
-- 0022 fez assim porque `properties` guarda código de fechadura e Wi-Fi. Então
-- a lista de reposição precisa entrar no retorno dessa função, senão ela nunca
-- enxerga o que foi combinado.
--
-- O preço combinado NÃO vai junto: é acerto entre dono e diarista, e o que ela
-- precisa para trabalhar é a lista, não o valor.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.my_cleaning_properties();

CREATE FUNCTION public.my_cleaning_properties()
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
  turnover_price numeric,
  supplies_enabled boolean,
  supplies_items   text[],
  supplies_notes   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.owner_id, p.name, p.neighborhood, p.address, p.street_number,
         p.block, p.apt_number, p.city, p.checkin_time, p.checkout_time,
         p.turnover_price,
         p.supplies_enabled, p.supplies_items, p.supplies_notes
  FROM public.properties p
  WHERE p.cleaner_id = auth.uid()
    AND p.archived_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.my_cleaning_properties() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_cleaning_properties() TO authenticated;
