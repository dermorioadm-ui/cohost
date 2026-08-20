import { corsHeaders } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";

/**
 * Calendário de saída: o .ics que os canais importam.
 *
 * Até aqui a sincronia era de mão única — o app lia Airbnb e Booking, e nada
 * saía. Uma reserva feita no Booking não bloqueava as datas no Airbnb, então os
 * dois canais seguiam vendendo as mesmas noites e a dupla reserva só aparecia
 * quando dois hóspedes chegavam no mesmo dia.
 *
 * NÃO PASSA PELO `handler()` padrão. O envelope comum responde JSON e trata
 * OPTIONS/POST; aqui quem chama é um robô do Airbnb fazendo GET e esperando
 * `text/calendar`. Um corpo JSON, ou um 400 bonito, seriam lidos como feed
 * inválido — e o canal desiste depois de algumas tentativas.
 *
 * AUTORIZAÇÃO PELO TOKEN NA URL. É o único formato que os canais aceitam: eles
 * não mandam header nem fazem login. Por isso o token é longo, o banco guarda
 * só o hash, e a resposta nunca diz se um token errado é inexistente ou de
 * outro imóvel.
 *
 * SEM IDENTIDADE DE HÓSPEDE. Todo evento é "Ocupado". A URL vai parar dentro do
 * sistema de um terceiro, e nome de hóspede não tem o que fazer lá — o próprio
 * Airbnb faz assim nos feeds dele.
 *
 * UM LINK POR ANÚNCIO. O parâmetro `exceto` carrega o id do anúncio que está
 * importando, e o feed devolve tudo menos o que aquele anúncio mesmo trouxe.
 * Excluir por canal seria mais simples e estaria errado: dois anúncios do mesmo
 * apartamento no Airbnb deixariam de se bloquear.
 */

interface Row {
  property_id: string;
  property_name: string;
  reservation_id: string;
  provider: string;
  checkin_date: string;
  checkout_date: string;
  updated_at: string;
}

/** Datas do iCalendar em all-day: AAAAMMDD, sem hora nem fuso. */
const dia = (iso: string) => iso.slice(0, 10).replace(/-/g, "");

const carimbo = (iso: string) =>
  new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Dobra linha em 75 octetos, como o RFC 5545 exige.
 *
 * Parece purismo, mas não é: importador que segue a norma trunca a linha longa
 * e o evento chega quebrado. A conta é em BYTES — cortar por caractere parte um
 * acento no meio e entrega UTF-8 inválido.
 */
function dobrar(linha: string): string {
  const bytes = new TextEncoder().encode(linha);
  if (bytes.length <= 75) return linha;

  const partes: string[] = [];
  let atual = "";
  let tamanho = 0;

  for (const ch of linha) {
    const n = new TextEncoder().encode(ch).length;
    // 74 na continuação: o espaço inicial da linha dobrada também conta.
    if (tamanho + n > (partes.length === 0 ? 75 : 74)) {
      partes.push(atual);
      atual = "";
      tamanho = 0;
    }
    atual += ch;
    tamanho += n;
  }
  if (atual) partes.push(atual);

  return partes[0] + partes.slice(1).map((p) => `\r\n ${p}`).join("");
}

const escapar = (v: string) =>
  v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

function montarIcs(nome: string, rows: Row[]): string {
  const linhas: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HospedePay//Calendario de saida//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    dobrar(`X-WR-CALNAME:${escapar(nome)} — HospedePay`),
  ];

  for (const r of rows) {
    linhas.push(
      "BEGIN:VEVENT",
      // O UID precisa ser estável entre leituras: é por ele que o canal
      // reconhece "o mesmo bloqueio de antes" em vez de criar um duplicado a
      // cada importação.
      `UID:${r.reservation_id}@hospedepay.org`,
      `DTSTAMP:${carimbo(r.updated_at)}`,
      // DTEND é exclusivo no iCalendar: a data de check-out fica LIVRE, que é o
      // comportamento certo — quem sai às 11h libera a noite para quem entra
      // no mesmo dia. Somar um dia aqui bloquearia uma noite que está à venda.
      `DTSTART;VALUE=DATE:${dia(r.checkin_date)}`,
      `DTEND;VALUE=DATE:${dia(r.checkout_date)}`,
      "SUMMARY:Ocupado",
      "TRANSP:OPAQUE",
      "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  }

  linhas.push("END:VCALENDAR");
  return linhas.join("\r\n") + "\r\n";
}

const calendarioVazio = (nome = "HospedePay") =>
  montarIcs(nome, []);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const token = (url.searchParams.get("t") ?? "").trim();

  // `exceto` é o id do ANÚNCIO que está importando, não o nome do canal.
  //
  // A primeira versão excluía por canal, e isso abria um buraco assim que o
  // mesmo imóvel ganhava dois anúncios no Airbnb: o anúncio B receberia o feed
  // sem nenhuma reserva do Airbnb — inclusive as do anúncio A, que é o mesmo
  // apartamento. Os dois seguiriam vendendo a mesma noite.
  const exceto = (url.searchParams.get("exceto") ?? "").trim();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const excetoId = UUID.test(exceto) ? exceto : null;

  const cabecalho = {
    ...corsHeaders,
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="hospedepay.ics"',
    // O canal relê de tempos em tempos; cache curto evita que ele veja uma
    // reserva de dez minutos atrás como inexistente.
    "Cache-Control": "public, max-age=300",
  };

  // Token ausente ou inválido devolve um calendário VAZIO, e não um erro.
  //
  // Parece esconder problema, mas é o oposto: um 404 aqui vira uma resposta que
  // diferencia "token não existe" de "token existe e não tem reserva", e a URL
  // é pública por natureza — isso transformaria o endpoint em oráculo de quais
  // tokens são válidos. O dono que colar a URL errada percebe do jeito certo,
  // pelo canal dizendo que o calendário está vazio.
  if (!token) return new Response(calendarioVazio(), { headers: cabecalho });

  try {
    const { data, error } = await admin().rpc("ical_feed_rows", {
      _token: token,
      _exceto: excetoId,
    });

    if (error) {
      console.error("Falha ao ler o feed:", error.message);
      // Falha nossa não pode virar calendário vazio: o canal leria isso como
      // "nenhuma data ocupada" e liberaria tudo para venda. 503 faz ele manter
      // o que já importou e tentar de novo.
      return new Response("Feed indisponivel", { status: 503, headers: corsHeaders });
    }

    const rows = (data ?? []) as Row[];
    return new Response(montarIcs(rows[0]?.property_name ?? "HospedePay", rows), {
      headers: cabecalho,
    });
  } catch (e) {
    console.error("Erro no feed:", e instanceof Error ? e.message : e);
    return new Response("Feed indisponivel", { status: 503, headers: corsHeaders });
  }
});
