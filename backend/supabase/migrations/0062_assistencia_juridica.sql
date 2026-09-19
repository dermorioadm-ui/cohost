-- Contratação jurídica independente do SaaS. Migração aditiva; nenhuma oferta
-- pode cobrar sem dados comerciais e operação explicitamente configurados.
CREATE TABLE public.legal_offers (
  id text PRIMARY KEY DEFAULT 'legal-annual',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title text NOT NULL DEFAULT 'Assistência jurídica anual',
  enabled boolean NOT NULL DEFAULT false,
  annual_price_cents integer CHECK (annual_price_cents > 0),
  currency text NOT NULL DEFAULT 'brl' CHECK (currency = 'brl'),
  term_months integer NOT NULL DEFAULT 12 CHECK (term_months = 12),
  stripe_price_id text,
  scope_text text,
  property_scope_text text,
  service_terms text,
  payment_terms text,
  terms_url text,
  operations_ready boolean NOT NULL DEFAULT false,
  coordinator_user_id uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.legal_offers(id) VALUES ('legal-annual');
CREATE FUNCTION public.tg_legal_offer_version()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
  IF (to_jsonb(NEW)-ARRAY['updated_at','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','version']) THEN NEW.version:=greatest(NEW.version,OLD.version+1); END IF;
  NEW.updated_at:=now(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.tg_legal_offer_version() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER legal_offer_version BEFORE UPDATE ON public.legal_offers FOR EACH ROW EXECUTE FUNCTION public.tg_legal_offer_version();
ALTER TABLE public.legal_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legal_offers FROM anon, authenticated;
GRANT ALL ON public.legal_offers TO service_role;

CREATE FUNCTION public.legal_offer_ready(_offer public.legal_offers)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _offer.enabled AND _offer.operations_ready
    AND _offer.annual_price_cents > 0 AND _offer.stripe_price_id ~ '^price_[A-Za-z0-9]+$'
    AND length(btrim(_offer.scope_text)) > 0
    AND length(btrim(_offer.property_scope_text)) > 0
    AND length(btrim(_offer.service_terms)) > 0
    AND length(btrim(_offer.payment_terms)) > 0
    AND _offer.terms_url ~ '^https://[^[:space:]]+$'
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _offer.coordinator_user_id AND role = 'admin');
$$;
CREATE FUNCTION public.legal_offer()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT jsonb_build_object('available', true, 'offer',
    to_jsonb(o) - ARRAY['enabled','operations_ready','coordinator_user_id','stripe_price_id','updated_at'])
    FROM public.legal_offers o WHERE public.legal_offer_ready(o) IS TRUE ORDER BY id LIMIT 1),
    '{"available":false,"offer":null}'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.legal_offer_ready(public.legal_offers) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.legal_offer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_offer_ready(public.legal_offers) TO service_role;
GRANT EXECUTE ON FUNCTION public.legal_offer() TO anon, authenticated, service_role;

CREATE TABLE public.legal_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  request_key uuid NOT NULL,
  offer_id text NOT NULL REFERENCES public.legal_offers(id),
  offer_version integer NOT NULL,
  offer_snapshot jsonb NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency = 'brl'),
  stripe_price_id text NOT NULL,
  stripe_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','pending','paid','failed','expired','payment_review')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX legal_one_pending_per_user ON public.legal_orders(user_id) WHERE status IN ('creating','pending');
CREATE TABLE public.legal_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  order_id uuid NOT NULL UNIQUE REFERENCES public.legal_orders(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  offer_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX legal_access_by_user ON public.legal_entitlements(user_id, ends_at);
CREATE TABLE public.legal_payment_events (
  event_key text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.legal_orders(id),
  payment_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.legal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  entitlement_id uuid NOT NULL REFERENCES public.legal_entitlements(id),
  request_key uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 5 AND 160),
  description text NOT NULL CHECK (length(description) BETWEEN 20 AND 6000),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_review','waiting_customer','completed')),
  public_reply text NOT NULL DEFAULT '' CHECK (length(public_reply) <= 6000),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, request_key)
);
CREATE TABLE public.legal_request_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.legal_requests(id),
  author_id uuid NOT NULL REFERENCES auth.users(id),
  author_role text NOT NULL CHECK (author_role IN ('owner','admin')),
  request_key uuid NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(author_id,request_key)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['legal_orders','legal_entitlements','legal_payment_events','legal_requests','legal_request_messages'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
-- Leitura própria mesmo após vencimento; escrita somente por RPCs autorizadas.
GRANT SELECT ON public.legal_entitlements, public.legal_requests TO authenticated;
CREATE POLICY legal_entitlements_read ON public.legal_entitlements FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());
CREATE POLICY legal_requests_read ON public.legal_requests FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

