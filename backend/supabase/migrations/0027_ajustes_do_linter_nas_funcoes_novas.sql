-- =============================================================================
-- 0027 — O que o linter apontou nas funções da 0025/0026
-- =============================================================================
-- Dois itens, ambos do código novo:
--
-- 1. `assert_service_role` ficou com search_path mutável. É a função que
--    decide se alguém pode ler senha do Airbnb; ela não pode depender de qual
--    schema o chamador colocou no caminho. `SET search_path = ''` obriga nome
--    qualificado e tira o assunto da mesa.
--
-- 2. Os dois gatilhos novos ficaram executáveis por anon/authenticated via
--    /rest/v1/rpc, pelo mesmo default privilege que causou o problema da 0026.
--    Chamar função de gatilho fora de gatilho já falha sozinho ("trigger
--    functions can only be called as triggers"), então não havia exposição —
--    mas deixar porta destrancada porque o cômodo está vazio é como se perde
--    o hábito de trancar.
--
-- Fica registrado que os gatilhos ANTIGOS (tg_handle_new_user,
-- tg_reservation_to_task e mais uma dúzia) têm a mesma concessão sobrando,
-- pela mesma razão e com o mesmo impacto nulo. Não foram varridos aqui para a
-- migração continuar sendo sobre o que mudou agora.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.assert_service_role()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  _role text := current_setting('role', true);
BEGIN
  IF _role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'acesso_negado';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_service_role() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.tg_extract_airbnb_listing_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_hermes_drop_vault_secret()  FROM PUBLIC, anon, authenticated;
