-- =============================================================================
-- 0028 — A credencial é da CONTA, não do imóvel
-- =============================================================================
-- A 0025 modelou `hermes_credentials` com UNIQUE (property_id, platform), como
-- se cada apartamento tivesse um login próprio. Não tem: uma conta do Airbnb
-- hospeda todos os anúncios daquele anfitrião. Quem tem cinco apartamentos
-- digitaria a MESMA senha cinco vezes, gerando cinco segredos no cofre para o
-- mesmo dado — e, na hora de trocar a senha, teria de lembrar de trocar nos
-- cinco. Um deles ficaria para trás e o agente começaria a falhar num imóvel
-- só, pelo motivo mais difícil de diagnosticar que existe.
--
-- Passa a ser UNIQUE (owner_id, platform). Quem diz QUAIS anúncios o agente
-- atende continua sendo `properties.hermes_enabled`, que já existe: a
-- credencial é a porta, o flag é o cômodo.
--
-- Consequência para o agente: buscar credencial não precisa mais de
-- listing_id. Ele loga uma vez e enxerga todos os anúncios da conta.
--
-- Fica o caso que esta modelagem NÃO cobre, para quem ler depois: o anfitrião
-- que administra imóveis em DUAS contas do Airbnb diferentes. Hoje ele teria
-- de abrir duas contas na HospedePay. Não foi resolvido porque cobrir isso
-- exige uma tabela de vínculo credencial↔imóvel, e a conta dupla é rara o
-- bastante para não pagar essa complexidade agora.
--
-- Duas correções menores viajam junto:
--   * o regex do listing_id passa a aceitar links sem o segmento `/calendar`;
--   * `hermes_messages` ganha `channel`, para o dia em que o Booking entrar.
-- =============================================================================

-- ---- 1. a tabela passa a ser por conta --------------------------------------
ALTER TABLE public.hermes_credentials
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Backfill antes de exigir NOT NULL. Hoje a tabela está vazia (a credencial de
-- teste da 0025 foi apagada), mas a migração não pode contar com isso.
UPDATE public.hermes_credentials c
SET owner_id = p.owner_id
FROM public.properties p
WHERE p.id = c.property_id AND c.owner_id IS NULL;

-- Se o mesmo dono tiver mais de uma linha (um por imóvel, do modelo antigo),
-- sobra a mais recente: é a que reflete a última senha digitada.
DELETE FROM public.hermes_credentials a
USING public.hermes_credentials b
WHERE a.owner_id = b.owner_id
  AND a.platform = b.platform
  AND a.updated_at < b.updated_at;

ALTER TABLE public.hermes_credentials
  ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE public.hermes_credentials
  DROP CONSTRAINT IF EXISTS hermes_credentials_property_id_platform_key;

-- property_id vira histórico: por qual imóvel o dono entrou nesta tela. Não é
-- mais chave de nada, e por isso passa a aceitar nulo.
ALTER TABLE public.hermes_credentials
  ALTER COLUMN property_id DROP NOT NULL;

ALTER TABLE public.hermes_credentials
  ADD CONSTRAINT hermes_credentials_owner_platform_key UNIQUE (owner_id, platform);

CREATE INDEX IF NOT EXISTS hermes_credentials_owner_idx
  ON public.hermes_credentials (owner_id);

COMMENT ON COLUMN public.hermes_credentials.property_id IS
  'Imóvel a partir de cuja tela o dono cadastrou. Informativo apenas — a '
  'credencial vale para a CONTA inteira. Quem liga/desliga por imóvel é '
  'properties.hermes_enabled.';


-- ---- 2. RLS acompanha a mudança de dono ------------------------------------
DROP POLICY IF EXISTS "hermes: dono lê o estado" ON public.hermes_credentials;
CREATE POLICY "hermes: dono lê o estado"
  ON public.hermes_credentials FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "hermes: dono revoga" ON public.hermes_credentials;
CREATE POLICY "hermes: dono revoga"
  ON public.hermes_credentials FOR DELETE
  TO authenticated
  USING (owner_id = auth.uid());


-- ---- 3. apagar a credencial desliga TODOS os imóveis daquele dono ----------
CREATE OR REPLACE FUNCTION public.tg_hermes_drop_vault_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.secret_id;
  IF OLD.otp_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.otp_secret_id;
  END IF;

  -- Antes desligava um imóvel só. Com a credencial valendo para a conta, o
  -- que sobrava eram imóveis marcados como "atendendo" sem senha para logar.
  UPDATE public.properties SET hermes_enabled = false WHERE owner_id = OLD.owner_id;

  INSERT INTO public.audit_log (actor_id, action, entity, entity_id, metadata)
  VALUES (auth.uid(), 'hermes.revogado', 'auth.users', OLD.owner_id::text,
          jsonb_build_object('platform', OLD.platform, 'login', OLD.login));

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_hermes_drop_vault_secret() FROM PUBLIC, anon, authenticated;


