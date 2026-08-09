-- =============================================================================
-- 0020 — O convite lembra o imóvel, e o aceite vincula de verdade
-- =============================================================================
-- O convite pedia `property_id`, conferia que o imóvel era do dono… e jogava
-- fora. Nenhuma coluna guardava a escolha. No aceite, a rotina que passa as
-- limpezas pendentes para a diarista filtrava por `pr.cleaner_id = _cleaner_id`
-- — condição que nunca era verdadeira, porque o único lugar em todo o backend
-- que escrevia `properties.cleaner_id` era o formulário de imóvel.
--
-- Resultado: o dono convidava a diarista pelo onboarding, ela aceitava, o
-- vínculo dono↔diarista nascia — e o imóvel continuava sem diarista, com a
-- agenda dela vazia. Os dois lados achavam que o outro tinha feito errado.
-- =============================================================================

ALTER TABLE public.cleaner_invites
  ADD COLUMN IF NOT EXISTS property_id uuid
    REFERENCES public.properties(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.cleaner_invites.property_id IS
  'Imóvel que passa a ser dela quando aceitar. NULL = convite sem imóvel definido.';

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

  -- O imóvel do convite passa a ser dela. Só quando está sem ninguém: um
  -- convite não tira o imóvel de outra diarista que já esteja atendendo.
  IF _invite.property_id IS NOT NULL THEN
    UPDATE public.properties
    SET cleaner_id = _cleaner_id, updated_at = now()
    WHERE id = _invite.property_id
      AND owner_id = _invite.owner_id
      AND cleaner_id IS NULL;
  END IF;

  -- Toda tarefa pendente do dono sem diarista passa a ser dela.
  -- Depende do UPDATE acima: é ele que faz esta condição casar.
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
          jsonb_build_object('owner_id', _invite.owner_id,
                             'property_id', _invite.property_id));

  RETURN _conn_id;
END;
$$;
