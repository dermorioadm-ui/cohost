-- Três assuntos em uma migração, todos pequenos e independentes:
-- a saída do hóspede, o registro de sistema, e higiene apontada pelo linter.

BEGIN;

-- ------------------------------------------------------ saída do hóspede
-- O hóspede sai às 11h, mas a diarista não sabe disso: ela chega "quando dá",
-- e o intervalo entre a saída real e a chegada dela é tempo morto que ninguém
-- enxerga. O timestamp existe para virar informação na agenda dela — "o
-- apartamento liberou às 10h42" — sem ninguém precisar mandar mensagem.
ALTER TABLE public.guest_registrations
  ADD COLUMN IF NOT EXISTS saida_confirmada_em timestamptz;

-- Cópia do timestamp na tarefa de limpeza, e não um join na agenda: a agenda
-- da diarista lê `cleaning_tasks` direto, e é a tela mais aberta do produto.
ALTER TABLE public.cleaning_tasks
  ADD COLUMN IF NOT EXISTS hospede_saiu_em timestamptz;

-- ------------------------------------------------------ registro de sistema
-- Uma linha por acontecimento que alguém pode precisar reconstituir depois:
-- admin entrou na conta de um assinante, função falhou com erro interno,
-- rotina de retenção apagou arquivos. A pergunta que a tabela responde é
-- "o que aconteceu e quando" — sem ela, a resposta é "ninguém sabe".
CREATE TABLE IF NOT EXISTS public.system_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem     text NOT NULL,              -- 'admin', 'edge:<função>', 'job:<rotina>'
  acao       text NOT NULL,              -- 'acessou_conta', 'erro_interno', ...
  ator       uuid,                       -- quem fez, quando há um quem
  alvo       text,                       -- id ou rótulo do que foi afetado
  detalhe    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_log_recentes ON public.system_log (created_at DESC);

ALTER TABLE public.system_log ENABLE ROW LEVEL SECURITY;

-- Só o admin lê. Ninguém escreve por RLS: as escritas vêm de funções
-- SECURITY DEFINER e do service_role, que passam por fora — e é proposital,
-- porque um log em que o autor escolhe o que entra não reconstitui nada.
CREATE POLICY system_log_admin_le ON public.system_log
  FOR SELECT TO authenticated USING (public.is_admin());

-- Limpeza: 90 dias de log operacional bastam para reconstituir qualquer
-- incidente, e o acúmulo infinito só deixa a consulta lenta.
-- (Anexado ao housekeeping diário existente na próxima edição dele; por ora,
-- índice + tabela.)

-- ------------------------------------------------------ higiene do linter
-- A view lia com os privilégios de quem a criou (postgres), ignorando a RLS
-- de quem consulta. `security_invoker` devolve a checagem ao consultante.
ALTER VIEW public.porter_status SET (security_invoker = true);

COMMIT;
