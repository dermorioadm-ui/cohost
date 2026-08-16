-- =============================================================================
-- 0031 — A fila só enche com o atendimento ligado
-- =============================================================================
-- A 0030 perdeu a guarda que o rascunho tinha: hermes_enqueue enfileirava sem
-- checar properties.hermes_enabled. Com os gatilhos ativos e o agente ainda
-- desligado, a fila acumula em silêncio — e na primeira conexão do worker ele
-- puxa meses de trabalho e dispara "bem-vindo" para hóspede que já foi embora.
-- Fila que enche sem consumidor não é fila, é bomba-relógio apontada para o
-- hóspede.
--
-- Junto: checkout_amanha existia no enum sem ninguém produzir. Passar do tempo
-- não é evento de tabela — precisa de alguém perguntando que horas são. A
-- varredura fica pronta; o agendamento no cron fica comentado, porque ligar é
-- decisão de quando começar a mandar lembrete de verdade a hóspede.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.hermes_enqueue(
  _property_id uuid, _event public.hermes_event, _payload jsonb, _dedupe text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _p public.properties; _id uuid;
BEGIN
  SELECT * INTO _p FROM public.properties WHERE id = _property_id;
  IF _p.id IS NULL OR _p.archived_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT _p.hermes_enabled THEN RETURN NULL; END IF;
  IF _p.airbnb_listing_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.hermes_jobs (owner_id, property_id, property_uuid, event_type, payload, dedupe_key)
  VALUES (_p.owner_id, _p.airbnb_listing_id, _p.id, _event, coalesce(_payload, '{}'::jsonb), _dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO _id;
  RETURN _id;
END; $fn$;

REVOKE ALL ON FUNCTION public.hermes_enqueue(uuid, public.hermes_event, jsonb, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hermes_enqueue_checkout_amanha()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _r record; _n integer := 0;
BEGIN
  FOR _r IN
    SELECT r.id, r.property_id, r.guest_label, r.checkout_date
    FROM public.reservations r
    JOIN public.properties p ON p.id = r.property_id
    WHERE r.checkout_date = public.app_today() + 1
      AND r.status::text <> 'cancelled'
      AND p.hermes_enabled AND p.archived_at IS NULL
  LOOP
    IF public.hermes_enqueue(_r.property_id, 'checkout_amanha',
         jsonb_build_object('reservation_id', _r.id, 'guest_label', _r.guest_label,
                            'checkout_date', _r.checkout_date),
         'checkout_amanha:' || _r.id::text || ':' || _r.checkout_date::text) IS NOT NULL
    THEN _n := _n + 1; END IF;
  END LOOP;
  RETURN _n;
END; $fn$;

REVOKE ALL ON FUNCTION public.hermes_enqueue_checkout_amanha() FROM PUBLIC, anon, authenticated;

-- Agendamento, quando decidirem ligar:
--   SELECT cron.schedule('hermes-checkout-amanha', '0 15 * * *',
--                        $$ SELECT public.hermes_enqueue_checkout_amanha(); $$);

DELETE FROM public.hermes_jobs
WHERE status = 'pendente'
  AND property_uuid IN (SELECT id FROM public.properties WHERE NOT hermes_enabled);
