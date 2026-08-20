-- 0039 — O que faltava para o painel do administrador existir de verdade.
--
-- A 0013 já entregou KPIs, assinantes, funil e saúde do sistema. Nada disso
-- ganhou tela, e três perguntas continuavam sem resposta no banco:
--
--   1. Quanto vale um cliente ao longo da vida? (LTV, ARPU, churn)
--   2. Quem são TODAS as diaristas da plataforma?
--   3. Quem pagou a implantação da portaria e em que pé ela está?
--
-- E uma quarta, que é do lado do dono e não do admin: o que este assinante
-- ainda pode ligar para o produto funcionar melhor?

-- ---------------------------------------------------------------------------
-- 1. Implantação da portaria — o serviço de R$ 197
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.porter_setup_status AS ENUM (
    'interessado',   -- clicou, ainda nao pagou
    'pago',          -- Stripe confirmou; nossa equipe ainda nao encostou
    'em_andamento',  -- equipe tecnica trabalhando
    'implantado',    -- funcionando, hospede se cadastra sozinho
    'cancelado'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.porter_setup_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL,
  status        public.porter_setup_status NOT NULL DEFAULT 'interessado',
  -- O valor fica gravado na linha, e nao lido de uma constante na hora de
  -- exibir: quando a taxa mudar, o historico precisa continuar dizendo o que
  -- cada cliente pagou de fato.
  amount_cents  integer NOT NULL DEFAULT 19700,
  currency      text    NOT NULL DEFAULT 'BRL',
  condo_name    text,
  condo_system  text,
  paid_at       timestamptz,
  contacted_at  timestamptz,
  implanted_at  timestamptz,
  stripe_session_id  text UNIQUE,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Um pedido vivo por imovel. Sem isso, dois cliques no botao viram duas
-- cobrancas de R$ 197 para a mesma portaria.
CREATE UNIQUE INDEX IF NOT EXISTS idx_porter_setup_um_vivo_por_imovel
  ON public.porter_setup_requests (property_id)
  WHERE status <> 'cancelado';

CREATE INDEX IF NOT EXISTS idx_porter_setup_fila
  ON public.porter_setup_requests (status, paid_at);

ALTER TABLE public.porter_setup_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS porter_setup_dono_le ON public.porter_setup_requests;
CREATE POLICY porter_setup_dono_le ON public.porter_setup_requests
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin(auth.uid()));

-- Escrita passa por function: o status e o valor nao podem ser decididos pelo
-- cliente. Quem paga e a Stripe quem confirma; quem implanta e a equipe.
DROP POLICY IF EXISTS porter_setup_dono_pede ON public.porter_setup_requests;
CREATE POLICY porter_setup_dono_pede ON public.porter_setup_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_id = auth.uid()
    AND status = 'interessado'
    AND EXISTS (SELECT 1 FROM public.properties p
                WHERE p.id = property_id AND p.owner_id = auth.uid())
  );

COMMENT ON TABLE public.porter_setup_requests IS
  'Pedidos de implantacao da portaria digital (taxa avulsa). O hospede se cadastrar sozinho depende de integracao com o sistema do predio, que hoje e trabalho manual da equipe tecnica — por isso e servico cobrado, e nao funcionalidade que se liga sozinha.';

