import { handler, json } from "../_shared/lib/http.ts";
import { admin, appToday, requireCron } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Relatório mensal para o dono — enviado no dia 1.
 *
 * Este produto fica invisível quando funciona: o cliente esquece que existe,
 * e no mês 5 olha a fatura e pensa "o que é isso mesmo?". O relatório é o
 * antídoto — mostra, em números, o trabalho que ele não precisou fazer.
 *
 * Todos os dados já são calculados pelo banco; aqui só empacotamos e enviamos.
 */

const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export default handler(async (req) => {
  await requireCron(req);

  const db = admin();

  // Mês fechado = o anterior ao atual.
  const today = appToday();
  const [y, m] = today.split("-").map(Number);
  const refYear = m === 1 ? y - 1 : y;
  const refMonth = m === 1 ? 12 : m - 1;
  const monthStart = `${refYear}-${String(refMonth).padStart(2, "0")}-01`;
  const monthEnd = new Date(Date.UTC(refYear, refMonth, 0)).toISOString().slice(0, 10);
  const monthLabel = `${MONTHS[refMonth - 1]} de ${refYear}`;

  const { data: owners } = await db
    .from("profiles")
    .select("user_id, email, locale")
    .in("subscription_status", ["active", "past_due", "trialing"]);

  let sent = 0;
  let skipped = 0;

  for (const owner of owners ?? []) {
    if (!owner.email) { skipped++; continue; }

    const { data: props } = await db
      .from("properties")
      .select("id")
      .eq("owner_id", owner.user_id)
      .is("archived_at", null);

    const propertyIds = (props ?? []).map((p) => p.id);
    if (propertyIds.length === 0) { skipped++; continue; }

    const { data: summary } = await db.rpc("owner_month_summary", {
      _month: monthStart,
      _owner: owner.user_id,
    });

    const rows = (summary ?? []) as Array<{
      cleanings: number;
      turnover_total: number;
      fees_total: number;
    }>;

    const cleanings = rows.reduce((s, r) => s + Number(r.cleanings ?? 0), 0);
    const turnover = rows.reduce((s, r) => s + Number(r.turnover_total ?? 0), 0);
    const fees = rows.reduce((s, r) => s + Number(r.fees_total ?? 0), 0);

    const { count: checkouts } = await db
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .in("property_id", propertyIds)
      .eq("status", "confirmed")
      .gte("checkout_date", monthStart)
      .lte("checkout_date", monthEnd);

    const { count: guests } = await db
      .from("guest_registrations")
      .select("id", { count: "exact", head: true })
      .in("property_id", propertyIds)
      .gte("created_at", `${monthStart}T00:00:00Z`)
      .lte("created_at", `${monthEnd}T23:59:59Z`);

    const { data: sessions } = await db
      .from("guest_sessions")
      .select("id")
      .in("property_id", propertyIds)
      .gte("created_at", `${monthStart}T00:00:00Z`)
      .lte("created_at", `${monthEnd}T23:59:59Z`);

    let aiAnswers = 0;
    const sessionIds = (sessions ?? []).map((s) => s.id);
    if (sessionIds.length > 0) {
      const { count } = await db
        .from("guest_messages")
        .select("id", { count: "exact", head: true })
        .in("session_id", sessionIds)
        .eq("role", "user");
      aiAnswers = count ?? 0;
    }

    // Mês sem nenhum movimento: não manda. Relatório vazio corrói confiança.
    if ((checkouts ?? 0) === 0 && cleanings === 0 && aiAnswers === 0) {
      skipped++;
      continue;
    }

    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "monthly-report",
      _payload: {
        month_label: monthLabel,
        checkouts: checkouts ?? 0,
        cleanings,
        turnover_cents: Math.round(turnover * 100),
        fees_cents: Math.round(fees * 100),
        total_cents: Math.round((turnover + fees) * 100),
        guests_registered: guests ?? 0,
        ai_answers: aiAnswers,
        dashboard_url: `${env.appBaseUrl()}/financeiro`,
      },
      _to_email: owner.email,
      _to_user_id: owner.user_id,
      _idempotency_key: `monthly-report:${owner.user_id}:${monthStart}`,
      _locale: owner.locale ?? "pt",
      _entity: "profiles",
      _entity_id: owner.user_id,
    });
    sent++;
  }

  const out = { month: monthStart, sent, skipped };
  console.log("monthly-report:", JSON.stringify(out));
  return json({ ok: true, ...out });
});
