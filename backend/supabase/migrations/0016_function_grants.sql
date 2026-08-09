-- =============================================================================
-- 0016 — Fechamento de privilégios de execução (correção importante)
-- =============================================================================
-- No Postgres, toda função nasce com EXECUTE concedido a PUBLIC. Um
--     REVOKE EXECUTE ON FUNCTION f FROM anon, authenticated;
-- NÃO remove o acesso, porque esses papéis continuam herdando o privilégio de
-- PUBLIC. As migrations anteriores usaram essa forma; esta corrige o padrão de
-- verdade:
--
--     REVOKE ... FROM PUBLIC  ->  depois GRANT explícito a quem precisa.
--
-- Sem isto, funções SECURITY DEFINER como resolve_guest_session() e
-- enqueue_notification() ficariam chamáveis por qualquer cliente anônimo com a
-- chave pública. O token de sessão do hóspede tem 32 bytes aleatórios (não é
-- adivinhável), mas "difícil de adivinhar" não é controle de acesso.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Somente service_role (edge functions e jobs). Ninguém mais.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
  internal_only text[] := ARRAY[
    'public.resolve_guest_session(text)',
    'public.accept_cleaner_invite(text, uuid)',
    'public.enqueue_notification(public.notification_channel, text, jsonb, text, text, uuid, text, text, text, text, timestamptz)',
    'public.claim_notifications(integer)',
    'public.fail_notification(uuid, text)',
    'public.generate_token(integer)',
    'public.hash_token(text)'
  ];
BEGIN
  FOREACH fn IN ARRAY internal_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Usuário logado (a própria função já filtra por auth.uid() ou is_admin()).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
  authed_only text[] := ARRAY[
    'public.has_role(uuid, public.app_role)',
    'public.is_admin()',
    'public.assert_admin()',
    'public.subscription_is_active(uuid)',
    'public.connected_user_ids(uuid)',
    'public.connected_profiles()',
    'public.plan_limit(uuid)',
    'public.my_activation()',
    'public.owner_month_summary(date, uuid)',
    'public.admin_kpis()',
    'public.admin_activation_funnel()',
    'public.admin_system_health()',
    'public.admin_timeseries(integer)',
    'public.admin_subscriber_detail(uuid)',
    'public.admin_subscribers(text, public.subscription_status, public.plan_tier, boolean, text, integer, integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY authed_only LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Público de propósito: o hóspede consulta o código de indicação antes de ter
-- conta. Devolve só id e primeiro nome — nunca a linha do perfil.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.lookup_referral(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_referral(text) TO anon, authenticated, service_role;

-- Helpers puros usados dentro de views e policies: leitura inofensiva.
REVOKE ALL ON FUNCTION public.app_today() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_tz() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_now() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_setting(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_today() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_tz() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_now() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_setting(text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- Esquema private (config dos jobs) — inacessível fora do service_role.
-- -----------------------------------------------------------------------------
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.call_job(text, jsonb) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Tabelas de configuração: leitura só por quem precisa.
-- app_settings e audit_log têm RLS ligada e nenhuma policy permissiva, então já
-- estão fechadas para anon/authenticated — mas revogamos o privilégio de tabela
-- também, para não depender só da RLS.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.app_settings FROM anon, authenticated;
REVOKE ALL ON public.audit_log FROM anon;

-- Admin lê a auditoria pelo painel.
CREATE POLICY "audit_log: admin lê"
  ON public.audit_log FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT ON public.audit_log TO authenticated;

-- -----------------------------------------------------------------------------
-- Defaults para funções criadas depois desta migration: nascem fechadas.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMENT ON SCHEMA private IS
  'Configuração operacional (segredo do cron, URL das functions). Fora do PostgREST.';
