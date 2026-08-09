/**
 * CORS, respostas padronizadas e tratamento de erro.
 *
 * Todo endpoint devolve o mesmo formato de erro:
 *   { error: { code: "codigo_estavel", message: "texto para humano" } }
 * O `code` é o que o frontend deve testar — a mensagem pode mudar.
 */

const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "apikey",
  "x-client-info",
  "x-cron-secret",
  "x-guest-token",
  "x-invite-token",
  "stripe-signature",
].join(", ");

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}

export function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

/** Erro de negócio com código estável — o handler converte em resposta HTTP. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  unauthorized: (msg = "Não autenticado") => new AppError("unauthorized", msg, 401),
  forbidden: (msg = "Sem permissão") => new AppError("forbidden", msg, 403),
  notFound: (msg = "Não encontrado") => new AppError("not_found", msg, 404),
  invalid: (msg: string, details?: unknown) => new AppError("invalid_request", msg, 400, details),
  rateLimited: (msg = "Muitas requisições. Tente novamente em instantes.") =>
    new AppError("rate_limited", msg, 429),
  upstream: (msg: string) => new AppError("upstream_error", msg, 502),
};

/**
 * Envolve o handler e já registra a function: trata OPTIONS, captura exceções
 * e nunca vaza stack trace para o cliente (mas registra no log da function).
 *
 * Uso: `export default handler(async (req) => { ... })`
 * A chamada a Deno.serve acontece aqui, então cada function tem um ponto de
 * entrada só — não dá para esquecer de servir, nem servir duas vezes.
 */
export function handler(fn: (req: Request) => Promise<Response>) {
  const wrapped = async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;

    const started = Date.now();
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof AppError) {
        console.warn(`[${e.code}] ${e.message}`, e.details ?? "");
        return json({ error: { code: e.code, message: e.message } }, e.status);
      }
      console.error("Erro não tratado:", e);
      return json(
        { error: { code: "internal_error", message: "Erro interno. Tente novamente." } },
        500,
      );
    } finally {
      console.log(`${req.method} ${new URL(req.url).pathname} — ${Date.now() - started}ms`);
    }
  };

  Deno.serve(wrapped);
  return wrapped;
}

/** Lê e valida o corpo JSON. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object") {
      throw errors.invalid("Corpo da requisição deve ser um objeto JSON");
    }
    return body as T;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.invalid("JSON inválido no corpo da requisição");
  }
}
