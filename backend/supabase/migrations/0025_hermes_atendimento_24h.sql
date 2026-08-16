-- =============================================================================
-- 0025 — Atendimento 24h (Hermes): credencial do canal, termo e acesso do agente
-- =============================================================================
-- O dono que quiser atendimento automático no chat do Airbnb entrega login e
-- senha da conta dele. Isso é um dado de outra ordem de risco do que qualquer
-- coisa que este banco já guardou: com ele se responde hóspede, se altera
-- anúncio, se cancela reserva e se mexe em conta bancária. O desenho abaixo
-- parte da premissa de que essa senha VAI vazar se ficar numa coluna, e trata
-- disso em vez de confiar no bom comportamento de quem consulta.
--
-- Três decisões, e o porquê de cada uma:
--
-- 1. A SENHA NÃO MORA NESTA TABELA. Ela vai para o Vault do Supabase, e a
--    tabela guarda só o uuid do segredo. `vault.decrypted_secrets` tem SELECT
--    concedido a `service_role` e a mais ninguém — nem `authenticated`, nem
--    `anon`. Então a senha é ilegível para o navegador do próprio dono: ele
--    escreve e nunca mais lê. Um `select *` com o token dele devolve um uuid
--    que não abre nada. É a mesma classe de falha da 0022 (diarista lendo
--    fechadura), resolvida antes de existir em vez de depois.
--
-- 2. Hash não serve aqui. Senha de login de terceiro precisa ser REVERSÍVEL —
--    o agente tem que digitá-la no Airbnb. Quem espera `crypt()` nesta tabela
--    está pensando em senha de autenticação nossa, que é outro problema.
--
-- 3. O CONSENTIMENTO É REGISTRADO NO MESMO ATO. As colunas de termo espelham
--    `guest_registrations` (term_version_id, aceito em, ip, user agent) porque
--    o que se prova em disputa não é "ele aceitou um dia", é "ele aceitou ESTE
--    texto no instante em que entregou ESTA senha". Sem aceite não há linha:
--    a função de gravação exige o term_version_id ativo.
--
-- O agente roda numa VPS, sem sessão de usuário, então entra por chave de
-- máquina (`agent_api_keys`) — guardada como hash, revogável, e com toda
-- leitura de senha carimbada em `audit_log`.
-- =============================================================================


-- ---- 1. termos ganham assunto ----------------------------------------------
-- `term_versions` nasceu só para o cadastro do hóspede e a unicidade era
-- (version, locale). Com um segundo termo no sistema, "1.0/pt" passa a existir
-- duas vezes com textos diferentes — a chave precisa incluir o assunto.
ALTER TABLE public.term_versions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cadastro_hospede';

ALTER TABLE public.term_versions
  DROP CONSTRAINT IF EXISTS term_versions_version_locale_key;

CREATE UNIQUE INDEX IF NOT EXISTS term_versions_kind_version_locale_key
  ON public.term_versions (kind, version, locale);

-- Mesma história com "só um termo ativo por idioma": a regra valia quando
-- existia um assunto só. Agora o vigente é um por assunto POR idioma, senão
-- publicar o termo do Hermes desativaria o termo do check-in do hóspede.
DROP INDEX IF EXISTS public.uq_term_active_per_locale;

CREATE UNIQUE INDEX IF NOT EXISTS uq_term_active_per_kind_locale
  ON public.term_versions (kind, locale) WHERE active;

COMMENT ON COLUMN public.term_versions.kind IS
  'Assunto do termo: cadastro_hospede (check-in) ou hermes_credencial '
  '(entrega de login e senha do canal). Nunca reaproveite uma linha para outro '
  'assunto: o aceite guardado aponta para o id e o texto tem de ficar imutável.';


-- ---- 2. o texto do termo ----------------------------------------------------
-- Escrito para ser lido por quem está com o dedo no botão, não para ser
-- ignorado: cada item diz uma consequência concreta.
INSERT INTO public.term_versions (kind, version, locale, title, body, active)
VALUES (
  'hermes_credencial',
  '1.0',
  'pt',
  'Termo de Uso e Responsabilidade — Atendimento Automático 24h',
$termo$Ao ativar o Atendimento Automático 24h, você autoriza a HospedePay a acessar sua conta na plataforma de hospedagem (Airbnb e/ou Booking) usando as credenciais que você fornecer, com a finalidade única de ler e responder mensagens de hóspedes referentes ao imóvel que você indicou.

1. NATUREZA DO ACESSO
As plataformas de hospedagem não oferecem acesso automatizado público às suas mensagens. O atendimento automático é feito acessando sua conta como se fosse você. Você declara estar ciente de que esse tipo de acesso pode contrariar os Termos de Serviço da plataforma e de que a decisão de ativá-lo é sua.

2. RISCO DE BLOQUEIO — ISENÇÃO DE RESPONSABILIDADE
Você declara estar ciente e assume integralmente o risco de que a plataforma de hospedagem possa, a seu exclusivo critério e sem aviso prévio:
   a) suspender, limitar, bloquear ou encerrar sua conta;
   b) despublicar, rebaixar ou reduzir a visibilidade dos seus anúncios;
   c) remover selos, categorias ou benefícios como Superhost;
   d) reter, atrasar ou cancelar repasses financeiros;
   e) exigir verificação adicional de identidade.

