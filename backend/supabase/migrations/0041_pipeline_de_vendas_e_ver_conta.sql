-- 0041 — O pipeline da equipe de vendas, e o painel de qualquer conta.
--
-- Duas lacunas que apareceram no uso real do painel do admin:
--
--   1. A equipe de vendas nao tem por onde se orientar. A lista de assinantes
--      diz QUEM assinou; nao diz quem ligar primeiro, o que falar, nem o que
--      ja foi tentado. Sem isso duas pessoas ligam para o mesmo cliente na
--      mesma semana e ninguem liga para quem esta prestes a cancelar.
--
--   2. O admin ve a FICHA do assinante, mas nao o painel dele. Quando o
--      cliente liga dizendo "nao aparece nada aqui", quem atende precisa ver
--      a mesma tela que ele esta vendo — nao um resumo em outra linguagem.
--
-- A leitura ja era permitida: as policies `admin le tudo` existem desde a
-- 0013. O que faltava era juntar tudo numa resposta so, para nao depender de
-- o front acertar dez consultas em ordem.

-- ---------------------------------------------------------------------------
-- 1. Registro de contato — a memoria da equipe
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.crm_contatos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id  uuid NOT NULL,
  autor_id        uuid NOT NULL,
  canal           text NOT NULL CHECK (canal IN ('whatsapp','ligacao','email','presencial','outro')),
  resultado       text NOT NULL CHECK (resultado IN ('falou','nao_atendeu','agendou','recusou','resolvido')),
  notas           text,
  proximo_passo   text,
  proximo_passo_em date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_contatos_alvo
  ON public.crm_contatos (target_user_id, created_at DESC);

-- Follow-up vencido e o que a equipe precisa ver primeiro de manha.
CREATE INDEX IF NOT EXISTS idx_crm_contatos_proximo_passo
  ON public.crm_contatos (proximo_passo_em)
  WHERE proximo_passo_em IS NOT NULL;

ALTER TABLE public.crm_contatos ENABLE ROW LEVEL SECURITY;

-- Nem o cliente nem a diarista leem isto. Sao anotacoes internas da equipe, e
-- quem escreve precisa poder ser franco ("nao atende ha duas semanas") sem
-- pensar em quem vai ler do outro lado.
DROP POLICY IF EXISTS crm_contatos_admin ON public.crm_contatos;
CREATE POLICY crm_contatos_admin ON public.crm_contatos
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

COMMENT ON TABLE public.crm_contatos IS
  'Historico de contato da equipe com cada cliente. Existe para que duas pessoas nao liguem para o mesmo cliente na mesma semana, e para que o proximo passo combinado nao viva na cabeca de quem atendeu.';

