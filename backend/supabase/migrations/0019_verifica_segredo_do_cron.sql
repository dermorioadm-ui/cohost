-- O segredo das rotinas vive em private.job_config, que é quem o pg_cron usa
-- para assinar a chamada. As functions conferiam contra uma variável de
-- ambiente separada — duas fontes para a mesma verdade, e a segunda nunca foi
-- preenchida, então toda rotina respondia 500.
--
-- Passa a existir uma fonte só. A comparação é feita aqui, em tempo constante,
-- e o segredo nunca sai do banco.

CREATE OR REPLACE FUNCTION public.verify_cron_secret(_provided text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = private, public
AS $$
DECLARE
  _expected text;
  _diff     int := 0;
  _i        int;
BEGIN
  SELECT cron_secret INTO _expected FROM private.job_config WHERE id = 1;

  IF _expected IS NULL OR _provided IS NULL THEN
    RETURN false;
  END IF;
  IF length(_provided) <> length(_expected) THEN
    RETURN false;
  END IF;

  FOR _i IN 1..length(_expected) LOOP
    _diff := _diff | (ascii(substr(_expected, _i, 1)) # ascii(substr(_provided, _i, 1)));
  END LOOP;

  RETURN _diff = 0;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_cron_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_cron_secret(text) TO service_role;
