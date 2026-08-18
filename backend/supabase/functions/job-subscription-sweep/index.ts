import { handler, json } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Varredura diária de assinaturas.
 *
 *  1. Trial vencido -> status 'expired' (para a sincronização e o atendimento).
 *  2. Trial terminando em 3 dias e em 1 dia -> e-mail de aviso, com os números
 *     do que o sistema já fez por ele. É a hora em que a conversão acontece.
 *  3. Calendário quebrado há 3+ tentativas -> avisa o dono ANTES dele descobrir
 *     sozinho que a diarista não recebeu a agenda.
 *
 * O item 3 é o que mais evita cancelamento silencioso: uma falha de feed que
 * ninguém vê vira "o app parou de funcionar" no mês seguinte.
 */

export default handler(async (req) => {
  await requireCron(req);

  const db = admin();
  const result = { broken_feeds: 0 };

  // Não existe teste grátis: a assinatura nasce cobrando, e quem deixa de
  // pagar é rebaixado pelo webhook do Stripe (invoice.payment_failed ->
  // past_due, customer.subscription.deleted -> expired). Não há prazo de
  // graça para esta varredura vigiar, então ela cuida só dos calendários.
  // ---- 3. calendários quebrados -------------------------------------------
  const { data: broken } = await db
    .from("property_ical_sources")
    .select("id, provider, property_id, consecutive_fails, properties!inner(name, owner_id)")
    .eq("active", true)
    .gte("consecutive_fails", 3);

  for (const src of broken ?? []) {
    const prop = src.properties as unknown as { name: string; owner_id: string };
    const { data: owner } = await db
      .from("profiles").select("email, locale").eq("user_id", prop.owner_id).maybeSingle();
    if (!owner?.email) continue;

    // Uma vez por dia por fonte, não a cada varredura.
    const day = new Date().toISOString().slice(0, 10);
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "ical-broken",
      _payload: {
        property_name: prop.name,
        provider: src.provider,
        fix_url: `${env.appBaseUrl()}/imoveis/${src.property_id}`,
      },
      _to_email: owner.email,
      _to_user_id: prop.owner_id,
      _idempotency_key: `ical-broken:${src.id}:${day}`,
      _locale: owner.locale ?? "pt",
      _entity: "property_ical_sources",
      _entity_id: src.id,
    });
    result.broken_feeds++;
  }

  console.log("subscription-sweep:", JSON.stringify(result));
  return json({ ok: true, ...result });
});
