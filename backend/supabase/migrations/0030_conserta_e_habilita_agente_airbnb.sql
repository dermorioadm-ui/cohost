-- =============================================================================
-- 0030 — Conserta a 0028/0029 e habilita o agente do Airbnb
-- =============================================================================
-- As migrations 0028 e 0029 (PR #1) nunca aplicaram. Não foi deploy pela
-- metade: elas abortam inteiras, e o motivo é uma linha em cada.
--
--   0028: CREATE TABLE public.audit_log      -> já existe desde a 0015
--   0029: CREATE TABLE public.hermes_messages -> já existe desde a 0025
--
-- Cada migration roda em transação; o erro derruba tudo e faz rollback. Foi por
-- isso que `credentials` também não existe, mesmo sendo criada ANTES do
-- audit_log no arquivo. `audit_log` não é resquício do deploy parcial — é a
-- causa dele.
--
-- Mais três defeitos que a PR trazia, corrigidos aqui:
--
--   1. get_credentials_for_owner(p_owner uuid) recebia o dono como PARÂMETRO,
--      não checava quem chamava, e tinha GRANT EXECUTE TO authenticated.
--      Qualquer usuário logado — uma diarista, por exemplo — poderia fazer
--      POST /rest/v1/rpc/get_credentials_for_owner com o uuid de qualquer
--      proprietário e receber a senha do Airbnb já descriptografada. É a mesma
--      falha da 0026, reintroduzida e desta vez concedida explicitamente.
--
--   2. resolve_owner_by_agent_key foi declarada LANGUAGE plpgsql com corpo
--      `SELECT ...` sem BEGIN/END. Isso é erro de sintaxe no CREATE FUNCTION —
--      a migration não passaria nem sem a colisão do audit_log.
--
--   3. agent_key ficava em texto puro. Chave de API é credencial: guarda-se o
--      hash, como o repositório já faz em cleaner_invites e agent_api_keys.
--
-- SOBRE A CHAVE DE CRIPTOGRAFIA: a PR usava
-- current_setting('app.encryption_key'), que exige configurar um GUC no banco
-- e, sem ele, estoura 42704 no decrypt. Aqui a chave vem do Vault do Supabase,
-- cujo material fica no chaveiro gerenciado, fora das tabelas — um dump do
-- banco leva o texto cifrado sem levar a chave. O GUC continua aceito como
-- override para quem quiser gerenciar a chave por fora.
--
-- Script idempotente: pode rodar de novo sem quebrar.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ---- 1. a chave de criptografia --------------------------------------------
-- Nasce sozinha na primeira chamada. Não há passo manual de configuração para
-- alguém esquecer — e passo esquecido aqui significa senha ilegível em runtime.
CREATE OR REPLACE FUNCTION public.app_encryption_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _override text := current_setting('app.encryption_key', true);
  _key      text;
BEGIN
  -- Override explícito ganha: quem quiser gerenciar a chave fora do banco
  -- define o GUC e esta função nem toca no Vault.
  IF _override IS NOT NULL AND _override <> '' THEN
    RETURN _override;
  END IF;

  SELECT decrypted_secret INTO _key
  FROM vault.decrypted_secrets WHERE name = 'app_encryption_key';

  IF _key IS NULL THEN
    _key := encode(gen_random_bytes(32), 'hex');
    PERFORM vault.create_secret(_key, 'app_encryption_key',
      'Chave simétrica do pgcrypto para credentials. Trocar exige recriptografar tudo.');
  END IF;

  RETURN _key;
END;
$$;

REVOKE ALL ON FUNCTION public.app_encryption_key() FROM PUBLIC, anon, authenticated;


-- ---- 2. credentials ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  login               text NOT NULL,
  -- Hash, não a chave. O worker manda a chave crua no header; quem compara é
  -- resolve_owner_by_agent_key, que aplica o mesmo hash antes de procurar.
  agent_key_hash      text UNIQUE,
  password_encrypted  text NOT NULL,
  totp_seed_encrypted text,

  status              text NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'ativo', 'falhou')),
  last_error          text,
  last_read_at        timestamptz,
  read_count          integer NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Uma credencial por dono: a conta do Airbnb hospeda todos os anúncios dele.
