-- =============================================================================
-- 0024 — Três planos, escalonados por número de imóveis
-- =============================================================================
-- O preço passa a acompanhar o tamanho da carteira: 1, até 3 e até 5 imóveis.
-- O preço POR IMÓVEL cai a cada degrau (R$97 -> R$65,67 -> R$59,40), que é o
-- que faz o cliente de dois apartamentos subir de plano em vez de abrir duas
-- contas.
--
-- As CHAVES do enum plan_tier continuam essencial/pro/ilimitado. Trocar chave
-- de enum exigiria ALTER TYPE, migração de profiles.plan e conviver com
-- valores mortos que o Postgres não deixa remover — tudo isso para renomear
-- algo que o cliente nunca vê. Quem aparece na tela é a coluna `name`.
--
-- Fica o aviso para quem ler depois: a chave `ilimitado` NÃO é mais ilimitada.
-- max_properties = 5. A verdade está na coluna, não no nome da chave.
--
-- O gatilho tg_enforce_property_limit é BEFORE INSERT, então baixar o limite
-- do Essencial para 1 não trava quem já tem dois imóveis — só impede o
-- terceiro. Ninguém perde acesso ao que já cadastrou.
-- =============================================================================

UPDATE public.plans SET
  name           = 'Essencial',
  monthly_cents  = 9700,
  annual_cents   = 97000,   -- 10 meses: dois de desconto no anual
  max_properties = 1,
  sort_order     = 1
WHERE tier = 'essencial';

UPDATE public.plans SET
  name           = 'Profissional',
  monthly_cents  = 19700,
  annual_cents   = 197000,
  max_properties = 3,
  sort_order     = 2
WHERE tier = 'pro';

UPDATE public.plans SET
  name           = 'Portfólio',
  monthly_cents  = 29700,
  annual_cents   = 297000,
  max_properties = 5,
  sort_order     = 3
WHERE tier = 'ilimitado';

COMMENT ON COLUMN public.plans.max_properties IS
  'Limite de imóveis ativos. NULL seria ilimitado, mas hoje nenhum plano é: '
  'a chave de enum `ilimitado` está capada em 5. Confie nesta coluna, não no '
  'nome do tier.';
