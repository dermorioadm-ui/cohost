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
    checkout: (body: { tier: string; cycle: string; trial?: boolean }) =>
      request<{ url: string }>("billing-checkout", { body }),
    portal: () => request<{ url: string }>("billing-portal", {}),
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
  },
};

// ---------------------------------------------------------------------------
// Hóspede (público, sem sessão do Supabase)
// ---------------------------------------------------------------------------

export interface GuestInput {
  full_name: string;
  email: string;
  phone: string;
}

export const guestApi = {
  register: (body: {
    property_slug: string;
    checkin_date: string;
    checkout_date: string;
    guests: GuestInput[];
    term_accepted: boolean;
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
