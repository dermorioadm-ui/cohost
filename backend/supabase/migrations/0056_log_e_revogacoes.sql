-- O braço de escrita e o de leitura do registro de sistema, e a revogação dos
-- EXECUTE que o DEFAULT PRIVILEGES do projeto dá a `anon` em toda função nova.

BEGIN;

-- Grava uma linha de log em nome do admin logado. A checagem vem antes da
-- escrita: quem não é admin não escreve linha nenhuma.
CREATE OR REPLACE FUNCTION public.registrar_no_log(
  _origem text, _acao text, _alvo text DEFAULT NULL, _detalhe text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.assert_admin();
  INSERT INTO public.system_log (origem, acao, ator, alvo, detalhe)
  VALUES (_origem, _acao, auth.uid(), _alvo, _detalhe);
END $$;

REVOKE ALL ON FUNCTION public.registrar_no_log(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_no_log(text, text, text, text) TO authenticated;

-- Leitura unificada: o registro de sistema junta as duas trilhas que já
-- existem — o `audit_log` (admin entrou na conta de um assinante, gravado
-- pela `admin_registra_visita` desde antes) e o `system_log` novo (erro
-- interno de function, expurgo da retenção). Uma tela, uma linha do tempo.
DROP FUNCTION IF EXISTS public.log_do_sistema(integer);

CREATE FUNCTION public.log_do_sistema(_limite integer DEFAULT 100)
RETURNS TABLE (origem text, acao text, ator_nome text, alvo text, detalhe text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM (
    SELECT l.origem, l.acao,
           (SELECT p.full_name FROM public.profiles p WHERE p.user_id = l.ator) AS ator_nome,
           l.alvo, l.detalhe, l.created_at
      FROM public.system_log l
     WHERE public.is_admin()
    UNION ALL
    SELECT 'admin', a.action,
           (SELECT p.full_name FROM public.profiles p WHERE p.user_id = a.actor_id),
           COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.user_id::text = a.entity_id), a.entity_id),
           a.metadata->>'motivo', a.created_at
      FROM public.audit_log a
     WHERE public.is_admin()
  ) t
  ORDER BY t.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limite, 100), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.log_do_sistema(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_do_sistema(integer) TO authenticated;

-- Revogações apontadas pelo linter: funções SECURITY DEFINER que `anon` podia
-- executar por herança do DEFAULT PRIVILEGES. As admin_* já se guardavam por
-- dentro (assert_admin), mas grant que não é usado é superfície à toa — e
-- porter_totp executável por anônimo é o tipo de coisa que não se explica.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS assinatura
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'admin_activation_funnel','admin_kpis','admin_subscriber_detail','admin_subscribers',
         'admin_system_health','admin_timeseries','assert_admin','can_access_cleaning_photo',
         'connected_profiles','lookup_referral','my_activation','my_cleaning_properties',
         'owner_month_summary','plan_limit','tg_cleaner_fees_guard','tg_cleaning_completed_notify',
         'tg_cleaning_tasks_guard','tg_connection_demote_pseudo_owner','tg_enforce_property_limit',
         'tg_handle_new_user','tg_profiles_guard_billing','tg_property_propagate',
         'tg_reservation_notify_condo','tg_reservation_to_task',
         'porter_b32decode','porter_totp','mrr_cents','build_ai_prompt',
         'generate_token','hash_token','tg_profiles_normalize',
         'tg_properties_sync_prompt','tg_set_listing_id','tg_set_updated_at')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f.assinatura);
  END LOOP;
END $$;

COMMIT;