-- ---------------------------------------------------------------------------
-- 2. O pipeline
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_pipeline(
  _estagio text DEFAULT NULL,
  _limit   integer DEFAULT 100,
  _offset  integer DEFAULT 0
)
RETURNS TABLE (
  owner_id          uuid,
  full_name         text,
  email             text,
  phone_e164        text,
  plano             text,
  assinatura        text,
  estagio           text,
  prioridade        integer,
  acao              text,
  porque            text,
  imoveis           bigint,
  imoveis_ativos    bigint,
  ical_quebrado     bigint,
  assinou_em        timestamptz,
  ultima_atividade  timestamptz,
  ultimo_contato_em timestamptz,
  ultimo_resultado  text,
  proximo_passo     text,
  proximo_passo_em  date,
  contatos          bigint,
  total_count       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.assert_admin();

  RETURN QUERY
  WITH quebrado AS (
    -- Calendario fora do ar por imovel. Tres falhas seguidas ja e problema
    -- real: uma falha isolada e a plataforma do canal oscilando.
    SELECT p.owner_id, count(DISTINCT p.id) AS n
    FROM public.properties p
    JOIN public.property_ical_sources s ON s.property_id = p.id AND s.active
    WHERE p.archived_at IS NULL AND s.consecutive_fails >= 3
    GROUP BY p.owner_id
  ),
  ultimo AS (
    SELECT DISTINCT ON (c.target_user_id)
           c.target_user_id, c.created_at, c.resultado, c.proximo_passo, c.proximo_passo_em
    FROM public.crm_contatos c
    ORDER BY c.target_user_id, c.created_at DESC
  ),
  contagem AS (
    SELECT c.target_user_id, count(*) AS n FROM public.crm_contatos c GROUP BY c.target_user_id
  ),
  base AS (
    SELECT
      a.owner_id AS oid,
      a.full_name AS nome,
      a.email AS mail,
      a.phone_e164 AS fone,
      a.plan::text AS plano_t,
      a.subscription_status::text AS assin,
      a.properties_count AS qt,
      a.properties_active AS qt_ativos,
      COALESCE(q.n, 0) AS qt_quebrado,
      a.signed_up_at AS entrou,
      a.last_activity_at AS ativ,
      u.created_at AS ult_contato,
      u.resultado AS ult_resultado,
      u.proximo_passo AS passo,
      u.proximo_passo_em AS passo_em,
      COALESCE(ct.n, 0) AS qt_contatos,
      -- A ordem dos ramos E a regra de negocio: o primeiro que casar vence.
      -- Cobranca falhada vem antes de tudo porque e a unica em que o dinheiro
      -- ja parou de entrar; calendario quebrado vem logo depois porque o
      -- cliente esta pagando por um produto que nao esta funcionando.
      CASE
        WHEN a.subscription_status::text IN ('canceled','expired') THEN 'perdido'
        WHEN a.subscription_status::text = 'past_due'              THEN 'pagamento_falhou'
        WHEN COALESCE(q.n, 0) > 0                                  THEN 'calendario_quebrado'
        WHEN a.properties_count = 0                                THEN 'sem_imovel'
        WHEN a.properties_with_ical = 0                            THEN 'sem_calendario'
        WHEN a.properties_syncing = 0                              THEN 'calendario_sem_sincronizar'
        WHEN a.properties_with_cleaner < a.properties_count        THEN 'sem_diarista'
        WHEN a.properties_auto_message < a.properties_count        THEN 'sem_mensagem'
        ELSE 'consolidado'
      END AS est
    FROM public.owner_activation a
    LEFT JOIN quebrado q  ON q.owner_id = a.owner_id
    LEFT JOIN ultimo u    ON u.target_user_id = a.owner_id
    LEFT JOIN contagem ct ON ct.target_user_id = a.owner_id
  )
  SELECT
    b.oid, b.nome, b.mail, b.fone, b.plano_t, b.assin, b.est,
    CASE b.est
      WHEN 'pagamento_falhou'           THEN 1
      WHEN 'calendario_quebrado'        THEN 2
      WHEN 'sem_imovel'                 THEN 3
      WHEN 'sem_calendario'             THEN 4
      WHEN 'calendario_sem_sincronizar' THEN 5
      WHEN 'sem_diarista'               THEN 6
      WHEN 'sem_mensagem'               THEN 7
      WHEN 'consolidado'                THEN 8
      ELSE 9
    END,
    -- A acao e escrita como frase pronta para quem vai ligar. "Estagio:
    -- sem_calendario" nao diz o que dizer; a equipe precisa da fala, nao do
    -- rotulo interno.
    CASE b.est
      WHEN 'pagamento_falhou'    THEN 'Ligar hoje: o cartao recusou e a conta cai em dias.'
      WHEN 'calendario_quebrado' THEN 'Ligar hoje: o calendario dele caiu e reserva nova nao esta virando limpeza.'
      WHEN 'sem_imovel'          THEN 'Ajudar a cadastrar o primeiro imovel na ligacao, junto.'
      WHEN 'sem_calendario'      THEN 'Pegar o link do calendario do Airbnb com ele e colar junto.'
      WHEN 'calendario_sem_sincronizar' THEN 'Conferir o link colado: entrou, mas nao trouxe reserva nenhuma.'
      WHEN 'sem_diarista'        THEN 'Convidar a diarista dele pelo link — sem senha, sem cadastro.'
      WHEN 'sem_mensagem'        THEN 'Ligar a mensagem automatica no anuncio; sem ela o hospede nao chega no assistente.'
      WHEN 'consolidado'         THEN 'Nada urgente. Oferecer a portaria digital se o predio tiver sistema.'
      ELSE 'Perguntar por que saiu. E a unica hora em que ele ainda responde.'
    END,
    CASE b.est
      WHEN 'pagamento_falhou'    THEN 'Assinante que cai por cartao recusado quase nunca volta sozinho: ele nao sabe que caiu.'
      WHEN 'calendario_quebrado' THEN 'Ele esta pagando por um produto que parou. Descobre quando a diarista nao aparece.'
      WHEN 'sem_imovel'          THEN 'Pagou e nao usou nada. E o perfil que cancela no primeiro mes.'
      WHEN 'sem_calendario'      THEN 'E o passo que faz todo o resto acontecer sozinho. Sem ele o produto e uma agenda vazia.'
      WHEN 'calendario_sem_sincronizar' THEN 'Link errado ou anuncio sem reserva. Ele acha que ligou e nao ligou.'
      WHEN 'sem_diarista'        THEN 'Sem diarista vinculada ele continua avisando no WhatsApp a cada reserva — que e o trabalho que veio terceirizar.'
      WHEN 'sem_mensagem'        THEN 'O atendimento 24h existe e ninguem chega nele.'
      WHEN 'consolidado'         THEN 'Esta usando o produto inteiro. Ligar aqui e queimar tempo que falta nos de cima.'
      ELSE 'Cancelamento sem motivo registrado vira estatistica e nao vira conserto.'
    END,
    b.qt, b.qt_ativos, b.qt_quebrado, b.entrou, b.ativ,
    b.ult_contato, b.ult_resultado, b.passo, b.passo_em, b.qt_contatos,
    (SELECT count(*) FROM base x WHERE _estagio IS NULL OR _estagio = '' OR x.est = _estagio)
  FROM base b
  WHERE _estagio IS NULL OR _estagio = '' OR b.est = _estagio
  ORDER BY
    -- Follow-up vencido fura a fila: foi a equipe que prometeu voltar naquele
    -- dia, e promessa quebrada custa mais que estagio ruim.
    (b.passo_em IS NOT NULL AND b.passo_em <= current_date) DESC,
    CASE b.est
      WHEN 'pagamento_falhou' THEN 1 WHEN 'calendario_quebrado' THEN 2
      WHEN 'sem_imovel' THEN 3 WHEN 'sem_calendario' THEN 4
      WHEN 'calendario_sem_sincronizar' THEN 5 WHEN 'sem_diarista' THEN 6
      WHEN 'sem_mensagem' THEN 7 WHEN 'consolidado' THEN 8 ELSE 9
    END,
    -- Sem contato nenhum vem antes de quem ja foi trabalhado.
    b.ult_contato NULLS FIRST,
    b.entrou
  LIMIT greatest(1, least(_limit, 300)) OFFSET greatest(_offset, 0);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_pipeline(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_pipeline(text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_pipeline(text, integer, integer) IS
  'A fila de trabalho da equipe de vendas: cada assinante no estagio em que travou, com a frase do que fazer e o porque. Follow-up vencido fura a fila — promessa da equipe custa mais que estagio ruim.';

-- ---------------------------------------------------------------------------
-- 3. Registrar um contato
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_registra_contato(
  _target_user_id uuid,
  _canal          text,
  _resultado      text,
  _notas          text DEFAULT NULL,
  _proximo_passo  text DEFAULT NULL,
  _proximo_passo_em date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _id uuid;
BEGIN
  PERFORM public.assert_admin();

  INSERT INTO public.crm_contatos (
    target_user_id, autor_id, canal, resultado, notas, proximo_passo, proximo_passo_em
  ) VALUES (
    _target_user_id, auth.uid(), _canal, _resultado,
    NULLIF(btrim(_notas), ''), NULLIF(btrim(_proximo_passo), ''), _proximo_passo_em
  )
  RETURNING id INTO _id;

  RETURN _id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_registra_contato(uuid, text, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_registra_contato(uuid, text, text, text, text, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. O painel de qualquer conta
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_conta(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _r      jsonb;
  _papeis text[];
  _hoje   date := public.app_today();
BEGIN
  PERFORM public.assert_admin();

  SELECT array_agg(ur.role::text ORDER BY ur.role::text)
    INTO _papeis
  FROM public.user_roles ur WHERE ur.user_id = _user_id;

  IF _papeis IS NULL THEN
    RAISE EXCEPTION 'Conta nao encontrada' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT jsonb_build_object(
    'user_id',   p.user_id,
    'papeis',    to_jsonb(_papeis),
    'nome',      p.full_name,
    'email',     p.email,
    'telefone',  p.phone_e164,
    'plano',     p.plan::text,
    'ciclo',     p.billing_cycle,
    'assinatura', p.subscription_status::text,
    'assinou_em', p.created_at,
    'periodo_ate', p.current_period_end,
    'ultimo_acesso', p.last_seen_at,
    'notas',     p.notes
  ) INTO _r
  FROM public.profiles p WHERE p.user_id = _user_id;

  -- ---- lado dono -----------------------------------------------------------
  IF 'owner' = ANY(_papeis) THEN
    SELECT _r || jsonb_build_object('imoveis', COALESCE(jsonb_agg(x ORDER BY x->>'nome'), '[]'::jsonb))
      INTO _r
    FROM (
      SELECT jsonb_build_object(
        'id',   p.id,
        'nome', p.name,
        'cidade', p.city,
        -- Cada bandeira responde a uma pergunta que o cliente faz ao telefone.
        'calendarios', (SELECT count(*) FROM public.property_ical_sources s
                        WHERE s.property_id = p.id AND s.active),
        'calendario_quebrado', (SELECT count(*) FROM public.property_ical_sources s
                                WHERE s.property_id = p.id AND s.active AND s.consecutive_fails >= 3),
        'ultima_sincronia', (SELECT max(s.last_success_at) FROM public.property_ical_sources s
                             WHERE s.property_id = p.id AND s.active),
        'diarista', (SELECT pr.full_name FROM public.profiles pr WHERE pr.user_id = p.cleaner_id),
        'self_clean', p.self_clean,
        'mensagem_automatica', (p.auto_message_confirmed_at IS NOT NULL),
        'portaria', COALESCE((SELECT pa.active FROM public.porter_accounts pa
                              WHERE pa.property_id = p.id), false),
        'portaria_pedido', (SELECT r.status::text FROM public.porter_setup_requests r
                            WHERE r.property_id = p.id AND r.status <> 'cancelado'),
        'reservas_futuras', (SELECT count(*) FROM public.reservations rs
                             WHERE rs.property_id = p.id AND rs.status = 'confirmed'
                               AND rs.checkout_date >= _hoje)
      ) AS x
      FROM public.properties p
      WHERE p.owner_id = _user_id AND p.archived_at IS NULL
    ) y;

    -- As proximas saidas: e a tela que o cliente esta olhando quando liga.
    SELECT _r || jsonb_build_object('saidas', COALESCE(jsonb_agg(x ORDER BY x->>'data'), '[]'::jsonb))
      INTO _r
    FROM (
      SELECT jsonb_build_object(
        'data', t.checkout_date,
        'hora', t.checkout_time,
        'imovel', p.name,
        'status', t.status::text,
        'diarista', (SELECT pr.full_name FROM public.profiles pr WHERE pr.user_id = t.cleaner_id)
      ) AS x
      FROM public.cleaning_tasks t
      JOIN public.properties p ON p.id = t.property_id
      WHERE p.owner_id = _user_id
        AND t.checkout_date >= _hoje
        AND t.status <> 'cancelled'
      ORDER BY t.checkout_date
      LIMIT 15
    ) y;

    SELECT _r || jsonb_build_object(
      'ativacao', jsonb_build_object(
        'travado_em', a.stuck_step,
        'ativado',    a.is_activated,
        'imoveis',    a.properties_count,
        'com_calendario', a.properties_with_ical,
        'sincronizando',  a.properties_syncing,
        'com_diarista',   a.properties_with_cleaner,
        'com_mensagem',   a.properties_auto_message,
        'convites_pendentes', a.pending_cleaner_invites
      )) INTO _r
    FROM public.owner_activation a WHERE a.owner_id = _user_id;
  END IF;

  -- ---- lado diarista -------------------------------------------------------
  IF 'cleaner' = ANY(_papeis) THEN
    SELECT _r || jsonb_build_object('diarista', jsonb_build_object(
      'hosts', (SELECT count(DISTINCT c.owner_id) FROM public.connections c
                WHERE c.cleaner_id = _user_id AND c.active),
      'imoveis', (SELECT count(*) FROM public.properties p
                  WHERE p.cleaner_id = _user_id AND p.archived_at IS NULL),
      'acordos_pendentes', (SELECT count(*) FROM public.cleaner_agreements g
                            WHERE g.cleaner_id = _user_id AND g.status::text = 'pending'),
      'limpezas_30d', (SELECT count(*) FROM public.cleaning_tasks t
                       WHERE t.cleaner_id = _user_id AND t.status::text = 'completed'
                         AND t.completed_at > now() - interval '30 days'),
      'a_receber_mes', COALESCE((SELECT sum(t.turnover_price) FROM public.cleaning_tasks t
                                 WHERE t.cleaner_id = _user_id
                                   AND date_trunc('month', t.checkout_date::timestamptz)
                                       = date_trunc('month', now())), 0)
    )) INTO _r;

    SELECT _r || jsonb_build_object('tarefas', COALESCE(jsonb_agg(x ORDER BY x->>'data'), '[]'::jsonb))
      INTO _r
    FROM (
      SELECT jsonb_build_object(
        'data', t.checkout_date,
        'hora', t.checkout_time,
        'imovel', p.name,
        'status', t.status::text,
        'host', (SELECT pr.full_name FROM public.profiles pr WHERE pr.user_id = p.owner_id)
      ) AS x
      FROM public.cleaning_tasks t
      JOIN public.properties p ON p.id = t.property_id
      WHERE t.cleaner_id = _user_id AND t.checkout_date >= _hoje AND t.status <> 'cancelled'
      ORDER BY t.checkout_date
      LIMIT 15
    ) y;
  END IF;

  -- ---- historico de contato -----------------------------------------------
  SELECT _r || jsonb_build_object('contatos', COALESCE(jsonb_agg(x ORDER BY x->>'quando' DESC), '[]'::jsonb))
    INTO _r
  FROM (
    SELECT jsonb_build_object(
      'quando', c.created_at,
      'canal', c.canal,
      'resultado', c.resultado,
      'notas', c.notas,
      'proximo_passo', c.proximo_passo,
      'proximo_passo_em', c.proximo_passo_em,
      'autor', (SELECT pr.full_name FROM public.profiles pr WHERE pr.user_id = c.autor_id)
    ) AS x
    FROM public.crm_contatos c
    WHERE c.target_user_id = _user_id
    ORDER BY c.created_at DESC
    LIMIT 30
  ) y;

  RETURN _r;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_conta(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_conta(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_conta(uuid) IS
  'Tudo sobre uma conta numa resposta so — o lado dono, o lado diarista e o historico de contato. Serve a ligacao de suporte: quem atende precisa ver a mesma tela que o cliente esta vendo, e nao um resumo em outra linguagem.';
