-- =============================================================================
-- 0024 — A portaria digital passa a ter como ser conectada
-- =============================================================================
-- A 0009 criou `porter_accounts` fechada: nem o dono lê as credenciais de
-- volta, e é assim que tem de ser. Só que sem SELECT e sem tela, ninguém nunca
-- escreveu uma linha ali — e `guest-register` só enfileira hóspede na portaria
-- quando essa linha existe. A integração inteira estava ligada e vazia.
--
-- Quem grava agora é a function `porter-connect`, com service_role, depois de
-- conferir que o imóvel é de quem pediu e que a Kiper aceitou as credenciais.
--
-- Duas correções na leitura do estado:
--
-- 1. `porter_status` nascia com `security_invoker = true` sobre uma tabela sem
--    policy de SELECT. O efeito era a view devolver zero linha para todo mundo,
--    sempre: a tela da Portaria dizia "não configurada" mesmo com a integração
--    no ar. Aqui ela passa a rodar como definer e filtra por dono na própria
--    consulta — que é o que dá para fazer quando a tabela-base é fechada de
--    propósito. Só colunas de estado saem; nenhuma credencial.
--
-- 2. Passa a devolver o texto do último erro, não apenas que houve um. O erro
--    típico é token vencido — a credencial é capturada à mão pelo app do prédio
--    e expira sozinha. "Com erro na última tentativa" faz o dono abrir chamado;
--    "a portaria recusou o token" faz ele reconectar em dois minutos. O texto é
--    a resposta da Kiper gravada por `job-porter-sync`; nenhum segredo nosso
--    entra nela.
-- =============================================================================

DROP VIEW IF EXISTS public.porter_status;

CREATE VIEW public.porter_status
WITH (security_invoker = false) AS
SELECT
  pa.property_id,
  pa.owner_id,
  pa.active,
  pa.last_ok_at,
  (pa.last_error IS NOT NULL) AS has_error,
  pa.last_error,
  pa.updated_at
FROM public.porter_accounts pa
WHERE pa.owner_id = auth.uid() OR public.is_admin();

GRANT SELECT ON public.porter_status TO authenticated;
