import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";

/**
 * O dono liga (ou desliga) o Atendimento Automático 24h de um imóvel.
 *
 * Esta function existe por um motivo só: a senha do canal precisa ir para o
 * Vault, e escrever no Vault exige service_role. Não existe policy de INSERT
 * em `hermes_credentials` — o caminho do navegador direto ao banco está
 * fechado de propósito, para não haver dois lugares gravando credencial.
 *
 * O que ela NUNCA faz: devolver a senha. Não há ação de leitura aqui. Depois
 * de gravada, a senha some para todo mundo que não seja o agente — inclusive
 * para o próprio dono, que se esquecer terá de digitar outra. Isso é escolha,
 * não limitação: um endpoint que devolve senha vira, no primeiro bug de
 * autorização, um endpoint que devolve a senha dos outros.
 */

interface Body {
  action?: "status" | "save" | "revoke" | "key-create" | "key-revoke";
  property_id?: string;
  platform?: "airbnb" | "booking";
  login?: string;
  password?: string;
  totp_secret?: string;
  accept_term?: boolean;
  key_id?: string;
  key_name?: string;
}

/** IP real do cliente atrás do proxy do Supabase. */
function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() ?? "";
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const body = await readJson<Body>(req);
  const action = body.action ?? "status";
  const db = admin();

  // ---- estado ---------------------------------------------------------------
  if (action === "status") {
    const { data: props } = await db
      .from("properties")
      .select("id, name, airbnb_listing_id, hermes_enabled")
      .eq("owner_id", user.id)
      .is("archived_at", null)
      .order("created_at");

    const ids = (props ?? []).map((p) => p.id);

    const { data: creds } = ids.length
      ? await db
          .from("hermes_credentials")
          .select(
            "property_id, platform, login, status, last_verified_at, last_error, last_access_at, access_count, term_accepted_at",
          )
          .in("property_id", ids)
      : { data: [] };

    const { data: term } = await db
      .from("term_versions")
      .select("id, title, body, version")
      .eq("kind", "hermes_credencial")
      .eq("locale", "pt")
      .eq("active", true)
      .maybeSingle();

    const { data: keys } = await db
      .from("agent_api_keys")
      .select("id, name, key_prefix, created_at, last_used_at")
      .eq("owner_id", user.id)
      .is("revoked_at", null)
      .order("created_at");

    return json({
      ok: true,
      properties: props ?? [],
      credentials: creds ?? [],
      term,
      keys: keys ?? [],
    });
  }

  // ---- gravar ---------------------------------------------------------------
  if (action === "save") {
    const { property_id, login, password, platform = "airbnb" } = body;

    if (!property_id) throw errors.invalid("Escolha o imóvel.");
    if (!login?.trim()) throw errors.invalid("Informe o e-mail ou telefone da conta.");
    if (!password || password.length < 6) throw errors.invalid("Informe a senha da conta.");

    // O aceite é condição de existência da credencial, não um detalhe de tela.
    // Se o frontend um dia esquecer a caixa, o backend recusa — o que se prova
    // em disputa é o registro, e ele nasce aqui.
    if (body.accept_term !== true) {
      throw errors.forbidden("É preciso aceitar o termo de responsabilidade.");
    }

    const { data: prop } = await db
      .from("properties")
      .select("id, airbnb_listing_id")
      .eq("id", property_id)
      .eq("owner_id", user.id)
      .is("archived_at", null)
      .maybeSingle();

    if (!prop) throw errors.notFound("Imóvel não encontrado.");

    // Sem o número do anúncio o agente recebe uma conversa e não sabe de qual
    // apartamento ela é. Barrar aqui evita uma credencial que nunca seria usada.
    if (platform === "airbnb" && !prop.airbnb_listing_id) {
      throw errors.invalid(
        "Conecte primeiro o calendário do Airbnb neste imóvel — é dele que sai o número do anúncio.",
      );
    }

    const { error } = await db.rpc("hermes_save_credentials", {
      _property_id: property_id,
      _owner_id: user.id,
      _platform: platform,
      _login: login.trim(),
      _password: password,
      _otp_secret: body.totp_secret?.trim() ?? "",
      _ip: clientIp(req),
      _user_agent: req.headers.get("user-agent") ?? "",
    });

    if (error) {
      const map: Record<string, string> = {
        imovel_nao_e_seu: "Imóvel não encontrado.",
        termo_indisponivel: "O termo não está disponível. Tente de novo em instantes.",
      };
      const key = Object.keys(map).find((k) => error.message.includes(k));
      if (key) throw errors.forbidden(map[key]);
      console.error("Falha ao gravar credencial:", error.message);
      throw errors.upstream("Não foi possível salvar. Tente de novo.");
    }

    return json({ ok: true });
  }

  // ---- revogar --------------------------------------------------------------
  if (action === "revoke") {
    if (!body.property_id) throw errors.invalid("Escolha o imóvel.");

    const { data: prop } = await db
      .from("properties")
      .select("id")
      .eq("id", body.property_id)
      .eq("owner_id", user.id)
      .maybeSingle();

    if (!prop) throw errors.notFound("Imóvel não encontrado.");

    // O DELETE dispara o gatilho que apaga o segredo do Vault e desliga
    // hermes_enabled. Revogar de verdade é apagar, não marcar uma coluna.
    const { error } = await db
      .from("hermes_credentials")
      .delete()
      .eq("property_id", body.property_id);

    if (error) {
      console.error("Falha ao revogar:", error.message);
      throw errors.upstream("Não foi possível desligar. Tente de novo.");
    }

    return json({ ok: true });
  }

  // ---- chave do agente ------------------------------------------------------
  if (action === "key-create") {
    const { data: raw } = await db.rpc("generate_token", { _bytes: 32 });
    const key = `hp_${raw as unknown as string}`;

    const { data: hash } = await db.rpc("hash_token", { _token: key });

    const { error } = await db.from("agent_api_keys").insert({
      owner_id: user.id,
      name: body.key_name?.trim() || "VPS do agente",
      key_hash: hash as unknown as string,
      key_prefix: key.slice(0, 11),
    });

    if (error) {
      console.error("Falha ao criar chave:", error.message);
      throw errors.upstream("Não foi possível gerar a chave.");
    }

    // Única vez que a chave inteira existe fora do hash. Quem perder, gera outra.
    return json({ ok: true, key });
  }

  if (action === "key-revoke") {
    if (!body.key_id) throw errors.invalid("Chave não informada.");

    const { error } = await db
      .from("agent_api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", body.key_id)
      .eq("owner_id", user.id);

    if (error) throw errors.upstream("Não foi possível revogar a chave.");
    return json({ ok: true });
  }

  throw errors.invalid("Ação desconhecida");
});
