import { createClient } from "@supabase/supabase-js";

// A URL e a chave publicável do Supabase são públicas por definição — elas
// viajam no bundle de qualquer forma. Deixá-las como padrão aqui faz o app
// subir sem depender de variável de ambiente configurada à mão; quem quiser
// apontar para outro projeto sobrescreve pelo .env.
const DEFAULT_URL = "https://hukjxwpwnrsepgneopqd.supabase.co";
const DEFAULT_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1a2p4d3B3bnJzZXBnbmVvcHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNTAzNzgsImV4cCI6MjEwMTcyNjM3OH0.XceZUXIPrCUenrNxY4Orj0CDGCoHCBQO0uzirPvODbc";

/**
 * Um `.env` com valor de exemplo é pior que `.env` nenhum: ele é "preenchido",
 * então venceria o padrão abaixo e o app subiria apontando para um domínio
 * inexistente — a falha aparece só em produção, como "Load failed". Por isso
 * tratamos placeholder como se fosse ausente.
 */
const isPlaceholder = (v: string | undefined) =>
  !v || v.trim() === "" || /placeholder|example|changeme|your[-_]/i.test(v);

const envUrl = import.meta.env.VITE_SUPABASE_URL;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const url = isPlaceholder(envUrl) ? DEFAULT_URL : envUrl;
const key = isPlaceholder(envKey) ? DEFAULT_KEY : envKey;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const FUNCTIONS = `${url}/functions/v1`;

/**
 * URL do calendário de saída de um imóvel, para colar na importação do canal.
 *
 * `para` não é enfeite: ele diz ao feed QUEM está importando, e o backend
 * devolve tudo menos as reservas daquele mesmo canal. Sem isso o Airbnb
 * reimportaria as próprias reservas como bloqueio externo — e um bloqueio
 * importado pode sobreviver ao cancelamento da reserva que o originou,
 * travando uma data que voltou a estar livre.
 */
export const icalFeedUrl = (token: string, para: "airbnb" | "booking") =>
  `${FUNCTIONS}/ical-feed?t=${encodeURIComponent(token)}&para=${para}`;

