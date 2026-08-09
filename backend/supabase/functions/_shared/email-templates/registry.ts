/**
 * Templates de e-mail transacional.
 *
 * Sem framework: cada template é uma função pura que recebe o payload e
 * devolve assunto + HTML + texto puro. Fácil de testar, fácil de traduzir,
 * e o HTML é simples de propósito — cliente de e-mail não é navegador.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

type Payload = Record<string, unknown>;
type Renderer = (p: Payload, locale: string) => RenderedEmail;

const s = (v: unknown, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

const esc = (v: unknown): string =>
  s(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const brDate = (v: unknown): string => {
  const raw = s(v);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : raw;
};

const money = (cents: unknown): string =>
  `R$ ${(Number(cents ?? 0) / 100).toFixed(2).replace(".", ",")}`;

/** Moldura comum: cabeçalho, corpo e rodapé. */
function layout(title: string, bodyHtml: string, footer?: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
<tr><td style="padding:24px 28px 8px;">
<div style="font-size:13px;font-weight:700;letter-spacing:.04em;color:#0f6d5f;text-transform:uppercase;">HospedePay</div>
<h1 style="margin:10px 0 0;font-size:20px;line-height:1.3;font-weight:700;">${esc(title)}</h1>
</td></tr>
<tr><td style="padding:8px 28px 24px;font-size:15px;line-height:1.6;color:#33383d;">
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #eceef0;font-size:12px;line-height:1.5;color:#8a9199;">
${footer ?? "Você recebeu este e-mail porque usa o HospedePay para gerenciar seu imóvel."}
</td></tr>
</table></body></html>`;
}

function rows(pairs: Array<[string, unknown]>): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0;font-size:14px;">
${pairs
    .filter(([, v]) => v !== null && v !== undefined && s(v) !== "")
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#8a9199;width:42%;">${esc(k)}</td>` +
        `<td style="padding:6px 0;font-weight:600;">${esc(v)}</td></tr>`,
    )
    .join("")}
</table>`;
}

function button(label: string, url: string): string {
  return `<p style="margin:22px 0;"><a href="${esc(url)}" style="display:inline-block;background:#0f6d5f;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;font-size:15px;">${esc(label)}</a></p>
<p style="margin:0;font-size:12px;color:#8a9199;word-break:break-all;">${esc(url)}</p>`;
}

// ---------------------------------------------------------------------------

const templates: Record<string, Renderer> = {
  /** Portaria: sai a CADA reserva confirmada, direto do calendário. */
  "condo-reservation": (p) => {
    const unit = [s(p.condo_name), p.block ? `Bloco ${s(p.block)}` : "", p.apt_number ? `Apto ${s(p.apt_number)}` : ""]
      .filter(Boolean)
      .join(" · ");
    const subject = `Hospedagem ${brDate(p.checkin_date)} a ${brDate(p.checkout_date)}${p.apt_number ? ` — Apto ${s(p.apt_number)}` : ""}`;

    const body = `<p>Prezados,</p>
<p>Informamos uma nova hospedagem na unidade abaixo, para conhecimento da portaria.</p>
${rows([
      ["Unidade", unit || s(p.property_name)],
      ["Entrada", `${brDate(p.checkin_date)} a partir das ${s(p.checkin_time, "15:00")}`],
      ["Saída", `${brDate(p.checkout_date)} até as ${s(p.checkout_time, "11:00")}`],
      ["Responsável", s(p.owner_name)],
      ["Contato", s(p.owner_phone)],
    ])}
<p>Os hóspedes fazem cadastro prévio com nome completo e documento, e aceitam termo de responsabilidade pela unidade.</p>
<p>Qualquer necessidade, o responsável está à disposição no contato acima.</p>`;

    const text = `Nova hospedagem\n\nUnidade: ${unit || s(p.property_name)}\nEntrada: ${brDate(p.checkin_date)} (${s(p.checkin_time, "15:00")})\nSaída: ${brDate(p.checkout_date)} (${s(p.checkout_time, "11:00")})\nResponsável: ${s(p.owner_name)} — ${s(p.owner_phone)}`;

    return {
      subject,
      html: layout("Nova hospedagem na unidade", body, "Mensagem automática enviada pelo responsável pela unidade."),
      text,
    };
  },

  /** Hóspede: instruções + cópia do termo. Isto não existia no backend antigo. */
  "guest-welcome": (p) => {
    const body = `<p>Olá, ${esc(s(p.guest_name).split(" ")[0])}!</p>
