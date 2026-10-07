-- =============================================================================
-- 0062 — Janela da portaria com horário próprio, separado do check-in/out
-- =============================================================================
-- Até aqui o acesso ao prédio era exatamente o horário do imóvel: entra no
-- `checkin_time` do dia de chegada, sai no `checkout_time` do dia de saída. No
-- Sou Mais (check-out às 9h) isso trancava dentro do prédio o hóspede que
-- atrasava a saída — a Kiper corta o acesso na hora exata.
--
-- O horário do imóvel continua sendo o que o hóspede lê (e-mail, chat, termo).
-- Estas duas colunas valem só para a portaria; nulas, nada muda.
--
-- Por que trigger e não as edge functions: duas delas enfileiram
-- (`guest-register` e o preenchimento do passado em `porter-connect`), e as
-- duas montam a janela a partir de `checkin_time`/`checkout_time`. Aplicar a
-- regra na entrada da fila cobre os dois caminhos — e qualquer outro que
-- apareça — sem depender de as duas functions estarem publicadas na mesma
-- versão. Só a hora é trocada; a DATA continua sendo a que a function mandou.
-- =============================================================================

ALTER TABLE public.properties
  ADD COLUMN porter_access_from_time  time,
  ADD COLUMN porter_access_until_time time;

COMMENT ON COLUMN public.properties.porter_access_from_time IS
  'Hora em que a portaria libera o hóspede no dia do check-in. Nula = checkin_time.';
COMMENT ON COLUMN public.properties.porter_access_until_time IS
  'Hora em que a portaria corta o acesso no dia do check-out. Nula = checkout_time.';

CREATE OR REPLACE FUNCTION public.tg_porter_registrations_access_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _from  time;
  _until time;
  _tz    text := public.app_tz();
BEGIN
  SELECT porter_access_from_time, porter_access_until_time
    INTO _from, _until
    FROM public.properties
   WHERE id = NEW.property_id;

  IF _from IS NOT NULL THEN
    NEW.access_from :=
      ((NEW.access_from AT TIME ZONE _tz)::date + _from) AT TIME ZONE _tz;
  END IF;

  IF _until IS NOT NULL THEN
    NEW.access_until :=
      ((NEW.access_until AT TIME ZONE _tz)::date + _until) AT TIME ZONE _tz;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_porter_registrations_access_window() FROM PUBLIC;

CREATE TRIGGER trg_porter_reg_access_window
  BEFORE INSERT ON public.porter_registrations
  FOR EACH ROW EXECUTE FUNCTION public.tg_porter_registrations_access_window();
