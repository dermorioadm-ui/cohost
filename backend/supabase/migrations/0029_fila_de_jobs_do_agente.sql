-- =============================================================================
-- 0029 — Fila de jobs do agente (pull, nunca push)
-- =============================================================================
-- Existem eventos que nascem DO NOSSO LADO e que o agente precisa saber:
-- reserva nova (mandar boas-vindas), limpeza concluída (avisar que está
-- pronto), check-out amanhã (lembrete). Mensagem de hóspede não é um deles —
-- essa nasce no Airbnb e o agente vê sozinho.
--
-- POR QUE FILA E NÃO POST DIRETO PARA O AGENTE
--
-- O agente roda no computador de casa do dono. Três consequências:
--
--   1. Não há endereço para onde mandar. Atrás do roteador, com IP dinâmico e
--      provavelmente CGNAT da operadora, a máquina não aceita conexão de
--      entrada. Push não é pior — é impossível.
--   2. A máquina desliga. À noite, na queda de luz, no reboot da atualização.
--      Um POST nesse intervalo vira timeout e a mensagem some. Na fila, o job
--      espera e é entregue quando a máquina volta.
--   3. Fila parada é diagnóstico; POST perdido é mistério.
--
-- O preço é latência de até um ciclo de polling (~30s), irrelevante para
-- responder hóspede.
--
-- SOBRE `mensagem_recebida`: está no enum porque o agente pode enfileirar para
-- si mesmo o que leu no Airbnb, dando retentativa a uma resposta que falhou no
-- meio. Nenhum gatilho nosso a produz.
--
-- DESLIGAR NO MEIO DO JOB é o caso normal aqui, não a exceção. Por isso o job
-- é RESERVADO (`processando` + `claimed_at`), não removido: quem some sem
-- confirmar tem o job devolvido à fila pela varredura de reserva vencida.
-- =============================================================================

-- ---- 1. a fila --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hermes_jobs (
  -- bigserial, não uuid: a ordem de chegada É a ordem de atendimento, e um
  -- inteiro crescente ordena de graça. uuid v4 exigiria ordenar por created_at,
  -- que empata quando dois gatilhos disparam na mesma transação.
  id           bigserial PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id  uuid REFERENCES public.properties(id) ON DELETE CASCADE,

  -- Desnormalizado de propósito: o agente pensa em número de anúncio, e o job
  -- precisa continuar legível mesmo se o imóvel for arquivado depois.
  listing_id   text,

  event_type   text NOT NULL CHECK (event_type IN
                 ('reserva_nova', 'limpeza_concluida', 'checkout_amanha', 'mensagem_recebida')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,

  status       text NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente', 'processando', 'processado', 'falhou')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,

  -- Idempotência. O gatilho de reserva dispara de novo se a reserva for
  -- atualizada pelo sync do iCal; sem esta chave o hóspede receberia
  -- "bem-vindo" a cada leitura de calendário — 96 vezes por dia.
  dedupe_key   text UNIQUE,

  created_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  processed_at timestamptz
);

-- Índice do caminho quente: o agente pergunta "meus pendentes, em ordem".
CREATE INDEX IF NOT EXISTS hermes_jobs_fila_idx
  ON public.hermes_jobs (owner_id, id) WHERE status = 'pendente';

-- Índice da varredura de reserva vencida.
CREATE INDEX IF NOT EXISTS hermes_jobs_travados_idx
  ON public.hermes_jobs (claimed_at) WHERE status = 'processando';

ALTER TABLE public.hermes_jobs ENABLE ROW LEVEL SECURITY;

-- Só leitura pelo painel. Escrita é dos gatilhos e do agente, ambos via
-- SECURITY DEFINER — cliente nenhum enfileira job direto.
DROP POLICY IF EXISTS "hermes_jobs: dono lê os seus" ON public.hermes_jobs;
CREATE POLICY "hermes_jobs: dono lê os seus"
  ON public.hermes_jobs FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());


