import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Convite da diarista — o ponto que mais derruba ativação no produto.
 *
 * No backend antigo o convite ia por e-mail e ela precisava abrir a caixa,
 * criar senha e voltar. Diarista não usa e-mail. Aqui o convite é um TOKEN
 * opaco embutido num link; ela toca e entra, sem senha e sem e-mail.
 *
 * O envio tem dois modos:
 *   - WHATSAPP_ENABLED=false (padrão): devolvemos um link wa.me pronto, com a
 *     mensagem escrita. O DONO aperta enviar — e o convite chega de um número
 *     que ela conhece, o que converte melhor do que um número comercial
 *     desconhecido pedindo para clicar num link.
 *   - WHATSAPP_ENABLED=true: enfileira o envio pela Cloud API da Meta.
 */

interface Body {
  cleaner_name?: string;
  cleaner_phone?: string;
  cleaner_email?: string;
  property_id?: string; // opcional: já atribui o imóvel quando ela aceitar
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const body = await readJson<Body>(req);
  const db = admin();

  const name = (body.cleaner_name ?? "").trim();
  if (name.length < 2) throw errors.invalid("Informe o nome da diarista");

  const phone = (body.cleaner_phone ?? "").replace(/\D/g, "");
  const email = (body.cleaner_email ?? "").trim().toLowerCase();

  if (!phone && !email) {
    throw errors.invalid("Informe ao menos o WhatsApp ou o e-mail da diarista");
  }
  if (phone && phone.length < 10) {
    throw errors.invalid("Telefone inválido — inclua o DDD");
  }

  const { data: normalized } = await db.rpc("normalize_phone", {
    _phone: body.cleaner_phone ?? null,
  });
  const phoneE164 = normalized as unknown as string | null;

  // Se já existe convite pendente para o mesmo contato, reaproveita em vez de
  // criar um segundo link (senão o primeiro que ela clicar pode ser o velho).
  const { data: existing } = await db
    .from("cleaner_invites")
    .select("id, send_count")
    .eq("owner_id", user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .or(
      [
        phoneE164 ? `cleaner_phone_e164.eq.${phoneE164}` : null,
        email ? `cleaner_email.eq.${email}` : null,
      ].filter(Boolean).join(","),
    )
    .maybeSingle();

  // O imóvel fica gravado no convite; quem aplica é accept_cleaner_invite,
  // no aceite dela — antes disso não existe usuário para pôr em cleaner_id.
  if (body.property_id) {
    const { data: prop } = await db
      .from("properties")
      .select("id")
      .eq("id", body.property_id)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (!prop) throw errors.notFound("Imóvel não encontrado");
  }

  const { data: tokenRow } = await db.rpc("generate_token", { _bytes: 24 });
  const token = tokenRow as unknown as string;
  const { data: hashRow } = await db.rpc("hash_token", { _token: token });

  const ttlDays = Number(
    (await db.from("app_settings").select("value").eq("key", "cleaner_invite_ttl_days")
      .maybeSingle()).data?.value ?? 30,
  );

  let inviteId: string;

  if (existing) {
    // Rotaciona o token: o link antigo deixa de valer, e o que o dono acabou
    // de pedir é o único válido.
    const { error } = await db
      .from("cleaner_invites")
      .update({
        token_hash: hashRow as unknown as string,
        cleaner_name: name,
        cleaner_phone_e164: phoneE164,
        cleaner_email: email || null,
        expires_at: new Date(Date.now() + ttlDays * 86400_000).toISOString(),
        last_sent_at: new Date().toISOString(),
        send_count: (existing.send_count ?? 0) + 1,
        ...(body.property_id ? { property_id: body.property_id } : {}),
      })
      .eq("id", existing.id);
    if (error) throw errors.upstream(`Falha ao atualizar convite: ${error.message}`);
    inviteId = existing.id;
  } else {
    const { data: created, error } = await db
      .from("cleaner_invites")
      .insert({
        owner_id: user.id,
        cleaner_name: name,
        cleaner_phone_e164: phoneE164,
        cleaner_email: email || null,
        token_hash: hashRow as unknown as string,
        expires_at: new Date(Date.now() + ttlDays * 86400_000).toISOString(),
        last_sent_at: new Date().toISOString(),
        send_count: 1,
        property_id: body.property_id ?? null,
      })
      .select("id")
      .single();
    if (error || !created) throw errors.upstream(`Falha ao criar convite: ${error?.message}`);
    inviteId = created.id;
  }

  const { data: profile } = await db
    .from("profiles")
    .select("full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  const ownerName = profile?.full_name?.split(" ")[0] ?? "seu cliente";
  const acceptUrl = `${env.appBaseUrl()}/d/${token}`;

  const waMessage =
    `Oi, ${name.split(" ")[0]}! Aqui é ${ownerName}. ` +
    `Coloquei a agenda dos apartamentos num app pra facilitar — ` +
    `você vê os horários de saída direto no celular, sem eu precisar te avisar toda vez. ` +
    `É só tocar aqui pra entrar (não precisa criar senha): ${acceptUrl}`;

  const waLink = phoneE164
    ? `https://wa.me/${phoneE164}?text=${encodeURIComponent(waMessage)}`
    : null;

  // Modo automático (quando a verificação da Meta estiver liberada).
  if (env.whatsappEnabled() && phoneE164) {
    await db.rpc("enqueue_notification", {
      _channel: "whatsapp",
      _template: "cleaner-invite",
      _payload: { cleaner_name: name, owner_name: ownerName, accept_url: acceptUrl },
      _to_phone: phoneE164,
      _idempotency_key: `cleaner-invite:${inviteId}:${Date.now()}`,
      _entity: "cleaner_invites",
      _entity_id: inviteId,
    });
  }

  // E-mail continua saindo como plano B quando o dono tem o endereço.
  if (email) {
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "cleaner-invite",
      _payload: { cleaner_name: name, owner_name: ownerName, accept_url: acceptUrl },
      _to_email: email,
      _idempotency_key: `cleaner-invite-email:${inviteId}:${Date.now()}`,
      _entity: "cleaner_invites",
      _entity_id: inviteId,
    });
  }

  return json({
    ok: true,
    invite_id: inviteId,
    accept_url: acceptUrl,
    // O frontend abre este link; o dono só aperta enviar.
    whatsapp_link: waLink,
    whatsapp_message: waMessage,
    auto_sent: env.whatsappEnabled() && Boolean(phoneE164),
    expires_in_days: ttlDays,
  });
});