A HospedePay NÃO se responsabiliza por nenhuma dessas consequências, nem por lucros cessantes, reservas perdidas, cancelamentos, danos à reputação ou quaisquer prejuízos diretos ou indiretos delas decorrentes.

3. CONTEÚDO DAS RESPOSTAS
O atendimento é gerado por inteligência artificial a partir das informações que você cadastrou sobre o imóvel. A HospedePay não garante exatidão, adequação ou oportunidade das respostas e não se responsabiliza por informações incorretas, compromissos assumidos com hóspedes, descontos, autorizações, liberações de acesso ou qualquer obrigação criada em seu nome. A responsabilidade perante o hóspede e perante a plataforma permanece sua.

4. GUARDA DAS CREDENCIAIS
Suas credenciais são armazenadas cifradas, em cofre separado do banco de dados da aplicação, e são usadas exclusivamente para a finalidade descrita neste termo. Elas não são exibidas de volta a você, à nossa equipe de atendimento, nem a qualquer outro usuário. Ainda assim, nenhum armazenamento é infalível: você declara ciência de que confiar credenciais a terceiros envolve risco residual e que optou por assumi-lo.

5. REVOGAÇÃO
Você pode desativar o atendimento automático a qualquer momento pelo painel. A revogação apaga as credenciais dos nossos sistemas e interrompe o serviço. RECOMENDAMOS FORTEMENTE que, ao revogar, você também troque a senha na plataforma de hospedagem e encerre as sessões ativas.

6. ESCOPO
A autorização se limita à leitura e resposta de mensagens. A HospedePay não altera preços, não aceita ou cancela reservas, não modifica anúncios e não movimenta valores.

7. VERACIDADE E TITULARIDADE
Você declara ser o titular da conta informada ou possuir autorização expressa do titular para conceder este acesso.

Ao marcar a caixa de aceite, você declara que leu, compreendeu e concorda com todos os itens acima.$termo$,
  true
)
ON CONFLICT (kind, version, locale) DO NOTHING;


-- ---- 3. o imóvel sabe se está sob atendimento automático --------------------
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS hermes_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS airbnb_listing_id  text;

COMMENT ON COLUMN public.properties.airbnb_listing_id IS
  'Número do anúncio no Airbnb. É a chave que liga uma conversa recebida pelo '
  'agente ao imóvel certo. Extraído do próprio link iCal — o dono nunca digita.';


-- ---- 4. o número do anúncio sai do link que já está salvo -------------------
-- O link do Airbnb é .../calendar/ical/<id>.ics. O dado já estava no banco;
-- faltava lê-lo. Pedir para o dono digitar de novo seria pedir algo que já
-- temos, e com chance de erro de digitação.
CREATE OR REPLACE FUNCTION public.tg_extract_airbnb_listing_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _listing text;
BEGIN
  IF NEW.provider <> 'airbnb' THEN RETURN NULL; END IF;

  _listing := substring(NEW.url FROM 'calendar/ical/([0-9]+)\.ics');
  IF _listing IS NULL THEN RETURN NULL; END IF;

  UPDATE public.properties
  SET airbnb_listing_id = _listing
  WHERE id = NEW.property_id
    AND airbnb_listing_id IS DISTINCT FROM _listing;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_extract_airbnb_listing_id ON public.property_ical_sources;
CREATE TRIGGER trg_extract_airbnb_listing_id
  AFTER INSERT OR UPDATE OF url ON public.property_ical_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_extract_airbnb_listing_id();

UPDATE public.properties p
SET airbnb_listing_id = substring(s.url FROM 'calendar/ical/([0-9]+)\.ics')
FROM public.property_ical_sources s
WHERE s.property_id = p.id
  AND s.provider = 'airbnb'
  AND p.airbnb_listing_id IS NULL
  AND substring(s.url FROM 'calendar/ical/([0-9]+)\.ics') IS NOT NULL;


