import { handler, json } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";

/**
 * Rede de segurança do aviso à portaria.
 *
 * O caminho principal é o gatilho no banco (migration 0010): toda reserva
 * confirmada enfileira o e-mail e carimba condo_notified_at. Este job varre o
 * que sobrou — reserva confirmada, imóvel com e-mail de portaria, e ainda sem
 * carimbo.
 *
 * Existe porque "avisamos a portaria a cada reserva" é argumento de venda, e
 * argumento de venda não pode depender de um gatilho ter rodado. Se o job não
 * encontrar nada, ótimo: significa que o caminho principal está funcionando.
 */

const BATCH = 100;

export default handler(async (req) => {
  await requireCron(req);

  const db = admin();

  const { data: pending, error } = await db
    .from("reservations")
    .select(
      "id, property_id, checkin_date, checkout_date, guest_label, " +
        "properties!inner(name, owner_id, condo_email, condo_notify, condo_name, block, apt_number, checkin_time, checkout_time, archived_at)",
    )
    .eq("status", "confirmed")
    .is("condo_notified_at", null)
    .gte("checkout_date", new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10))
    .limit(BATCH);

  if (error) throw new Error(`Falha ao listar reservas pendentes: ${error.message}`);

  let queued = 0;
  let skipped = 0;

  for (const r of pending ?? []) {
    const p = r.properties as unknown as {
      name: string;
      owner_id: string;
      condo_email: string | null;
      condo_notify: boolean;
      condo_name: string | null;
      block: string | null;
      apt_number: string | null;
      checkin_time: string | null;
      checkout_time: string | null;
      archived_at: string | null;
    };

    // Sem e-mail de portaria configurado não há nada a enviar — carimba para
    // não varrer a mesma reserva todo ciclo.
    if (!p.condo_email || !p.condo_notify || p.archived_at) {
      await db.from("reservations")
        .update({ condo_notified_at: new Date().toISOString(), condo_notify_error: "portaria_nao_configurada" })
        .eq("id", r.id);
      skipped++;
      continue;
    }

    const { data: active } = await db.rpc("subscription_is_active", { _user_id: p.owner_id });
    if (!active) { skipped++; continue; }

    const { data: owner } = await db
      .from("profiles").select("full_name, phone_e164").eq("user_id", p.owner_id).maybeSingle();

    const notificationId = await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "condo-reservation",
      _payload: {
        property_name: p.name,
        condo_name: p.condo_name,
        block: p.block,
        apt_number: p.apt_number,
        owner_name: owner?.full_name ?? null,
        owner_phone: owner?.phone_e164 ?? null,
        checkin_date: r.checkin_date,
        checkout_date: r.checkout_date,
        checkin_time: p.checkin_time,
        checkout_time: p.checkout_time,
        guest_label: r.guest_label,
      },
      _to_email: p.condo_email,
      _to_user_id: p.owner_id,
      _idempotency_key: `condo:${r.id}`,
      _locale: "pt",
      _entity: "reservations",
      _entity_id: r.id,
    });

    await db.from("reservations")
      .update({ condo_notified_at: new Date().toISOString(), condo_notify_error: null })
      .eq("id", r.id);

    if (notificationId.data) queued++;
    else skipped++; // já enfileirado antes (idempotência) ou e-mail suprimido
  }

  const out = { scanned: pending?.length ?? 0, queued, skipped };
  if ((pending?.length ?? 0) > 0) console.log("notify-condo:", JSON.stringify(out));
  return json({ ok: true, ...out });
});
