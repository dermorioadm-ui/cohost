-- Agenda a rotina de retenção LGPD (job-retencao): todo dia às 6h30 UTC, os
-- documentos e rostos com mais de 180 dias de checkout são apagados do
-- storage, em lotes pequenos. Ver o comentário da própria function.

BEGIN;
SELECT cron.schedule(
  'retencao-lgpd',
  '30 6 * * *',
  $cron$ SELECT private.call_job('job-retencao'); $cron$
);
COMMIT;