<p>Seu cadastro em <strong>${esc(p.property_name)}</strong> está confirmado. Guarde este e-mail: é por aqui que você volta ao assistente se fechar a página.</p>
${rows([
      ["Entrada", `${brDate(p.checkin_date)} a partir das ${s(p.checkin_time, "15:00")}`],
      ["Saída", `${brDate(p.checkout_date)} até as ${s(p.checkout_time, "11:00")}`],
    ])}
${button("Abrir o assistente do imóvel", s(p.chat_url))}
<p>No assistente você encontra Wi-Fi, como entrar, regras da casa e tira qualquer dúvida — 24 horas por dia.</p>
${p.has_porter ? "<p><strong>Portaria:</strong> baixe o app da portaria, crie a conta com este mesmo e-mail e faça o reconhecimento facial antes de chegar.</p>" : ""}
<p style="margin-top:20px;padding-top:16px;border-top:1px solid #eceef0;font-size:13px;color:#8a9199;">
Você aceitou o Termo de Responsabilidade (versão ${esc(p.term_version)}) no momento do cadastro, declarando ter registrado todos os hóspedes e assumindo a responsabilidade pelo imóvel durante a estadia.</p>`;

    return {
      subject: `Seu acesso em ${s(p.property_name)}`,
      html: layout("Cadastro confirmado", body, "Este e-mail foi enviado porque você se cadastrou para uma hospedagem."),
      text: `Olá, ${s(p.guest_name)}!\n\nCadastro confirmado em ${s(p.property_name)}.\nEntrada: ${brDate(p.checkin_date)} · Saída: ${brDate(p.checkout_date)}\n\nAssistente do imóvel: ${s(p.chat_url)}`,
    };
  },

  /** Dono: alguém se cadastrou. */
  "guest-registered": (p) => {
    const n = Number(p.guest_count ?? 1);
    const body = `<p>Um novo cadastro entrou em <strong>${esc(p.property_name)}</strong>.</p>
${rows([
      ["Hóspede responsável", s(p.primary_guest)],
      ["Total de pessoas", `${n}`],
      ["Entrada", brDate(p.checkin_date)],
      ["Saída", brDate(p.checkout_date)],
    ])}
<p>Todos aceitaram o termo de responsabilidade. Os dados completos estão no seu painel.</p>`;
    return {
      subject: `${n} hóspede${n > 1 ? "s" : ""} cadastrado${n > 1 ? "s" : ""} — ${s(p.property_name)}`,
      html: layout("Novo cadastro de hóspede", body),
      text: `Novo cadastro em ${s(p.property_name)}: ${s(p.primary_guest)} e mais ${n - 1}. ${brDate(p.checkin_date)} a ${brDate(p.checkout_date)}.`,
    };
  },

  /** Dono: limpeza concluída. */
  "cleaning-completed": (p) => {
    const body = `<p>A limpeza de <strong>${esc(p.property_name)}</strong> foi concluída.</p>
${rows([["Concluída em", s(p.completed_at)], ["Foto do imóvel", p.has_photo ? "Enviada" : "Não enviada"]])}
<p>O imóvel está pronto para o próximo hóspede.</p>`;
    return {
      subject: `Limpeza concluída — ${s(p.property_name)}`,
      html: layout("Limpeza concluída", body),
      text: `Limpeza concluída em ${s(p.property_name)} (${s(p.completed_at)}).`,
    };
  },

  /** Diarista: convite (plano B do WhatsApp). */
  "cleaner-invite": (p) => {
    const body = `<p>Olá, ${esc(s(p.cleaner_name).split(" ")[0])}!</p>
<p><strong>${esc(p.owner_name)}</strong> colocou a agenda dos apartamentos num app para facilitar seu trabalho. Você vê os horários de saída direto no celular, sem precisar ser avisada toda vez.</p>
${button("Entrar (não precisa criar senha)", s(p.accept_url))}
<p>É só tocar no botão. Nenhuma senha, nenhum cadastro.</p>`;
    return {
      subject: `${s(p.owner_name)} te adicionou à agenda de limpezas`,
      html: layout("Seu acesso à agenda", body, "Você recebeu este convite de um cliente que usa o HospedePay."),
      text: `Olá, ${s(p.cleaner_name)}! ${s(p.owner_name)} te adicionou à agenda de limpezas.\nEntre aqui (sem senha): ${s(p.accept_url)}`,
    };
  },

  /** Dono: fechamento do mês. Torna visível um produto que, funcionando, é invisível. */
  "monthly-report": (p) => {
    const body = `<p>Seu resumo de <strong>${esc(p.month_label)}</strong>:</p>
