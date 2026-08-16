// =============================================================================
// airbnb-agent — endpoint único do agente (worker no PC do operador)
//
// Contrato externo (o worker depende disto, não mude sem avisar):
//   header  x-agent-key   identifica o DONO, não o imóvel
//   body    { action: 'credentials'|'next-jobs'|'finish-job'|'context'|'log'|'failure', ... }
//   erro    { error: { code, message } }
//
// Esta é a reescrita da versão da PR #1, que não rodava contra o schema real:
//
//   * next-jobs fazia SELECT sem RESERVAR o job. Duas leituras seguidas — ou
//     duas janelas do worker — devolviam o mesmo job, e o hóspede receberia a
//     mesma mensagem duas vezes. Agora passa por hermes_next_jobs, que reserva
//     com FOR UPDATE SKIP LOCKED e devolve à fila o que ficou preso.
//   * log inseria o listing_id (texto) na coluna property_id, que é uuid —
//     erro de tipo em toda chamada.
//   * finish-job marcava 'falhou' direto. Falha agora volta para 'pendente';
//     quem desiste é o contador de tentativas, senão o Airbnb fora do ar às 3h
//     queima um lembrete de check-out para sempre.
//
// Nada aqui escreve senha ou prompt em log. O prompt do imóvel carrega código
// de fechadura e senha de Wi-Fi: trate com o cuidado da senha da conta.
// =============================================================================

import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, appToday } from "../_shared/lib/db.ts";

const AGENT_KEY_HEADER = "x-agent-key";

interface Body {
  action?: string;
  listing_id?: string;
  job_id?: string;
  status?: string;
  error?: string;
  limit?: number;
  guest_message?: string;
  agent_reply?: string;
  challenge_type?: string;
  challenge_hint?: string;
  ttl?: number;
}

async function resolveOwner(req: Request): Promise<string> {
  const key = req.headers.get(AGENT_KEY_HEADER);
  if (!key) throw errors.unauthorized("Cabeçalho x-agent-key ausente");

  const { data, error } = await admin().rpc("resolve_owner_by_agent_key", { p_key: key });
  if (error) throw errors.upstream(`Falha ao resolver owner: ${error.message}`);
  if (!data) throw errors.forbidden("Chave de agente inválida");
  return data as string;
}

