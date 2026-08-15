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
 * Seis ações, separadas por frequência e por risco:
 *
 *   credentials — uma vez por sessão de login. Devolve a senha da CONTA e a
 *                 lista de anúncios ligados; cada leitura vai para audit_log.
 *   next-jobs   — o laço do worker. Reserva jobs da fila (nada é empurrado
 *                 para a máquina do dono: ela só faz saída).
 *   finish-job  — confirma ou devolve o job à fila.
 *   context     — a cada mensagem. Prompt do imóvel e reserva atual, sem senha.
 *   log         — o agente conta o que respondeu, para aparecer no painel.
 *   failure     — o login quebrou; o dono precisa saber hoje, não no dia em
 *                 que um hóspede reclamar.
 *
 * `listing_id` é exigido só onde identifica um imóvel. Credencial e fila são
 * da conta inteira, e a chave já diz de quem é.
 */

interface Body {
  action?: "context" | "credentials" | "log" | "failure" | "next-jobs" | "finish-job";
  listing_id?: string;
  thread_ref?: string;
  direction?: "hospede" | "agente";
  guest_name?: string;
  content?: string;
  error?: string;
  platform?: "airbnb" | "booking";
  limit?: number;
  job_id?: number;
  ok?: boolean;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const key = req.headers.get("x-agent-key") ?? "";
  const db = admin();

  const { data: ownerId } = await db.rpc("verify_agent_key", { _key: key });
  if (!ownerId) throw errors.unauthorized("Chave de agente inválida ou revogada");

  const body = await readJson<Body>(req);
  const action = body.action ?? "context";

  // Ações de conta não pedem imóvel; as de imóvel pedem.
  const PRECISA_LISTING = new Set(["context", "log", "failure"]);
  const listing = body.listing_id?.trim() ?? "";
  if (PRECISA_LISTING.has(action) && !listing) {
    throw errors.invalid("listing_id é obrigatório");
  }

  switch (action) {
    // ---- laço do worker ----------------------------------------------------
    case "next-jobs": {
      const { data, error } = await db.rpc("hermes_agent_next_jobs", {
        _owner_id: ownerId,
        _limit: body.limit ?? 10,
      });
      if (error) {
        console.error("Falha ao puxar jobs:", error.message);
        throw errors.upstream("Não foi possível puxar a fila");
      }
      return json({ ok: true, jobs: data ?? [] });
    }

    case "finish-job": {
      if (typeof body.job_id !== "number") throw errors.invalid("job_id é obrigatório");

      const { data, error } = await db.rpc("hermes_agent_finish_job", {
        _owner_id: ownerId,
        _job_id: body.job_id,
        _ok: body.ok !== false,
        _error: body.error?.slice(0, 500) ?? null,
      });
      if (error) {
        console.error("Falha ao encerrar job:", error.message);
        throw errors.upstream("Não foi possível encerrar o job");
      }
      // `false` aqui é job de outro dono ou id inexistente — não é erro de
      // servidor, e o worker precisa distinguir para não reprocessar em laço.
      if (!data) throw errors.notFound("Job não encontrado");
      return json({ ok: true });
    }

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
        _platform: body.platform ?? "airbnb",
      });
      if (!data) throw errors.notFound("Sem credencial ativa ou nenhum imóvel ligado");
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
