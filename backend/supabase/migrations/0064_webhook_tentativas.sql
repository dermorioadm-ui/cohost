-- Evento recebido não é evento processado. Retries após falha devem tentar
-- novamente; notificação e contratação já possuem suas chaves idempotentes.
ALTER TABLE public.billing_events ADD COLUMN processed_at timestamptz;
COMMENT ON COLUMN public.billing_events.processed_at IS 'Preenchido somente após reconciliação concluída. NULL permite retry após falha.';