CREATE FUNCTION public.legal_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u uuid := auth.uid(); BEGIN
  IF u IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'has_access', EXISTS (SELECT 1 FROM public.legal_entitlements WHERE user_id=u AND status='active' AND starts_at<=now() AND ends_at>now()),
    'entitlements', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY ends_at DESC) FROM public.legal_entitlements e WHERE user_id=u), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('messages',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at,m.id) FROM public.legal_request_messages m WHERE m.request_id=r.id),'[]'::jsonb)) ORDER BY created_at DESC) FROM public.legal_requests r WHERE user_id=u), '[]'::jsonb),
    'orders', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'created_at',created_at) ORDER BY created_at DESC) FROM public.legal_orders WHERE user_id=u), '[]'::jsonb)
  );
END $$;
CREATE FUNCTION public.legal_create_request(_subject text, _description text, _request_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u uuid:=auth.uid(); e uuid; r public.legal_requests; BEGIN
  IF u IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE='42501'; END IF;
  IF _request_key IS NULL OR length(btrim(_subject)) NOT BETWEEN 5 AND 160 OR length(btrim(_description)) NOT BETWEEN 20 AND 6000 OR _subject IS NULL OR _description IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(u::text,62));
  SELECT * INTO r FROM public.legal_requests WHERE user_id=u AND request_key=_request_key;
  IF FOUND THEN RETURN to_jsonb(r); END IF;
  SELECT id INTO e FROM public.legal_entitlements WHERE user_id=u AND status='active' AND starts_at<=now() AND ends_at>now() ORDER BY ends_at DESC LIMIT 1;
  IF e IS NULL THEN RAISE EXCEPTION 'legal_access_required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.legal_requests(user_id,entitlement_id,request_key,subject,description)
    VALUES(u,e,_request_key,btrim(_subject),btrim(_description)) RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.admin_legal_requests()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.assert_admin();
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('email',p.email,'full_name',p.full_name,'messages',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at,m.id) FROM public.legal_request_messages m WHERE m.request_id=r.id),'[]'::jsonb)) ORDER BY r.created_at DESC)
    FROM public.legal_requests r LEFT JOIN public.profiles p ON p.user_id=r.user_id), '[]'::jsonb);
