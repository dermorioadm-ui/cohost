import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { errors } from "./http.ts";

/**
 * Termos assinados a dedo.
 *
 * O documento vale pelo que consegue provar depois, e não pelo que parece na
 * tela. Por isso três decisões atravessam este arquivo:
 *
 * 1. O TEXTO do termo é copiado para dentro da assinatura, e não referenciado.
 *    Se amanhã alguém corrigir uma vírgula na versão publicada, o documento
 *    que a pessoa assinou ontem não pode mudar de conteúdo junto.
 *
 * 2. A DATA DO FATO é separada da data da assinatura. A diarista assina às 19h
 *    a limpeza que fez às 11h; guardar um carimbo só transformaria a
 *    declaração dela em outra coisa.
 *
 * 3. O PDF é gerado no servidor. Se o cliente montasse o PDF e mandasse
 *    pronto, o que ficaria arquivado seria o que ele decidiu escrever — e a
 *    assinatura estaria colada num texto que ninguém controla.
 */

const BUCKET = "termos";

/** Limite do PNG da assinatura. Rabisco cabe folgado; foto de tela, não. */
const MAX_ASSINATURA_BYTES = 400_000;

export interface EntradaTermo {
  kind: "cadastro_hospede" | "limpeza_concluida";
  propertyId: string;
  registrationId?: string | null;
  cleaningTaskId?: string | null;
  signerUserId?: string | null;
  signerName: string;
  signerDoc?: string | null;
  /** Quando o fato aconteceu, segundo quem assina. */
  declaradoEm?: string | null;
  /** data:image/png;base64,... vindo do canvas. */
  assinaturaDataUrl: string;
  locale?: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Linhas extras do documento: pessoas cadastradas, datas da estadia, etc. */
  detalhes?: Array<[string, string]>;
}

export interface ResultadoTermo {
  id: string;
  pdfPath: string;
  assinaturaPath: string;
}

/** Converte o data URL do canvas em bytes, recusando o que não for PNG. */
function pngDoDataUrl(dataUrl: string): Uint8Array {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl ?? "");
  if (!m) throw errors.invalid("Assinatura inválida");

  let bin: string;
  try {
    bin = atob(m[1].replace(/\s/g, ""));
  } catch {
    throw errors.invalid("Assinatura inválida");
  }

  if (bin.length > MAX_ASSINATURA_BYTES) {
    throw errors.invalid("Assinatura grande demais");
  }
  // Um PNG de verdade começa com esta assinatura de 8 bytes. Sem a checagem,
  // qualquer base64 entra no bucket com content-type de imagem.
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw errors.invalid("Assinatura inválida");
  }
  return bytes;
}

/**
 * Deixa o texto no que a fonte padrão do PDF consegue escrever.
 *
 * As fontes StandardFonts do pdf-lib codificam em WinAnsi. Acentos do
 * português cabem; travessão, aspas curvas e reticências não — e `drawText`
 * não ignora o caractere, ele LANÇA. Na prática isso significa que um imóvel
 * chamado "Cobertura — Icaraí" derrubaria a geração do termo inteiro, e o
 * hóspede veria o cadastro falhar por causa de um traço.
 *
 * Traduzir para o equivalente ASCII é melhor que remover: "Cobertura - Icaraí"
 * continua legível, "CobreturaIcaraí" não.
 */
function winAnsi(texto: string): string {
  return (texto ?? "")
    .replace(/[\u2013\u2014]/g, "-")      // – —
    .replace(/[\u2018\u2019\u201B]/g, "'") // ' ' ‛
    .replace(/[\u201C\u201D\u201F]/g, '"') // " " ‟
    .replace(/\u2026/g, "...")             // …
    .replace(/\u00A0/g, " ")               // espaço fixo
    .replace(/[\u2022\u00B7]/g, "-")       // • ·
    // O que sobrar fora da faixa que a WinAnsi cobre vira "?" em vez de
    // derrubar o documento. Perder um caractere exótico é aceitável; perder o
    // termo inteiro, não.
    .replace(/[^\x20-\x7E\u00A1-\u00FF\n]/g, "?");
}

const fmtBR = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Quebra o parágrafo na largura da página.
 *
 * Feito à mão porque o pdf-lib não quebra linha: sem isto o texto sai numa
 * única reta que atravessa a folha e some na margem — e o termo passaria a
 * "existir" com metade das cláusulas invisíveis.
 */
