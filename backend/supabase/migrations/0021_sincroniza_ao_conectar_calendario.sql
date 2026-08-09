-- =============================================================================
-- 0021 — Sincronizar na hora em que o calendário é conectado
-- =============================================================================
-- O dono colava o link e não acontecia nada até a próxima passada do pg_cron:
-- até 15 minutos olhando um calendário vazio, justamente no passo que existe
-- para provar que o produto funciona. Pior no segundo canal — quem já tinha o
-- Airbnb sincronizado adicionava o Booking e concluía que estava quebrado.
--
-- O job-sync-ical sempre aceitou { property_id } para rodar sob demanda; o que
-- faltava era alguém chamar. Chamamos daqui, e não da edge function, por dois
-- motivos: o segredo do cron continua sem sair do Postgres, e passa a valer
-- para QUALQUER caminho que grave uma fonte — onboarding, tela do imóvel ou
-- operação manual no banco.
--
-- net.http_post é assíncrono: o INSERT não espera o feed externo responder.
-- =============================================================================

CREATE OR REPLACE FUNCTION private.tg_ical_source_sync_now()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public
AS $$
BEGIN
  IF NEW.active THEN
    PERFORM private.call_job(
      'job-sync-ical',
      jsonb_build_object('property_id', NEW.property_id)
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_ical_source_sync_on_insert
  AFTER INSERT ON public.property_ical_sources
  FOR EACH ROW
  EXECUTE FUNCTION private.tg_ical_source_sync_now();

-- `UPDATE OF url, active` é o que impede o laço infinito: o próprio
-- job-sync-ical escreve em last_synced_at, last_error, consecutive_fails e
-- events_last_sync ao terminar. Como essas colunas não estão na lista, a
-- gravação do job não redispara o job.
CREATE TRIGGER trg_ical_source_sync_on_url_change
  AFTER UPDATE OF url, active ON public.property_ical_sources
  FOR EACH ROW
  WHEN (NEW.active)
  EXECUTE FUNCTION private.tg_ical_source_sync_now();