${rows([
      ["Check-outs no período", s(p.checkouts)],
      ["Limpezas concluídas", s(p.cleanings)],
      ["Gasto com diárias", money(p.turnover_cents)],
      ["Reposição de produtos", money(p.fees_cents)],
      ["Total do mês", money(p.total_cents)],
      ["Hóspedes cadastrados", s(p.guests_registered)],
      ["Perguntas respondidas pela assistente", s(p.ai_answers)],
    ])}
<p>Tudo isso aconteceu no automático, sem você precisar avisar ninguém.</p>
${p.dashboard_url ? button("Ver o painel completo", s(p.dashboard_url)) : ""}`;
    return {
      subject: `Seu mês em números — ${s(p.month_label)}`,
      html: layout(`Resumo de ${s(p.month_label)}`, body),
      text: `Resumo de ${s(p.month_label)}: ${s(p.checkouts)} check-outs, ${s(p.cleanings)} limpezas, total ${money(p.total_cents)}.`,
    };
  },

  /** Dono: trial terminando. */
  "trial-ending": (p) => {
    const days = Number(p.days_left ?? 0);
    const body = `<p>Seu período de teste termina ${days <= 1 ? "amanhã" : `em ${days} dias`}.</p>
<p>Nesse período o sistema registrou <strong>${esc(p.checkouts)} check-out(s)</strong> e organizou <strong>${esc(p.cleanings)} limpeza(s)</strong> sem você precisar avisar ninguém.</p>
<p>Para continuar, é só ativar sua assinatura.</p>
${p.checkout_url ? button("Ativar assinatura", s(p.checkout_url)) : ""}`;
    return {
      subject: days <= 1 ? "Seu teste termina amanhã" : `Seu teste termina em ${days} dias`,
      html: layout("Seu período de teste está acabando", body),
      text: `Seu teste termina em ${days} dia(s). Ative sua assinatura para continuar: ${s(p.checkout_url)}`,
    };
  },

  /** Dono: acesso expirado. */
  "subscription-expired": (p) => {
    const body = `<p>Sua assinatura está inativa, então a sincronização dos calendários e o atendimento aos hóspedes foram pausados.</p>
<p>Seus dados continuam salvos — nada foi apagado. Reativando, tudo volta a funcionar de onde parou.</p>
${p.checkout_url ? button("Reativar assinatura", s(p.checkout_url)) : ""}`;
    return {
      subject: "Sua assinatura está inativa",
      html: layout("Assinatura inativa", body),
      text: `Sua assinatura está inativa e a sincronização foi pausada. Reative em: ${s(p.checkout_url)}`,
    };
  },

  /** Dono: calendário parou de sincronizar — antes dele descobrir sozinho. */
  "ical-broken": (p) => {
    const body = `<p>O calendário do <strong>${esc(p.provider)}</strong> de <strong>${esc(p.property_name)}</strong> parou de responder nas últimas tentativas.</p>
<p>Enquanto isso, reservas novas desse canal não viram limpeza automaticamente.</p>
<p>Isso normalmente acontece quando o link é regerado na plataforma. Gere um link novo e cole no app — leva um minuto.</p>
${p.fix_url ? button("Atualizar o calendário", s(p.fix_url)) : ""}`;
    return {
      subject: `Ação necessária: calendário de ${s(p.property_name)}`,
      html: layout("Um calendário parou de sincronizar", body),
      text: `O calendário ${s(p.provider)} de ${s(p.property_name)} parou de responder. Gere um link novo e atualize no app.`,
    };
  },
};

export function renderEmail(
  template: string,
  payload: Payload,
  locale = "pt",
): RenderedEmail {
  const renderer = templates[template];
  if (!renderer) throw new Error(`Template de e-mail desconhecido: ${template}`);
  return renderer(payload, locale);
}

export function hasTemplate(name: string): boolean {
  return name in templates;
}

export const templateNames = Object.keys(templates);