-- ---- 4. gravar: sem property_id na chave -----------------------------------
DROP FUNCTION IF EXISTS public.hermes_save_credentials(uuid, uuid, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.hermes_save_credentials(
  _owner_id    uuid,
  _platform    text,
  _login       text,
  _password    text,
  _otp_secret  text,
  _ip          text,
  _user_agent  text,
  _enable_property_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _term uuid; _existing public.hermes_credentials;
  _secret uuid; _otp uuid; _name text;
BEGIN
  PERFORM public.assert_service_role();

  SELECT id INTO _term FROM public.term_versions
  WHERE kind = 'hermes_credencial' AND locale = 'pt' AND active
  ORDER BY published_at DESC LIMIT 1;
  IF _term IS NULL THEN RAISE EXCEPTION 'termo_indisponivel'; END IF;

  -- Ligar um imóvel exige que ele seja do dono. Sem esta checagem, um
  -- _enable_property_id qualquer marcaria imóvel alheio como atendido.
  IF _enable_property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.properties
    WHERE id = _enable_property_id AND owner_id = _owner_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'imovel_nao_e_seu';
  END IF;

  SELECT * INTO _existing FROM public.hermes_credentials
  WHERE owner_id = _owner_id AND platform = _platform;

  _name := format('hermes/%s/%s', _platform, _owner_id);

  IF _existing.id IS NULL THEN
    _secret := vault.create_secret(_password, _name, 'Senha do canal para atendimento automatico');
    IF _otp_secret IS NOT NULL AND _otp_secret <> '' THEN
      _otp := vault.create_secret(_otp_secret, _name || '/totp', 'Semente TOTP (2FA)');
    END IF;

    INSERT INTO public.hermes_credentials (
      owner_id, property_id, platform, login, secret_id, otp_secret_id,
      status, term_version_id, term_accepted_ip, term_user_agent
    ) VALUES (
      _owner_id, _enable_property_id, _platform, _login, _secret, _otp,
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

  IF _enable_property_id IS NOT NULL THEN
    UPDATE public.properties SET hermes_enabled = true WHERE id = _enable_property_id;
  END IF;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata, ip)
  VALUES (_owner_id, 'owner', 'hermes.credencial_gravada', 'auth.users', _owner_id::text,
          jsonb_build_object('platform', _platform, 'login', _login, 'termo', _term),
          nullif(_ip, '')::inet);

  RETURN _owner_id;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_save_credentials(uuid, text, text, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_save_credentials(uuid, text, text, text, text, text, text, uuid) TO service_role;


-- ---- 5. ler: o agente não precisa mais dizer qual imóvel --------------------
DROP FUNCTION IF EXISTS public.hermes_agent_credentials(uuid, text);

CREATE OR REPLACE FUNCTION public.hermes_agent_credentials(_owner_id uuid, _platform text DEFAULT 'airbnb')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _c public.hermes_credentials; _password text; _totp text;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _c FROM public.hermes_credentials
  WHERE owner_id = _owner_id AND platform = _platform AND revoked_at IS NULL;
  IF _c.id IS NULL THEN RETURN NULL; END IF;

  -- Credencial existe mas nenhum imóvel ligado: entregar a senha não teria
  -- para que servir, e uma senha entregue à toa é uma senha a mais em trânsito.
  IF NOT EXISTS (
    SELECT 1 FROM public.properties
    WHERE owner_id = _owner_id AND hermes_enabled AND archived_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO _password FROM vault.decrypted_secrets WHERE id = _c.secret_id;
  IF _c.otp_secret_id IS NOT NULL THEN
    SELECT decrypted_secret INTO _totp FROM vault.decrypted_secrets WHERE id = _c.otp_secret_id;
  END IF;

  UPDATE public.hermes_credentials
  SET last_access_at = now(), access_count = access_count + 1 WHERE id = _c.id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (NULL, NULL, 'hermes.credencial_lida', 'auth.users', _owner_id::text,
          jsonb_build_object('platform', _c.platform, 'login', _c.login));

  RETURN jsonb_build_object(
    'login', _c.login, 'password', _password, 'totp_secret', _totp,
    'listings', (SELECT coalesce(jsonb_agg(airbnb_listing_id), '[]'::jsonb)
                 FROM public.properties
                 WHERE owner_id = _owner_id AND hermes_enabled
                   AND archived_at IS NULL AND airbnb_listing_id IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_credentials(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_credentials(uuid, text) TO service_role;


-- ---- 6. o regex aceita link sem /calendar ----------------------------------
-- Visto no campo: além de .../calendar/ical/<id>.ics, o Airbnb serve
-- .../ical/<id>.ics. Ancorar em /ical/ cobre os dois sem afrouxar — continua
-- exigindo só dígitos e a extensão.
CREATE OR REPLACE FUNCTION public.tg_extract_airbnb_listing_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _listing text;
BEGIN
  IF NEW.provider::text <> 'airbnb' THEN RETURN NULL; END IF;

  _listing := substring(NEW.url FROM '/ical/([0-9]+)\.ics');
  IF _listing IS NULL THEN RETURN NULL; END IF;

  UPDATE public.properties SET airbnb_listing_id = _listing
  WHERE id = NEW.property_id AND airbnb_listing_id IS DISTINCT FROM _listing;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_extract_airbnb_listing_id() FROM PUBLIC, anon, authenticated;

UPDATE public.properties p
SET airbnb_listing_id = substring(s.url FROM '/ical/([0-9]+)\.ics')
FROM public.property_ical_sources s
WHERE s.property_id = p.id AND s.provider::text = 'airbnb'
  AND p.airbnb_listing_id IS NULL
  AND substring(s.url FROM '/ical/([0-9]+)\.ics') IS NOT NULL;


-- ---- 7. hermes_messages: de qual canal veio ---------------------------------
ALTER TABLE public.hermes_messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'airbnb'
    CHECK (channel IN ('airbnb', 'booking'));

COMMENT ON TABLE public.hermes_messages IS
  'Uma LINHA POR MENSAGEM, com direction. Não use colunas pareadas '
  '(guest_message/agent_reply): o hóspede manda três mensagens seguidas antes '
  'de qualquer resposta, e o agente às vezes fala primeiro (lembrete de '
  'check-in). Par forçado gera NULL dos dois lados e perde a ordem real.';