END $$;
CREATE FUNCTION public.admin_legal_update_request(_id uuid, _status text, _public_reply text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.legal_requests; BEGIN
  PERFORM public.assert_admin();
  IF _status IS NULL OR _status NOT IN ('received','in_review','waiting_customer','completed') OR length(coalesce(_public_reply,'')) > 6000 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.legal_requests WHERE id=_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  IF btrim(coalesce(_public_reply,''))<>'' AND _public_reply IS DISTINCT FROM r.public_reply THEN
    INSERT INTO public.legal_request_messages(request_id,author_id,author_role,request_key,message) VALUES(_id,auth.uid(),'admin',gen_random_uuid(),btrim(_public_reply));
  END IF;
  UPDATE public.legal_requests SET status=_status,public_reply=coalesce(_public_reply,''),updated_at=now(),updated_by=auth.uid() WHERE id=_id RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.audit_log(actor_id,actor_role,action,entity,entity_id,metadata)
    VALUES(auth.uid(),'admin','legal.request_updated','legal_requests',_id::text,jsonb_build_object('status',_status));
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.legal_reply_request(_id uuid,_message text,_request_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u uuid:=auth.uid(); r public.legal_requests; m public.legal_request_messages; BEGIN
  IF u IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE='42501'; END IF;
  IF _request_key IS NULL OR _message IS NULL OR length(btrim(_message)) NOT BETWEEN 1 AND 6000 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.legal_requests WHERE id=_id AND user_id=u FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO m FROM public.legal_request_messages WHERE author_id=u AND request_key=_request_key;
  IF FOUND THEN RETURN to_jsonb(m); END IF;
  IF r.status='completed' THEN RAISE EXCEPTION 'legal_request_completed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.legal_entitlements WHERE user_id=u AND status='active' AND starts_at<=now() AND ends_at>now()) THEN RAISE EXCEPTION 'legal_access_required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.legal_request_messages(request_id,author_id,author_role,request_key,message) VALUES(_id,u,'owner',_request_key,btrim(_message)) RETURNING * INTO m;
  UPDATE public.legal_requests SET status='received',updated_at=now(),updated_by=u WHERE id=_id;
  RETURN to_jsonb(m);
END $$;

-- Serviço reserva uma única compra pendente sob lock. Identidade vem da Edge autenticada.
CREATE FUNCTION public.legal_reserve_order(_user_id uuid,_offer_id text,_offer_version integer,_request_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.legal_offers; r public.legal_orders; BEGIN
  IF _user_id IS NULL OR _request_key IS NULL THEN RAISE EXCEPTION 'invalid_request'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_user_id::text,62));
  IF EXISTS(SELECT 1 FROM public.legal_entitlements WHERE user_id=_user_id AND status='active' AND starts_at<=now() AND ends_at>now()) THEN RAISE EXCEPTION 'legal_already_active'; END IF;
  SELECT * INTO o FROM public.legal_offers WHERE id=_offer_id;
  IF NOT FOUND OR public.legal_offer_ready(o) IS NOT TRUE THEN RAISE EXCEPTION 'legal_offer_unavailable'; END IF;
  IF o.version <> _offer_version THEN RAISE EXCEPTION 'legal_offer_changed'; END IF;
  SELECT * INTO r FROM public.legal_orders WHERE user_id=_user_id AND (status IN ('creating','pending') OR request_key=_request_key) ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF r.offer_version<>_offer_version THEN RAISE EXCEPTION 'legal_checkout_pending'; END IF;
    RETURN to_jsonb(r);
  END IF;
  INSERT INTO public.legal_orders(user_id,request_key,offer_id,offer_version,offer_snapshot,amount_cents,currency,stripe_price_id)
    VALUES(_user_id,_request_key,o.id,o.version,to_jsonb(o)-ARRAY['enabled','operations_ready','coordinator_user_id','stripe_price_id','updated_at'],o.annual_price_cents,o.currency,o.stripe_price_id) RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

-- Pagamento e direito persistem na mesma transação; duplicação não estende vigência.
-- A Edge confere na Stripe preço, modo, usuário, moeda, total e sessão antes desta RPC.
CREATE FUNCTION public.legal_apply_payment(_order_id uuid,_session_id text,_payment_intent_id text,_event_key text,_state text,_paid_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.legal_orders; e public.legal_entitlements; BEGIN
  SELECT * INTO o FROM public.legal_orders WHERE id=_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'legal_order_not_found'; END IF;
  IF o.stripe_session_id IS DISTINCT FROM _session_id THEN RAISE EXCEPTION 'legal_session_mismatch'; END IF;
  IF o.stripe_payment_intent_id IS NOT NULL AND _payment_intent_id IS NOT NULL AND o.stripe_payment_intent_id<>_payment_intent_id THEN RAISE EXCEPTION 'legal_payment_mismatch'; END IF;
  IF _state NOT IN ('pending','paid','failed','expired','payment_review') THEN RAISE EXCEPTION 'invalid_payment_state'; END IF;
  IF _event_key IS NULL OR _event_key='' THEN RAISE EXCEPTION 'invalid_event'; END IF;
  INSERT INTO public.legal_payment_events(event_key,order_id,payment_state) VALUES(_event_key,o.id,_state) ON CONFLICT DO NOTHING;
  IF _state='paid' THEN
    IF _paid_at IS NULL OR _payment_intent_id IS NULL OR _paid_at > now()+interval '5 minutes' THEN RAISE EXCEPTION 'invalid_payment'; END IF;
    IF o.status<>'payment_review' THEN
      INSERT INTO public.legal_entitlements(user_id,order_id,starts_at,ends_at,offer_snapshot)
        VALUES(o.user_id,o.id,_paid_at,_paid_at+interval '12 months',o.offer_snapshot) ON CONFLICT(order_id) DO NOTHING;
    END IF;
    -- Uma confirmação atrasada não apaga uma exceção financeira já registrada.
    UPDATE public.legal_orders SET status=CASE WHEN status='payment_review' THEN status ELSE 'paid' END,stripe_payment_intent_id=_payment_intent_id,updated_at=now() WHERE id=o.id;
  ELSIF _state='payment_review' THEN
    UPDATE public.legal_orders SET status='payment_review',stripe_payment_intent_id=coalesce(_payment_intent_id,stripe_payment_intent_id),updated_at=now() WHERE id=o.id;
  ELSIF o.status NOT IN ('paid','payment_review') THEN
    UPDATE public.legal_orders SET status=_state,updated_at=now() WHERE id=o.id;
  END IF;
  SELECT * INTO e FROM public.legal_entitlements WHERE order_id=o.id;
  RETURN jsonb_build_object('state',CASE WHEN e.id IS NOT NULL AND e.status='active' AND e.starts_at<=now() AND e.ends_at>now() THEN 'active' WHEN e.id IS NOT NULL OR o.status='payment_review' OR _state IN ('failed','expired','payment_review') THEN 'failed' ELSE 'pending' END,'entitlement',CASE WHEN e.id IS NOT NULL THEN to_jsonb(e) ELSE NULL END);
END $$;

CREATE FUNCTION public.admin_legal_payment_reviews()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$ BEGIN
  PERFORM public.assert_admin();
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'user_id',o.user_id,'email',p.email,'status',o.status,'stripe_session_id',o.stripe_session_id,'updated_at',o.updated_at)) FROM public.legal_orders o LEFT JOIN public.profiles p ON p.user_id=o.user_id WHERE o.status='payment_review' OR (o.status='creating' AND o.created_at < now()-interval '1 hour')), '[]'::jsonb);
END $$;
DO $$ DECLARE fn text; BEGIN
  FOREACH fn IN ARRAY ARRAY['legal_overview()','legal_create_request(text,text,uuid)','legal_reply_request(uuid,text,uuid)','admin_legal_requests()','admin_legal_update_request(uuid,text,text)','admin_legal_payment_reviews()'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.'||fn||' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||fn||' TO authenticated, service_role';
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['legal_reserve_order(uuid,text,integer,uuid)','legal_apply_payment(uuid,text,text,text,text,timestamptz)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.'||fn||' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||fn||' TO service_role';
  END LOOP;
END $$;
