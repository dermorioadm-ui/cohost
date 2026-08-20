/**
 * Acesso a variáveis de ambiente com validação na inicialização.
 * Preferimos falhar no deploy a falhar na primeira requisição do cliente.
 */

export function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim() === "") {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export function optional(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

export function flag(name: string, fallback = false): boolean {
  const v = Deno.env.get(name)?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

export function num(name: string, fallback: number): number {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) ? v : fallback;
}

export const env = {
  supabaseUrl: () => required("SUPABASE_URL"),
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  anonKey: () => optional("SUPABASE_ANON_KEY"),

  // O padrão é o domínio do produto, não a URL de preview da Vercel. Ele vaza
  // para lugares visíveis: o link do assistente no e-mail do hóspede, o link
  // do painel da diarista, o redirect da recuperação de senha e o retorno do
  // checkout da Stripe — tudo saindo de uma mensagem assinada @hospedepay.org.
  // Em produção quem manda é o secret APP_BASE_URL; este valor é a rede de
  // segurança para quando ele não estiver preenchido.
  appBaseUrl: () => optional("APP_BASE_URL", "https://hospedepay.org"),
  timezone: () => optional("APP_TIMEZONE", "America/Sao_Paulo"),
  defaultLocale: () => optional("APP_DEFAULT_LOCALE", "pt"),
  isProduction: () => optional("APP_ENV", "production") === "production",


  stripeSecret: () => required("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: () => required("STRIPE_WEBHOOK_SECRET"),

  aiProvider: () => optional("AI_PROVIDER", "anthropic"),
  aiModel: () => optional("AI_MODEL"),
  aiMaxTokens: () => num("AI_MAX_OUTPUT_TOKENS", 800),

  emailProvider: () => optional("EMAIL_PROVIDER", "resend"),
  emailFrom: () => optional("EMAIL_FROM_ADDRESS", "nao-responda@hospedepay.org"),
  emailFromName: () => optional("EMAIL_FROM_NAME", "HospedePay"),
  // Sem valor por padrão, e é intencional: todo e-mail do produto sai de uma
  // caixa não monitorada. Preencher isto aponta as respostas para algum lugar
  // — e aí alguém precisa lê-las.
  emailReplyTo: () => optional("EMAIL_REPLY_TO"),
  /** Caixa interna que recebe os avisos da plataforma (assinatura nova). */
  adminNotifyEmail: () => optional("ADMIN_NOTIFY_EMAIL"),

  whatsappEnabled: () => flag("WHATSAPP_ENABLED", false),

  porterBaseUrl: () => optional("PORTER_API_BASE_URL", "https://api.cloud.kiper.com.br"),
  porterEnabled: () => flag("PORTER_ENABLED", true),

  logLevel: () => optional("LOG_LEVEL", "info"),
};
