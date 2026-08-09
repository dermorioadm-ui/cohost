import { corsHeaders, json } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { optional } from "../_shared/lib/env.ts";

/**
 * Webhook do provedor de e-mail: bounce, reclamação de spam e descadastro.
 *
 * Endereço que devolveu bounce permanente ou marcou spam entra na lista de
 * supressão e nunca mais recebe. Sem isso a reputação de envio degrada, e aí
 * o e-mail para a PORTARIA — que é argumento de venda — começa a cair em spam.
 *
 * Aceita o formato da Resend e do SendGrid; detecta pelo corpo.
 */

const HARD_BOUNCE = new Set([
  "email.bounced",
  "email.complained",
  "bounce",
  "dropped",
  "spamreport",
  "blocked",
]);

const UNSUBSCRIBE = new Set(["unsubscribe", "group_unsubscribe", "email.unsubscribed"]);

/** Valida o segredo compartilhado do webhook, quando configurado. */
function authorized(req: Request): boolean {
  const expected = optional("EMAIL_WEBHOOK_SECRET");
  if (!expected) return true; // não configurado: aceita (útil em staging)
  const provided =
    req.headers.get("x-webhook-secret") ??
    new URL(req.url).searchParams.get("secret") ??
    "";
  return provided === expected;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  if (!authorized(req)) return json({ error: "não autorizado" }, 401);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  // Resend envia um objeto; SendGrid envia um array.
  const events = Array.isArray(payload) ? payload : [payload];
  const db = admin();

  let suppressed = 0;
  let ignored = 0;

  for (const raw of events) {
    const e = raw as Record<string, unknown>;

    const type = String(e.type ?? e.event ?? "").toLowerCase();
    const data = (e.data ?? e) as Record<string, unknown>;
    const address = String(
      data.email ?? (Array.isArray(data.to) ? data.to[0] : data.to) ?? "",
    ).toLowerCase().trim();

    if (!address || !address.includes("@")) {
      ignored++;
      continue;
    }

    // Bounce transitório (caixa cheia, servidor fora) não suprime — o retry
    // do outbox resolve. Só suprimimos o que é permanente.
    const isSoft =
      String(data.bounce_type ?? data.type ?? "").toLowerCase().includes("soft") ||
      String(data.reason ?? "").toLowerCase().includes("mailbox full");

    if (HARD_BOUNCE.has(type) && !isSoft) {
      await db.from("suppressions").upsert(
        {
          channel: "email",
          address,
          reason: type,
          metadata: { raw_type: type, reason: data.reason ?? null },
        },
        { onConflict: "channel,address" },
      );
      suppressed++;
      continue;
    }

    if (UNSUBSCRIBE.has(type)) {
      await db.from("suppressions").upsert(
        { channel: "email", address, reason: "unsubscribe", metadata: {} },
        { onConflict: "channel,address" },
      );
      suppressed++;
      continue;
    }

    ignored++;
  }

  if (suppressed > 0) {
    console.log(`email-webhook: ${suppressed} endereço(s) suprimido(s), ${ignored} ignorado(s)`);
  }

  return json({ ok: true, suppressed, ignored });
});