function quebrar(texto: string, fonte: unknown, tamanho: number, largura: number): string[] {
  const medir = (t: string) =>
    (fonte as { widthOfTextAtSize(t: string, s: number): number }).widthOfTextAtSize(t, tamanho);

  const linhas: string[] = [];
  for (const paragrafo of texto.split("\n")) {
    if (!paragrafo.trim()) {
      linhas.push("");
      continue;
    }
    let atual = "";
    for (const palavra of paragrafo.split(/\s+/)) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (medir(tentativa) <= largura) {
        atual = tentativa;
      } else {
        if (atual) linhas.push(atual);
        atual = palavra;
      }
    }
    if (atual) linhas.push(atual);
  }
  return linhas;
}

async function montarPdf(opts: {
  titulo: string;
  corpo: string;
  imovel: string;
  detalhes: Array<[string, string]>;
  signerName: string;
  signerDoc?: string | null;
  declaradoEm?: string | null;
  assinadoEm: string;
  ip?: string | null;
  assinaturaPng: Uint8Array;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const assinatura = await pdf.embedPng(opts.assinaturaPng);

  const A4: [number, number] = [595.28, 841.89];
  const MARGEM = 56;
  const LARGURA = A4[0] - MARGEM * 2;
  const CINZA = rgb(0.42, 0.42, 0.45);
  const PRETO = rgb(0.1, 0.1, 0.12);

  let pagina = pdf.addPage(A4);
  let y = A4[1] - MARGEM;

  /** Garante espaço; abre página nova quando o rodapé se aproxima. */
  const espaco = (altura: number) => {
    if (y - altura < MARGEM + 40) {
      pagina = pdf.addPage(A4);
      y = A4[1] - MARGEM;
    }
  };

  const escrever = (
    texto: string,
    tamanho: number,
    fonte: typeof normal,
    cor = PRETO,
    entrelinha = 1.45,
  ) => {
    for (const linha of quebrar(winAnsi(texto), fonte, tamanho, LARGURA)) {
      espaco(tamanho * entrelinha);
      if (linha) pagina.drawText(linha, { x: MARGEM, y, size: tamanho, font: fonte, color: cor });
      y -= tamanho * entrelinha;
    }
  };

  escrever("HospedePay", 9, negrito, CINZA);
  y -= 10;
  escrever(opts.titulo, 17, negrito);
  y -= 6;
  escrever(opts.imovel, 11, normal, CINZA);
  y -= 18;

  for (const [rotulo, valor] of opts.detalhes) {
    espaco(15);
    pagina.drawText(winAnsi(`${rotulo}:`), { x: MARGEM, y, size: 9.5, font: negrito, color: CINZA });
    pagina.drawText(winAnsi(valor), { x: MARGEM + 130, y, size: 9.5, font: normal, color: PRETO });
    y -= 15;
  }

  y -= 14;
  escrever(opts.corpo, 10, normal);

  // A assinatura precisa de espaço contínuo: quebrar a imagem entre páginas
  // deixaria um risco solto no pé de uma folha e o nome no topo da outra.
  espaco(150);
  y -= 24;

  pagina.drawLine({
    start: { x: MARGEM, y },
    end: { x: MARGEM + LARGURA, y },
    thickness: 0.5,
    color: rgb(0.85, 0.85, 0.88),
  });
  y -= 18;

  escrever("ASSINATURA", 8.5, negrito, CINZA);
  y -= 4;

  const escala = Math.min(200 / assinatura.width, 70 / assinatura.height);
  const larg = assinatura.width * escala;
  const alt = assinatura.height * escala;
  pagina.drawImage(assinatura, { x: MARGEM, y: y - alt, width: larg, height: alt });
  y -= alt + 8;

  pagina.drawLine({
    start: { x: MARGEM, y },
    end: { x: MARGEM + 220, y },
    thickness: 0.7,
    color: rgb(0.6, 0.6, 0.65),
  });
  y -= 14;

  escrever(opts.signerName, 10.5, negrito);
  if (opts.signerDoc) escrever(`Documento: ${opts.signerDoc}`, 9, normal, CINZA);

  y -= 10;
  // O rastro fica no próprio documento. Assinatura eletrônica sem data, hora e
  // origem é um desenho; com elas, é algo que se sustenta numa discussão.
  const rastro = [
    opts.declaradoEm ? `Fato declarado para: ${fmtBR(opts.declaradoEm)}` : null,
    `Assinado em: ${fmtBR(opts.assinadoEm)} (horário de Brasília)`,
    opts.ip ? `Origem: ${opts.ip}` : null,
  ].filter(Boolean) as string[];
  for (const linha of rastro) escrever(linha, 8.5, normal, CINZA, 1.5);

  return await pdf.save();
}

/**
 * Grava a assinatura, gera o PDF e devolve os caminhos.
 *
 * Não envia e-mail: quem chama decide para quem, porque o destinatário muda
 * conforme o termo (o dono do imóvel, e no futuro também o hóspede).
 */
export async function registrarTermo(
  db: SupabaseClient,
  entrada: EntradaTermo,
): Promise<ResultadoTermo> {
  const png = pngDoDataUrl(entrada.assinaturaDataUrl);
  const locale = entrada.locale ?? "pt";

  const { data: termo } = await db
    .from("term_versions")
    .select("id, title, body, version")
    .eq("kind", entrada.kind)
    .eq("locale", locale)
    .eq("active", true)
    .maybeSingle();

  // Sem termo publicado no idioma, cai para português em vez de falhar: é
  // melhor a pessoa assinar um documento que ela consegue ler no tradutor do
  // que não conseguir concluir o cadastro.
  const { data: fallback } = termo
    ? { data: null }
    : await db
        .from("term_versions")
        .select("id, title, body, version")
        .eq("kind", entrada.kind)
        .eq("locale", "pt")
        .eq("active", true)
        .maybeSingle();

  const usado = termo ?? fallback;
  if (!usado) throw errors.upstream("Termo indisponível no momento");

  const { data: imovel } = await db
    .from("properties")
    .select("name, owner_id")
    .eq("id", entrada.propertyId)
    .maybeSingle();

  if (!imovel) throw errors.notFound("Imóvel não encontrado");

  const assinadoEm = new Date().toISOString();
  const base = `${entrada.propertyId}/${crypto.randomUUID()}`;
  const assinaturaPath = `${base}/assinatura.png`;
  const pdfPath = `${base}/termo.pdf`;

  const up1 = await db.storage
    .from(BUCKET)
    .upload(assinaturaPath, png, { contentType: "image/png", upsert: false });
  if (up1.error) throw errors.upstream("Não consegui guardar a assinatura");

  const pdf = await montarPdf({
    titulo: usado.title,
    corpo: usado.body,
    imovel: imovel.name,
    detalhes: entrada.detalhes ?? [],
    signerName: entrada.signerName,
    signerDoc: entrada.signerDoc,
    declaradoEm: entrada.declaradoEm,
    assinadoEm,
    ip: entrada.ip,
    assinaturaPng: png,
  });

  const up2 = await db.storage
    .from(BUCKET)
    .upload(pdfPath, pdf, { contentType: "application/pdf", upsert: false });
  if (up2.error) throw errors.upstream("Não consegui gerar o documento");

  const { data: linha, error } = await db
    .from("assinaturas")
    .insert({
      kind: entrada.kind,
      property_id: entrada.propertyId,
      registration_id: entrada.registrationId ?? null,
      cleaning_task_id: entrada.cleaningTaskId ?? null,
      signer_user_id: entrada.signerUserId ?? null,
      signer_name: entrada.signerName,
      signer_doc: entrada.signerDoc ?? null,
      declarado_em: entrada.declaradoEm ?? null,
      assinado_em: assinadoEm,
      term_version_id: usado.id,
      term_texto: usado.body,
      term_titulo: usado.title,
      assinatura_path: assinaturaPath,
      pdf_path: pdfPath,
      ip: entrada.ip ?? null,
      user_agent: entrada.userAgent ?? null,
    })
    .select("id")
    .single();

  if (error || !linha) {
    console.error("Falha ao gravar assinatura:", error?.message);
    throw errors.upstream("Não consegui registrar a assinatura");
  }

  return { id: linha.id, pdfPath, assinaturaPath };
}

/**
 * Manda o termo assinado para o dono, com o PDF anexado.
 *
 * Este envio NÃO passa pela fila de notificações, e a razão é de contenção:
 * o worker da fila carrega o registro dos catorze templates transacionais do
 * produto, e mexer nele para acrescentar anexo colocaria em risco e-mails que
 * já funcionam — recuperação de senha, confirmação de cadastro, aviso de
 * calendário quebrado. Um documento assinado não vale esse risco.
 *
 * O preço é não ter o backoff da fila. Ele é pago de duas formas: a falha fica
 * gravada na própria linha (`pdf_enviado_em` continua nulo, e o painel do dono
 * mostra o termo mesmo assim), e o PDF nunca depende do e-mail para existir.
 *
 * Anexo e não link: documento que mora atrás de uma URL temporária deixa de
 * existir no dia em que a URL vence — normalmente o dia em que alguém precisou
 * dele.
 */
export async function enviarTermoPorEmail(
  db: SupabaseClient,
  opts: {
    assinaturaId: string;
    pdfPath: string;
    para: string;
    assunto: string;
    titulo: string;
    linhas: Array<[string, string]>;
    fecho: string;
    nomeArquivo: string;
  },
): Promise<boolean> {
  const chave = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!chave) {
    console.error("Termo sem envio: RESEND_API_KEY ausente");
    return false;
  }

  try {
    const { data: arquivo, error } = await db.storage.from(BUCKET).download(opts.pdfPath);
    if (error || !arquivo) throw new Error(error?.message ?? "PDF ausente");

    const bytes = new Uint8Array(await arquivo.arrayBuffer());

    // btoa em pedaços: `String.fromCharCode(...bytes)` estoura a pilha de
    // chamadas em arquivos de algumas centenas de KB, e o erro que aparece não
    // se parece com um erro de tamanho.
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const linhasHtml = opts.linhas
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 0;color:#8a9199;width:42%;">${esc(k)}</td>` +
          `<td style="padding:6px 0;font-weight:600;">${esc(v)}</td></tr>`,
      )
      .join("");

    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.titulo)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
