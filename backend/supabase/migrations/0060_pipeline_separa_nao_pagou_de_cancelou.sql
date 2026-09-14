-- "Cancelou" so vale para quem teve assinatura.
--
-- Conta nova nasce 'expired' desde que o teste gratis acabou (0036). Com
-- isso, quem cadastrou e nunca pagou caia no mesmo balde de quem assinou e
-- saiu — e a equipe ligava perguntando "por que voce saiu?" para alguem que
-- nunca entrou. O que separa os dois e o vinculo com a Stripe: sem
-- assinatura la, nunca houve pagamento.
--
-- Estagio novo: nao_pagou. Vem logo depois dos dois urgentes (cartao
-- recusado, calendario quebrado): e a venda mais quente da lista e esfria
-- em horas.

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
        WHEN a.subscription_status::text IN ('canceled','expired')
             AND pr.stripe_subscription_id IS NULL                  THEN 'nao_pagou'
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
    LEFT JOIN public.profiles pr ON pr.user_id = a.owner_id
    LEFT JOIN quebrado q  ON q.owner_id = a.owner_id
    LEFT JOIN ultimo u    ON u.target_user_id = a.owner_id
    LEFT JOIN contagem ct ON ct.target_user_id = a.owner_id
  )
  SELECT
    b.oid, b.nome, b.mail, b.fone, b.plano_t, b.assin, b.est,
    CASE b.est
      WHEN 'pagamento_falhou'           THEN 1
      WHEN 'calendario_quebrado'        THEN 2
      WHEN 'nao_pagou'                  THEN 3
      WHEN 'sem_imovel'                 THEN 4
      WHEN 'sem_calendario'             THEN 5
      WHEN 'calendario_sem_sincronizar' THEN 6
      WHEN 'sem_diarista'               THEN 7
      WHEN 'sem_mensagem'               THEN 8
      WHEN 'consolidado'                THEN 9
      ELSE 10
    END,
    -- A acao e escrita como frase pronta para quem vai ligar. "Estagio:
    -- sem_calendario" nao diz o que dizer; a equipe precisa da fala, nao do
    -- rotulo interno.
    CASE b.est
      WHEN 'pagamento_falhou'    THEN 'Ligar hoje: o cartao recusou e a conta cai em dias.'
      WHEN 'calendario_quebrado' THEN 'Ligar hoje: o calendario dele caiu e reserva nova nao esta virando limpeza.'
      WHEN 'nao_pagou'           THEN 'Ligar hoje: entrou, viu o preco e nao pagou. Fechar na ligacao, com o cartao na mao.'
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
      WHEN 'nao_pagou'           THEN 'Cadastro sem pagamento esfria em horas. Amanha ele nem lembra que entrou.'
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
      WHEN 'nao_pagou' THEN 3 WHEN 'sem_imovel' THEN 4
      WHEN 'sem_calendario' THEN 5 WHEN 'calendario_sem_sincronizar' THEN 6
      WHEN 'sem_diarista' THEN 7 WHEN 'sem_mensagem' THEN 8
      WHEN 'consolidado' THEN 9 ELSE 10
    END,
    -- Sem contato nenhum vem antes de quem ja foi trabalhado.
    b.ult_contato NULLS FIRST,
    b.entrou
  LIMIT greatest(1, least(_limit, 300)) OFFSET greatest(_offset, 0);
END;
$fn$;
