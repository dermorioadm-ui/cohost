import { handler, json } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";
import { env, optional } from "../_shared/lib/env.ts";
import { hasTemplate, renderEmail } from "../_shared/email-templates/registry.ts";

/**
 * Worker da fila de notificações — e-mail e WhatsApp no mesmo fluxo.
 *
 * Roda a cada minuto (migration 0015). O banco entrega o lote com
 * claim_notifications(), que usa FOR UPDATE SKIP LOCKED: dá para rodar vários
 * workers em paralelo sem enviar nada duplicado.
 *
 * Falha não perde a mensagem — volta para a fila com backoff exponencial
 * (1min, 2min, 4min...) até max_attempts, e aí fica visível como 'failed'
 * no painel de saúde do sistema.
 */

const BATCH_SIZE = 25;

interface Notification {
  id: string;
  channel: "email" | "whatsapp";
  template: string;
  to_email: string | null;
  to_phone_e164: string | null;
  payload: Record<string, unknown>;
  locale: string;
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

async function sendEmail(n: Notification): Promise<string> {
  if (!n.to_email) throw new Error("destinatário de e-mail ausente");
  if (!hasTemplate(n.template)) throw new Error(`template desconhecido: ${n.template}`);

  const { subject, html, text } = renderEmail(n.template, n.payload, n.locale);
  const provider = env.emailProvider();
  const from = `${env.emailFromName()} <${env.emailFrom()}>`;

  if (provider === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${optional("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [n.to_email],
        subject,
        html,
        text,
        reply_to: env.emailReplyTo() || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`);
    return String(body.id ?? "");
  }

  if (provider === "sendgrid") {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${optional("SENDGRID_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: n.to_email }] }],
        from: { email: env.emailFrom(), name: env.emailFromName() },
        reply_to: env.emailReplyTo() ? { email: env.emailReplyTo() } : undefined,
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
    return res.headers.get("x-message-id") ?? "";
  }

  throw new Error(`EMAIL_PROVIDER não suportado: ${provider}`);
}

// ---------------------------------------------------------------------------
// WhatsApp (Meta Cloud API)
// ---------------------------------------------------------------------------

const WA_TEMPLATES: Record<string, string> = {
  "cleaner-invite": optional("WHATSAPP_TEMPLATE_CLEANER_INVITE", "convite_diarista"),
  "new-reservation": optional("WHATSAPP_TEMPLATE_NEW_RESERVATION", "nova_reserva"),
};

async function sendWhatsApp(n: Notification): Promise<string> {
  if (!env.whatsappEnabled()) {
    // Não é erro: enquanto a verificação da Meta não sai, o envio é manual
    // pelo link wa.me que o cleaner-invite já devolve.
    throw new Error("whatsapp_desabilitado");
  }
  if (!n.to_phone_e164) throw new Error("destinatário de WhatsApp ausente");

  const templateName = WA_TEMPLATES[n.template];
  if (!templateName) throw new Error(`template WhatsApp desconhecido: ${n.template}`);

  const phoneId = optional("WHATSAPP_PHONE_NUMBER_ID");
  const token = optional("WHATSAPP_ACCESS_TOKEN");
  if (!phoneId || !token) throw new Error("credenciais do WhatsApp ausentes");

  // Mensagem iniciada pelo negócio exige template aprovado; as variáveis
  // entram em ordem posicional.
  const params = Object.values(n.payload)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .slice(0, 10)
    .map((v) => ({ type: "text", text: String(v) }));

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: n.to_phone_e164,
      type: "template",
      template: {
        name: templateName,
        language: { code: n.locale === "pt" ? "pt_BR" : n.locale },
        components: params.length ? [{ type: "body", parameters: params }] : [],
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(body)}`);
  return String(body?.messages?.[0]?.id ?? "");
}

// ---------------------------------------------------------------------------

export default handler(async (req) => {
  await requireCron(req);

  const db = admin();
  const { data: batch, error } = await db.rpc("claim_notifications", { _limit: BATCH_SIZE });
  if (error) throw new Error(`Falha ao reservar lote: ${error.message}`);

  const items = (batch ?? []) as Notification[];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const n of items) {
    try {
      const messageId = n.channel === "email" ? await sendEmail(n) : await sendWhatsApp(n);
      await db
        .from("notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider_message_id: messageId || null,
          last_error: null,
        })
        .eq("id", n.id);
      sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      // WhatsApp desligado não é falha a ser reprocessada — o envio é manual.
      if (message === "whatsapp_desabilitado") {
        await db
          .from("notifications")
          .update({ status: "cancelled", last_error: "envio manual via wa.me" })
          .eq("id", n.id);
        skipped++;
        continue;
      }

      console.error(`Falha ao enviar ${n.template} (${n.id}): ${message}`);
      await db.rpc("fail_notification", { _id: n.id, _error: message.slice(0, 500) });
      failed++;
    }
  }

  const summary = { claimed: items.length, sent, failed, skipped };
  if (items.length > 0) console.log("process-outbox:", JSON.stringify(summary));
  return json({ ok: true, ...summary });
});