<tr><td style="padding:24px 28px 8px;">
<div style="font-size:13px;font-weight:700;letter-spacing:.04em;color:#0f6d5f;text-transform:uppercase;">HospedePay</div>
<h1 style="margin:10px 0 0;font-size:20px;line-height:1.3;font-weight:700;">${esc(opts.titulo)}</h1>
</td></tr>
<tr><td style="padding:8px 28px 24px;font-size:15px;line-height:1.6;color:#33383d;">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0;font-size:14px;">${linhasHtml}</table>
<p>${esc(opts.fecho)}</p>
<p style="font-size:13px;color:#66707a;">O documento assinado vai anexado a este e-mail, em PDF. Ele também fica guardado no aplicativo.</p>
</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #eceef0;font-size:11px;line-height:1.5;color:#a4abb3;">
Esta mensagem foi enviada automaticamente de uma caixa que não é lida. Não responda a este e-mail.
</td></tr></table></body></html>`;

    const texto =
      `${opts.titulo}\n\n` +
      opts.linhas.map(([k, v]) => `${k}: ${v}`).join("\n") +
      `\n\n${opts.fecho}\nO PDF assinado está anexado a este e-mail.`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${Deno.env.get("EMAIL_FROM_NAME")?.trim() || "HospedePay"} <${
          Deno.env.get("EMAIL_FROM_ADDRESS")?.trim() || "nao-responda@hospedepay.org"
        }>`,
        to: [opts.para],
        subject: opts.assunto,
        html,
        text: texto,
        attachments: [{ filename: opts.nomeArquivo, content: btoa(bin) }],
      }),
    });

    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);

    await db
      .from("assinaturas")
      .update({ pdf_enviado_para: opts.para, pdf_enviado_em: new Date().toISOString() })
      .eq("id", opts.assinaturaId);

    return true;
  } catch (e) {
    // Não propaga: o termo existe, está gravado e aparece no app. O e-mail é a
    // entrega, não o documento.
    console.error("Termo não foi enviado por e-mail:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Link temporário do PDF, para anexar ou mandar por e-mail. */
export async function linkDoPdf(
  db: SupabaseClient,
  pdfPath: string,
  segundos = 60 * 60 * 24 * 30,
): Promise<string | null> {
  const { data } = await db.storage.from(BUCKET).createSignedUrl(pdfPath, segundos);
  return data?.signedUrl ?? null;
}
