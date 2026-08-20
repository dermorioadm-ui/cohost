-- 0037 — Calendário de saída: o app deixa de só ler e passa a publicar.
--
-- Até aqui a sincronia era de mão única: liam-se os links do Airbnb e do
-- Booking, e as reservas entravam. Mas nada saía. Na prática isso significa que
-- uma reserva feita no Booking NÃO bloqueia as datas no Airbnb — os dois canais
-- continuam vendendo as mesmas noites, e a dupla reserva só aparece quando dois
-- hóspedes chegam no mesmo dia.
--
-- Este feed fecha o circuito: cada imóvel ganha uma URL .ics estável para colar
-- na importação de calendário de qualquer canal.
--
-- DUAS DECISÕES QUE PARECEM DETALHE E NÃO SÃO:
--
-- 1. O feed NÃO leva identidade de hóspede. Nome, e-mail e telefone ficam de
--    fora — a 0022 já estabeleceu essa fronteira para a diarista, e aqui ela
--    vale ainda mais: a URL vai parar dentro de um sistema de terceiros. Todo
--    evento é apenas "ocupado", como o próprio Airbnb faz nos feeds dele.
--
-- 2. O feed sabe quem está perguntando. Quem importa é um canal específico, e
--    devolver a esse canal as reservas que ele mesmo criou é como devolver um
--    eco: o Airbnb reimportaria as próprias reservas como bloqueios externos e,
--    no dia em que uma fosse cancelada, o bloqueio importado poderia sobreviver
--    ao cancelamento e travar a data sem motivo. Por isso o parâmetro `_para`
--    exclui a origem.

-- ---------------------------------------------------------------------------
-- Token do feed
-- ---------------------------------------------------------------------------

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS ical_feed_token_hash text,
  ADD COLUMN IF NOT EXISTS ical_feed_rotated_at timestamptz;

COMMENT ON COLUMN public.properties.ical_feed_token_hash IS
  'Hash do token do feed .ics publico deste imovel. O token em claro so existe no momento em que e emitido: quem perder a URL emite outra, o que rotaciona e invalida a anterior.';

-- Índice para a busca do feed ser por hash, e não varredura.
CREATE INDEX IF NOT EXISTS idx_properties_ical_feed_token
  ON public.properties (ical_feed_token_hash)
  WHERE ical_feed_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Emissão da URL (dono)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.issue_ical_feed_token(_property_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _token text;
BEGIN
  -- Autoriza pelo dono. SECURITY DEFINER ignora RLS, então a checagem é aqui.
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = _property_id AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Imóvel não encontrado' USING ERRCODE = '42501';
  END IF;

  _token := public.generate_token(32);

  UPDATE public.properties
  SET ical_feed_token_hash = public.hash_token(_token),
      ical_feed_rotated_at = now()
  WHERE id = _property_id;

  RETURN _token;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.issue_ical_feed_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_ical_feed_token(uuid) TO authenticated;

COMMENT ON FUNCTION public.issue_ical_feed_token(uuid) IS
  'Emite (ou rotaciona) o token do feed .ics do imovel. Devolve o token em claro uma unica vez.';

-- ---------------------------------------------------------------------------
-- Leitura do feed (anônimo, autorizado pelo token)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ical_feed_rows(_token text, _para text DEFAULT NULL)
RETURNS TABLE (
  property_id uuid,
  property_name text,
  reservation_id uuid,
  provider text,
  checkin_date date,
  checkout_date date,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    p.id,
    p.name,
    r.id,
    r.provider::text,
    r.checkin_date,
    r.checkout_date,
    r.updated_at
  FROM public.properties p
  JOIN public.reservations r ON r.property_id = p.id
  WHERE p.ical_feed_token_hash IS NOT NULL
    AND p.ical_feed_token_hash = public.hash_token(_token)
    AND p.archived_at IS NULL
    AND r.status = 'confirmed'
    -- Passado não interessa a quem está vendendo noites futuras, e um feed que
    -- carrega anos de histórico fica pesado e lento de importar. Um mês para
    -- trás cobre a estadia em curso.
    AND r.checkout_date >= (public.app_today() - INTERVAL '31 days')::date
    -- Não devolve ao canal o eco das reservas dele mesmo.
    AND (_para IS NULL OR r.provider::text <> _para)
  ORDER BY r.checkin_date;
$fn$;

REVOKE EXECUTE ON FUNCTION public.ical_feed_rows(text, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ical_feed_rows(text, text) IS
  'Linhas do feed .ics de um imovel, autorizadas pelo token. Nao devolve identidade de hospede: o destino e um sistema de terceiros. `_para` exclui as reservas do proprio canal que esta importando.';
