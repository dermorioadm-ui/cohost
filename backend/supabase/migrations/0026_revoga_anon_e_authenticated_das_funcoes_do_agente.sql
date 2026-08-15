-- =============================================================================
-- 0026 — REVOKE FROM PUBLIC não bastava
-- =============================================================================
-- A 0025 fechou as funções do agente com o par de comandos que parece óbvio:
--
--   REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION ... TO service_role;
--
-- Não fechou nada. O Supabase mantém ALTER DEFAULT PRIVILEGES concedendo
-- EXECUTE a `anon`, `authenticated` e `service_role` em toda função criada no
-- schema public. Essas concessões são EXPLÍCITAS, e revogar de PUBLIC não
-- toca em concessão explícita — PUBLIC é um bucket próprio, não "todo mundo".
-- A ACL real ficava assim:
--
--   {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, ...}
--
-- Consequência medida em produção, não suposta: com o papel `authenticated`,
--
--   SELECT public.hermes_agent_credentials('<uuid do dono>', '<id do anuncio>');
--
-- devolvia login, senha e semente TOTP em texto puro. Como o uuid do dono é
-- PARÂMETRO — as funções confiam em quem chama porque só service_role deveria
-- chamar — qualquer usuário logado, inclusive uma diarista, poderia ler a
-- senha do Airbnb de QUALQUER proprietário sabendo dois identificadores. Era o
-- pior vazamento que este banco já teve, e durou uma migração.
--
-- Duas camadas agora, porque a lição da 0023 é que uma só volta a quebrar:
--
--   1. REVOKE nominal de anon e authenticated (o que realmente fecha a porta);
--   2. um porteiro dentro de cada função, que recusa quem não for service_role
--      mesmo que um GRANT volte por descuido no futuro.
--
-- REGRA para quem escrever a próxima função sensível neste schema: revogar de
-- PUBLIC não protege nada aqui. Revogue de `anon` e `authenticated` pelo nome.
-- =============================================================================

