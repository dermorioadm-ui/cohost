-- Segredos que nascem em runtime (ex.: a assinatura do webhook da Stripe,
-- que só existe depois de criar o endpoint pela API) e não têm como virar
-- variável de ambiente sem passar pelo painel do Supabase. Ficam fora do
-- schema exposto; só a service_role lê e grava, via RPC.
CREATE TABLE IF NOT EXISTS private.secrets (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.private_secret(_name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private, public
AS $$
  SELECT value FROM private.secrets WHERE name = _name;
$$;

CREATE OR REPLACE FUNCTION public.private_secret_set(_name text, _value text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = private, public
AS $$
  INSERT INTO private.secrets (name, value, updated_at)
  VALUES (_name, _value, now())
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
$$;

REVOKE ALL ON FUNCTION public.private_secret(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.private_secret_set(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.private_secret(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.private_secret_set(text, text) TO service_role;