CREATE UNIQUE INDEX IF NOT EXISTS credentials_owner_key
  ON public.credentials (owner_id);

ALTER TABLE public.credentials ENABLE ROW LEVEL SECURITY;

-- O dono lê o ESTADO da própria linha. As colunas cifradas não são legíveis
-- por RLS — RLS filtra linha, não coluna (lição da 0022) —, mas aqui isso não
-- entrega nada: sem a chave do Vault, password_encrypted é ruído.
DROP POLICY IF EXISTS "credentials: dono le o estado" ON public.credentials;
CREATE POLICY "credentials: dono le o estado"
  ON public.credentials FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "credentials: dono revoga" ON public.credentials;
CREATE POLICY "credentials: dono revoga"
  ON public.credentials FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

-- Sem policy de INSERT/UPDATE de propósito: gravar exige cifrar, e cifrar é
-- trabalho das funções abaixo.


-- ---- 3. audit_log: NÃO recriar, só acrescentar -----------------------------
-- Existe desde a 0015 com (actor_id, actor_role, action, entity, entity_id,
-- metadata, ip). owner_id entra porque a PR filtra por dono e a coluna não
-- existia. Recriar a tabela apagaria o histórico que já está lá.
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS owner_id uuid;

CREATE INDEX IF NOT EXISTS idx_audit_log_owner
  ON public.audit_log (owner_id, created_at DESC) WHERE owner_id IS NOT NULL;


