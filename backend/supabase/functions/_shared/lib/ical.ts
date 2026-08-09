/**
 * Parser de iCal (RFC 5545) para feeds de Airbnb, Booking e VRBO.
 *
 * O parser antigo usava três regex soltas sobre o texto inteiro e ignorava o
 * UID. Isso causava dois problemas reais:
 *   - Linhas dobradas (o RFC quebra linhas longas com CRLF + espaço) chegavam
 *     truncadas, então o nome do hóspede vinha cortado.
 *   - Sem UID, a reserva era identificada pela data de saída — duas reservas
 *     com a mesma saída colidiam, e mudar a data criava uma reserva "nova".
 */

export interface IcalEvent {
  uid: string;
  summary: string;
  description: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  url: string | null;
}

/** Desdobra linhas continuadas: CRLF seguido de espaço ou tab. */
function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

/** `DTSTART;VALUE=DATE:20260814` -> { params, value } */
function splitLine(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const name = head.split(";")[0].toUpperCase();
  return { name, value };
}

/** Aceita YYYYMMDD e YYYYMMDDTHHMMSSZ; devolve YYYY-MM-DD. */
function parseDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

function unescape(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

export function parseIcal(text: string): IcalEvent[] {
  const lines = unfold(text);
  const events: IcalEvent[] = [];

  let current: Partial<IcalEvent> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "BEGIN:VEVENT") {
      current = {};
      continue;
    }

    if (trimmed === "END:VEVENT") {
      if (current?.uid && current.start && current.end) {
        events.push({
          uid: current.uid,
          summary: current.summary ?? "",
          description: current.description ?? "",
          start: current.start,
          end: current.end,
          url: current.url ?? null,
        });
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const parsed = splitLine(trimmed);
    if (!parsed) continue;

    switch (parsed.name) {
      case "UID":
        current.uid = parsed.value.trim();
        break;
      case "SUMMARY":
        current.summary = unescape(parsed.value);
        break;
      case "DESCRIPTION":
        current.description = unescape(parsed.value);
        break;
      case "DTSTART":
        current.start = parseDate(parsed.value) ?? undefined;
        break;
      case "DTEND":
        current.end = parseDate(parsed.value) ?? undefined;
        break;
      case "URL":
        current.url = parsed.value.trim();
        break;
    }
  }

  return events;
}

/**
 * Bloqueios manuais no calendário não são reserva de hóspede — virariam
 * limpeza cobrada à toa. Filtramos os rótulos mais comuns das plataformas.
 */
const BLOCK_PATTERNS = [
  /^blocked$/i,
  /^not available$/i,
  /^unavailable$/i,
  /^bloqueado$/i,
  /^indisponível$/i,
  /airbnb \(not available\)/i,
  /^closed$/i,
];

export function isBlock(event: IcalEvent): boolean {
  const s = event.summary.trim();
  if (s === "") return false;
  return BLOCK_PATTERNS.some((re) => re.test(s));
}

/**
 * Valida a URL de um feed antes de gravar.
 *
 * Este é o passo em que o cliente mais trava no onboarding — ele quase sempre
 * cola o link do ANÚNCIO em vez do link do calendário. A mensagem de erro
 * precisa dizer exatamente isso, não "URL inválida".
 */
export interface IcalValidation {
  ok: boolean;
  reason?: string;
  hint?: string;
  eventCount?: number;
  nextCheckout?: string | null;
}

export async function validateIcalUrl(url: string, timeoutMs = 15000): Promise<IcalValidation> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "url_malformada", hint: "O link precisa começar com https://" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "protocolo_invalido", hint: "O link precisa começar com https://" };
  }

  // Erro nº 1 na prática: link do anúncio em vez do link do calendário.
  if (/^(www\.)?airbnb\.[a-z.]+$/i.test(parsed.hostname) && !parsed.pathname.includes("/calendar/")) {
    return {
      ok: false,
      reason: "link_do_anuncio",
      hint:
        "Esse é o link do seu anúncio, não do calendário. No app do Airbnb: " +
        "Calendário → Disponibilidade → Conectar a outro site → Copiar link. " +
        "O link certo termina em .ics",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "HospedePay/1.0 (+calendar-sync)" },
      redirect: "follow",
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: `http_${res.status}`,
        hint:
          res.status === 404
            ? "O link não existe mais. Gere um novo na plataforma."
            : "A plataforma não respondeu. Confira se o link foi copiado inteiro.",
      };
    }

    const body = await res.text();

    if (!body.includes("BEGIN:VCALENDAR")) {
      return {
        ok: false,
        reason: "nao_e_calendario",
        hint:
          "Esse link não devolveu um calendário. Verifique se copiou o link de " +
          "exportação (.ics), e não o endereço da página.",
      };
    }

    const events = parseIcal(body).filter((e) => !isBlock(e));
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = events
      .map((e) => e.end)
      .filter((d) => d >= today)
      .sort();

    return {
      ok: true,
      eventCount: events.length,
      nextCheckout: upcoming[0] ?? null,
    };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return {
      ok: false,
      reason: aborted ? "timeout" : "falha_de_rede",
      hint: "Não conseguimos acessar o link. Confira se ele está completo e tente de novo.",
    };
  } finally {
    clearTimeout(timer);
  }
}