-- ---- 5. a credencial do canal ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.hermes_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  platform         text NOT NULL DEFAULT 'airbnb' CHECK (platform IN ('airbnb', 'booking')),

  login            text NOT NULL,
  -- Ponteiros para vault.secrets. Um uuid aqui não abre nada: quem não tem
  -- service_role não enxerga vault.decrypted_secrets.
  secret_id        uuid NOT NULL,
  otp_secret_id    uuid,

  status           text NOT NULL DEFAULT 'pendente'
                     CHECK (status IN ('pendente', 'ativo', 'falhou', 'revogado')),
  last_verified_at timestamptz,
  last_error       text,
  last_access_at   timestamptz,
  access_count     integer NOT NULL DEFAULT 0,

  -- O aceite mora junto com a credencial de propósito: o que se prova é o
  -- consentimento no instante da entrega, não um aceite genérico de outro dia.
  term_version_id  uuid NOT NULL REFERENCES public.term_versions(id),
  term_accepted_at timestamptz NOT NULL DEFAULT now(),
  term_accepted_ip inet,
  term_user_agent  text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,

  UNIQUE (property_id, platform)
);

COMMENT ON TABLE public.hermes_credentials IS
  'Credencial do canal para o atendimento automático. NUNCA adicione aqui uma '
  'coluna com a senha em texto: ela vive no Vault e esta tabela guarda só o '
  'uuid. RLS deixa o dono ler a linha justamente porque não há o que ler.';

CREATE INDEX IF NOT EXISTS hermes_credentials_property_idx
  ON public.hermes_credentials (property_id);

ALTER TABLE public.hermes_credentials ENABLE ROW LEVEL SECURITY;

-- O dono lê o ESTADO (conectado? falhou? quando o agente usou pela última
-- vez?) e pode revogar. Não existe policy de INSERT nem de UPDATE: gravar
-- exige levar a senha ao Vault, e isso só a função abaixo sabe fazer.
DROP POLICY IF EXISTS "hermes: dono lê o estado" ON public.hermes_credentials;
CREATE POLICY "hermes: dono lê o estado"
  ON public.hermes_credentials FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = hermes_credentials.property_id AND p.owner_id = auth.uid()
  ));

DROP POLICY IF EXISTS "hermes: dono revoga" ON public.hermes_credentials;
CREATE POLICY "hermes: dono revoga"
  ON public.hermes_credentials FOR DELETE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = hermes_credentials.property_id AND p.owner_id = auth.uid()
  ));

-- Apagar a linha tem de apagar o segredo. Sem isto, "revoguei" viraria uma
-- senha órfã vivendo no Vault para sempre, e o termo promete o contrário.
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

  UPDATE public.properties SET hermes_enabled = false WHERE id = OLD.property_id;

  INSERT INTO public.audit_log (actor_id, action, entity, entity_id, metadata)
  VALUES (auth.uid(), 'hermes.revogado', 'properties', OLD.property_id,
          jsonb_build_object('platform', OLD.platform, 'login', OLD.login));

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_hermes_drop_vault_secret ON public.hermes_credentials;
CREATE TRIGGER trg_hermes_drop_vault_secret
  AFTER DELETE ON public.hermes_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_hermes_drop_vault_secret();


