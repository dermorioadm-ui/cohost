import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";

/**
 * A porta do agente que roda na VPS.
 *
 * Ele não tem sessão de usuário — entra com uma chave de máquina no header
 * `x-agent-key`, guardada só como hash. A chave identifica o DONO; o imóvel
 * vem do número do anúncio que chega junto com a conversa. Quer dizer: uma
 * chave vazada expõe os imóveis daquele dono, e de mais ninguém. É o motivo de
 * a chave ser por conta e não uma global do serviço.
 *
 * Quatro ações, separadas por frequência e por risco:
 *
 *   context     — a cada mensagem. Devolve o prompt do imóvel e a reserva
 *                 atual. Não devolve senha.
 *   credentials — uma vez por sessão de login. Devolve a senha, e cada leitura
 *                 fica carimbada em audit_log.
 *   log         — o agente conta o que respondeu, para aparecer no painel.
 *   failure     — o login quebrou; o dono precisa saber hoje, não no dia em
 *                 que um hóspede reclamar.
 */

interface Body {
  action?: "context" | "credentials" | "log" | "failure";
  listing_id?: string;
  thread_ref?: string;
  direction?: "hospede" | "agente";
  guest_name?: string;
  content?: string;
  error?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const key = req.headers.get("x-agent-key") ?? "";
  const db = admin();

  const { data: ownerId } = await db.rpc("verify_agent_key", { _key: key });
  if (!ownerId) throw errors.unauthorized("Chave de agente inválida ou revogada");

  const body = await readJson<Body>(req);
  const listing = body.listing_id?.trim();
  if (!listing) throw errors.invalid("listing_id é obrigatório");

  switch (body.action ?? "context") {
    case "context": {
      const { data } = await db.rpc("hermes_agent_context", {
        _owner_id: ownerId,
        _listing_id: listing,
      });
      // Nulo aqui quer dizer: não é imóvel deste dono, está arquivado, ou o
      // atendimento foi desligado. As três respostas são a mesma para quem
      // pergunta — distinguir seria contar sobre imóvel alheio.
      if (!data) throw errors.notFound("Imóvel não encontrado ou atendimento desligado");
      return json({ ok: true, context: data });
    }

    case "credentials": {
      const { data } = await db.rpc("hermes_agent_credentials", {
        _owner_id: ownerId,
        _listing_id: listing,
      });
      if (!data) throw errors.notFound("Sem credencial ativa para este imóvel");
      return json({ ok: true, credentials: data });
    }

    case "log": {
      if (!body.thread_ref?.trim()) throw errors.invalid("thread_ref é obrigatório");
      if (!body.content?.trim()) throw errors.invalid("content é obrigatório");
      if (body.direction !== "hospede" && body.direction !== "agente") {
        throw errors.invalid("direction deve ser 'hospede' ou 'agente'");
      }

      const { data, error } = await db.rpc("hermes_agent_log", {
        _owner_id: ownerId,
        _listing_id: listing,
        _thread_ref: body.thread_ref.trim(),
        _direction: body.direction,
        _guest_name: body.guest_name?.trim() ?? null,
        _content: body.content.trim(),
      });

      if (error) {
        if (error.message.includes("imovel_nao_encontrado")) {
          throw errors.notFound("Imóvel não encontrado");
        }
        console.error("Falha ao registrar mensagem:", error.message);
        throw errors.upstream("Não foi possível registrar a mensagem");
      }

      return json({ ok: true, id: data });
    }

    case "failure": {
      await db.rpc("hermes_agent_report_failure", {
        _owner_id: ownerId,
        _listing_id: listing,
        _error: body.error?.slice(0, 500) ?? "erro não informado",
      });
      return json({ ok: true });
    }

    default:
      throw errors.invalid("Ação desconhecida");
  }
});
