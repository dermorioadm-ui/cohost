import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";

/**
 * A diarista toca no link do convite e entra.
 *
 * Duas etapas, ambas sem senha:
 *   GET-like  (action: "preview") -> mostra quem convidou, antes de pedir nada.
 *   POST      (action: "accept")  -> cria/reaproveita o usuário dela e o vínculo,
 *                                    devolvendo uma sessão pronta.
 *
 * A conta é criada com e-mail sintético quando ela não tem e-mail — o telefone
 * é a identidade real. Ela nunca digita senha; o acesso é a posse do celular.
 */

interface Body {
  token?: string;
  action?: "preview" | "accept";
  phone?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const { token, action = "accept", phone } = await readJson<Body>(req);
  if (!token || token.length < 16) throw errors.invalid("Link de convite inválido");

  const db = admin();
  const { data: hashRow } = await db.rpc("hash_token", { _token: token });
  const tokenHash = hashRow as unknown as string;

  const { data: invite } = await db
    .from("cleaner_invites")
    .select("id, owner_id, cleaner_name, cleaner_email, cleaner_phone_e164, status, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!invite) throw errors.notFound("Convite não encontrado. Peça um link novo.");

  if (invite.status === "revoked") throw errors.forbidden("Este convite foi cancelado.");
  if (new Date(invite.expires_at) < new Date()) {
    await db.from("cleaner_invites").update({ status: "expired" }).eq("id", invite.id);
    throw errors.forbidden("Este convite expirou. Peça um link novo ao cliente.");
  }

  const { data: owner } = await db
    .from("profiles")
    .select("full_name, email")
    .eq("user_id", invite.owner_id)
    .maybeSingle();

  const ownerName = owner?.full_name ?? "Cliente";

  const { count: propertyCount } = await db
    .from("properties")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", invite.owner_id)
    .is("archived_at", null);

  if (action === "preview") {
    return json({
      ok: true,
      cleaner_name: invite.cleaner_name,
      owner_name: ownerName,
      properties: propertyCount ?? 0,
      already_accepted: invite.status === "accepted",
      needs_phone: Boolean(invite.cleaner_phone_e164),
    });
  }

  // ---- aceite --------------------------------------------------------------

  // O link sozinho não basta: ele viaja por WhatsApp, é encaminhado e fica no
  // histórico de quem já leu a conversa. Confirmar o telefone que o dono
  // cadastrou prende o acesso a quem ele quis dar — e é a única coisa que ela
  // digita, porque senha ela não tem e não vai ter.
  if (invite.cleaner_phone_e164) {
    if (!phone) throw errors.invalid("Digite seu telefone para entrar.");

    const { data: typed } = await db.rpc("normalize_phone", { _phone: phone });
    if ((typed as unknown as string | null) !== invite.cleaner_phone_e164) {
      throw errors.forbidden(
        "Esse telefone não é o que foi cadastrado. Confira com quem te convidou.",
      );
    }
  }

  const syntheticEmail =
    invite.cleaner_email ??
    `diarista.${invite.cleaner_phone_e164 ?? invite.id.slice(0, 8)}@cleaner.hospedepay.local`;

  // Já existe conta com esse contato? Reaproveita — a diarista que atende
  // vários donos usa UM login para todos.
  const { data: existingProfile } = await db
    .from("profiles")
    .select("user_id")
    .or(
      [
        invite.cleaner_email ? `email.eq.${invite.cleaner_email}` : null,
        invite.cleaner_phone_e164 ? `phone_e164.eq.${invite.cleaner_phone_e164}` : null,
      ].filter(Boolean).join(","),
    )
    .maybeSingle();

  let cleanerId: string;

  if (existingProfile) {
    cleanerId = existingProfile.user_id;
  } else {
    const { data: created, error } = await db.auth.admin.createUser({
      email: syntheticEmail,
      email_confirm: true,
      phone: invite.cleaner_phone_e164 ?? undefined,
      user_metadata: {
        full_name: invite.cleaner_name,
        whatsapp: invite.cleaner_phone_e164,
        account_type: "cleaner",
      },
    });
    if (error || !created.user) {
      console.error("Falha ao criar conta da diarista:", error?.message);
      throw errors.upstream("Não foi possível criar seu acesso. Tente de novo.");
    }
    cleanerId = created.user.id;
  }

  const { error: acceptError } = await db.rpc("accept_cleaner_invite", {
    _token: token,
    _cleaner_id: cleanerId,
  });

  if (acceptError) {
    const map: Record<string, string> = {
      convite_invalido: "Convite não encontrado.",
      convite_ja_usado: "Este convite já foi usado.",
      convite_expirado: "Este convite expirou. Peça um link novo.",
    };
    const key = Object.keys(map).find((k) => acceptError.message.includes(k));
    throw errors.forbidden(key ? map[key] : "Não foi possível aceitar o convite.");
  }

  // Sessão sem senha: link mágico trocado por tokens de acesso.
  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: syntheticEmail,
  });

  if (linkError || !link.properties?.hashed_token) {
    console.error("Falha ao gerar sessão:", linkError?.message);
    throw errors.upstream("Vínculo criado, mas a sessão falhou. Recarregue a página.");
  }

  const { data: verified, error: verifyError } = await db.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });

  if (verifyError || !verified.session) {
    console.error("Falha ao validar sessão:", verifyError?.message);
    throw errors.upstream("Vínculo criado, mas a sessão falhou. Recarregue a página.");
  }

  return json({
    ok: true,
    owner_name: ownerName,
    cleaner_name: invite.cleaner_name,
    session: {
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
      expires_in: verified.session.expires_in,
    },
  });
});
