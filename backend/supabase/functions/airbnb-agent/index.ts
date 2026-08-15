// =============================================================================
// airbnb-agent — endpoint único do agente (worker no PC do operador)
// Contrato: header x-agent-key identifica o DONO (não o imóvel).
// Body: { action: 'credentials'|'next-jobs'|'finish-job'|'context'|'log'|'failure', ... }
// Erro estável: { error: { code, message } }
// =============================================================================

import { handler, json, readJson, errors } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";

const AGENT_KEY_HEADER = "x-agent-key";

async function resolveOwner(req: Request): Promise<string> {
  const key = req.headers.get(AGENT_KEY_HEADER);
  if (!key) throw errors.unauthorized("Cabeçalho x-agent-key ausente");

  const { data, error } = await admin().rpc("resolve_owner_by_agent_key", {
    p_key: key,
  });
  if (error) throw errors.upstream(`Falha ao resolver owner: ${error.message}`);
  if (!data) throw errors.forbidden("Chave de agente inválida");
  return data as string;
}

export default handler(async (req: Request) => {
  const ownerId = await resolveOwner(req);
  const body = await readJson(req);
  const action = body.action;

  switch (action) {
    // 1. credentials — retorna login/senha/totp em memória; nunca em log/disco.
    case "credentials": {
      const { data, error } = await admin().rpc("get_credentials_for_owner", {
        p_owner: ownerId,
      });
      if (error) throw errors.upstream(`Falha ao ler credencial: ${error.message}`);
      if (!data) throw errors.notFound("Nenhuma credencial cadastrada para este dono");
      // data já vem descriptografado pela function (e já logou em audit_log).
      return json({ credentials: data });
    }

    // 2. next-jobs — fila pull: jobs pendentes do dono.
    case "next-jobs": {
      const { data, error } = await admin()
        .from("hermes_jobs")
        .select("*")
        .eq("owner_id", ownerId)
        .eq("status", "pendente")
        .order("created_at", { ascending: true })
        .limit(10);
      if (error) throw errors.upstream(`Falha ao ler fila: ${error.message}`);
      return json({ jobs: data ?? [] });
    }

    // 3. finish-job — marca processado/falhou.
    case "finish-job": {
      const jobId = body.job_id;
      const status = body.status === "falhou" ? "falhou" : "processado";
      if (!jobId) throw errors.invalid("job_id obrigatório");
      const { error } = await admin()
        .from("hermes_jobs")
        .update({ status, processed_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("owner_id", ownerId);
      if (error) throw errors.upstream(`Falha ao concluir job: ${error.message}`);
      return json({ ok: true });
    }

    // 4. context — prompt do imóvel + reserva atual + horários. EXIGE listing_id.
    case "context": {
      const listingId = body.listing_id;
      if (!listingId) throw errors.invalid("listing_id obrigatório nesta ação");

      const { data: src, error: srcErr } = await admin()
        .from("property_ical_sources")
        .select("property_id")
        .eq("listing_id", listingId)
        .limit(1);
      if (srcErr) throw errors.upstream(`Falha ao achar imóvel: ${srcErr.message}`);
      if (!src || src.length === 0) throw errors.notFound("listing_id não encontrado");
      const propertyId = src[0].property_id;

      const { data: prop, error: propErr } = await admin()
        .from("properties")
        .select("name, ai_prompt, ai_config, ai_enabled, checkin_time, checkout_time")
        .eq("id", propertyId)
        .single();
      if (propErr) throw errors.upstream(`Falha ao ler imóvel: ${propErr.message}`);

      // Reserva atual (mais próxima, confirmada)
      const { data: res, error: resErr } = await admin()
        .from("reservations")
        .select("checkin_date, checkout_date, guest_label, status")
        .eq("property_id", propertyId)
        .eq("status", "confirmed")
        .gte("checkout_date", new Date().toISOString().slice(0, 10))
        .order("checkin_date", { ascending: true })
        .limit(1);
      if (resErr) throw errors.upstream(`Falha ao ler reserva: ${resErr.message}`);

      // ATENÇÃO: ai_prompt pode conter lock/wifi. Tratar com cuidado de senha:
      // não logar, não expor em logs de servidor (acima não logamos).
      return json({
        property: prop,
        current_reservation: res && res.length ? res[0] : null,
      });
    }

    // 5. log — grava guest_message + agent_reply em hermes_messages.
    case "log": {
      const { guest_message, agent_reply, listing_id } = body;
      if (!guest_message || !agent_reply) {
        throw errors.invalid("guest_message e agent_reply obrigatórios");
      }
      const { error } = await admin()
        .from("hermes_messages")
        .insert({
          owner_id: ownerId,
          property_id: listing_id ?? null,
          guest_message,
          agent_reply,
          channel: "airbnb",
        });
      if (error) throw errors.upstream(`Falha ao gravar log: ${error.message}`);
      return json({ ok: true });
    }

    // 6. failure — login quebrou ou caiu em verificação de identidade.
    case "failure": {
      const { error } = await admin()
        .from("credentials")
        .update({ status: "falhou", updated_at: new Date().toISOString() })
        .eq("owner_id", ownerId);
      if (error) throw errors.upstream(`Falha ao marcar falha: ${error.message}`);
      // O worker decide se para; aqui só registramos. E-mail ao dono é outro job.
      return json({ ok: true, status: "falhou" });
    }

    default:
      throw errors.invalid(`Ação desconhecida: ${String(action)}`);
  }
});
