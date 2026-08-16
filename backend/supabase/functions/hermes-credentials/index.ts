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
  action?: "status" | "save" | "enable" | "revoke" | "challenge-submit" | "resend-request" | "key-create" | "key-revoke";
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
  /** Código de verificação que o Airbnb mandou no SMS/e-mail do dono. */
  code?: string;
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

    // Estado vem de `credentials`, incluindo o desafio pendente (o Airbnb
    // pediu código e o agente está parado esperando o dono digitar).
    const { data: cred } = await db.rpc("hermes_credential_state", { p_owner: user.id });

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
      credential: cred ?? null,
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

    // A credencial é da CONTA e vive em `credentials` — a MESMA tabela que o
    // worker lê. Antes o painel gravava num cofre e o agente lia de outro:
    // senha salva aqui era invisível para o worker.
    const { data: chave, error } = await db.rpc("save_credential", {
      p_owner: user.id,
      p_login: login.trim(),
      p_password: password,
      p_totp: body.totp_secret?.trim() || null,
    });

    if (error) {
      console.error("Falha ao gravar credencial:", error.message);
      throw errors.upstream("Não foi possível salvar. Tente de novo.");
    }

    if (property_id) {
      await db.from("properties").update({ hermes_enabled: true })
        .eq("id", property_id).eq("owner_id", user.id);
    }

    // A chave do agente aparece UMA vez. É ela que vai no .env do worker.
    return json({ ok: true, agent_key: chave });
  }

  // ---- código de verificação que o Airbnb pediu ------------------------------
  // O agente está com o navegador parado esperando isto. Segundos importam:
  // código do Airbnb morre em poucos minutos.
  if (action === "challenge-submit") {
    if (!body.code?.trim()) throw errors.invalid("Digite o código.");

    const { data, error } = await db.rpc("hermes_submit_challenge_code", {
      p_owner: user.id,
      p_code: body.code.trim(),
    });
    if (error) throw errors.upstream("Não foi possível enviar o código.");

    const recado: Record<string, string> = {
      sem_credencial: "Nenhuma conta cadastrada.",
      nao_esta_esperando: "O agente não está esperando código agora.",
      expirado: "O código expirou. Ative de novo para receber outro.",
      codigo_invalido: "Código muito curto. Confira e digite de novo.",
    };
    if (data !== "ok") throw errors.invalid(recado[data as string] ?? "Código recusado.");

    return json({ ok: true });
  }

  // ---- "não recebi o código" -------------------------------------------------
  // O painel só PEDE. Quem clica em reenviar é o worker, que tem a sessão do
  // Airbnb aberta — a nossa página não tem como falar com o Airbnb.
  if (action === "resend-request") {
    const { data, error } = await db.rpc("hermes_request_resend", { p_owner: user.id });
    if (error) throw errors.upstream("Não foi possível pedir o reenvio.");

    const recado: Record<string, string> = {
      sem_credencial: "Nenhuma conta cadastrada.",
      nao_esta_esperando: "O agente não está esperando código agora.",
      expirado: "O código expirou. Ative de novo para receber outro.",
      muito_cedo: "Espere alguns segundos antes de pedir de novo.",
      limite: "Já foram 3 reenvios. Desligue e ative de novo para recomeçar.",
    };
    if (data !== "ok") throw errors.invalid(recado[data as string] ?? "Não foi possível reenviar.");

    return json({ ok: true });
  }

  // ---- ligar um imóvel numa conta já conectada -------------------------------
  // Sem isto, o dono de cinco apartamentos redigitaria a senha cinco vezes —
  // o próprio problema que a credencial por conta existe para resolver.
  if (action === "enable") {
    if (!body.property_id) throw errors.invalid("Escolha o imóvel.");

    const { data: cred } = await db
      .from("credentials")
      .select("id")
      .eq("owner_id", user.id)
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
        await db.from("credentials").delete().eq("owner_id", user.id);
        return json({ ok: true, credencial_apagada: true });
      }

      return json({ ok: true, credencial_apagada: false });
    }

    // O DELETE dispara o gatilho que apaga os segredos do Vault e desliga
    // hermes_enabled em todos os imóveis do dono.
    const { error } = await db.from("credentials").delete().eq("owner_id", user.id);

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