export default handler(async (req: Request) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const ownerId = await resolveOwner(req);
  const body = await readJson<Body>(req);
  const db = admin();

  switch (body.action) {
    // ---- 1. credenciais ------------------------------------------------------
    // Só em memória do worker. A função já registra a leitura em audit_log.
    case "credentials": {
      const { data, error } = await db.rpc("get_credentials_for_owner", { p_owner: ownerId });
      if (error) throw errors.upstream(`Falha ao ler credencial: ${error.message}`);
      if (!data) throw errors.notFound("Nenhuma credencial cadastrada para este dono");
      return json({ credentials: data });
    }

    // ---- 2. fila -------------------------------------------------------------
    case "next-jobs": {
      const { data, error } = await db.rpc("hermes_next_jobs", {
        p_owner: ownerId,
        p_limit: body.limit ?? 10,
      });
      if (error) throw errors.upstream(`Falha ao ler fila: ${error.message}`);
      return json({ jobs: data ?? [] });
    }

    case "finish-job": {
      if (!body.job_id) throw errors.invalid("job_id obrigatório");

      const { data, error } = await db.rpc("hermes_finish_job", {
        p_owner: ownerId,
        p_job: body.job_id,
        p_ok: body.status !== "falhou",
        p_error: body.error?.slice(0, 500) ?? null,
      });
      if (error) throw errors.upstream(`Falha ao concluir job: ${error.message}`);
      // `false` é job de outro dono ou id inexistente. O worker precisa
      // distinguir isso de erro de servidor para não reprocessar em laço.
      if (!data) throw errors.notFound("Job não encontrado");
      return json({ ok: true });
    }

    // ---- 3. contexto do imóvel ----------------------------------------------
    case "context": {
      const listingId = body.listing_id?.trim();
      if (!listingId) throw errors.invalid("listing_id obrigatório nesta ação");

      // O join com properties prende o anúncio ao DONO da chave. Sem ele, uma
      // chave válida leria o contexto de qualquer imóvel da base sabendo o
      // número do anúncio — que é público na URL do Airbnb.
      const { data: src, error: srcErr } = await db
        .from("property_ical_sources")
        .select("property_id, properties!inner(owner_id)")
        .eq("listing_id", listingId)
        .eq("properties.owner_id", ownerId)
        .limit(1);

      if (srcErr) throw errors.upstream(`Falha ao achar imóvel: ${srcErr.message}`);
      if (!src?.length) throw errors.notFound("listing_id não encontrado");

      const propertyId = src[0].property_id;

      const { data: prop, error: propErr } = await db
        .from("properties")
        .select("name, neighborhood, ai_prompt, ai_config, ai_enabled, checkin_time, checkout_time")
        .eq("id", propertyId)
        .single();
      if (propErr) throw errors.upstream(`Falha ao ler imóvel: ${propErr.message}`);

      const { data: res, error: resErr } = await db
        .from("reservations")
        .select("checkin_date, checkout_date, guest_label, status")
        .eq("property_id", propertyId)
        .eq("status", "confirmed")
        .gte("checkout_date", appToday())
        .order("checkin_date", { ascending: true })
        .limit(1);
      if (resErr) throw errors.upstream(`Falha ao ler reserva: ${resErr.message}`);

      return json({
        property: prop,
        current_reservation: res?.length ? res[0] : null,
      });
    }

    // ---- 4. registro da conversa --------------------------------------------
    case "log": {
      const { guest_message, agent_reply, listing_id } = body;
      if (!guest_message && !agent_reply) {
        throw errors.invalid("informe guest_message e/ou agent_reply");
      }

      // listing_id vai na coluna de texto. property_id é uuid e continua
      // preenchido quando dá para resolver — é ele que a tela Conversas usa.
      let propertyUuid: string | null = null;
      if (listing_id) {
        const { data: src } = await db
          .from("property_ical_sources")
          .select("property_id, properties!inner(owner_id)")
          .eq("listing_id", listing_id)
          .eq("properties.owner_id", ownerId)
          .limit(1);
        propertyUuid = src?.[0]?.property_id ?? null;
      }

      const { error } = await db.from("hermes_messages").insert({
        owner_id: ownerId,
        property_id: propertyUuid,
        listing_id: listing_id ?? null,
        guest_message: guest_message ?? null,
        agent_reply: agent_reply ?? null,
        channel: "airbnb",
      });
      if (error) throw errors.upstream(`Falha ao gravar log: ${error.message}`);
      return json({ ok: true });
    }

    // ---- 5. o Airbnb pediu código de verificação -----------------------------
    // O agente NÃO fecha o navegador aqui. O código que vai chegar só vale para
    // a sessão que o pediu; reiniciar o login invalida tudo e o dono terá
    // digitado um código morto.
    case "challenge": {
      const { data, error } = await db.rpc("hermes_report_challenge", {
        p_owner: ownerId,
        p_type: body.challenge_type ?? "outro",
        p_hint: body.challenge_hint ?? null,
        p_ttl: body.ttl ?? 600,
      });
      if (error) throw errors.upstream(`Falha ao pedir codigo: ${error.message}`);
      if (!data) throw errors.notFound("Nenhuma credencial cadastrada para este dono");
      return json({ ok: true, aguardando: true });
    }

    // O agente consulta em laço CURTO (3-5s) enquanto espera. Não são os 30s da
    // fila: código de verificação morre em minutos e a sessão fica presa até lá.
    case "challenge-code": {
      const { data, error } = await db.rpc("hermes_take_challenge_code", { p_owner: ownerId });
      if (error) throw errors.upstream(`Falha ao ler codigo: ${error.message}`);
      return json(data ?? { estado: "sem_credencial" });
    }

    // Entrou. Marca 'ativo' e limpa o desafio.
    case "session-ok": {
      const { error } = await db.rpc("hermes_mark_active", { p_owner: ownerId });
      if (error) throw errors.upstream(`Falha ao marcar ativo: ${error.message}`);
      return json({ ok: true, status: "ativo" });
    }

    // ---- 7. o login quebrou --------------------------------------------------
    case "failure": {
      const { error } = await db.rpc("hermes_mark_failure", {
        p_owner: ownerId,
        p_error: body.error?.slice(0, 500) ?? "erro não informado",
      });
      if (error) throw errors.upstream(`Falha ao marcar falha: ${error.message}`);
      // O worker deve PARAR aqui se caiu em verificação de identidade:
      // insistir transforma verificação em bloqueio da conta.
      return json({ ok: true, status: "falhou" });
    }

    default:
      throw errors.invalid(`Ação desconhecida: ${String(body.action)}`);
  }
});
