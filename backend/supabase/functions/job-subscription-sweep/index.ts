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
  const now = new Date();
  const result = { expired: 0, reminders: 0, broken_feeds: 0 };

  // ---- 1. trials vencidos --------------------------------------------------
  const { data: expired } = await db
    .from("profiles")
    .update({ subscription_status: "expired" })
    .eq("subscription_status", "trialing")
    .lt("trial_ends_at", now.toISOString())
    .select("user_id, email, locale");

  result.expired = expired?.length ?? 0;

  for (const p of expired ?? []) {
    if (!p.email) continue;
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "subscription-expired",
      _payload: { checkout_url: `${env.appBaseUrl()}/assinatura` },
      _to_email: p.email,
      _to_user_id: p.user_id,
      _idempotency_key: `trial-expired:${p.user_id}`,
      _locale: p.locale ?? "pt",
      _entity: "profiles",
      _entity_id: p.user_id,
    });
  }

  // ---- 2. lembretes de fim de trial ---------------------------------------
  for (const daysLeft of [3, 1]) {
    const from = new Date(now.getTime() + (daysLeft - 1) * 86400_000).toISOString();
    const to = new Date(now.getTime() + daysLeft * 86400_000).toISOString();

    const { data: ending } = await db
      .from("profiles")
      .select("user_id, email, locale")
      .eq("subscription_status", "trialing")
      .gte("trial_ends_at", from)
      .lt("trial_ends_at", to);

    for (const p of ending ?? []) {
      if (!p.email) continue;

      // Números concretos convertem melhor que "seu teste vai acabar".
      const { data: props } = await db
        .from("properties").select("id").eq("owner_id", p.user_id).is("archived_at", null);
      const propertyIds = (props ?? []).map((x) => x.id);

      let checkouts = 0;
      let cleanings = 0;
      if (propertyIds.length > 0) {
        const { count: c1 } = await db
          .from("reservations")
          .select("id", { count: "exact", head: true })
          .in("property_id", propertyIds)
          .eq("status", "confirmed");
        const { count: c2 } = await db
          .from("cleaning_tasks")
          .select("id", { count: "exact", head: true })
          .in("property_id", propertyIds);
        checkouts = c1 ?? 0;
        cleanings = c2 ?? 0;
      }

      await db.rpc("enqueue_notification", {
        _channel: "email",
        _template: "trial-ending",
        _payload: {
          days_left: daysLeft,
          checkouts,
          cleanings,
          checkout_url: `${env.appBaseUrl()}/assinatura`,
        },
        _to_email: p.email,
        _to_user_id: p.user_id,
        _idempotency_key: `trial-ending:${p.user_id}:${daysLeft}`,
        _locale: p.locale ?? "pt",
        _entity: "profiles",
        _entity_id: p.user_id,
      });
      result.reminders++;
    }
  }

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
