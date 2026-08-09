-- =============================================================================
-- 0015 — Jobs agendados (pg_cron -> edge functions via pg_net)
-- =============================================================================
-- É esta migration que torna verdadeiro o "funciona no automático".
--
-- No backend antigo a sincronização de calendário só rodava quando alguém abria
-- o app. O cliente que você quer — dono de 2-3 apartamentos que comprou para
-- esquecer — passa dias sem abrir. A reserva nova não virava tarefa, a
-- cancelada continuava na agenda da diarista, e a falha era silenciosa.
--
-- ANTES DE AGENDAR: preencha private.job_config (ver bloco no final).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

-- Configuração dos jobs. Fora de public: nem anon nem authenticated enxergam.
CREATE TABLE private.job_config (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  functions_url text NOT NULL,          -- https://<projeto>.supabase.co/functions/v1
  cron_secret   text NOT NULL,          -- mesmo valor de CRON_SECRET no .env
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.job_config ENABLE ROW LEVEL SECURITY;

-- Dispara uma edge function autenticada pelo segredo do cron.
CREATE OR REPLACE FUNCTION private.call_job(_path text, _body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, net
AS $$
DECLARE
  _cfg private.job_config%ROWTYPE;
BEGIN
  SELECT * INTO _cfg FROM private.job_config WHERE id = 1;

  IF NOT FOUND OR NOT _cfg.enabled THEN
    RAISE NOTICE 'job_config ausente ou desabilitado — job % ignorado', _path;
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url     := _cfg.functions_url || '/' || _path,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', _cfg.cron_secret
               ),
    body    := _body,
    timeout_milliseconds := 120000
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- Agendamentos
-- -----------------------------------------------------------------------------

-- Calendários: a cada 15 minutos. É o coração da promessa do produto.
SELECT cron.schedule(
  'sync-ical',
  '*/15 * * * *',
  $$ SELECT private.call_job('job-sync-ical'); $$
);

-- Fila de notificações (e-mail/WhatsApp): a cada minuto.
SELECT cron.schedule(
  'process-outbox',
  '* * * * *',
  $$ SELECT private.call_job('job-process-outbox'); $$
);

-- Rede de segurança da portaria: se algum gatilho falhou, o job varre
-- reservas confirmadas ainda não avisadas. A cada 10 minutos.
SELECT cron.schedule(
  'notify-condo-sweep',
  '*/10 * * * *',
  $$ SELECT private.call_job('job-notify-condo'); $$
);

-- Assinaturas: expira trial vencido, marca inadimplente. 06:00 BRT = 09:00 UTC.
SELECT cron.schedule(
  'subscription-sweep',
  '0 9 * * *',
  $$ SELECT private.call_job('job-subscription-sweep'); $$
);

-- Relatório mensal para o dono. Dia 1, 09:00 BRT = 12:00 UTC.
-- É o que torna visível um produto que, funcionando, é invisível.
SELECT cron.schedule(
  'monthly-report',
  '0 12 1 * *',
  $$ SELECT private.call_job('job-monthly-report'); $$
);

-- Higiene: sessões de hóspede e convites vencidos. 04:00 BRT = 07:00 UTC.
SELECT cron.schedule(
  'housekeeping',
  '0 7 * * *',
  $$
    DELETE FROM public.guest_sessions WHERE expires_at < now() - interval '30 days';
    UPDATE public.cleaner_invites SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now();
    DELETE FROM public.audit_log WHERE created_at < now() - interval '180 days';
    DELETE FROM public.notifications
      WHERE status = 'sent' AND created_at < now() - interval '90 days';
  $$
);

-- -----------------------------------------------------------------------------
-- PASSO MANUAL PÓS-DEPLOY
--
-- Rode uma vez, com os valores reais do projeto:
--
--   INSERT INTO private.job_config (id, functions_url, cron_secret)
--   VALUES (1,
--     'https://SEU_PROJETO.supabase.co/functions/v1',
--     'MESMO_VALOR_DO_CRON_SECRET_DO_ENV'
--   )
--   ON CONFLICT (id) DO UPDATE
--     SET functions_url = EXCLUDED.functions_url,
--         cron_secret   = EXCLUDED.cron_secret,
--         updated_at    = now();
--
-- Conferir agendamentos:  SELECT * FROM cron.job;
-- Conferir execuções:     SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
-- -----------------------------------------------------------------------------
