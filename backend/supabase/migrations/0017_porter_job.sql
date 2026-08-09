-- =============================================================================
-- 0017 — Job da portaria digital
-- =============================================================================
-- A fila de porter_registrations é preenchida pelo guest-register; este job a
-- consome e chama a API da Kiper.
--
-- A cada 5 minutos: o hóspede acabou de se cadastrar e vai chegar no prédio.
-- Esperar 15 minutos seria tempo demais.
-- =============================================================================

SELECT cron.schedule(
  'porter-sync',
  '*/5 * * * *',
  $$ SELECT private.call_job('job-porter-sync'); $$
);

-- Índice para a varredura da fila: pendentes, mais antigos primeiro, sem
-- varrer o histórico inteiro de cadastros já processados.
CREATE INDEX IF NOT EXISTS idx_porter_reg_queue
  ON public.porter_registrations (created_at)
  WHERE status = 'pending';