-- ---- 2. enfileirar ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_enqueue(
  _property_id uuid,
  _event_type  text,
  _payload     jsonb,
  _dedupe_key  text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _p public.properties; _id bigint;
BEGIN
  SELECT * INTO _p FROM public.properties WHERE id = _property_id;

  -- Sem atendimento ligado não há quem consuma. Enfileirar assim mesmo encheria
  -- a tabela de trabalho que ninguém vai puxar, e no dia em que o dono ligasse
  -- o Hermes o agente despejaria meses de mensagens atrasadas nos hóspedes.
  IF _p.id IS NULL OR NOT _p.hermes_enabled OR _p.archived_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.hermes_jobs (owner_id, property_id, listing_id, event_type, payload, dedupe_key)
  VALUES (_p.owner_id, _p.id, _p.airbnb_listing_id, _event_type, coalesce(_payload, '{}'::jsonb), _dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_enqueue(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;


-- ---- 3. gatilho: reserva nova ----------------------------------------------
-- AFTER INSERT apenas. O sync do iCal roda a cada 15 min e faz UPDATE nas
-- reservas que já viu (last_seen_at); disparar no UPDATE geraria um job por
-- ciclo. A dedupe_key é a segunda linha de defesa, não a primeira.
CREATE OR REPLACE FUNCTION public.tg_hermes_job_reserva_nova()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text = 'cancelled' THEN RETURN NULL; END IF;

  PERFORM public.hermes_enqueue(
    NEW.property_id,
    'reserva_nova',
    jsonb_build_object(
      'reservation_id', NEW.id,
      'guest_label',    NEW.guest_label,
      'checkin_date',   NEW.checkin_date,
      'checkout_date',  NEW.checkout_date,
      'provider',       NEW.provider
    ),
    'reserva_nova:' || NEW.id::text
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_hermes_job_reserva_nova ON public.reservations;
CREATE TRIGGER trg_hermes_job_reserva_nova
  AFTER INSERT ON public.reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_hermes_job_reserva_nova();

REVOKE ALL ON FUNCTION public.tg_hermes_job_reserva_nova() FROM PUBLIC, anon, authenticated;


-- ---- 4. gatilho: limpeza concluída -----------------------------------------
CREATE OR REPLACE FUNCTION public.tg_hermes_job_limpeza_concluida()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text <> 'completed' OR OLD.status::text = 'completed' THEN
    RETURN NULL;
  END IF;

  PERFORM public.hermes_enqueue(
    NEW.property_id,
    'limpeza_concluida',
    jsonb_build_object(
      'task_id',            NEW.id,
      'checkout_date',      NEW.checkout_date,
      'next_checkin_date',  NEW.next_checkin_date,
      'completed_at',       NEW.completed_at
    ),
    'limpeza_concluida:' || NEW.id::text
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_hermes_job_limpeza_concluida ON public.cleaning_tasks;
CREATE TRIGGER trg_hermes_job_limpeza_concluida
  AFTER UPDATE OF status ON public.cleaning_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_hermes_job_limpeza_concluida();

REVOKE ALL ON FUNCTION public.tg_hermes_job_limpeza_concluida() FROM PUBLIC, anon, authenticated;


-- ---- 5. check-out amanhã: varredura, não gatilho ---------------------------
-- Passar do tempo não é evento de tabela. Precisa de alguém perguntando "que
-- horas são", e isso é o cron. A dedupe_key inclui a data para o lembrete sair
-- uma vez por reserva, mesmo que a varredura rode duas vezes no dia.
CREATE OR REPLACE FUNCTION public.hermes_enqueue_checkout_amanha()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _r record; _n integer := 0;
BEGIN
  FOR _r IN
    SELECT r.id, r.property_id, r.guest_label, r.checkout_date
    FROM public.reservations r
    JOIN public.properties p ON p.id = r.property_id
    WHERE r.checkout_date = public.app_today() + 1
      AND r.status::text <> 'cancelled'
      AND p.hermes_enabled
      AND p.archived_at IS NULL
  LOOP
    IF public.hermes_enqueue(
         _r.property_id, 'checkout_amanha',
         jsonb_build_object('reservation_id', _r.id, 'guest_label', _r.guest_label,
                            'checkout_date', _r.checkout_date),
         'checkout_amanha:' || _r.id::text || ':' || _r.checkout_date::text
       ) IS NOT NULL
    THEN _n := _n + 1;
    END IF;
  END LOOP;

  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_enqueue_checkout_amanha() FROM PUBLIC, anon, authenticated;

-- Agendamento fica comentado: ligar o cron é decisão de quando começar a
-- mandar lembrete a hóspede de verdade, não de quando a migração roda.
--   SELECT cron.schedule('hermes-checkout-amanha', '0 15 * * *',
--                        $$ SELECT public.hermes_enqueue_checkout_amanha(); $$);


-- ---- 6. o agente puxa -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_agent_next_jobs(_owner_id uuid, _limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _jobs jsonb;
BEGIN
  PERFORM public.assert_service_role();

  -- Devolve à fila o que foi reservado e nunca confirmado. É o caso do
  -- computador desligado no meio do job — aqui, o comportamento esperado.
  UPDATE public.hermes_jobs
  SET status = 'pendente', claimed_at = NULL
  WHERE status = 'processando'
    AND claimed_at < now() - interval '10 minutes';

  -- Desiste do que falhou muitas vezes, senão um job envenenado é servido para
  -- sempre e tranca a fila atrás dele.
  UPDATE public.hermes_jobs
  SET status = 'falhou', processed_at = now(),
      last_error = coalesce(last_error, '') || ' [desistiu após 5 tentativas]'
  WHERE status = 'pendente' AND attempts >= 5;

  -- FOR UPDATE SKIP LOCKED: se o dono abrir o agente em duas máquinas, cada
  -- uma leva jobs diferentes em vez de as duas responderem ao mesmo hóspede.
  WITH reservados AS (
    UPDATE public.hermes_jobs j
    SET status = 'processando', claimed_at = now(), attempts = attempts + 1
    WHERE j.id IN (
      SELECT id FROM public.hermes_jobs
      WHERE owner_id = _owner_id AND status = 'pendente'
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(_limit, 10), 50))
    )
    RETURNING j.id, j.event_type, j.listing_id, j.property_id, j.payload, j.attempts, j.created_at
  )
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) INTO _jobs FROM reservados r;

  RETURN _jobs;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_next_jobs(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_next_jobs(uuid, integer) TO service_role;


-- ---- 7. o agente confirma ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_agent_finish_job(
  _owner_id uuid,
  _job_id   bigint,
  _ok       boolean,
  _error    text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _n integer;
BEGIN
  PERFORM public.assert_service_role();

  -- Falha volta para 'pendente', não para 'falhou': quem decide desistir é o
  -- contador de tentativas, não o erro isolado. Airbnb fora do ar às 3h não
  -- pode queimar um lembrete de check-out.
  UPDATE public.hermes_jobs
  SET status       = CASE WHEN _ok THEN 'processado' ELSE 'pendente' END,
      processed_at = CASE WHEN _ok THEN now() ELSE NULL END,
      claimed_at   = NULL,
      last_error   = CASE WHEN _ok THEN NULL ELSE left(_error, 500) END
  WHERE id = _job_id AND owner_id = _owner_id;

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.hermes_agent_finish_job(uuid, bigint, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_agent_finish_job(uuid, bigint, boolean, text) TO service_role;
