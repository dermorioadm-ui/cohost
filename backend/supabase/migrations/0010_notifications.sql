-- =============================================================================
-- 0010 — Outbox único de notificações (e-mail + WhatsApp)
-- =============================================================================
-- Um lugar só para tudo que sai do sistema. Vantagens sobre a fila de e-mail
-- antiga: você vê numa tabela por que a portaria não foi avisada, reenvia sem
-- duplicar (idempotency_key), e o WhatsApp entra no mesmo fluxo quando a Meta
-- liberar — sem reescrever nada.
-- =============================================================================

CREATE TYPE public.notification_channel AS ENUM ('email', 'whatsapp');

CREATE TYPE public.notification_status AS ENUM (
  'queued', 'sending', 'sent', 'failed', 'suppressed', 'cancelled'
);

CREATE TABLE public.notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          public.notification_channel NOT NULL,
  template         text NOT NULL,

  -- Destinatário: e-mail OU telefone, conforme o canal.
  to_email         text,
  to_phone_e164    text,
  to_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  locale           text NOT NULL DEFAULT 'pt',

  -- Não manda duas vezes a mesma coisa. Ex.: 'condo:<reservation_id>'
  idempotency_key  text UNIQUE,

  status           public.notification_status NOT NULL DEFAULT 'queued',
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 5,
  scheduled_for    timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  provider_message_id text,
  last_error       text,

  -- Rastreabilidade: de qual registro nasceu esta notificação
  entity           text,
  entity_id        text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_has_recipient CHECK (
    (channel = 'email'    AND to_email      IS NOT NULL) OR
    (channel = 'whatsapp' AND to_phone_e164 IS NOT NULL)
  )
);

-- Índice do worker: o que está pronto para sair, mais antigo primeiro.
CREATE INDEX idx_notifications_due ON public.notifications (scheduled_for)
  WHERE status = 'queued';
CREATE INDEX idx_notifications_entity ON public.notifications (entity, entity_id);
CREATE INDEX idx_notifications_failed ON public.notifications (updated_at DESC)
  WHERE status = 'failed';

CREATE TRIGGER trg_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications: admin lê"
  ON public.notifications FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "notifications: usuário lê as próprias"
  ON public.notifications FOR SELECT TO authenticated
  USING (to_user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Lista de supressão (bounce, spam, descadastro). Consultada antes de enviar.
-- -----------------------------------------------------------------------------
CREATE TABLE public.suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel    public.notification_channel NOT NULL,
  address    text NOT NULL,
  reason     text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, address)
);

ALTER TABLE public.suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppressions: admin"
  ON public.suppressions FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- -----------------------------------------------------------------------------
