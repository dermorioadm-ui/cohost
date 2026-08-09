import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { env } from "./env.ts";
import { errors } from "./http.ts";

/**
 * Cliente com service_role — ignora RLS. Use só depois de ter autorizado
 * a operação explicitamente no código da function.
 */
export function admin(): SupabaseClient {
  return createClient(env.supabaseUrl(), env.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Cliente no contexto do usuário — respeita RLS. Prefira este sempre que a
 * própria RLS já expressa a regra de acesso.
 */
export function asUser(authHeader: string): SupabaseClient {
  return createClient(env.supabaseUrl(), env.anonKey() || env.serviceRoleKey(), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthedUser {
  id: string;
  email: string | null;
  role: "owner" | "cleaner" | "admin" | null;
}

/** Exige usuário autenticado. Devolve id, email e papel prioritário. */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw errors.unauthorized();

  const db = admin();
  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw errors.unauthorized("Sessão inválida ou expirada");

  const { data: roles } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", data.user.id);

  const list = (roles ?? []).map((r) => r.role as string);
  const role = list.includes("admin")
    ? "admin"
    : list.includes("owner")
      ? "owner"
      : list.includes("cleaner")
        ? "cleaner"
        : null;

  return { id: data.user.id, email: data.user.email ?? null, role };
}

export async function requireRole(
  req: Request,
  ...allowed: Array<"owner" | "cleaner" | "admin">
): Promise<AuthedUser> {
  const user = await requireUser(req);
  // Admin passa em qualquer rota.
  if (user.role === "admin") return user;
  if (!user.role || !allowed.includes(user.role)) {
    throw errors.forbidden(`Requer papel: ${allowed.join(" ou ")}`);
  }
  return user;
}

/**
 * Jobs agendados. O pg_cron assina a chamada com x-cron-secret; o segredo
 * esperado vive em private.job_config — a mesma linha que o pg_cron lê para
 * assinar. Uma fonte só: não existe variável de ambiente para esquecer de
 * preencher. A comparação é feita no banco, em tempo constante.
 */
export async function requireCron(req: Request): Promise<void> {
  const provided = req.headers.get("x-cron-secret") ?? "";

  const { data: ok, error } = await admin().rpc("verify_cron_secret", {
    _provided: provided,
  });

  if (error) throw errors.upstream(`Falha ao verificar o segredo: ${error.message}`);
  if (!ok) throw errors.forbidden("Segredo de cron inválido");
}

/** Data de hoje no fuso da aplicação — espelha public.app_today() no banco. */
export function appToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.timezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