-- ---- 4. cifrar / decifrar ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.encrypt_credential(p_secret text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_service_role();
  IF p_secret IS NULL OR p_secret = '' THEN RETURN NULL; END IF;
  RETURN encode(pgp_sym_encrypt(p_secret, public.app_encryption_key()), 'base64');
END;
$$;

REVOKE ALL ON FUNCTION public.encrypt_credential(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.encrypt_credential(text) TO service_role;


-- Resolve o dono a partir da chave do header. LANGUAGE sql desta vez: o corpo
-- É uma consulta, e era isso que a 0028 tentou escrever dentro de plpgsql.
CREATE OR REPLACE FUNCTION public.resolve_owner_by_agent_key(p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _owner uuid;
BEGIN
  PERFORM public.assert_service_role();
  IF p_key IS NULL OR length(p_key) < 16 THEN RETURN NULL; END IF;

  SELECT owner_id INTO _owner
  FROM public.credentials
  WHERE agent_key_hash = public.hash_token(p_key);

  -- Compatibilidade com as chaves já emitidas pelo painel (agent_api_keys),
  -- para quem gerou a chave antes desta migration não precisar gerar outra.
  IF _owner IS NULL THEN
    SELECT owner_id INTO _owner
    FROM public.agent_api_keys
    WHERE key_hash = public.hash_token(p_key) AND revoked_at IS NULL;
  END IF;

  RETURN _owner;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_owner_by_agent_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_owner_by_agent_key(text) TO service_role;


-- A leitura da credencial. Guardada por assert_service_role e revogada de
-- anon/authenticated: o dono vem por parâmetro, então sem o porteiro qualquer
-- logado leria a senha de qualquer proprietário.
CREATE OR REPLACE FUNCTION public.get_credentials_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _c public.credentials%ROWTYPE; _key text;
BEGIN
  PERFORM public.assert_service_role();

  SELECT * INTO _c FROM public.credentials WHERE owner_id = p_owner;

  -- Registra a leitura mesmo quando não encontra: tentativa com chave válida
  -- e dono sem credencial também é informação de segurança.
  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id, metadata)
  VALUES (NULL, 'agent', 'credentials:read', 'credentials', p_owner::text, p_owner,
          jsonb_build_object('encontrou', _c.id IS NOT NULL));

  IF _c.id IS NULL THEN RETURN NULL; END IF;

  _key := public.app_encryption_key();

  UPDATE public.credentials
  SET last_read_at = now(), read_count = read_count + 1
  WHERE id = _c.id;

  RETURN jsonb_build_object(
    'login',     _c.login,
    'password',  pgp_sym_decrypt(decode(_c.password_encrypted, 'base64'), _key),
    'totp_seed', CASE WHEN _c.totp_seed_encrypted IS NOT NULL
                      THEN pgp_sym_decrypt(decode(_c.totp_seed_encrypted, 'base64'), _key)
                      ELSE NULL END,
    'status',    _c.status,
    'listings',  (SELECT coalesce(jsonb_agg(s.listing_id), '[]'::jsonb)
                  FROM public.property_ical_sources s
                  JOIN public.properties p ON p.id = s.property_id
                  WHERE p.owner_id = p_owner AND p.archived_at IS NULL
                    AND s.listing_id IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_credentials_for_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_credentials_for_owner(uuid) TO service_role;


-- Grava credencial já cifrada e devolve a chave crua UMA vez.
CREATE OR REPLACE FUNCTION public.save_credential(
  p_owner uuid, p_login text, p_password text, p_totp text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _key text; _existing uuid;
BEGIN
  PERFORM public.assert_service_role();

  SELECT id INTO _existing FROM public.credentials WHERE owner_id = p_owner;
  _key := 'hp_' || public.generate_token(32);

  IF _existing IS NULL THEN
    INSERT INTO public.credentials (owner_id, login, password_encrypted, totp_seed_encrypted,
                                    agent_key_hash, status)
    VALUES (p_owner, p_login,
            public.encrypt_credential(p_password),
            public.encrypt_credential(p_totp),
            public.hash_token(_key), 'pendente');
  ELSE
    UPDATE public.credentials SET
      login = p_login,
      password_encrypted = public.encrypt_credential(p_password),
      totp_seed_encrypted = public.encrypt_credential(p_totp),
      agent_key_hash = public.hash_token(_key),
      status = 'pendente', last_error = NULL, updated_at = now()
    WHERE id = _existing;
  END IF;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id)
  VALUES (p_owner, 'owner', 'credentials:write', 'credentials', p_owner::text, p_owner);

  RETURN _key;
END;
$$;

REVOKE ALL ON FUNCTION public.save_credential(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_credential(uuid, text, text, text) TO service_role;


-- ---- 5. listing_id no property_ical_sources ---------------------------------
ALTER TABLE public.property_ical_sources
  ADD COLUMN IF NOT EXISTS listing_id text;

CREATE INDEX IF NOT EXISTS idx_ical_sources_listing
  ON public.property_ical_sources (listing_id) WHERE listing_id IS NOT NULL;

-- substring(), não regexp_matches(): regexp_matches devolve CONJUNTO, e usá-la
-- em atribuição escalar depende de detalhe de implementação do plpgsql. Num
-- gatilho BEFORE INSERT do property_ical_sources, um erro aí derrubaria a
-- conexão de calendário inteira — o pilar que alimenta reserva e limpeza.
CREATE OR REPLACE FUNCTION public.extract_listing_id(u text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(
    substring(u FROM '/ical/([0-9]+)\.ics'),
    substring(u FROM 'ical/([0-9A-Za-z_-]+)\.ics')
  );
$$;

CREATE OR REPLACE FUNCTION public.tg_set_listing_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Só Airbnb: o link do Booking também casa com o padrão genérico, e gravar
  -- um "listing" de Booking numa coluna que o agente do Airbnb consulta faria
  -- o agente pedir contexto de um anúncio que não existe lá.
  IF NEW.provider::text = 'airbnb' THEN
    NEW.listing_id := public.extract_listing_id(NEW.url);
    IF NEW.listing_id IS NOT NULL THEN
      UPDATE public.properties SET airbnb_listing_id = NEW.listing_id
      WHERE id = NEW.property_id AND airbnb_listing_id IS DISTINCT FROM NEW.listing_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ical_sources_listing_id ON public.property_ical_sources;
CREATE TRIGGER trg_ical_sources_listing_id
  BEFORE INSERT OR UPDATE OF url ON public.property_ical_sources
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_listing_id();

UPDATE public.property_ical_sources
SET listing_id = public.extract_listing_id(url)
WHERE provider::text = 'airbnb' AND listing_id IS NULL;


-- ---- 6. hermes_jobs ---------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.hermes_event AS ENUM
    ('mensagem_recebida', 'reserva_nova', 'limpeza_concluida', 'checkout_amanha');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.hermes_job_status AS ENUM
    ('pendente', 'processando', 'processado', 'falhou');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.hermes_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordem de chegada. uuid v4 não ordena, e created_at empata quando dois
  -- gatilhos disparam na mesma transação; a fila precisa de FIFO estável.
  seq          bigserial,
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id  text,                       -- listing_id do anúncio
  property_uuid uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  event_type   public.hermes_event NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       public.hermes_job_status NOT NULL DEFAULT 'pendente',
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  -- Idempotência: o sync do iCal reprocessa reservas a cada 15 min. Sem isto o
  -- hóspede receberia "bem-vindo" 96 vezes por dia.
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_hermes_jobs_pending
  ON public.hermes_jobs (owner_id, seq) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_hermes_jobs_listing
  ON public.hermes_jobs (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hermes_jobs_travados
  ON public.hermes_jobs (claimed_at) WHERE status = 'processando';

ALTER TABLE public.hermes_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hermes_jobs: dono le os seus" ON public.hermes_jobs;
CREATE POLICY "hermes_jobs: dono le os seus"
  ON public.hermes_jobs FOR SELECT TO authenticated
  USING (owner_id = auth.uid());


-- ---- 7. hermes_messages: acrescentar, não recriar ---------------------------
-- Existe desde a 0025 com (property_id uuid, thread_ref, direction, content).
-- A PR insere (owner_id, property_id=listing TEXT, guest_message, agent_reply),
-- que nem tipo compatível tem. As colunas novas convivem com as antigas.
ALTER TABLE public.hermes_messages
  ADD COLUMN IF NOT EXISTS owner_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS listing_id    text,
  ADD COLUMN IF NOT EXISTS guest_message text,
  ADD COLUMN IF NOT EXISTS agent_reply   text;

ALTER TABLE public.hermes_messages ALTER COLUMN property_id DROP NOT NULL;
ALTER TABLE public.hermes_messages ALTER COLUMN thread_ref  DROP NOT NULL;
ALTER TABLE public.hermes_messages ALTER COLUMN direction   DROP NOT NULL;
ALTER TABLE public.hermes_messages ALTER COLUMN content     DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hermes_messages_owner
  ON public.hermes_messages (owner_id, created_at DESC) WHERE owner_id IS NOT NULL;

DROP POLICY IF EXISTS "hermes_messages: dono lê as suas" ON public.hermes_messages;
CREATE POLICY "hermes_messages: dono lê as suas"
  ON public.hermes_messages FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.properties p
               WHERE p.id = hermes_messages.property_id AND p.owner_id = auth.uid())
    OR public.is_admin()
  );


-- ---- 8. quem enche a fila ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_enqueue(
  _property_id uuid, _event public.hermes_event, _payload jsonb, _dedupe text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _p public.properties; _id uuid;
BEGIN
  SELECT * INTO _p FROM public.properties WHERE id = _property_id;
  IF _p.id IS NULL OR _p.archived_at IS NOT NULL THEN RETURN NULL; END IF;

  INSERT INTO public.hermes_jobs (owner_id, property_id, property_uuid, event_type, payload, dedupe_key)
  VALUES (_p.owner_id, _p.airbnb_listing_id, _p.id, _event, coalesce(_payload, '{}'::jsonb), _dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_enqueue(uuid, public.hermes_event, jsonb, text) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.tg_enqueue_reserva_nova()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status::text = 'cancelled' THEN RETURN NULL; END IF;
  PERFORM public.hermes_enqueue(NEW.property_id, 'reserva_nova',
    jsonb_build_object('reservation_id', NEW.id, 'guest_label', NEW.guest_label,
                       'checkin_date', NEW.checkin_date, 'checkout_date', NEW.checkout_date,
                       'provider', NEW.provider),
    'reserva_nova:' || NEW.id::text);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_enqueue_reserva_nova ON public.reservations;
-- AFTER INSERT apenas: o sync do iCal faz UPDATE nas reservas que já viu.
CREATE TRIGGER trg_enqueue_reserva_nova
  AFTER INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_enqueue_reserva_nova();

REVOKE ALL ON FUNCTION public.tg_enqueue_reserva_nova() FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.tg_enqueue_limpeza_concluida()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status::text <> 'completed' OR OLD.status::text = 'completed' THEN RETURN NULL; END IF;
  PERFORM public.hermes_enqueue(NEW.property_id, 'limpeza_concluida',
    jsonb_build_object('task_id', NEW.id, 'checkout_date', NEW.checkout_date,
                       'next_checkin_date', NEW.next_checkin_date),
    'limpeza_concluida:' || NEW.id::text);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_enqueue_limpeza_concluida ON public.cleaning_tasks;
CREATE TRIGGER trg_enqueue_limpeza_concluida
  AFTER UPDATE OF status ON public.cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_enqueue_limpeza_concluida();

REVOKE ALL ON FUNCTION public.tg_enqueue_limpeza_concluida() FROM PUBLIC, anon, authenticated;


-- ---- 9. o agente puxa e confirma -------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_next_jobs(p_owner uuid, p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _jobs jsonb;
BEGIN
  PERFORM public.assert_service_role();

  -- Devolve à fila o que foi reservado e nunca confirmado. O worker roda no PC
  -- de casa: desligar no meio de um job é o caso normal, não a exceção.
  UPDATE public.hermes_jobs SET status = 'pendente', claimed_at = NULL
  WHERE status = 'processando' AND claimed_at < now() - interval '10 minutes';

  UPDATE public.hermes_jobs
  SET status = 'falhou', processed_at = now(),
      last_error = coalesce(last_error, '') || ' [desistiu apos 5 tentativas]'
  WHERE status = 'pendente' AND attempts >= 5;

  -- SKIP LOCKED: se o worker abrir em duas janelas, cada uma leva jobs
  -- diferentes em vez de as duas responderem ao mesmo hóspede.
  WITH reservados AS (
    UPDATE public.hermes_jobs j
    SET status = 'processando', claimed_at = now(), attempts = attempts + 1
    WHERE j.id IN (
      SELECT id FROM public.hermes_jobs
      WHERE owner_id = p_owner AND status = 'pendente'
      ORDER BY seq FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 10), 50))
    )
    RETURNING j.id, j.event_type, j.property_id, j.payload, j.attempts, j.created_at, j.seq
  )
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.seq), '[]'::jsonb) INTO _jobs FROM reservados r;

  RETURN _jobs;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_next_jobs(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_next_jobs(uuid, integer) TO service_role;


CREATE OR REPLACE FUNCTION public.hermes_finish_job(
  p_owner uuid, p_job uuid, p_ok boolean, p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  PERFORM public.assert_service_role();

  -- Falha volta para 'pendente': quem desiste é o contador de tentativas, não
  -- o erro isolado. Airbnb fora do ar às 3h não pode queimar um lembrete.
  UPDATE public.hermes_jobs
  SET status       = CASE WHEN p_ok THEN 'processado'::public.hermes_job_status
                          ELSE 'pendente'::public.hermes_job_status END,
      processed_at = CASE WHEN p_ok THEN now() ELSE NULL END,
      claimed_at   = NULL,
      last_error   = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  WHERE id = p_job AND owner_id = p_owner;

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_finish_job(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_finish_job(uuid, uuid, boolean, text) TO service_role;


-- ---- 10. marcar falha de login ---------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_mark_failure(p_owner uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_service_role();

  UPDATE public.credentials
  SET status = 'falhou', last_error = left(p_error, 500), updated_at = now()
  WHERE owner_id = p_owner;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, owner_id, metadata)
  VALUES (NULL, 'agent', 'credentials:failure', 'credentials', p_owner::text, p_owner,
          jsonb_build_object('erro', left(p_error, 200)));
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_mark_failure(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_mark_failure(uuid, text) TO service_role;
