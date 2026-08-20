-- 0042 — Duplicar o imovel para um segundo anuncio, ja travado contra o primeiro.
--
-- O cenario: o mesmo apartamento anunciado duas vezes no Airbnb (ou no Airbnb
-- e no Booking). Sao dois anuncios, dois calendarios, um imovel so. Se os dois
-- vendem a mesma noite, chegam dois hospedes na porta — e quem descobre e o
-- porteiro.
--
-- A 0038 ja permitiu varios anuncios por imovel, e a 0037 ja publicava o feed
-- de saida. Faltava o passo que ninguem faz na mao: ligar um no outro. Duplicar
-- sem cruzar os calendarios entrega exatamente o problema que a duplicacao
-- deveria resolver.
--
-- O CRUZAMENTO, e por que ele precisa do `exceto`
--
--   Feed de A publica as reservas de A. B assina o feed de A e passa a ter
--   bloqueio nas datas de A. So que agora B tem esses bloqueios como reservas
--   dele, e o feed de B publicaria os mesmos de volta para A — que ja os tinha.
--   Isso e eco: a data continua travada mesmo depois de a reserva original ser
--   cancelada, porque cada lado esta segurando a copia do outro.
--
--   Por isso a URL que B assina carrega `exceto=<id da fonte de A que vem de B>`:
--   "me manda tudo de A, menos o que voce ja recebeu de mim". Cada lado publica
--   so o que e originalmente seu.

CREATE OR REPLACE FUNCTION public.duplicar_imovel(
  _property_id uuid,
  _nome        text DEFAULT NULL,
  _feed_base   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _orig   public.properties%ROWTYPE;
  _novo   uuid;
  _nome_f text;
  _tok_a  text;
  _tok_b  text;
  _src_a  uuid;   -- fonte DENTRO do original, alimentada pela copia
  _src_b  uuid;   -- fonte DENTRO da copia, alimentada pelo original
  _base   text := COALESCE(NULLIF(btrim(_feed_base), ''), '');
BEGIN
  -- SECURITY DEFINER ignora RLS, entao a dona da checagem e esta linha.
  SELECT * INTO _orig
  FROM public.properties p
  WHERE p.id = _property_id AND p.owner_id = auth.uid() AND p.archived_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Imovel nao encontrado' USING ERRCODE = '42501';
  END IF;

  -- Nome default numerado. Dois cartoes com o mesmo nome na lista de imoveis
  -- e a forma mais rapida de o dono colar o link errado no anuncio errado.
  _nome_f := COALESCE(NULLIF(btrim(_nome), ''),
    _orig.name || ' — anuncio ' ||
    (1 + (SELECT count(*) FROM public.properties p
          WHERE p.owner_id = _orig.owner_id AND p.archived_at IS NULL
            AND (p.name = _orig.name OR p.name LIKE _orig.name || ' — anuncio %')))::text);

  -- A copia leva a CONFIGURACAO e nao o historico. Reservas, limpezas e
  -- hospedes pertencem ao anuncio que os gerou; copia-los inventaria
  -- faturamento que nunca existiu.
  --
  -- Fica de fora tambem: public_slug (tem default proprio e e unico),
  -- airbnb_listing_id (e outro anuncio, por definicao), e o token do feed
  -- (emitido abaixo).
  INSERT INTO public.properties (
    owner_id, cleaner_id, name, property_type, address, street_number, apt_number,
    block, neighborhood, city, state, zip_code, condo_name, condo_email, condo_notify,
    checkin_time, checkout_time, turnover_price, self_clean, ai_config, ai_prompt,
    ai_enabled, supplies_enabled, supplies_monthly_price, supplies_items, supplies_notes
  )
  SELECT
    _orig.owner_id, _orig.cleaner_id, _nome_f, _orig.property_type, _orig.address,
    _orig.street_number, _orig.apt_number, _orig.block, _orig.neighborhood, _orig.city,
    _orig.state, _orig.zip_code, _orig.condo_name, _orig.condo_email, _orig.condo_notify,
    _orig.checkin_time, _orig.checkout_time, _orig.turnover_price, _orig.self_clean,
    _orig.ai_config, _orig.ai_prompt, _orig.ai_enabled, _orig.supplies_enabled,
    _orig.supplies_monthly_price, _orig.supplies_items, _orig.supplies_notes
  RETURNING id INTO _novo;

  -- Sem base de URL nao da para cruzar os calendarios. Melhor devolver o
  -- imovel criado avisando disso do que criar o par e fingir que travou.
  IF _base = '' THEN
    RETURN jsonb_build_object(
      'id', _novo, 'nome', _nome_f, 'cruzado', false,
      'aviso', 'Imovel duplicado, mas os calendarios nao foram cruzados.');
  END IF;

  -- Tokens dos dois feeds. Emitir aqui rotaciona o do original: quem ja tinha
  -- colado a URL antiga no canal precisa colar a nova. E o preco de o par
  -- nascer travado, e a tela avisa.
  _tok_a := public.generate_token(32);
  _tok_b := public.generate_token(32);

  UPDATE public.properties
     SET ical_feed_token_hash = public.hash_token(_tok_a), ical_feed_rotated_at = now()
   WHERE id = _orig.id;

  UPDATE public.properties
     SET ical_feed_token_hash = public.hash_token(_tok_b), ical_feed_rotated_at = now()
   WHERE id = _novo;

  -- Os dois lados entram com URL provisoria porque cada um precisa do id do
  -- outro para montar o `exceto`. Sao duas linhas numa transacao so: ou o par
  -- nasce completo, ou nao nasce.
  INSERT INTO public.property_ical_sources (property_id, provider, url, label, active)
  VALUES (_orig.id, 'other', _base || '?pendente=' || _novo::text,
          'Bloqueio automatico — ' || _nome_f, true)
  RETURNING id INTO _src_a;

  INSERT INTO public.property_ical_sources (property_id, provider, url, label, active)
  VALUES (_novo, 'other', _base || '?pendente=' || _orig.id::text,
          'Bloqueio automatico — ' || _orig.name, true)
  RETURNING id INTO _src_b;

  -- A fonte de A le o feed de B, menos o que B recebeu de A.
  UPDATE public.property_ical_sources
     SET url = _base || '?t=' || _tok_b || '&exceto=' || _src_b::text
   WHERE id = _src_a;

  -- E o espelho.
  UPDATE public.property_ical_sources
     SET url = _base || '?t=' || _tok_a || '&exceto=' || _src_a::text
   WHERE id = _src_b;

  RETURN jsonb_build_object(
    'id', _novo,
    'nome', _nome_f,
    'cruzado', true,
    'slug', (SELECT p.public_slug FROM public.properties p WHERE p.id = _novo),
    'feed_token', _tok_b,
    'origem_token_rotacionado', true
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.duplicar_imovel(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.duplicar_imovel(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.duplicar_imovel(uuid, text, text) IS
  'Duplica a CONFIGURACAO do imovel para um segundo anuncio e cruza os dois calendarios na mesma transacao. O `exceto` na URL de cada lado impede o eco: cada feed publica so o que e originalmente dele, senao um bloqueio importado sobrevive ao cancelamento da reserva que o criou.';
