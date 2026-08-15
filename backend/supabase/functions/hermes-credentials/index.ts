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
  action?: "status" | "save" | "enable" | "revoke" | "key-create" | "key-revoke";
  property_id?: string;
  platform?: "airbnb" | "booking";
  login?: string;
  password?: string;
  totp_secret?: string;
  accept_term?: boolean;
  key_id?: string;
  key_name?: string;
  /** "imovel" desliga um apartamento; "conta" apaga a credencial inteira. */
  scope?: "imovel" | "conta";
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

    // Uma credencial por conta e por canal — não mais uma por imóvel.
    const { data: creds } = await db
      .from("hermes_credentials")
      .select(
        "platform, login, status, last_verified_at, last_error, last_access_at, access_count, term_accepted_at",
      )
      .eq("owner_id", user.id);

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

    // A credencial é da CONTA (uma conta do Airbnb hospeda todos os anúncios
    // dela). `_enable_property_id` não é chave: é só qual imóvel ligar agora.
    const { error } = await db.rpc("hermes_save_credentials", {
      _owner_id: user.id,
      _platform: platform,
      _login: login.trim(),
      _password: password,
      _otp_secret: body.totp_secret?.trim() ?? "",
      _ip: clientIp(req),
      _user_agent: req.headers.get("user-agent") ?? "",
      _enable_property_id: property_id,
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

  // ---- ligar um imóvel numa conta já conectada -------------------------------
  // Sem isto, o dono de cinco apartamentos redigitaria a senha cinco vezes —
  // o próprio problema que a credencial por conta existe para resolver.
  if (action === "enable") {
    if (!body.property_id) throw errors.invalid("Escolha o imóvel.");

    const { data: cred } = await db
      .from("hermes_credentials")
      .select("id")
      .eq("owner_id", user.id)
      .eq("platform", "airbnb")
      .maybeSingle();

    if (!cred) throw errors.invalid("Nenhuma conta conectada. Informe login e senha primeiro.");

    const { data: prop } = await db
      .from("properties")
      .select("id, airbnb_listing_id")
      .eq("id", body.property_id)
      .eq("owner_id", user.id)
      .is("archived_at", null)
      .maybeSingle();

    if (!prop) throw errors.notFound("Imóvel não encontrado.");
    if (!prop.airbnb_listing_id) {
      throw errors.invalid(
        "Conecte primeiro o calendário do Airbnb neste imóvel — é dele que sai o número do anúncio.",
      );
    }

    const { error } = await db
      .from("properties")
      .update({ hermes_enabled: true })
      .eq("id", body.property_id)
      .eq("owner_id", user.id);

    if (error) throw errors.upstream("Não foi possível ligar. Tente de novo.");
    return json({ ok: true });
  }

  // ---- revogar --------------------------------------------------------------
  // Duas intenções diferentes, e confundi-las custa caro nos dois sentidos:
  // desligar UM apartamento de cinco não pode apagar a senha da conta, e
  // encerrar a conta não pode deixar senha guardada.
  if (action === "revoke") {
    const scope = body.scope ?? "imovel";

    if (scope === "imovel") {
      if (!body.property_id) throw errors.invalid("Escolha o imóvel.");

      const { error } = await db
        .from("properties")
        .update({ hermes_enabled: false })
        .eq("id", body.property_id)
        .eq("owner_id", user.id);

      if (error) throw errors.upstream("Não foi possível desligar. Tente de novo.");

      // Nenhum imóvel ligado significa senha guardada sem finalidade — e o
      // termo promete que revogar apaga a credencial. Apaga.
      const { count } = await db
        .from("properties")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .is("archived_at", null)
        .eq("hermes_enabled", true);

      if ((count ?? 0) === 0) {
        await db.from("hermes_credentials").delete().eq("owner_id", user.id);
        return json({ ok: true, credencial_apagada: true });
      }

      return json({ ok: true, credencial_apagada: false });
    }

    // O DELETE dispara o gatilho que apaga os segredos do Vault e desliga
    // hermes_enabled em todos os imóveis do dono.
    const { error } = await db.from("hermes_credentials").delete().eq("owner_id", user.id);

    if (error) {
      console.error("Falha ao revogar:", error.message);
      throw errors.upstream("Não foi possível desligar. Tente de novo.");
    }

    return json({ ok: true, credencial_apagada: true });
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
