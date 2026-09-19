-- Fechar o SaaS não encerra jurídico; fecha novas operações da ferramenta.
-- Trigger cobre REST e RPCs SECURITY DEFINER, mantendo jobs service_role e
-- operação administrativa. Não apaga dados nem impede a leitura do histórico.
CREATE FUNCTION public.tg_require_software_for_owner_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin()
    AND public.has_role(auth.uid(),'owner') AND NOT public.subscription_is_active(auth.uid()) THEN
    RAISE EXCEPTION 'software_subscription_required' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.tg_require_software_for_owner_write() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['properties','property_ical_sources','cleaner_invites','connections','cleaning_tasks','porter_accounts'] LOOP
    EXECUTE format('CREATE TRIGGER require_software_for_owner_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tg_require_software_for_owner_write()',t);
  END LOOP;
END $$;
