-- =============================================================================
-- 0023 — A diarista não pode nascer proprietária
-- =============================================================================
-- O gatilho de cadastro decide o papel lendo `raw_user_meta_data ->> 'role'`.
-- A edge function cleaner-accept gravava esse dado com outro nome:
--
--   cleaner-accept:  user_metadata: { account_type: "cleaner" }
--   gatilho 0018:    WHEN raw_user_meta_data ->> 'role' = 'cleaner'
--
-- Nomes diferentes, condição nunca verdadeira, `ELSE 'owner'`. Toda diarista
-- que entrava pelo link do convite era criada como PROPRIETÁRIA. Em seguida
-- accept_cleaner_invite inseria 'cleaner' também — e como a prioridade de
-- papel é admin > owner > cleaner, ela resolvia como dona:
--
--   * caía em /painel com a barra do dono (Conversas, Imóveis, Portaria...)
--   * passava no requireRole(req, 'owner') das edge functions, ou seja,
--     conseguiria cadastrar imóvel e gerar convite de diarista
--   * ganhava trial e virava "assinante" nas métricas
--
-- Três camadas de conserto, porque uma só volta a quebrar no próximo typo:
--   1. o gatilho passa a aceitar as duas chaves;
--   2. o aceite do convite remove 'owner' de quem não tem imóvel nenhum —
--      o convite é a fonte autoritativa, não o metadado;
--   3. conserta quem já está no banco.
-- =============================================================================

-- ---- 1. gatilho tolerante às duas chaves ------------------------------------
CREATE OR REPLACE FUNCTION public.tg_handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _trial_days int := COALESCE(public.app_setting('trial_days', '7')::int, 7);
  _code       text;
  _role       public.app_role;
  _is_cleaner boolean;
BEGIN
  LOOP
    _code := upper(substr(public.generate_token(6), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = _code);
  END LOOP;

  _is_cleaner := COALESCE(NEW.raw_user_meta_data ->> 'role', '') = 'cleaner'
              OR COALESCE(NEW.raw_user_meta_data ->> 'account_type', '') = 'cleaner';

  -- Diarista não assina nada: sem trial, ela não entra na varredura de
  -- assinatura nem recebe "seu teste termina em 3 dias" num e-mail sintético
  -- que só existe para dar login e que voltaria como hard bounce.
  INSERT INTO public.profiles (
    user_id, email, full_name, phone_e164,
    trial_started_at, trial_ends_at, subscription_status, referral_code
  ) VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    public.normalize_phone(NEW.raw_user_meta_data ->> 'whatsapp'),
    CASE WHEN _is_cleaner THEN NULL ELSE now() END,
    CASE WHEN _is_cleaner THEN NULL ELSE now() + make_interval(days => _trial_days) END,
    'trialing',
    _code
  )
  ON CONFLICT (user_id) DO NOTHING;

  _role := CASE WHEN _is_cleaner THEN 'cleaner'::public.app_role
                ELSE 'owner'::public.app_role END;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, _role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---- 2. o aceite do convite é a fonte autoritativa --------------------------
-- Remove 'owner' de quem aceita convite e não é dono de imóvel nenhum. Quem
-- TEM imóvel continua dono: existe o caso legítimo do proprietário que também
-- limpa, e ele não pode perder o próprio painel por aceitar um convite.
CREATE OR REPLACE FUNCTION public.tg_connection_demote_pseudo_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.user_roles r
  WHERE r.user_id = NEW.cleaner_id
    AND r.role = 'owner'
    AND NOT EXISTS (
      SELECT 1 FROM public.properties p WHERE p.owner_id = NEW.cleaner_id
    );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_connection_demote_pseudo_owner ON public.connections;
CREATE TRIGGER trg_connection_demote_pseudo_owner
  AFTER INSERT ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_connection_demote_pseudo_owner();

-- ---- 3. conserta quem já está no banco --------------------------------------
DELETE FROM public.user_roles r
WHERE r.role = 'owner'
  AND EXISTS (SELECT 1 FROM public.user_roles c
              WHERE c.user_id = r.user_id AND c.role = 'cleaner')
  AND NOT EXISTS (SELECT 1 FROM public.properties p WHERE p.owner_id = r.user_id);

UPDATE public.profiles p
SET trial_started_at = NULL, trial_ends_at = NULL
WHERE EXISTS (SELECT 1 FROM public.user_roles r
              WHERE r.user_id = p.user_id AND r.role = 'cleaner')
  AND NOT EXISTS (SELECT 1 FROM public.user_roles r
                  WHERE r.user_id = p.user_id AND r.role = 'owner');
