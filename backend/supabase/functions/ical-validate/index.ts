import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { validateIcalUrl } from "../_shared/lib/ical.ts";

/**
 * Valida (e opcionalmente grava) um link de calendário.
 *
 * É o passo mais importante do onboarding conversacional: o cliente cola o
 * link, e em vez de "salvo com sucesso" ele recebe a confirmação que faz ele
 * acreditar que comprou certo —
 *
 *   "Achei 7 reservas no seu calendário. A próxima saída é dia 14, às 11h."
 *
 * E quando o link está errado (quase sempre o link do anúncio em vez do link
 * do calendário), a mensagem diz exatamente isso, com o caminho do menu.
 */

interface Body {
  url?: string;
  property_id?: string;
  provider?: "airbnb" | "booking" | "vrbo" | "other";
  save?: boolean;
  /** Apelido do anúncio. Só faz diferença quando há mais de um no mesmo canal. */
  label?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const body = await readJson<Body>(req);

  const url = (body.url ?? "").trim();
  if (!url) throw errors.invalid("Informe o link do calendário");

  const result = await validateIcalUrl(url);

  if (!result.ok) {
    return json({
      ok: false,
      reason: result.reason,
      message: result.hint ?? "Não conseguimos ler esse calendário.",
    });
  }

  const response: Record<string, unknown> = {
    ok: true,
    events: result.eventCount,
    next_checkout: result.nextCheckout,
    message:
      result.eventCount === 0
        ? "Calendário conectado. Ainda não há reservas nele — assim que entrar uma, ela aparece aqui sozinha."
        : `Achei ${result.eventCount} reserva${result.eventCount === 1 ? "" : "s"} no seu calendário.` +
          (result.nextCheckout ? ` A próxima saída é ${result.nextCheckout}.` : ""),
  };

  if (!body.save) return json(response);

  // ---- grava ---------------------------------------------------------------
  if (!body.property_id) throw errors.invalid("property_id é obrigatório para salvar");

  const db = admin();
  const { data: property } = await db
    .from("properties")
    .select("id")
    .eq("id", body.property_id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!property) throw errors.notFound("Imóvel não encontrado");

  const provider = body.provider ?? guessProvider(url);

  // O conflito é pela URL, e não pelo canal.
  //
  // Era `property_id,provider`, e isso significava um anúncio por canal: colar
  // o link do segundo anúncio do Airbnb SOBRESCREVIA o primeiro. O link antigo
  // sumia sem aviso e as reservas dele paravam de entrar — pior que recusar,
  // porque ninguém percebe até faltar reserva na agenda.
  //
  // Pela URL, colar o mesmo link de novo revalida a fonte que já existe (é o
  // caminho de quem regerou o link e quer religar), e um link diferente cria um
  // anúncio novo. Quantos o dono quiser, no mesmo canal.
  const { error } = await db
    .from("property_ical_sources")
    .upsert(
      {
        property_id: property.id,
        provider,
        url,
        label: (body.label ?? "").trim() || null,
        active: true,
        last_error: null,
        consecutive_fails: 0,
      },
      { onConflict: "property_id,url" },
    );

  if (error) throw errors.upstream(`Falha ao salvar o calendário: ${error.message}`);

  response.saved = true;
  response.provider = provider;

  return json(response);
});

function guessProvider(url: string): "airbnb" | "booking" | "vrbo" | "other" {
  const h = url.toLowerCase();
  if (h.includes("airbnb")) return "airbnb";
  if (h.includes("booking.com") || h.includes("bstatic")) return "booking";
  if (h.includes("vrbo") || h.includes("homeaway") || h.includes("expedia")) return "vrbo";
  return "other";
}
