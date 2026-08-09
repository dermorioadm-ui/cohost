import { corsHeaders, json } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { optional } from "../_shared/lib/env.ts";

/**
 * Webhook da Meta Cloud API.
 *
 * Duas responsabilidades:
 *  1. Verificação inicial (GET com hub.challenge) — a Meta exige para ativar.
 *  2. Status de entrega e respostas recebidas.
 *
 * Número que devolve erro permanente entra na supressão, igual ao e-mail. E
 * quando a diarista responde no WhatsApp, gravamos: é o gancho para o funil
 * conversacional de configuração ligar aqui depois, sem reescrever nada.
 */

/** A Meta assina o corpo com HMAC-SHA256 usando o App Secret. */
async function validSignature(req: Request, raw: string): Promise<boolean> {
  const appSecret = optional("WHATSAPP_APP_SECRET");
  if (!appSecret) return true; // não configurado: aceita (staging)

  const header = req.headers.get("x-hub-signature-256") ?? "";
  if (!header.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const provided = header.slice("sha256=".length);
  if (provided.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---- 1. verificação do endpoint (a Meta chama uma vez) -------------------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === optional("WHATSAPP_VERIFY_TOKEN")) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return json({ error: "método não suportado" }, 405);

  const raw = await req.text();
  if (!(await validSignature(req, raw))) {
    console.warn("whatsapp-webhook: assinatura inválida");
    return json({ error: "assinatura inválida" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const db = admin();
  let statuses = 0;
  let inbound = 0;

  const entries = (payload.entry ?? []) as Array<Record<string, unknown>>;

  for (const entry of entries) {
    const changes = (entry.changes ?? []) as Array<Record<string, unknown>>;

    for (const change of changes) {
      const value = (change.value ?? {}) as Record<string, unknown>;

      // ---- status de entrega --------------------------------------------
      for (const s of (value.statuses ?? []) as Array<Record<string, unknown>>) {
        const messageId = String(s.id ?? "");
        const status = String(s.status ?? "");
        const recipient = String(s.recipient_id ?? "");

        if (messageId) {
          await db
            .from("notifications")
            .update({
              status: status === "failed" ? "failed" : "sent",
              last_error: status === "failed"
                ? JSON.stringify(s.errors ?? {}).slice(0, 500)
                : null,
            })
            .eq("provider_message_id", messageId);
        }

        // Erro permanente: número inexistente ou que bloqueou o negócio.
        const code = Number(
          ((s.errors as Array<Record<string, unknown>> | undefined)?.[0]?.code) ?? 0,
        );
        if (status === "failed" && [131026, 131047, 131052, 470].includes(code) && recipient) {
          await db.from("suppressions").upsert(
            {
              channel: "whatsapp",
              address: recipient,
              reason: `meta_error_${code}`,
              metadata: { errors: s.errors ?? null },
            },
            { onConflict: "channel,address" },
          );
        }
        statuses++;
      }

      // ---- mensagens recebidas -------------------------------------------
      for (const m of (value.messages ?? []) as Array<Record<string, unknown>>) {
        const from = String(m.from ?? "");
        const text = String(
          ((m.text as Record<string, unknown> | undefined)?.body) ?? "",
        );

        // Por ora só registramos. É o ponto de entrada do funil de
        // configuração conversacional — quando ele existir, é aqui que
        // a mensagem da diarista ou do dono será roteada.
        await db.from("audit_log").insert({
          action: "whatsapp.inbound",
          entity: "whatsapp",
          entity_id: String(m.id ?? ""),
          metadata: { from, text: text.slice(0, 500), type: m.type ?? null },
        });
        inbound++;
      }
    }
  }

  // A Meta reenvia enquanto não receber 200. Sempre confirmamos o recebimento;
  // erro de processamento nosso vai para o log, não para a Meta.
  return json({ ok: true, statuses, inbound });
});