/** Erro vindo do backend, já com o código estável para o frontend testar. */
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
    ...options.headers,
  };

  if (options.auth !== false) {
    const { data } = await supabase.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }

  const res = await fetch(`${FUNCTIONS}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = payload?.error;
    throw new ApiError(
      err?.code ?? "unknown",
      err?.message ?? "Algo deu errado. Tente novamente.",
      res.status,
    );
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Dono
// ---------------------------------------------------------------------------

export interface ActivationState {
  property_id: string;
  property_name: string;
  has_ical: boolean;
  ical_syncing: boolean;
  ical_failing: number;
  reservations_count: number;
  has_cleaner: boolean;
  auto_message_done: boolean;
  condo_configured: boolean;
  ai_configured: boolean;
  blocked_at: string;
}

/** Os seis headers que o app do prédio manda em toda chamada à Kiper. */
export interface PorterCredentials {
  porter_token: string;
  porter_application_key: string;
  porter_account_local_id: string;
  porter_user_context_id: string;
  porter_user_partner_context_id: string;
  porter_condo_person_context_id: string;
  // Vêm da captura do login (resposta de /auth/activate). Sem o segredo do
  // TOTP a Kiper recusa o cadastro desde ago/2026 — é o que liga a integração.
  porter_totp_secret?: string;
  porter_app_device_id?: string;
}

export interface PorterState {
  ok: boolean;
  connected: boolean;
  active?: boolean;
  last_ok_at?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
  reason?: string;
  message?: string;
}

/** Um termo assinado a dedo — do hóspede ou da diarista. */
export interface TermoAssinado {
  id: string;
  kind: "cadastro_hospede" | "limpeza_concluida";
  property_id: string;
  registration_id: string | null;
  cleaning_task_id: string | null;
  signer_name: string;
  signer_doc: string | null;
  /** Quando o fato aconteceu, segundo quem assinou. */
  declarado_em: string | null;
  assinado_em: string;
  term_titulo: string;
  pdf_path: string | null;
  pdf_enviado_em: string | null;
}

/** Onde este assinante travou, e o que a equipe faz a respeito. */
export type Estagio =
  | "pagamento_falhou"
  | "calendario_quebrado"
  | "sem_imovel"
  | "sem_calendario"
  | "calendario_sem_sincronizar"
  | "sem_diarista"
  | "sem_mensagem"
  | "consolidado"
  | "perdido";

export interface PipelineLinha {
  owner_id: string;
  full_name: string | null;
  email: string | null;
  phone_e164: string | null;
  plano: string | null;
  assinatura: string | null;
  estagio: Estagio;
  prioridade: number;
  /** Frase pronta para quem vai ligar — não o rótulo interno do estágio. */
  acao: string;
  porque: string;
  imoveis: number;
  imoveis_ativos: number;
  ical_quebrado: number;
  assinou_em: string | null;
  ultima_atividade: string | null;
  ultimo_contato_em: string | null;
  ultimo_resultado: string | null;
  proximo_passo: string | null;
  proximo_passo_em: string | null;
  contatos: number;
  total_count: number;
}

export interface ContaImovel {
  id: string;
  nome: string;
  cidade: string | null;
  calendarios: number;
  calendario_quebrado: number;
  ultima_sincronia: string | null;
  diarista: string | null;
  self_clean: boolean;
  mensagem_automatica: boolean;
  portaria: boolean;
  portaria_pedido: string | null;
  reservas_futuras: number;
}

export interface ContaAdmin {
  user_id: string;
  papeis: string[];
  nome: string | null;
  email: string | null;
  telefone: string | null;
  plano: string | null;
  ciclo: string | null;
  assinatura: string | null;
  assinou_em: string | null;
  periodo_ate: string | null;
  ultimo_acesso: string | null;
  notas: string | null;
  imoveis?: ContaImovel[];
  saidas?: Array<{
    data: string;
    hora: string | null;
    imovel: string;
    status: string;
    diarista: string | null;
  }>;
  ativacao?: {
    travado_em: string | null;
    ativado: boolean;
    imoveis: number;
    com_calendario: number;
    sincronizando: number;
    com_diarista: number;
    com_mensagem: number;
    convites_pendentes: number;
  };
  diarista?: {
    hosts: number;
    imoveis: number;
    acordos_pendentes: number;
    limpezas_30d: number;
    a_receber_mes: number;
  };
  tarefas?: Array<{
    data: string;
    hora: string | null;
    imovel: string;
    status: string;
    host: string | null;
  }>;
  contatos: Array<{
    quando: string;
    canal: string;
    resultado: string;
    notas: string | null;
    proximo_passo: string | null;
    proximo_passo_em: string | null;
    autor: string | null;
  }>;
}

/** Um pedido de implantação da portaria, como o admin vê na fila. */
export interface PorterPedido {
  id: string;
  status: "interessado" | "pago" | "em_andamento" | "implantado" | "cancelado";
  property_id: string;
  property_name: string;
  owner_id: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  condo_name: string | null;
  condo_system: string | null;
  amount_cents: number;
  paid_at: string | null;
  contacted_at: string | null;
  implanted_at: string | null;
  notes: string | null;
  created_at: string;
  total_count: number;
}

export interface HermesCredential {
  // Sem property_id: a credencial é da CONTA do Airbnb, que hospeda todos os
  // anúncios daquele anfitrião. Quem liga por imóvel é `hermes_enabled`.
  login: string;
  status: "pendente" | "aguardando_codigo" | "ativo" | "falhou";
  last_error: string | null;
  last_read_at: string | null;
  read_count: number;
  created_at: string;
  /** Preenchidos só enquanto o Airbnb está pedindo código de verificação. */
  challenge_type: string | null;
  challenge_hint: string | null;
  codigo_enviado: boolean;
  expira_em: number | null;
  /** Reenvio: pedido em aberto, quantos já foram, e quando o botão destrava. */
  reenvio_pedido: boolean;
  reenvios_usados: number;
  reenvio_em: number;
}

export interface HermesStatus {
  properties: Array<{
    id: string;
    name: string;
    airbnb_listing_id: string | null;
    hermes_enabled: boolean;
  }>;
  credential: HermesCredential | null;
  term: { id: string; title: string; body: string; version: string } | null;
  keys: Array<{
    id: string;
    name: string;
    key_prefix: string;
    created_at: string;
    last_used_at: string | null;
  }>;
}

export const api = {
  property: {
    upsert: (body: Record<string, unknown>) =>
      request<{
        property: { id: string; name: string; chat_url: string };
        activation: ActivationState | null;
        next_step: string;
      }>("property-upsert", { body }),
  },

  ical: {
    /**
     * Emite (ou rotaciona) a URL do calendário DE SAÍDA — o .ics que o Airbnb e
     * o Booking importam para bloquear as datas um do outro.
     *
     * Devolve o token em claro uma vez só: o banco guarda apenas o hash. Quem
     * perder a URL emite outra, e a anterior deixa de valer no mesmo instante.
     * Por isso o botão diz "gerar de novo" e avisa que o link antigo morre — um
     * link morto dentro do Airbnb significa datas deixando de ser bloqueadas,
     * e ninguém percebe isso até a dupla reserva.
     */
    issueFeedToken: async (property_id: string) => {
      const { data, error } = await supabase.rpc("issue_ical_feed_token", {
        _property_id: property_id,
      });
      if (error) throw new ApiError("invalid_request", error.message, 400);
      return data as unknown as string;
    },

    // `provider` vai explícito: o backend sabe adivinhar pela URL, mas quem
    // colou o link na caixa do Booking já disse qual é, e um link encurtado
    // ou de domínio próprio seria arquivado como "other" — criando uma
    // segunda fonte em vez de atualizar a que existe.
    validate: (body: {
      url: string;
      property_id?: string;
      save?: boolean;
      provider?: "airbnb" | "booking" | "vrbo" | "other";
    }) =>
      request<{
        ok: boolean;
        reason?: string;
        message: string;
        events?: number;
        next_checkout?: string | null;
        saved?: boolean;
      }>("ical-validate", { body }),
  },

  /**
   * Implantação da portaria (serviço avulso).
   *
   * Devolve a URL do checkout da Stripe, ou o estado do pedido quando já
   * existe um vivo. O preço não viaja daqui: quem decide é o banco.
   */
  porterSetup: (body: { property_id: string; condo_name?: string; condo_system?: string }) =>
    request<{
      ok: boolean;
      checkout_url?: string;
      ja_existe?: boolean;
      status?: string;
      message?: string;
    }>("porter-setup", { body }),

  // Portaria digital. As credenciais só viajam daqui para o backend — a
  // tabela não tem policy de SELECT, então nunca voltam. Por isso o formulário
  // não "carrega o que está salvo": não existe carregar.
  porter: {
    status: (property_id: string) =>
      request<PorterState>("porter-connect", { body: { action: "status", property_id } }),

    test: (body: PorterCredentials & { property_id: string }) =>
      request<{ ok: boolean; status: number | null; message: string }>("porter-connect", {
        body: { action: "test", ...body },
      }),

    save: (body: PorterCredentials & { property_id: string; skip_test?: boolean }) =>
      request<{
        ok: boolean;
        saved?: boolean;
        reason?: string;
        queued?: number;
        message: string;
      }>("porter-connect", { body: { action: "save", ...body } }),

    disconnect: (property_id: string) =>
      request<{ ok: boolean; connected: boolean; message: string }>("porter-connect", {
        body: { action: "disconnect", property_id },
      }),
  },

  cleaner: {
    invite: (body: {
      cleaner_name: string;
      cleaner_phone?: string;
      cleaner_email?: string;
      property_id?: string;
    }) =>
      request<{
        invite_id: string;
        accept_url: string;
        whatsapp_link: string | null;
        whatsapp_message: string;
        auto_sent: boolean;
      }>("cleaner-invite", { body }),

    // Reemite o link permanente do painel dela. O anterior deixa de valer —
    // o token não fica em claro no banco, então não há "ver o mesmo de novo".
    link: (cleaner_id: string) =>
      request<{
        invite_id: string;
        cleaner_name: string;
        access_url: string;
        whatsapp_link: string | null;
        whatsapp_message: string;
        replaced_previous: boolean;
      }>("cleaner-link", { body: { cleaner_id } }),

    preview: (token: string) =>
      request<{
        cleaner_name: string;
        owner_name: string;
        properties: number;
        already_accepted: boolean;
        needs_phone: boolean;
      }>("cleaner-accept", { body: { token, action: "preview" }, auth: false }),

    accept: (token: string, phone?: string) =>
      request<{
        owner_name: string;
        cleaner_name: string;
        session: { access_token: string; refresh_token: string };
      }>("cleaner-accept", { body: { token, action: "accept", phone }, auth: false }),
  },

  billing: {
    checkout: (body: { tier: string; cycle: string }) =>
      request<{ url: string }>("billing-checkout", { body }),
    portal: () => request<{ url: string }>("billing-portal", {}),
  },

  // Recuperação de senha. A resposta é a mesma exista a conta ou não — a tela
  // precisa refletir isso e nunca dizer "e-mail não encontrado".
  auth: {
    resetPassword: (email: string) =>
      request<{ ok: boolean; message: string }>("password-reset", {
        body: { email },
        auth: false,
      }),

    // Cadastro pelo backend, e não pelo `supabase.auth.signUp`. O signUp manda
    // a confirmação pelo e-mail padrão do Supabase, cujo link aponta para o
    // Site URL do projeto — campo de dashboard que, em branco, mandava todo
    // cliente novo para localhost. Aqui o link é nosso, e o e-mail sai com a
    // mesma cara dos outros. A resposta também não distingue conta existente.
    signup: (body: { email: string; password: string; full_name: string; phone?: string }) =>
      request<{ ok: boolean; message: string }>("signup", { body, auth: false }),
  },

  // Atendimento automático 24h. Repare que não existe `get` da senha: ela vai
  // para o cofre e não volta. O `status` devolve só o estado — conectado,
  // falhou, quando o agente usou pela última vez.
  hermes: {
    status: () => request<HermesStatus>("hermes-credentials", { body: { action: "status" } }),

    save: (body: {
      property_id: string;
      login: string;
      password: string;
      totp_secret?: string;
      platform?: "airbnb" | "booking";
      accept_term: boolean;
    }) =>
      request<{ ok: boolean; agent_key: string }>("hermes-credentials", {
        body: { action: "save", ...body },
      }),

    /** Código de verificação que o Airbnb mandou no SMS/e-mail do dono. */
    submitCode: (code: string) =>
      request<{ ok: boolean }>("hermes-credentials", {
        body: { action: "challenge-submit", code },
      }),

    /** Pede ao worker que clique em "reenviar" na página do Airbnb. */
    resend: () =>
      request<{ ok: boolean }>("hermes-credentials", { body: { action: "resend-request" } }),

    /** Liga um imóvel numa conta já conectada — sem redigitar a senha. */
    enable: (property_id: string) =>
      request<{ ok: boolean }>("hermes-credentials", {
        body: { action: "enable", property_id },
      }),

    revoke: (property_id: string, scope: "imovel" | "conta" = "imovel") =>
      request<{ ok: boolean; credencial_apagada: boolean }>("hermes-credentials", {
        body: { action: "revoke", property_id, scope },
      }),

    createKey: (key_name?: string) =>
      request<{ key: string }>("hermes-credentials", { body: { action: "key-create", key_name } }),

    revokeKey: (key_id: string) =>
      request<{ ok: boolean }>("hermes-credentials", { body: { action: "key-revoke", key_id } }),
  },

  /** Duplica o imóvel para um segundo anúncio, com os calendários cruzados. */
  duplicarImovel: (property_id: string, nome?: string) =>
    request<{
      ok: boolean;
      id: string;
      nome: string;
      cruzado: boolean;
      slug?: string;
      aviso?: string;
    }>("property-duplicate", { body: { property_id, nome } }),

  /** A declaração de limpeza, assinada pela diarista. */
  assinarLimpeza: (entrada: {
    cleaning_task_id: string;
    declarado_em: string;
    signer_name: string;
    signer_doc?: string;
    assinatura: string;
  }) => request<{ ok: boolean; id: string }>("assinar-termo", { body: entrada }),

  /**
   * Termos assinados.
   *
   * O PDF vive num bucket privado; o acesso é decidido pelas policies do
   * storage (0045) e não por esta camada. `createSignedUrl` só devolve link
   * para quem a policy já deixaria ler.
   */
  termos: {
    /** Os termos de um imóvel, ou de um cadastro de hóspede específico. */
    listar: async (filtro: { propertyId?: string; registrationId?: string } = {}) => {
      let q = supabase
        .from("assinaturas")
        .select(
          "id, kind, property_id, registration_id, cleaning_task_id, signer_name, " +
            "signer_doc, declarado_em, assinado_em, term_titulo, pdf_path, pdf_enviado_em",
        )
        .order("assinado_em", { ascending: false });

      if (filtro.propertyId) q = q.eq("property_id", filtro.propertyId);
      if (filtro.registrationId) q = q.eq("registration_id", filtro.registrationId);

      const { data, error } = await q;
      if (error) throw new ApiError("forbidden", error.message, 403);
      return (data ?? []) as unknown as TermoAssinado[];
    },

    /**
     * Link temporário para abrir o PDF.
     *
     * Curto de propósito: é para clicar agora, não para colar num grupo de
     * WhatsApp. Quem precisa guardar o documento baixa o arquivo.
     */
    link: async (pdfPath: string) => {
      const { data, error } = await supabase.storage
        .from("termos")
        .createSignedUrl(pdfPath, 120, { download: true });
      if (error || !data?.signedUrl) {
        throw new ApiError("not_found", "Não consegui abrir esse documento", 404);
      }
      return data.signedUrl;
    },
  },

  admin: {
    metrics: async (view: string, params: Record<string, string> = {}) => {
      const { data } = await supabase.auth.getSession();
      const qs = new URLSearchParams({ view, ...params });
      const res = await fetch(`${FUNCTIONS}/admin-metrics?${qs}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${data.session?.access_token ?? ""}`,
        },
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        throw new ApiError(p?.error?.code ?? "unknown", p?.error?.message ?? "Erro", res.status);
      }
      return res.json();
    },

    visaoGeral: async () => {
      const [kpis, funil, saude] = await Promise.all([
        supabase.rpc("admin_kpis"),
        supabase.rpc("admin_activation_funnel"),
        supabase.rpc("admin_system_health"),
      ]);
      if (kpis.error) throw new ApiError("forbidden", kpis.error.message, 403);
      return {
        kpis: kpis.data as Record<string, number>,
        funil: (funil.data ?? []) as Array<Record<string, unknown>>,
        saude: saude.data as Record<string, unknown>,
      };
    },

    financeiro: async (meses = 12) => {
      const { data, error } = await supabase.rpc("admin_financeiro", { _meses: meses });
      if (error) throw new ApiError("forbidden", error.message, 403);
      return data as {
        receita_total_cents: number;
        clientes_pagantes: number;
        ltv_realizado_cents: number;
        ltv_projetado_cents: number | null;
        churn_mensal_pct: number;
        vida_media_meses: number | null;
        amostra_confiavel: boolean;
        por_plano: Array<{ tier: string; nome: string; assinantes: number; mrr_cents: number }>;
        serie_mensal: Array<{ mes: string; receita_cents: number; cobrancas: number }>;
        portaria_pagos_nao_implantados: number;
        portaria_receita_cents: number;
        portaria_interessados: number;
        portaria_implantados: number;
      };
    },

    diaristas: async (busca?: string) => {
      const { data, error } = await supabase.rpc("admin_cleaners", {
        _search: busca ?? null,
        _limit: 100,
        _offset: 0,
      });
      if (error) throw new ApiError("forbidden", error.message, 403);
      return (data ?? []) as Array<{
        cleaner_id: string;
        full_name: string | null;
        email: string | null;
        phone_e164: string | null;
        entrou_em: string;
        hosts: number;
        imoveis: number;
        limpezas_30d: number;
        ultima_limpeza: string | null;
      }>;
    },

    /**
     * O pipeline da equipe de vendas.
     *
     * A lista de assinantes diz QUEM assinou. Isso não organiza trabalho
     * nenhum: não diz para quem ligar primeiro, o que falar, nem o que já foi
     * tentado. Sem isso duas pessoas ligam para o mesmo cliente na mesma
     * semana e ninguém liga para quem está prestes a cancelar.
     */
    pipeline: async (estagio?: string) => {
      const { data, error } = await supabase.rpc("admin_pipeline", {
        _estagio: estagio ?? null,
        _limit: 200,
        _offset: 0,
      });
      if (error) throw new ApiError("forbidden", error.message, 403);
      return (data ?? []) as PipelineLinha[];
    },

    registrarContato: async (entrada: {
      target_user_id: string;
      canal: string;
      resultado: string;
      notas?: string;
      proximo_passo?: string;
      proximo_passo_em?: string | null;
    }) => {
      const { error } = await supabase.rpc("admin_registra_contato", {
        _target_user_id: entrada.target_user_id,
        _canal: entrada.canal,
        _resultado: entrada.resultado,
        _notas: entrada.notas ?? null,
        _proximo_passo: entrada.proximo_passo ?? null,
        _proximo_passo_em: entrada.proximo_passo_em ?? null,
      });
      if (error) throw new ApiError("invalid_request", error.message, 400);
    },

    /**
     * O painel de uma conta — dono, diarista, ou os dois.
     *
     * Registra a visita ANTES de ler. Se o log falhasse depois da leitura,
     * existiria uma janela em que o admin vê a conta alheia sem deixar rastro.
     */
    conta: async (userId: string, motivo?: string) => {
      await api.admin.registrarVisita(userId, motivo ?? "abriu o painel da conta");
      const { data, error } = await supabase.rpc("admin_conta", { _user_id: userId });
      if (error) throw new ApiError("forbidden", error.message, 403);
      return data as ContaAdmin;
    },

    /**
     * A fila da implantação da portaria.
     *
     * O financeiro já contava quantos pagaram. Contar não atende ninguém: o
     * cliente paga R$ 197 e o único aviso é um e-mail que depende de um
     * segredo estar configurado. Serviço cobrado precisa de fila dentro do
     * produto — e-mail é notificação, fila é onde o trabalho fica até alguém
     * fazer.
     */
    portariaFila: async (status?: string) => {
      const { data, error } = await supabase.rpc("admin_porter_fila", {
        _status: status ?? null,
        _limit: 100,
        _offset: 0,
      });
      if (error) throw new ApiError("forbidden", error.message, 403);
      return (data ?? []) as PorterPedido[];
    },

    portariaAvanca: async (id: string, status: string, notas?: string) => {
      const { error } = await supabase.rpc("admin_porter_avanca", {
        _id: id,
        _status: status,
        _notes: notas ?? null,
      });
      if (error) throw new ApiError("invalid_request", error.message, 400);
    },

    // Registra a visita ANTES de mostrar os dados. Se o log falhar, a tela não
    // abre — auditoria que só grava quando dá tudo certo não é auditoria.
    registrarVisita: async (userId: string, motivo?: string) => {
      const { error } = await supabase.rpc("admin_registra_visita", {
        _target_user_id: userId,
        _motivo: motivo ?? null,
      });
      if (error) throw new ApiError("forbidden", error.message, 403);
    },
  },

  /** As dicas do próximo passo. Sem id, são as de quem está logado. */
  dicas: async (ownerId?: string) => {
    const { data, error } = await supabase.rpc("owner_next_steps", {
      _owner_id: ownerId ?? null,
    });
    if (error) throw new ApiError("invalid_request", error.message, 400);
    return data as {
      dicas: Array<{
        chave: string;
        peso: number;
        titulo: string;
        porque: string;
        destino: string;
        oferta?: boolean;
      }>;
      total: number;
      ativado: boolean;
      travado_em: string | null;
    };
  },
};

// ---------------------------------------------------------------------------
// Hóspede (público, sem sessão do Supabase)
// ---------------------------------------------------------------------------

export interface GuestInput {
  full_name: string;
  email: string;
  /** E.164, com o DDI do país escolhido. */
  phone: string;
  /** O DDI sozinho, sem o "+". Ver `guest_people.phone_ddi`. */
  phone_ddi?: string;
  document_type?: "cpf" | "passaporte" | "rg" | "outro";
  /** CPF só com dígitos, ou passaporte em maiúsculas. */
  document_number?: string;
  /** ISO 3166-1 alfa-2. "BR" para quem informou CPF. */
  nationality?: string;
  /** data:image/...;base64,... da foto do documento. */
  document_photo?: string;
}

export const guestApi = {
  register: (body: {
    property_slug: string;
    checkin_date: string;
    checkout_date: string;
    guests: GuestInput[];
    term_accepted: boolean;
    /** PNG do canvas de assinatura. Obrigatório desde o termo 2.0. */
    assinatura: string;
    locale: string;
  }) =>
    request<{
      session_token: string;
      property: { name: string; checkin_time: string; checkout_time: string };
      guests_registered: number;
      porter_pending: boolean;
    }>("guest-register", { body, auth: false }),

  /** Chat em streaming — chama onChunk a cada pedaço de texto. */
  async chat(
    token: string,
    message: string,
    onChunk: (text: string) => void,
  ): Promise<void> {
    const res = await fetch(`${FUNCTIONS}/guest-chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        "x-guest-token": token,
      },
      body: JSON.stringify({ message }),
    });

    if (!res.ok || !res.body) {
      const p = await res.json().catch(() => ({}));
      throw new ApiError(
        p?.error?.code ?? "unknown",
        p?.error?.message ?? "Não consegui responder agora.",
        res.status,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]" || payload === "") continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.text) onChunk(parsed.text);
          if (parsed.error) throw new ApiError("stream_error", parsed.error, 500);
        } catch (e) {
          if (e instanceof ApiError) throw e;
        }
      }
    }
  },
};

/** Token do hóspede no navegador — a estadia dura semanas, não a aba. */
export const guestSession = {
  key: (slug: string) => `hp_guest_${slug}`,
  get: (slug: string) => localStorage.getItem(guestSession.key(slug)),
  set: (slug: string, token: string) =>
    localStorage.setItem(guestSession.key(slug), token),
  clear: (slug: string) => localStorage.removeItem(guestSession.key(slug)),
};