-- ---------------------------------------------------------------------------
-- 2. Financeiro: LTV, ARPU e churn
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_financeiro(_meses integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _r jsonb;
  _receita_total bigint;
  _pagantes integer;
  _arpu numeric;
  _churn numeric;
  _meses_medios numeric;
BEGIN
  PERFORM public.assert_admin();

  -- Receita REALIZADA, vinda do que a Stripe confirmou — nao do que os planos
  -- prometem. MRR e projecao; isto e caixa.
  SELECT COALESCE(sum(amount_cents), 0), count(DISTINCT user_id)
    INTO _receita_total, _pagantes
  FROM public.billing_events
  WHERE type IN ('invoice.paid', 'checkout.session.completed')
    AND amount_cents > 0;

  _arpu := CASE WHEN _pagantes = 0 THEN 0
                ELSE round(_receita_total::numeric / _pagantes, 0) END;

  -- Churn mensal: cancelados nos ultimos 30 dias sobre a base ativa no inicio
  -- do periodo. Com base pequena isso oscila muito, e por isso a resposta leva
  -- `amostra` junto — quem ler o numero precisa saber de quantos ele veio.
  SELECT CASE WHEN count(*) FILTER (WHERE subscription_status IN ('active','past_due')) = 0 THEN 0
              ELSE round(100.0 * count(*) FILTER (
                     WHERE subscription_status = 'canceled'
                       AND updated_at > now() - interval '30 days')
                   / NULLIF(count(*) FILTER (WHERE subscription_status IN ('active','past_due','canceled')), 0), 2)
         END
    INTO _churn
  FROM public.profiles p
  JOIN public.user_roles ur ON ur.user_id = p.user_id AND ur.role = 'owner';

  _meses_medios := CASE WHEN _churn > 0 THEN round(100.0 / _churn, 1) ELSE NULL END;

  SELECT jsonb_build_object(
    'receita_total_cents', _receita_total,
    'clientes_pagantes',   _pagantes,
    -- LTV histórico: o que cada cliente já deixou, em média. Não projeta nada.
    'ltv_realizado_cents', _arpu,
    -- LTV projetado: ARPU mensal dividido pelo churn. Só existe quando houve
    -- cancelamento; sem churn medido, projetar vida infinita seria mentira.
    'ltv_projetado_cents', CASE WHEN _churn > 0
      THEN round((SELECT COALESCE(avg(public.mrr_cents(p.*)), 0) FROM public.profiles p
                  WHERE p.subscription_status IN ('active','past_due')) * (100.0 / _churn), 0)
      ELSE NULL END,
    'churn_mensal_pct',    _churn,
    'vida_media_meses',    _meses_medios,
    -- Com poucos clientes, LTV e churn são ruído. Quem lê precisa saber disso
    -- na mesma tela, e não descobrir depois de decidir preço em cima do número.
    'amostra_confiavel',   (_pagantes >= 10)
  ) INTO _r;

  -- Receita por plano: onde o dinheiro realmente está.
  SELECT _r || jsonb_build_object('por_plano', COALESCE(jsonb_agg(x), '[]'::jsonb))
    INTO _r
  FROM (
    SELECT pl.tier, pl.name,
           count(p.user_id) FILTER (WHERE p.subscription_status IN ('active','past_due')) AS assinantes,
           COALESCE(sum(public.mrr_cents(p.*)) FILTER (WHERE p.subscription_status IN ('active','past_due')), 0) AS mrr_cents
    FROM public.plans pl
    LEFT JOIN public.profiles p ON p.plan = pl.tier
    WHERE pl.active
    GROUP BY pl.tier, pl.name, pl.sort_order
    ORDER BY pl.sort_order
  ) x;

  -- Série mensal de caixa, para o gráfico.
  SELECT _r || jsonb_build_object('serie_mensal', COALESCE(jsonb_agg(y ORDER BY y->>'mes'), '[]'::jsonb))
    INTO _r
  FROM (
    SELECT jsonb_build_object(
      'mes', to_char(date_trunc('month', occurred_at), 'YYYY-MM'),
      'receita_cents', sum(amount_cents),
      'cobrancas', count(*)
    ) AS y
    FROM public.billing_events
    WHERE type IN ('invoice.paid', 'checkout.session.completed')
      AND amount_cents > 0
      AND occurred_at > date_trunc('month', now()) - (_meses || ' months')::interval
    GROUP BY date_trunc('month', occurred_at)
  ) z;

  -- Fila da portaria: o admin precisa ver quem pagou e ainda não foi atendido.
  SELECT _r || jsonb_build_object(
    'portaria_pagos_nao_implantados', count(*) FILTER (WHERE status IN ('pago','em_andamento')),
    'portaria_receita_cents', COALESCE(sum(amount_cents) FILTER (WHERE paid_at IS NOT NULL), 0),
    'portaria_interessados', count(*) FILTER (WHERE status = 'interessado')
  ) INTO _r
  FROM public.porter_setup_requests;

  RETURN _r;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_financeiro(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_financeiro(integer) TO authenticated;

COMMENT ON FUNCTION public.admin_financeiro(integer) IS
  'Financeiro do admin: receita realizada (caixa da Stripe, nao projecao), LTV historico e projetado, churn, receita por plano e serie mensal. Devolve `amostra_confiavel` porque LTV com menos de dez pagantes e ruido, e quem le precisa saber disso antes de precificar em cima.';

-- ---------------------------------------------------------------------------
-- 3. Todas as diaristas da plataforma
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_cleaners(
  _search text DEFAULT NULL,
  _limit  integer DEFAULT 50,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  cleaner_id      uuid,
  full_name       text,
  email           text,
  phone_e164      text,
  entrou_em       timestamptz,
  hosts           bigint,
  imoveis         bigint,
  limpezas_30d    bigint,
  ultima_limpeza  timestamptz,
  total_count     bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- A checagem vem antes de qualquer leitura, e nao embutida num WHERE: filtro
  -- e algo que o planejador pode reordenar, autorizacao nao pode.
  PERFORM public.assert_admin();

  RETURN QUERY
  WITH base AS (
    SELECT
      pr.user_id AS cid,
      pr.full_name AS nome,
      pr.email AS mail,
      pr.phone_e164 AS fone,
      pr.created_at AS entrou,
      count(DISTINCT c.owner_id) AS qt_hosts,
      count(DISTINCT p.id) AS qt_imoveis,
      count(DISTINCT ct.id) FILTER (
        WHERE ct.status = 'completed' AND ct.completed_at > now() - interval '30 days'
      ) AS qt_limpezas,
      max(ct.completed_at) FILTER (WHERE ct.status = 'completed') AS ult
    FROM public.profiles pr
    JOIN public.user_roles ur ON ur.user_id = pr.user_id AND ur.role = 'cleaner'
    LEFT JOIN public.connections c ON c.cleaner_id = pr.user_id AND c.active
    LEFT JOIN public.properties p ON p.cleaner_id = pr.user_id AND p.archived_at IS NULL
    LEFT JOIN public.cleaning_tasks ct ON ct.cleaner_id = pr.user_id
    WHERE _search IS NULL OR _search = ''
       OR pr.full_name ILIKE '%' || _search || '%'
       OR pr.email ILIKE '%' || _search || '%'
       OR pr.phone_e164 ILIKE '%' || _search || '%'
    GROUP BY pr.user_id, pr.full_name, pr.email, pr.phone_e164, pr.created_at
  )
  SELECT b.cid, b.nome, b.mail, b.fone, b.entrou,
         b.qt_hosts, b.qt_imoveis, b.qt_limpezas, b.ult,
         (SELECT count(*) FROM base)
  FROM base b
  ORDER BY b.qt_limpezas DESC, b.nome
  LIMIT greatest(1, least(_limit, 200)) OFFSET greatest(_offset, 0);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_cleaners(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cleaners(text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_cleaners(text, integer, integer) IS
  'Todas as diaristas da plataforma, com quantos hosts atendem e quantas limpezas fecharam em 30 dias. Ordena por volume: quem trabalha mais aparece primeiro, porque e quem mais afeta o produto.';

-- ---------------------------------------------------------------------------
-- 4. "Ver como": leitura, com rastro
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_registra_visita(_target_user_id uuid, _motivo text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.assert_admin();

  -- Olhar a conta de alguem e uma acao, nao um efeito colateral. Fica no mesmo
  -- log das alteracoes do admin para que "quem viu o que" seja tao auditavel
  -- quanto "quem mudou o que".
  INSERT INTO public.audit_log (actor_id, actor_role, action, entity, entity_id, metadata)
  VALUES (auth.uid(), 'admin', 'admin.view_as', 'profiles', _target_user_id::text,
          jsonb_build_object('motivo', _motivo));

  RETURN true;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.admin_registra_visita(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_registra_visita(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.admin_registra_visita(uuid, text) IS
  'Registra que um admin abriu a conta de alguem em modo leitura. O admin NAO assume a sessao: escrever continua exigindo as acoes de admin-users, que saem no nome dele. Assim nenhuma alteracao aparece no log como se tivesse sido feita pelo cliente.';

-- ---------------------------------------------------------------------------
-- 5. Dicas: o que este dono ainda pode ligar
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.owner_next_steps(_owner_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _id uuid := COALESCE(_owner_id, auth.uid());
  _a  public.owner_activation%ROWTYPE;
  _dicas jsonb := '[]'::jsonb;
  _portaria integer;
BEGIN
  -- Ver as dicas de outra pessoa exige ser admin. Sem isto, qualquer dono
  -- passaria o id do vizinho e leria quantos imoveis ele tem.
  IF _id IS DISTINCT FROM auth.uid() THEN
    PERFORM public.assert_admin();
  END IF;

  SELECT * INTO _a FROM public.owner_activation WHERE owner_id = _id;
  IF NOT FOUND THEN RETURN jsonb_build_object('dicas', _dicas, 'total', 0); END IF;

  -- A ordem importa: cada dica so faz sentido depois da anterior. Mostrar
  -- "ligue o atendimento 24h" para quem nem conectou calendario e pedir que a
  -- pessoa monte o telhado antes da parede.
  IF _a.properties_count = 0 THEN
    _dicas := _dicas || jsonb_build_object(
      'chave','cadastrar_imovel','peso',1,'titulo','Cadastre seu primeiro imóvel',
      'porque','Nada acontece antes disso: é o imóvel que recebe reservas, limpezas e hóspedes.',
      'destino','/imoveis');
  ELSIF _a.properties_with_ical = 0 THEN
    _dicas := _dicas || jsonb_build_object(
      'chave','conectar_calendario','peso',1,'titulo','Conecte o calendário do Airbnb',
      'porque','É o passo que faz todo o resto acontecer sozinho: cada reserva vira limpeza na agenda sem você avisar ninguém.',
      'destino','/imoveis');
  ELSE
    IF _a.properties_with_cleaner < _a.properties_count THEN
      _dicas := _dicas || jsonb_build_object(
        'chave','convidar_diarista','peso',2,'titulo','Convide sua diarista',
        'porque','Ela passa a ver os horários de saída no celular, sem senha e sem cadastro — e você para de avisar a cada reserva.',
        'destino','/imoveis');
    END IF;

    IF _a.properties_auto_message < _a.properties_count THEN
      _dicas := _dicas || jsonb_build_object(
        'chave','mensagem_automatica','peso',3,'titulo','Ligue a mensagem automática',
        'porque','É ela que leva o hóspede ao cadastro e ao assistente 24h. Sem isso, o atendimento existe e ninguém chega nele.',
        'destino','/imoveis');
    END IF;

    -- Calendário de saída: existe desde a 0037 e quase ninguém sabe.
    IF EXISTS (SELECT 1 FROM public.properties p
               WHERE p.owner_id = _id AND p.archived_at IS NULL
                 AND p.ical_feed_token_hash IS NULL) THEN
      _dicas := _dicas || jsonb_build_object(
        'chave','feed_saida','peso',4,'titulo','Bloqueie as datas entre seus anúncios',
        'porque','Hoje seus anúncios não enxergam as reservas uns dos outros. Dois podem vender a mesma noite, e você só descobre com dois hóspedes na porta.',
        'destino','/imoveis');
    END IF;

    -- Portaria: aqui a dica é também a oferta.
    SELECT count(*) INTO _portaria
    FROM public.properties p
    LEFT JOIN public.porter_setup_requests r
      ON r.property_id = p.id AND r.status <> 'cancelado'
    LEFT JOIN public.porter_accounts pa ON pa.property_id = p.id AND pa.active
    WHERE p.owner_id = _id AND p.archived_at IS NULL
      AND r.id IS NULL AND pa.id IS NULL;

    IF _portaria > 0 THEN
      _dicas := _dicas || jsonb_build_object(
        'chave','portaria','peso',5,'titulo','Conecte a portaria digital',
        'porque','Com a portaria ligada, o hóspede é cadastrado no prédio sozinho — você não precisa mandar nome e documento para o porteiro a cada chegada.',
        'destino','/portaria','oferta',true);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'dicas', _dicas,
    'total', jsonb_array_length(_dicas),
    'ativado', _a.is_activated,
    'travado_em', _a.stuck_step
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.owner_next_steps(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_next_steps(uuid) TO authenticated;

COMMENT ON FUNCTION public.owner_next_steps(uuid) IS
  'O que este dono ainda pode ligar, em ordem de dependencia. Cada dica leva o PORQUE junto do que fazer: "conecte o calendario" sozinho e tarefa, e tarefa a pessoa adia. Le a owner_activation, que ja sabia onde cada um travou e nunca foi mostrada para quem podia agir.';
