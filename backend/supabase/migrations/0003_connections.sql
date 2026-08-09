-- =============================================================================
-- 0003 — Vínculo dono ↔ diarista, com convite por link mágico
-- =============================================================================
-- No backend antigo o convite ia por e-mail e a diarista tinha que abrir a
-- caixa, criar senha e voltar. É o maior ralo de ativação do produto: diarista
-- não usa e-mail. Aqui o convite vira um TOKEN opaco que viaja por onde você
-- quiser (wa.me manual hoje, Cloud API depois) e resolve o acesso em um toque.
--
-- O token nunca é gravado em claro — guardamos só o hash.
-- =============================================================================

CREATE TYPE public.invite_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');

CREATE TABLE public.cleaner_invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  cleaner_name      text NOT NULL,
  cleaner_email     text,
  cleaner_phone_e164 text,

  token_hash        text NOT NULL UNIQUE,
  status            public.invite_status NOT NULL DEFAULT 'pending',

  accepted_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at       timestamptz,
  expires_at        timestamptz NOT NULL,
  last_sent_at      timestamptz,
  send_count        int NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cleaner_invites_contact_required
    CHECK (cleaner_email IS NOT NULL OR cleaner_phone_e164 IS NOT NULL)
);

CREATE INDEX idx_cleaner_invites_owner  ON public.cleaner_invites (owner_id, status);
CREATE INDEX idx_cleaner_invites_status ON public.cleaner_invites (status, expires_at);

CREATE TRIGGER trg_cleaner_invites_updated_at
  BEFORE UPDATE ON public.cleaner_invites
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.cleaner_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cleaner_invites: dono gerencia os seus"
  ON public.cleaner_invites FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "cleaner_invites: admin lê tudo"
  ON public.cleaner_invites FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- connections — o vínculo ativo. Uma diarista pode atender vários donos.
-- -----------------------------------------------------------------------------
CREATE TABLE public.connections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cleaner_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invite_id   uuid REFERENCES public.cleaner_invites(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, cleaner_id)
);

CREATE INDEX idx_connections_owner   ON public.connections (owner_id) WHERE active;
CREATE INDEX idx_connections_cleaner ON public.connections (cleaner_id) WHERE active;

CREATE TRIGGER trg_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connections: participantes leem"
  ON public.connections FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR cleaner_id = auth.uid());

CREATE POLICY "connections: dono desativa"
  ON public.connections FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "connections: admin lê tudo"
  ON public.connections FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Quem eu posso ver? Usado pelas policies de perfil cruzado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.connected_user_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cleaner_id FROM public.connections WHERE owner_id = _user_id AND active
  UNION
  SELECT owner_id   FROM public.connections WHERE cleaner_id = _user_id AND active;
$$;

REVOKE EXECUTE ON FUNCTION public.connected_user_ids(uuid) FROM anon;

-- Dono e diarista precisam ver nome/telefone um do outro — e SÓ isso.
-- Por isso é uma função com colunas explícitas, não uma policy na profiles.
CREATE OR REPLACE FUNCTION public.connected_profiles()
RETURNS TABLE (
  user_id    uuid,
  full_name  text,
  email      text,
  phone_e164 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id, p.full_name, p.email, p.phone_e164
  FROM public.profiles p
  WHERE p.user_id IN (SELECT public.connected_user_ids(auth.uid()));
$$;

GRANT EXECUTE ON FUNCTION public.connected_profiles() TO authenticated;

-- -----------------------------------------------------------------------------
-- Aceite do convite. Roda como service_role a partir da edge function
-- cleaner-accept, que já validou o token.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_cleaner_invite(_token text, _cleaner_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _invite public.cleaner_invites%ROWTYPE;
  _conn_id uuid;
BEGIN
  SELECT * INTO _invite
  FROM public.cleaner_invites
  WHERE token_hash = public.hash_token(_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'convite_invalido' USING ERRCODE = 'P0002';
  END IF;

  IF _invite.status = 'accepted' AND _invite.accepted_by = _cleaner_id THEN
    SELECT id INTO _conn_id FROM public.connections
    WHERE owner_id = _invite.owner_id AND cleaner_id = _cleaner_id;
    RETURN _conn_id;                       -- idempotente
  END IF;

  IF _invite.status <> 'pending' THEN
    RAISE EXCEPTION 'convite_ja_usado' USING ERRCODE = 'P0002';
  END IF;

  IF _invite.expires_at < now() THEN
    UPDATE public.cleaner_invites SET status = 'expired' WHERE id = _invite.id;
    RAISE EXCEPTION 'convite_expirado' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_cleaner_id, 'cleaner')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.connections (owner_id, cleaner_id, invite_id)
  VALUES (_invite.owner_id, _cleaner_id, _invite.id)
  ON CONFLICT (owner_id, cleaner_id)
    DO UPDATE SET active = true, updated_at = now()
  RETURNING id INTO _conn_id;

  UPDATE public.cleaner_invites
  SET status = 'accepted', accepted_by = _cleaner_id, accepted_at = now()
  WHERE id = _invite.id;

  -- Toda tarefa pendente do dono sem diarista passa a ser dela.
  UPDATE public.cleaning_tasks t
  SET cleaner_id = _cleaner_id, updated_at = now()
  FROM public.properties pr
  WHERE t.property_id = pr.id
    AND pr.owner_id = _invite.owner_id
    AND pr.cleaner_id = _cleaner_id
    AND t.status = 'pending'
    AND t.cleaner_id IS DISTINCT FROM _cleaner_id;

  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (_cleaner_id, 'cleaner', 'invite.accepted', 'cleaner_invites', _invite.id::text,
          jsonb_build_object('owner_id', _invite.owner_id));

  RETURN _conn_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_cleaner_invite(text, uuid) FROM anon, authenticated;

COMMENT ON FUNCTION public.accept_cleaner_invite(text, uuid) IS
  'Aceita convite e cria vínculo. Só service_role (chamada pela edge function cleaner-accept).';
