import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Link permanente do painel da diarista.
 *
 * O convite (`cleaner-invite`) já servia de porta: `accept_cleaner_invite` é
 * idempotente para quem já aceitou, então o mesmo `/d/:token` continua abrindo
 * a agenda dela depois do primeiro acesso — e pedindo só o telefone, nunca
 * senha. O que faltava era o dono conseguir VER esse link de novo. O token não
 * fica em claro no banco (guardamos só o hash), então "ver de novo" não existe:
 * o que existe é emitir outro, invalidando o anterior.
 *
 * Por isso este endpoint rotaciona o token do convite JÁ ACEITO em vez de criar
 * um convite novo. Criar um novo deixaria uma linha `pending` para uma diarista
 * que já está vinculada — e o painel do dono passaria a avisar "convite ainda
 * não aceito" sobre quem já trabalha para ele.
 *
 * O telefone continua sendo o segundo fator: o link sozinho não entra, porque
 * `cleaner-accept` exige o número que o dono cadastrou.
 */

interface Body {
  cleaner_id?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const { cleaner_id } = await readJson<Body>(req);
  if (!cleaner_id) throw errors.invalid("Informe a diarista");

  const db = admin();

  // Só quem já está vinculado a ESTE dono ganha link — o vínculo é a permissão.
  const { data: conn } = await db
    .from("connections")
    .select("id, invite_id")
    .eq("owner_id", user.id)
    .eq("cleaner_id", cleaner_id)
    .eq("active", true)
    .maybeSingle();

  if (!conn) throw errors.notFound("Essa diarista não está vinculada a você");

  const { data: profile } = await db
    .from("profiles")
    .select("full_name, phone_e164, email")
    .eq("user_id", cleaner_id)
    .maybeSingle();

  const cleanerName = profile?.full_name ?? "Diarista";

  const { data: tokenRow } = await db.rpc("generate_token", { _bytes: 24 });
  const token = tokenRow as unknown as string;
  const { data: hashRow } = await db.rpc("hash_token", { _token: token });
  const tokenHash = hashRow as unknown as string;

  // O link é permanente para ela, então a validade é longa: um convite que
  // vence sozinho tira do ar a única porta de entrada de quem já trabalha.
  const expiresAt = new Date(Date.now() + 365 * 86400_000).toISOString();

  // O convite que originou o vínculo é o alvo natural da rotação. Se ele sumiu
  // (`ON DELETE SET NULL`), procuramos qualquer convite deste dono aceito por
  // ela; se nem isso existir, criamos a linha já no estado `accepted`.
  const { data: invite } = conn.invite_id
    ? await db.from("cleaner_invites").select("id").eq("id", conn.invite_id).maybeSingle()
    : await db
      .from("cleaner_invites")
      .select("id")
      .eq("owner_id", user.id)
      .eq("accepted_by", cleaner_id)
      .order("accepted_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  let inviteId: string;

  if (invite) {
    const { error } = await db
      .from("cleaner_invites")
      .update({
        token_hash: tokenHash,
        status: "accepted",
        accepted_by: cleaner_id,
        expires_at: expiresAt,
        last_sent_at: new Date().toISOString(),
      })
      .eq("id", invite.id);
    if (error) throw errors.upstream(`Falha ao gerar o link: ${error.message}`);
    inviteId = invite.id;
  } else {
    const { data: created, error } = await db
      .from("cleaner_invites")
      .insert({
        owner_id: user.id,
        cleaner_name: cleanerName,
        cleaner_phone_e164: profile?.phone_e164 ?? null,
        cleaner_email: profile?.email?.endsWith("@cleaner.hospedepay.local")
          ? null
          : profile?.email ?? null,
        token_hash: tokenHash,
        status: "accepted",
        accepted_by: cleaner_id,
        accepted_at: new Date().toISOString(),
        expires_at: expiresAt,
        last_sent_at: new Date().toISOString(),
        send_count: 1,
      })
      .select("id")
      .single();
    if (error || !created) throw errors.upstream(`Falha ao gerar o link: ${error?.message}`);
    inviteId = created.id;

    await db.from("connections").update({ invite_id: inviteId }).eq("id", conn.id);
  }

  const accessUrl = `${env.appBaseUrl()}/d/${token}`;
  const firstName = cleanerName.split(" ")[0];

  const message =
    `Oi, ${firstName}! Este é o link da sua agenda de limpeza. ` +
    `Salva ele no celular — é por aqui que você vê as saídas do dia e marca a ` +
    `limpeza como feita. Só precisa digitar o seu telefone, senha não tem: ${accessUrl}`;

  return json({
    ok: true,
    invite_id: inviteId,
    cleaner_name: cleanerName,
    access_url: accessUrl,
    whatsapp_link: profile?.phone_e164
      ? `https://wa.me/${profile.phone_e164}?text=${encodeURIComponent(message)}`
      : null,
    whatsapp_message: message,
    // O dono precisa saber que o anterior morreu — senão ele acha que existem
    // dois links válidos e manda o velho na próxima vez.
    replaced_previous: Boolean(invite),
  });
});
