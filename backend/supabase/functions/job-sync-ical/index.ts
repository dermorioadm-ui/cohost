import { handler, json } from "../_shared/lib/http.ts";
import { admin, addDays, appToday, requireCron } from "../_shared/lib/db.ts";
import { isBlock, parseIcal } from "../_shared/lib/ical.ts";

/**
 * Sincroniza os calendários de todos os imóveis ativos.
 *
 * Roda de 15 em 15 minutos pelo pg_cron (migration 0015). É isto que torna
 * verdadeira a frase "funciona no automático": no backend antigo a sync só
 * acontecia quando alguém abria o app, e o cliente que compra para esquecer
 * é justamente o que não abre.
 *
 * Também aceita { property_id } ou { owner_id } no corpo para sincronizar sob
 * demanda (usado logo depois que o dono cadastra o imóvel, para ele ver as
 * reservas aparecerem na hora).
 */

interface SourceRow {
  id: string;
  property_id: string;
  provider: string;
  url: string;
  consecutive_fails: number;
}

const FETCH_TIMEOUT_MS = 20000;
const MAX_CONCURRENT = 6;

async function fetchFeed(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "HospedePay/1.0 (+calendar-sync)" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.includes("BEGIN:VCALENDAR")) throw new Error("resposta não é um calendário");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function syncSource(
  db: ReturnType<typeof admin>,
  source: SourceRow,
  windowStart: string,
  windowEnd: string,
): Promise<{ imported: number; cancelled: number }> {
  let body: string;
  try {
    body = await fetchFeed(source.url);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .from("property_ical_sources")
      .update({
        last_synced_at: new Date().toISOString(),
        last_error: message,
        consecutive_fails: source.consecutive_fails + 1,
      })
      .eq("id", source.id);
    console.warn(`Feed falhou (${source.provider}, imóvel ${source.property_id}): ${message}`);
    return { imported: 0, cancelled: 0 };
  }

  const events = parseIcal(body)
    .filter((e) => !isBlock(e))
    .filter((e) => e.end >= windowStart && e.start <= windowEnd);

  const seenUids = new Set(events.map((e) => e.uid));
  let imported = 0;

  // Upsert por (property_id, external_uid): o gatilho no banco cria/atualiza a
  // tarefa de limpeza e dispara o e-mail para a portaria.
  if (events.length > 0) {
    const rows = events.map((e) => ({
      property_id: source.property_id,
      source_id: source.id,
      provider: source.provider,
      external_uid: e.uid,
      checkin_date: e.start,
      checkout_date: e.end,
      guest_label: e.summary || null,
      reservation_url: e.url,
      status: "confirmed",
      last_seen_at: new Date().toISOString(),
      raw: { summary: e.summary, description: e.description },
    }));

    const { error } = await db
      .from("reservations")
      .upsert(rows, { onConflict: "property_id,external_uid" });

    if (error) {
      console.error(`Falha ao gravar reservas do imóvel ${source.property_id}:`, error.message);
    } else {
      imported = rows.length;
    }
  }

  // Reserva que sumiu do feed dentro da janela = cancelamento.
  // Só marcamos as desta fonte, para o feed do Booking não cancelar o do Airbnb.
  const { data: existing } = await db
    .from("reservations")
    .select("id, external_uid")
    .eq("property_id", source.property_id)
    .eq("source_id", source.id)
    .eq("status", "confirmed")
    .gte("checkout_date", windowStart);

  const vanished = (existing ?? []).filter((r) => !seenUids.has(r.external_uid));

  if (vanished.length > 0) {
    await db
      .from("reservations")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .in("id", vanished.map((r) => r.id));
  }

  await db
    .from("property_ical_sources")
    .update({
      last_synced_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_error: null,
      consecutive_fails: 0,
      events_last_sync: events.length,
    })
    .eq("id", source.id);

  return { imported, cancelled: vanished.length };
}

export default handler(async (req) => {
  let scope: { property_id?: string; owner_id?: string } = {};

  // Chamada do cron não tem corpo; chamada sob demanda vem autenticada com o
  // mesmo segredo (o backend chama a si mesmo).
  await requireCron(req);
  try {
    scope = await req.json();
  } catch {
    // sem corpo = varredura completa
  }

  const db = admin();
  const today = appToday();

  const { data: settings } = await db
    .from("app_settings")
    .select("key, value")
    .in("key", ["ical_lookback_days", "ical_lookahead_days"]);

  const setting = (k: string, d: number) =>
    Number(settings?.find((s) => s.key === k)?.value ?? d) || d;

  const windowStart = addDays(today, -setting("ical_lookback_days", 3));
  const windowEnd = addDays(today, setting("ical_lookahead_days", 365));

  // Só imóveis de donos com assinatura viva. A regra mora numa função só
  // (subscription_is_active), então nunca diverge entre job, RLS e app.
  let query = db
    .from("property_ical_sources")
    .select("id, property_id, provider, url, consecutive_fails, properties!inner(owner_id, archived_at)")
    .eq("active", true)
    .is("properties.archived_at", null);

  if (scope.property_id) query = query.eq("property_id", scope.property_id);
  if (scope.owner_id) query = query.eq("properties.owner_id", scope.owner_id);

  const { data: rawSources, error } = await query;
  if (error) throw new Error(`Falha ao listar fontes: ${error.message}`);

  const ownerIds = [
    ...new Set((rawSources ?? []).map((s) => (s.properties as { owner_id: string }).owner_id)),
  ];

  const activeOwners = new Set<string>();
  for (const ownerId of ownerIds) {
    const { data: ok } = await db.rpc("subscription_is_active", { _user_id: ownerId });
    if (ok) activeOwners.add(ownerId);
  }

  const sources = (rawSources ?? []).filter((s) =>
    activeOwners.has((s.properties as { owner_id: string }).owner_id)
  ) as unknown as SourceRow[];

  let imported = 0;
  let cancelled = 0;
  const startedAt = Date.now();

  // Lotes pequenos: dezenas de feeds externos em paralelo derrubam o
  // tempo de execução da function e às vezes o rate limit da plataforma.
  for (let i = 0; i < sources.length; i += MAX_CONCURRENT) {
    const batch = sources.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      batch.map((s) => syncSource(db, s, windowStart, windowEnd)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        imported += r.value.imported;
        cancelled += r.value.cancelled;
      } else {
        console.error("Falha inesperada na sincronização:", r.reason);
      }
    }
  }

  const summary = {
    sources: sources.length,
    reservations_upserted: imported,
    reservations_cancelled: cancelled,
    window: { start: windowStart, end: windowEnd },
    duration_ms: Date.now() - startedAt,
  };

  console.log("sync-ical:", JSON.stringify(summary));
  return json({ ok: true, ...summary });
});
