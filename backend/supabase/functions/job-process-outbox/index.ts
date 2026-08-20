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

interface Anexo {
  filename: string;
  content: string;
}

/**
 * Baixa o anexo declarado no payload e devolve no formato do provedor.
 *
 * Falhar em anexar NÃO derruba o e-mail. A mensagem em si já diz o que
 * aconteceu, e um documento faltando é melhor do que o dono não ficar sabendo
 * que a limpeza foi declarada. O erro fica no log para quem for investigar.
 */
async function carregarAnexo(payload: Record<string, unknown>): Promise<Anexo[] | null> {
  const caminho = typeof payload.__anexo_path === "string" ? payload.__anexo_path : "";
  if (!caminho) return null;

  try {
    const { data, error } = await admin().storage.from("termos").download(caminho);
    if (error || !data) throw new Error(error?.message ?? "arquivo ausente");

    const bytes = new Uint8Array(await data.arrayBuffer());

    // btoa em pedaços: `String.fromCharCode(...bytes)` estoura a pilha em
    // arquivos de algumas centenas de KB, e o erro não parece de tamanho.
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    const nome = typeof payload.__anexo_nome === "string" ? payload.__anexo_nome : "documento.pdf";
    return [{ filename: nome, content: btoa(bin) }];
  } catch (e) {
    console.error(`Anexo ${caminho} não foi lido:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function sendEmail(n: Notification): Promise<string> {
  if (!n.to_email) throw new Error("destinatário de e-mail ausente");
  if (!hasTemplate(n.template)) throw new Error(`template desconhecido: ${n.template}`);

  const { subject, html, text } = renderEmail(n.template, n.payload, n.locale);
  const provider = env.emailProvider();
  const from = `${env.emailFromName()} <${env.emailFrom()}>`;

  // Anexo opcional, declarado no payload por quem enfileirou.
  //
  // Vai anexado e não como link: um termo assinado é documento, e documento
  // que mora atrás de uma URL temporária deixa de existir no dia em que a URL
  // vence — normalmente o dia em que alguém precisou dele.
  const anexos = await carregarAnexo(n.payload);

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
        ...(anexos ? { attachments: anexos } : {}),
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