-- ---- 6. gravar a credencial (só service_role) ------------------------------
CREATE OR REPLACE FUNCTION public.hermes_save_credentials(
  _property_id uuid,
  _owner_id    uuid,
  _platform    text,
  _login       text,
  _password    text,
  _otp_secret  text,
  _ip          text,
  _user_agent  text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _term      uuid;
  _existing  public.hermes_credentials;
  _secret    uuid;
  _otp       uuid;
  _name      text;
BEGIN
  -- A dona da decisão é a propriedade, não quem chamou: mesmo com
  -- service_role, gravar credencial de imóvel alheio é erro de programação e
  -- tem de estourar aqui.
  IF NOT EXISTS (
    SELECT 1 FROM public.properties
    WHERE id = _property_id AND owner_id = _owner_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'imovel_nao_e_seu';
  END IF;

  SELECT id INTO _term FROM public.term_versions
  WHERE kind = 'hermes_credencial' AND locale = 'pt' AND active
  ORDER BY published_at DESC LIMIT 1;

  IF _term IS NULL THEN RAISE EXCEPTION 'termo_indisponivel'; END IF;

  SELECT * INTO _existing FROM public.hermes_credentials
  WHERE property_id = _property_id AND platform = _platform;

  -- Trocar a senha reaproveita o segredo do Vault. Criar um novo e reapontar
  -- deixaria o antigo órfão — o Vault não tem coleta de lixo.
  _name := format('hermes/%s/%s', _platform, _property_id);

  IF _existing.id IS NULL THEN
    _secret := vault.create_secret(_password, _name, 'Senha do canal para atendimento automático');
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
      login            = _login,
      otp_secret_id    = _otp,
      status           = 'pendente',
      last_error       = NULL,
      revoked_at       = NULL,
      -- Reaceite: senha nova é entrega nova, e o consentimento é datado.
      term_version_id  = _term,
      term_accepted_at = now(),
      term_accepted_ip = nullif(_ip, '')::inet,
      term_user_agent  = _user_agent,
      updated_at       = now()
    WHERE id = _existing.id;
  END IF;

  UPDATE public.properties SET hermes_enabled = true WHERE id = _property_id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata, ip)
  VALUES (_owner_id, 'owner', 'hermes.credencial_gravada', 'properties', _property_id,
          jsonb_build_object('platform', _platform, 'login', _login, 'termo', _term),
          nullif(_ip, '')::inet);

  RETURN _property_id;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_save_credentials(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hermes_save_credentials(uuid, uuid, text, text, text, text, text, text) TO service_role;


-- ---- 7. chave de máquina do agente -----------------------------------------
-- A VPS não tem sessão de usuário. Chave guardada como hash, exibida uma única
-- vez na criação, revogável, e com o prefixo em claro só para o dono
-- reconhecer qual é qual na tela.
CREATE TABLE IF NOT EXISTS public.agent_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

ALTER TABLE public.agent_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_api_keys: dono lê as suas" ON public.agent_api_keys;
CREATE POLICY "agent_api_keys: dono lê as suas"
  ON public.agent_api_keys FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "agent_api_keys: dono revoga as suas" ON public.agent_api_keys;
CREATE POLICY "agent_api_keys: dono revoga as suas"
  ON public.agent_api_keys FOR DELETE
  TO authenticated
  USING (owner_id = auth.uid());

CREATE OR REPLACE FUNCTION public.verify_agent_key(_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _owner uuid;
BEGIN
  IF _key IS NULL OR length(_key) < 32 THEN RETURN NULL; END IF;

  SELECT owner_id INTO _owner FROM public.agent_api_keys
  WHERE key_hash = public.hash_token(_key) AND revoked_at IS NULL;

  IF _owner IS NOT NULL THEN
    UPDATE public.agent_api_keys SET last_used_at = now()
    WHERE key_hash = public.hash_token(_key);
  END IF;

  RETURN _owner;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_agent_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_agent_key(text) TO service_role;


-- ---- 8. o que o agente lê ---------------------------------------------------
-- Duas funções separadas de propósito. Contexto é lido a cada mensagem; senha
-- é lida uma vez por sessão de login. Juntá-las faria a senha trafegar dezenas
-- de vezes por dia sem necessidade.
CREATE OR REPLACE FUNCTION public.hermes_agent_context(_owner_id uuid, _listing_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.properties;
  _r jsonb;
BEGIN
  SELECT * INTO _p FROM public.properties
  WHERE airbnb_listing_id = _listing_id
    AND owner_id = _owner_id
    AND archived_at IS NULL
    AND hermes_enabled;

  IF _p.id IS NULL THEN RETURN NULL; END IF;

  SELECT to_jsonb(x) INTO _r FROM (
    SELECT r.guest_label, r.checkin_date, r.checkout_date, r.provider, r.status
    FROM public.reservations r
    WHERE r.property_id = _p.id
      AND r.checkout_date >= public.app_today()
      AND r.status <> 'cancelled'
    ORDER BY r.checkin_date
    LIMIT 1
  ) x;

  RETURN jsonb_build_object(
    'property_id',   _p.id,
    'name',          _p.name,
    'neighborhood',  _p.neighborhood,
    'checkin_time',  _p.checkin_time,
    'checkout_time', _p.checkout_time,
    'prompt',        _p.ai_prompt,
    'ai_config',     _p.ai_config,
    'reserva_atual', _r
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_context(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hermes_agent_context(uuid, text) TO service_role;


CREATE OR REPLACE FUNCTION public.hermes_agent_credentials(_owner_id uuid, _listing_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _c        public.hermes_credentials;
  _prop     uuid;
  _password text;
  _totp     text;
BEGIN
  SELECT id INTO _prop FROM public.properties
  WHERE airbnb_listing_id = _listing_id
    AND owner_id = _owner_id
    AND archived_at IS NULL
    AND hermes_enabled;

  IF _prop IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _c FROM public.hermes_credentials
  WHERE property_id = _prop AND platform = 'airbnb' AND revoked_at IS NULL;

  IF _c.id IS NULL THEN RETURN NULL; END IF;

  SELECT decrypted_secret INTO _password
  FROM vault.decrypted_secrets WHERE id = _c.secret_id;

  IF _c.otp_secret_id IS NOT NULL THEN
    SELECT decrypted_secret INTO _totp
    FROM vault.decrypted_secrets WHERE id = _c.otp_secret_id;
  END IF;

  -- Toda leitura de senha deixa rastro. Se um dia a conta do dono for
  -- bloqueada, esta é a linha do tempo que responde "quando o agente entrou".
  UPDATE public.hermes_credentials
  SET last_access_at = now(), access_count = access_count + 1
  WHERE id = _c.id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (NULL, NULL, 'hermes.credencial_lida', 'properties', _prop,
          jsonb_build_object('platform', _c.platform, 'login', _c.login));

  RETURN jsonb_build_object(
    'login',       _c.login,
    'password',    _password,
    'totp_secret', _totp,
    'property_id', _prop
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_credentials(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hermes_agent_credentials(uuid, text) TO service_role;


-- ---- 9. o agente reporta o que fez -----------------------------------------
-- Sem isto o dono entrega a conta e fica cego: o atendimento acontece no
-- Airbnb, fora do app. Estas linhas são o que a tela Conversas mostra.
CREATE TABLE IF NOT EXISTS public.hermes_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  thread_ref   text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('hospede', 'agente')),
  guest_name   text,
  content      text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hermes_messages_property_idx
  ON public.hermes_messages (property_id, sent_at DESC);

ALTER TABLE public.hermes_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hermes_messages: dono lê as suas" ON public.hermes_messages;
CREATE POLICY "hermes_messages: dono lê as suas"
  ON public.hermes_messages FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = hermes_messages.property_id AND p.owner_id = auth.uid()
  ));

CREATE OR REPLACE FUNCTION public.hermes_agent_log(
  _owner_id   uuid,
  _listing_id text,
  _thread_ref text,
  _direction  text,
  _guest_name text,
  _content    text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop uuid;
  _id   uuid;
BEGIN
  SELECT id INTO _prop FROM public.properties
  WHERE airbnb_listing_id = _listing_id AND owner_id = _owner_id AND archived_at IS NULL;

  IF _prop IS NULL THEN RAISE EXCEPTION 'imovel_nao_encontrado'; END IF;

  INSERT INTO public.hermes_messages (property_id, thread_ref, direction, guest_name, content)
  VALUES (_prop, _thread_ref, _direction, _guest_name, _content)
  RETURNING id INTO _id;

  -- Primeira mensagem trocada é a prova de que o login funcionou. Melhor sinal
  -- que um "testar conexão", que só diz que funcionava naquele segundo.
  UPDATE public.hermes_credentials
  SET status = 'ativo', last_verified_at = now(), last_error = NULL
  WHERE property_id = _prop AND status <> 'ativo';

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_log(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hermes_agent_log(uuid, text, text, text, text, text) TO service_role;


-- ---- 10. o agente avisa quando o login falha --------------------------------
CREATE OR REPLACE FUNCTION public.hermes_agent_report_failure(
  _owner_id   uuid,
  _listing_id text,
  _error      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop  uuid;
  _name  text;
  _email text;
BEGIN
  SELECT p.id, p.name INTO _prop, _name FROM public.properties p
  WHERE p.airbnb_listing_id = _listing_id AND p.owner_id = _owner_id;

  IF _prop IS NULL THEN RETURN; END IF;

  UPDATE public.hermes_credentials
  SET status = 'falhou', last_error = left(_error, 500)
  WHERE property_id = _prop;

  SELECT email INTO _email FROM public.profiles WHERE user_id = _owner_id;
  IF _email IS NULL THEN RETURN; END IF;

  -- A chave de idempotência inclui o dia: falha que persiste avisa uma vez por
  -- dia, não a cada tentativa. Um agente em laço de erro mandaria centenas de
  -- e-mails e o dono passaria a ignorar todos — inclusive o que importa.
  INSERT INTO public.notifications (
    channel, template, to_email, to_user_id, payload, entity, entity_id, idempotency_key
  ) VALUES (
    'email', 'hermes-falhou', _email, _owner_id,
    jsonb_build_object('property_name', _name, 'error', left(_error, 200)),
    'properties', _prop,
    format('hermes-falhou:%s:%s', _prop, public.app_today())
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_report_failure(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hermes_agent_report_failure(uuid, text, text) TO service_role;
