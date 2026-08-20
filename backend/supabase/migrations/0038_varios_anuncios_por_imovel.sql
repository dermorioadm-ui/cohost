-- 0038 — Vários anúncios do mesmo imóvel, e o bloqueio entre eles.
--
-- O `UNIQUE (property_id, provider)` permitia um link por canal. Quem anuncia o
-- mesmo apartamento duas vezes no Airbnb — coisa comum, para pegar buscas
-- diferentes — não tinha onde colar o segundo. Cair no `UPDATE` do primeiro
-- seria pior que recusar: o link antigo sumiria sem aviso e as reservas dele
-- parariam de entrar.
--
-- O SEGUNDO PROBLEMA, QUE SÓ APARECE AGORA. A 0037 fez o feed de saída excluir
-- as reservas do canal que está importando, para o Airbnb não reimportar as
-- próprias reservas como bloqueio externo. Com dois anúncios no MESMO canal
-- isso vira um buraco: o anúncio B recebe o feed sem NENHUMA reserva do Airbnb,
-- inclusive as do anúncio A — que é o apartamento dele. Os dois anúncios do
-- mesmo imóvel continuariam vendendo a mesma noite, que é exatamente o que a
-- 0037 existiu para impedir.
--
-- A exclusão passa a ser por ANÚNCIO, não por canal: cada link de saída ignora
-- só as reservas que ele mesmo trouxe. Dois anúncios no Airbnb passam a se
-- bloquear, e nenhum reimporta o próprio eco.

-- ---------------------------------------------------------------------------
-- Vários anúncios por canal
-- ---------------------------------------------------------------------------

ALTER TABLE public.property_ical_sources
  DROP CONSTRAINT IF EXISTS property_ical_sources_property_id_provider_key;

-- O que não pode repetir é a URL: colar o mesmo link duas vezes criaria duas
-- fontes lendo a mesma coisa, e toda reserva entraria em duplicata.
ALTER TABLE public.property_ical_sources
  ADD CONSTRAINT property_ical_sources_property_id_url_key
  UNIQUE (property_id, url);

-- Sem apelido, dois anúncios do Airbnb ficam indistinguíveis na tela — e o dono
-- não tem como saber qual link de saída colar em qual.
ALTER TABLE public.property_ical_sources
  ADD COLUMN IF NOT EXISTS label text;

COMMENT ON COLUMN public.property_ical_sources.label IS
  'Apelido do anuncio, dado pelo dono. So importa quando ha mais de um anuncio no mesmo canal: e o que distingue "casal" de "familia" na tela e diz qual link de saida vai em qual.';

COMMENT ON CONSTRAINT property_ical_sources_property_id_url_key
  ON public.property_ical_sources IS
  'Substitui o antigo UNIQUE (property_id, provider), que impedia dois anuncios no mesmo canal. O que de fato nao pode repetir e a URL: duas fontes lendo o mesmo link duplicariam toda reserva.';

-- ---------------------------------------------------------------------------
-- Feed de saída: exclusão por anúncio, e não por canal
-- ---------------------------------------------------------------------------

-- A assinatura antiga sai de cena. Ela recebia `_para` (o canal) e era o que
-- deixaria dois anuncios do mesmo canal sem se bloquear.
DROP FUNCTION IF EXISTS public.ical_feed_rows(text, text);

CREATE OR REPLACE FUNCTION public.ical_feed_rows(_token text, _exceto uuid DEFAULT NULL)
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
    AND r.checkout_date >= (public.app_today() - INTERVAL '31 days')::date
    -- Ignora só o que este anúncio mesmo trouxe. Reserva sem origem (lançada à
    -- mão) nunca é excluída: ela não veio de canal nenhum, então bloqueia todos.
    AND (_exceto IS NULL OR r.source_id IS DISTINCT FROM _exceto)
  ORDER BY r.checkin_date;
$fn$;

REVOKE EXECUTE ON FUNCTION public.ical_feed_rows(text, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ical_feed_rows(text, uuid) IS
  'Linhas do feed .ics de um imovel, autorizadas pelo token. Nao devolve identidade de hospede: o destino e um sistema de terceiros. `_exceto` e o id do anuncio que esta importando, e exclui apenas as reservas que ele proprio trouxe — por anuncio, e nao por canal, para que dois anuncios no mesmo Airbnb se bloqueiem.';
