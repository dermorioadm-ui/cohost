-- Diarista entra pelo site: WhatsApp + código de 6 dígitos.
--
-- Até aqui a única porta da diarista era o link do convite (token + telefone).
-- Quem perde o link cai na tela de login do site, que só tem e-mail e senha —
-- e a diarista, sem achar a porta, se cadastra como dona (foi o caso da Aline).
--
-- A porta nova mantém dois fatores sem depender de SMS: o WhatsApp dela e um
-- código de 6 dígitos que o dono vê ao gerar o link do painel e passa a ela.
-- O código fica só como hash, salgado com o id da conta, fora do schema
-- exposto; a tentativa errada é contada por telefone para frear adivinhação.

CREATE TABLE IF NOT EXISTS private.cleaner_codes (
  cleaner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS private.cleaner_login_attempts (
  id           bigserial PRIMARY KEY,
  phone_e164   text NOT NULL,
  ok           boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cleaner_login_attempts_phone
  ON private.cleaner_login_attempts (phone_e164, attempted_at);

-- Grava (ou troca) o código. `_only_if_missing` é o que o aceite do link usa:
-- a primeira entrada dela ganha um código sem apagar um que o dono já passou.
CREATE OR REPLACE FUNCTION public.cleaner_set_code(
  _cleaner_id uuid,
  _code text,
  _only_if_missing boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, extensions
AS $$
DECLARE
  _digits text := regexp_replace(coalesce(_code, ''), '[^0-9]', '', 'g');
BEGIN
  IF length(_digits) <> 6 THEN
    RAISE EXCEPTION 'codigo_invalido' USING ERRCODE = 'P0002';
  END IF;

  IF _only_if_missing AND EXISTS (SELECT 1 FROM private.cleaner_codes WHERE cleaner_id = _cleaner_id) THEN
    RETURN false;
  END IF;

  INSERT INTO private.cleaner_codes (cleaner_id, code_hash, set_at)
  VALUES (_cleaner_id, public.hash_token(_cleaner_id::text || ':' || _digits), now())
  ON CONFLICT (cleaner_id) DO UPDATE
    SET code_hash = EXCLUDED.code_hash, set_at = now();

  RETURN true;
END;
$$;

-- Valida WhatsApp + código e devolve a conta da diarista.
-- Erros: muitas_tentativas (5 erradas em 15 min) e acesso_invalido.
CREATE OR REPLACE FUNCTION public.cleaner_login(_phone text, _code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, extensions
AS $$
DECLARE
  _phone_e164 text := public.normalize_phone(_phone);
  _digits     text := regexp_replace(coalesce(_code, ''), '[^0-9]', '', 'g');
  _erradas    int;
  _id         uuid;
BEGIN
  IF _phone_e164 IS NULL THEN
    RAISE EXCEPTION 'acesso_invalido' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO _erradas
  FROM private.cleaner_login_attempts
  WHERE phone_e164 = _phone_e164
    AND NOT ok
    AND attempted_at > now() - interval '15 minutes';

  IF _erradas >= 5 THEN
    RAISE EXCEPTION 'muitas_tentativas' USING ERRCODE = 'P0002';
  END IF;

  -- Só entra quem é diarista E está vinculada a algum dono: uma conta que o
  -- dono desvinculou perde a porta junto com o vínculo.
  SELECT p.user_id INTO _id
  FROM public.profiles p
  JOIN private.cleaner_codes k ON k.cleaner_id = p.user_id
  WHERE p.phone_e164 = _phone_e164
    AND k.code_hash = public.hash_token(p.user_id::text || ':' || _digits)
    AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id AND r.role = 'cleaner')
    AND EXISTS (SELECT 1 FROM public.connections c WHERE c.cleaner_id = p.user_id AND c.active)
  LIMIT 1;

  INSERT INTO private.cleaner_login_attempts (phone_e164, ok)
  VALUES (_phone_e164, _id IS NOT NULL);

  DELETE FROM private.cleaner_login_attempts WHERE attempted_at < now() - interval '1 day';

  IF _id IS NULL THEN
    RAISE EXCEPTION 'acesso_invalido' USING ERRCODE = 'P0002';
  END IF;

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.cleaner_set_code(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleaner_login(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleaner_set_code(uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleaner_login(text, text) TO service_role;