-- Enfileirar. Respeita supressão e idempotência.
-- Devolve o id da notificação, ou NULL se foi suprimida/duplicada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_notification(
  _channel         public.notification_channel,
  _template        text,
  _payload         jsonb DEFAULT '{}'::jsonb,
  _to_email        text DEFAULT NULL,
  _to_phone        text DEFAULT NULL,
  _to_user_id      uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL,
  _locale          text DEFAULT 'pt',
  _entity          text DEFAULT NULL,
  _entity_id       text DEFAULT NULL,
  _scheduled_for   timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _addr text;
  _id   uuid;
BEGIN
  _to_email := lower(nullif(btrim(_to_email), ''));
  _to_phone := public.normalize_phone(_to_phone);
  _addr     := CASE WHEN _channel = 'email' THEN _to_email ELSE _to_phone END;

  IF _addr IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.suppressions s
    WHERE s.channel = _channel AND s.address = _addr
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notifications (
    channel, template, payload, to_email, to_phone_e164, to_user_id,
    idempotency_key, locale, entity, entity_id, scheduled_for
  ) VALUES (
    _channel, _template, _payload, _to_email, _to_phone, _to_user_id,
    _idempotency_key, _locale, _entity, _entity_id, _scheduled_for
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_notification FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Worker: pega um lote e marca como 'sending' de forma atômica.
-- SKIP LOCKED permite rodar vários workers sem enviar duplicado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_notifications(_limit int DEFAULT 25)
RETURNS SETOF public.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.notifications
    WHERE status = 'queued' AND scheduled_for <= now()
    ORDER BY scheduled_for
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notifications n
  SET status = 'sending', attempts = n.attempts + 1, updated_at = now()
  FROM due
  WHERE n.id = due.id
  RETURNING n.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_notifications(int) FROM anon, authenticated;

-- Backoff exponencial: 1min, 2min, 4min, 8min...
CREATE OR REPLACE FUNCTION public.fail_notification(_id uuid, _error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n public.notifications%ROWTYPE;
BEGIN
  SELECT * INTO _n FROM public.notifications WHERE id = _id;
  IF NOT FOUND THEN RETURN; END IF;

  IF _n.attempts >= _n.max_attempts THEN
    UPDATE public.notifications
    SET status = 'failed', last_error = _error, updated_at = now()
    WHERE id = _id;
  ELSE
    UPDATE public.notifications
    SET status        = 'queued',
        last_error    = _error,
        scheduled_for = now() + make_interval(secs => 60 * power(2, _n.attempts)::int),
        updated_at    = now()
    WHERE id = _id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fail_notification(uuid, text) FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- GATILHO DO PITCH: toda reserva confirmada avisa a portaria.
--
-- No backend antigo isso só saía se o hóspede preenchesse o formulário do chat.
-- Se ele não preenchesse — e a maioria não preenche — o condomínio nunca era
-- avisado, apesar de "avisamos a portaria a cada reserva" ser argumento de
-- venda. Agora nasce da reserva, que é o fato real.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_reservation_notify_condo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop  public.properties%ROWTYPE;
  _owner public.profiles%ROWTYPE;
BEGIN
  IF NEW.status <> 'confirmed' OR NEW.condo_notified_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF public.app_setting('condo_notify_enabled', 'true') <> 'true' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _prop FROM public.properties WHERE id = NEW.property_id;
  IF NOT FOUND OR _prop.condo_email IS NULL OR NOT _prop.condo_notify THEN
    RETURN NEW;
  END IF;

  -- Assinatura inativa não dispara comunicação em nome do cliente.
  IF NOT public.subscription_is_active(_prop.owner_id) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _owner FROM public.profiles WHERE user_id = _prop.owner_id;

  PERFORM public.enqueue_notification(
    'email',
    'condo-reservation',
    jsonb_build_object(
      'property_name', public.property_display_name(_prop),
      'condo_name',    _prop.condo_name,
      'block',         _prop.block,
      'apt_number',    _prop.apt_number,
      'owner_name',    _owner.full_name,
      'owner_phone',   _owner.phone_e164,
      'checkin_date',  NEW.checkin_date,
      'checkout_date', NEW.checkout_date,
      'checkin_time',  to_char(_prop.checkin_time,  'HH24:MI'),
      'checkout_time', to_char(_prop.checkout_time, 'HH24:MI'),
      'guest_label',   NEW.guest_label
    ),
    _prop.condo_email,
    NULL,
    _prop.owner_id,
    'condo:' || NEW.id::text,
    'pt',
    'reservations',
    NEW.id::text
  );

  UPDATE public.reservations SET condo_notified_at = now() WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservation_notify_condo
  AFTER INSERT OR UPDATE OF status ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_reservation_notify_condo();

-- -----------------------------------------------------------------------------
-- Limpeza concluída -> avisa o dono (e-mail sempre, WhatsApp quando ligado).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_cleaning_completed_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop  public.properties%ROWTYPE;
  _owner public.profiles%ROWTYPE;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _prop  FROM public.properties WHERE id = NEW.property_id;
  SELECT * INTO _owner FROM public.profiles   WHERE user_id = _prop.owner_id;

  PERFORM public.enqueue_notification(
    'email', 'cleaning-completed',
    jsonb_build_object(
      'property_name', public.property_display_name(_prop),
      'completed_at',  to_char(NEW.completed_at AT TIME ZONE public.app_tz(), 'DD/MM/YYYY HH24:MI'),
      'has_photo',     (NEW.photo_path IS NOT NULL)
    ),
    _owner.email, NULL, _prop.owner_id,
    'cleaning-done:' || NEW.id::text,
    COALESCE(_owner.locale, 'pt'),
    'cleaning_tasks', NEW.id::text
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cleaning_completed_notify
  AFTER UPDATE OF status ON public.cleaning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_cleaning_completed_notify();