REVOKE ALL ON FUNCTION public.hermes_save_credentials(uuid, uuid, text, text, text, text, text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.hermes_agent_credentials(uuid, text)                                    FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.hermes_agent_context(uuid, text)                                        FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.hermes_agent_log(uuid, text, text, text, text, text)                    FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.hermes_agent_report_failure(uuid, text, text)                           FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_agent_key(text)                                                  FROM anon, authenticated;

-- A diarista precisa desta; o visitante anônimo, não. auth.uid() nulo já
-- devolveria zero linhas, mas função sensível não deve depender de sorte.
REVOKE ALL ON FUNCTION public.my_cleaning_properties() FROM anon;


-- ---- porteiro ---------------------------------------------------------------
-- Dentro de uma função SECURITY DEFINER, current_user vira o dono (postgres),
-- então ele não serve para saber quem chamou. O papel que o PostgREST assumiu
-- continua legível na GUC `role`.
CREATE OR REPLACE FUNCTION public.assert_service_role()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  _role text := current_setting('role', true);
BEGIN
  -- 'none' aparece em conexão direta (psql, migração, cron), que já é
  -- superusuário e legítima. O que precisa ser barrado é anon e authenticated.
  IF _role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'acesso_negado';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_service_role() FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.hermes_agent_credentials(_owner_id uuid, _listing_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _c public.hermes_credentials; _prop uuid; _password text; _totp text;
BEGIN
  PERFORM public.assert_service_role();

  SELECT id INTO _prop FROM public.properties
  WHERE airbnb_listing_id = _listing_id AND owner_id = _owner_id
    AND archived_at IS NULL AND hermes_enabled;
  IF _prop IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _c FROM public.hermes_credentials
  WHERE property_id = _prop AND platform = 'airbnb' AND revoked_at IS NULL;
  IF _c.id IS NULL THEN RETURN NULL; END IF;

  SELECT decrypted_secret INTO _password FROM vault.decrypted_secrets WHERE id = _c.secret_id;
  IF _c.otp_secret_id IS NOT NULL THEN
    SELECT decrypted_secret INTO _totp FROM vault.decrypted_secrets WHERE id = _c.otp_secret_id;
  END IF;

  UPDATE public.hermes_credentials
  SET last_access_at = now(), access_count = access_count + 1 WHERE id = _c.id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (NULL, NULL, 'hermes.credencial_lida', 'properties', _prop,
          jsonb_build_object('platform', _c.platform, 'login', _c.login));

  RETURN jsonb_build_object('login', _c.login, 'password', _password,
                            'totp_secret', _totp, 'property_id', _prop);
END; $$;

REVOKE ALL ON FUNCTION public.hermes_agent_credentials(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_credentials(uuid, text) TO service_role;


CREATE OR REPLACE FUNCTION public.hermes_save_credentials(
  _property_id uuid, _owner_id uuid, _platform text, _login text,
  _password text, _otp_secret text, _ip text, _user_agent text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _term uuid; _existing public.hermes_credentials;
  _secret uuid; _otp uuid; _name text;
BEGIN
  PERFORM public.assert_service_role();

  IF NOT EXISTS (SELECT 1 FROM public.properties
                 WHERE id = _property_id AND owner_id = _owner_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'imovel_nao_e_seu';
  END IF;

  SELECT id INTO _term FROM public.term_versions
  WHERE kind = 'hermes_credencial' AND locale = 'pt' AND active
  ORDER BY published_at DESC LIMIT 1;
  IF _term IS NULL THEN RAISE EXCEPTION 'termo_indisponivel'; END IF;

  SELECT * INTO _existing FROM public.hermes_credentials
  WHERE property_id = _property_id AND platform = _platform;

  _name := format('hermes/%s/%s', _platform, _property_id);

  IF _existing.id IS NULL THEN
    _secret := vault.create_secret(_password, _name, 'Senha do canal para atendimento automatico');
    IF _otp_secret IS NOT NULL AND _otp_secret <> '' THEN
      _otp := vault.create_secret(_otp_secret, _name || '/totp', 'Semente TOTP (2FA)');
    END IF;
    INSERT INTO public.hermes_credentials (
      property_id, platform, login, secret_id, otp_secret_id,
      status, term_version_id, term_accepted_ip, term_user_agent
    ) VALUES (
      _property_id, _platform, _login, _secret, _otp,
      'pendente', _term, nullif(_ip, '')::inet, _user_agent
    );
  ELSE
    PERFORM vault.update_secret(_existing.secret_id, _password, _name, NULL, NULL);
    IF _otp_secret IS NOT NULL AND _otp_secret <> '' THEN
      IF _existing.otp_secret_id IS NULL THEN
        _otp := vault.create_secret(_otp_secret, _name || '/totp', 'Semente TOTP (2FA)');
      ELSE
        _otp := _existing.otp_secret_id;
        PERFORM vault.update_secret(_otp, _otp_secret, _name || '/totp', NULL, NULL);
      END IF;
    ELSE
      _otp := _existing.otp_secret_id;
    END IF;
    UPDATE public.hermes_credentials SET
      login = _login, otp_secret_id = _otp, status = 'pendente',
      last_error = NULL, revoked_at = NULL,
      term_version_id = _term, term_accepted_at = now(),
      term_accepted_ip = nullif(_ip, '')::inet, term_user_agent = _user_agent,
      updated_at = now()
    WHERE id = _existing.id;
  END IF;

  UPDATE public.properties SET hermes_enabled = true WHERE id = _property_id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata, ip)
  VALUES (_owner_id, 'owner', 'hermes.credencial_gravada', 'properties', _property_id,
          jsonb_build_object('platform', _platform, 'login', _login, 'termo', _term),
          nullif(_ip, '')::inet);

  RETURN _property_id;
END; $$;

REVOKE ALL ON FUNCTION public.hermes_save_credentials(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_save_credentials(uuid, uuid, text, text, text, text, text, text) TO service_role;


CREATE OR REPLACE FUNCTION public.hermes_agent_context(_owner_id uuid, _listing_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _p public.properties; _r jsonb;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _p FROM public.properties
  WHERE airbnb_listing_id = _listing_id AND owner_id = _owner_id
    AND archived_at IS NULL AND hermes_enabled;
  IF _p.id IS NULL THEN RETURN NULL; END IF;

  SELECT to_jsonb(x) INTO _r FROM (
    SELECT r.guest_label, r.checkin_date, r.checkout_date, r.provider, r.status
    FROM public.reservations r
    WHERE r.property_id = _p.id AND r.checkout_date >= public.app_today()
      AND r.status::text <> 'cancelled'
    ORDER BY r.checkin_date LIMIT 1
  ) x;

  RETURN jsonb_build_object(
    'property_id', _p.id, 'name', _p.name, 'neighborhood', _p.neighborhood,
    'checkin_time', _p.checkin_time, 'checkout_time', _p.checkout_time,
    'prompt', _p.ai_prompt, 'ai_config', _p.ai_config, 'reserva_atual', _r
  );
END; $$;

REVOKE ALL ON FUNCTION public.hermes_agent_context(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_context(uuid, text) TO service_role;


CREATE OR REPLACE FUNCTION public.hermes_agent_log(
  _owner_id uuid, _listing_id text, _thread_ref text,
  _direction text, _guest_name text, _content text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _prop uuid; _id uuid;
BEGIN
  PERFORM public.assert_service_role();

  SELECT id INTO _prop FROM public.properties
  WHERE airbnb_listing_id = _listing_id AND owner_id = _owner_id AND archived_at IS NULL;
  IF _prop IS NULL THEN RAISE EXCEPTION 'imovel_nao_encontrado'; END IF;

  INSERT INTO public.hermes_messages (property_id, thread_ref, direction, guest_name, content)
  VALUES (_prop, _thread_ref, _direction, _guest_name, _content)
  RETURNING id INTO _id;

  UPDATE public.hermes_credentials
  SET status = 'ativo', last_verified_at = now(), last_error = NULL
  WHERE property_id = _prop AND status <> 'ativo';

  RETURN _id;
END; $$;

REVOKE ALL ON FUNCTION public.hermes_agent_log(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_log(uuid, text, text, text, text, text) TO service_role;


CREATE OR REPLACE FUNCTION public.hermes_agent_report_failure(
  _owner_id uuid, _listing_id text, _error text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _prop uuid; _name text; _email text;
BEGIN
  PERFORM public.assert_service_role();

  SELECT p.id, p.name INTO _prop, _name FROM public.properties p
  WHERE p.airbnb_listing_id = _listing_id AND p.owner_id = _owner_id;
  IF _prop IS NULL THEN RETURN; END IF;

  UPDATE public.hermes_credentials
  SET status = 'falhou', last_error = left(_error, 500) WHERE property_id = _prop;

  SELECT email INTO _email FROM public.profiles WHERE user_id = _owner_id;
  IF _email IS NULL THEN RETURN; END IF;

  INSERT INTO public.notifications (
    channel, template, to_email, to_user_id, payload, entity, entity_id, idempotency_key
  ) VALUES (
    'email', 'hermes-falhou', _email, _owner_id,
    jsonb_build_object('property_name', _name, 'error', left(_error, 200)),
    'properties', _prop,
    format('hermes-falhou:%s:%s', _prop, public.app_today())
  ) ON CONFLICT (idempotency_key) DO NOTHING;
END; $$;

REVOKE ALL ON FUNCTION public.hermes_agent_report_failure(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_report_failure(uuid, text, text) TO service_role;


CREATE OR REPLACE FUNCTION public.verify_agent_key(_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _owner uuid;
BEGIN
  PERFORM public.assert_service_role();

  IF _key IS NULL OR length(_key) < 32 THEN RETURN NULL; END IF;
  SELECT owner_id INTO _owner FROM public.agent_api_keys
  WHERE key_hash = public.hash_token(_key) AND revoked_at IS NULL;
  IF _owner IS NOT NULL THEN
    UPDATE public.agent_api_keys SET last_used_at = now()
    WHERE key_hash = public.hash_token(_key);
  END IF;
  RETURN _owner;
END; $$;

REVOKE ALL ON FUNCTION public.verify_agent_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_agent_key(text) TO service_role;
