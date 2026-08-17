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

/**
 * Aviso de caixa não monitorada.
 *
 * Vai em TODO e-mail, dentro do `layout`, e não linha a linha em cada
 * template: um único ponto de saída é o que garante que ninguém publique um
 * template novo sem o aviso. O endereço remetente é `nao-responda@`, mas o
 * nome do domínio não é instrução — muita gente responde assim mesmo, e a
 * resposta morre num buraco sem que ela saiba.
 *
 * Por isso o aviso diz para onde ir, e não só que não adianta responder.
 */
const NO_REPLY =
  "Esta mensagem foi enviada automaticamente de uma caixa que não é lida. " +
  "Não responda a este e-mail — se precisar de ajuda, fale com quem te enviou o link " +
  "ou use o assistente dentro do aplicativo.";

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
<tr><td style="padding:16px 28px 20px;border-top:1px solid #eceef0;font-size:12px;line-height:1.5;color:#8a9199;">
${footer ?? "Você recebeu este e-mail porque usa o HospedePay para gerenciar seu imóvel."}
</td></tr>
<tr><td style="padding:0 28px 22px;font-size:11px;line-height:1.5;color:#a4abb3;">
${NO_REPLY}
</td></tr>
</table></body></html>`;
}

/** Mesmo aviso, para a versão em texto puro. */
const noReplyText = (body: string) => `${body}\n\n---\n${NO_REPLY}`;

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

  /**
   * Hóspede: comprovante do cadastro + cópia do termo aceito.
   *
   * Este e-mail é o RECIBO da estadia — é a única prova que o hóspede guarda
   * de que se cadastrou e de que aceitou o termo. Por isso o aceite não é uma
   * nota de rodapé: vem em bloco próprio, com a versão e a data, do jeito que
   * ele precisaria mostrar se um dia houver discussão sobre o que foi
   * combinado. O acesso ao assistente vem junto porque quem fecha a aba perde
   * Wi-Fi e código da fechadura.
   */
  "guest-welcome": (p) => {
    const body = `<p>Olá, ${esc(s(p.guest_name).split(" ")[0])}!</p>
<p>Seu cadastro em <strong>${esc(p.property_name)}</strong> foi concluído com sucesso e o termo de responsabilidade da hospedagem foi aceito. Não é preciso fazer mais nada.</p>
${rows([
      ["Entrada", `${brDate(p.checkin_date)} a partir das ${s(p.checkin_time, "15:00")}`],
      ["Saída", `${brDate(p.checkout_date)} até as ${s(p.checkout_time, "11:00")}`],
      ["Pessoas cadastradas", s(p.guest_count)],
    ])}
<div style="margin:18px 0;padding:14px 16px;background:#eef7f4;border-left:3px solid #0f6d5f;border-radius:8px;font-size:14px;line-height:1.55;">
<strong style="color:#0f6d5f;">Termo de responsabilidade aceito</strong><br>
Versão ${esc(s(p.term_version, "1.0"))}${p.term_accepted_at ? ` · aceito em ${esc(p.term_accepted_at)}` : ""}.<br>
Ao aceitar, você declarou ter cadastrado <strong>todas as pessoas</strong> que vão se hospedar, respeitando o limite de ocupação, e assumiu a responsabilidade pelo imóvel durante a estadia, ciente da vistoria ao término.
</div>
${button("Abrir o assistente do imóvel", s(p.chat_url))}
<p>No assistente você encontra Wi-Fi, como entrar, regras da casa e tira qualquer dúvida — 24 horas por dia. Guarde este e-mail: é por aqui que você volta se fechar a página.</p>
${p.has_porter ? `<div style="margin:18px 0;padding:14px 16px;background:#fff7e8;border-left:3px solid #d98324;border-radius:8px;font-size:14px;line-height:1.55;"><strong style="color:#a8630f;">Antes de chegar: portaria</strong><br>Baixe o aplicativo da portaria, crie a conta com <strong>este mesmo e-mail</strong> e faça o reconhecimento facial. É ele que libera sua entrada e os portões pelo celular.</div>` : ""}`;

    return {
      subject: `Cadastro confirmado — ${s(p.property_name)}`,
      html: layout(
        "Cadastro concluído com sucesso",
        body,
        "Este e-mail é o comprovante do seu cadastro e do termo aceito. Guarde-o até o fim da estadia.",
      ),
      text: `Olá, ${s(p.guest_name)}!\n\nCadastro concluído com sucesso em ${s(p.property_name)}, e o termo de responsabilidade foi aceito (versão ${s(p.term_version, "1.0")}).\n\nEntrada: ${brDate(p.checkin_date)} a partir das ${s(p.checkin_time, "15:00")}\nSaída: ${brDate(p.checkout_date)} até as ${s(p.checkout_time, "11:00")}\n\nAssistente do imóvel (Wi-Fi, acesso, regras): ${s(p.chat_url)}`,
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

  /**
   * Novo assinante: boas-vindas com o caminho até o primeiro checkout automático.
   *
   * Não é um e-mail de agradecimento — é a lista do que precisa acontecer para
   * o produto começar a funcionar. Quem assina e não conecta o calendário não
   * vê valor nenhum e cancela no primeiro mês, e o app inteiro fica esperando
   * três passos que ninguém explicou em ordem.
   */
  "welcome-subscriber": (p) => {
    const body = `<p>Olá, ${esc(s(p.owner_name, "tudo bem").split(" ")[0])}!</p>
<p>Sua assinatura do <strong>HospedePay</strong> está ativa${p.plan_label ? ` no plano <strong>${esc(p.plan_label)}</strong>` : ""}. A partir de agora o checkout do seu imóvel roda sozinho — falta só ligar as peças, e são três.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:18px 0;font-size:14px;line-height:1.55;">
<tr><td style="padding:10px 0;border-bottom:1px solid #eceef0;">
<strong>1. Conecte o calendário</strong><br>
<span style="color:#66707a;">Cole o link iCal do Airbnb e do Booking. É o passo que faz todo o resto acontecer: cada reserva vira limpeza na agenda sozinha.</span>
</td></tr>
<tr><td style="padding:10px 0;border-bottom:1px solid #eceef0;">
<strong>2. Convide a diarista</strong><br>
<span style="color:#66707a;">Ela entra pelo link no WhatsApp, sem senha e sem cadastro, e passa a ver os horários de saída no celular.</span>
</td></tr>
<tr><td style="padding:10px 0;">
<strong>3. Cole a mensagem automática no Airbnb</strong><br>
<span style="color:#66707a;">É ela que leva o hóspede ao cadastro e ao assistente 24h. O app gera o texto pronto, com o seu link.</span>
</td></tr>
</table>

${p.dashboard_url ? button("Configurar meu imóvel", s(p.dashboard_url)) : ""}
<p>Depois disso, o trabalho manual acaba: reserva entra, limpeza é agendada, hóspede se cadastra e a portaria é avisada — sem você no meio.</p>`;

    return {
      subject: "Sua assinatura está ativa — comece por aqui",
      html: layout(
        "Bem-vindo ao HospedePay",
        body,
        "Você recebeu este e-mail porque acabou de ativar sua assinatura.",
      ),
      text: `Olá, ${s(p.owner_name)}!\n\nSua assinatura do HospedePay está ativa${p.plan_label ? ` (plano ${s(p.plan_label)})` : ""}.\n\nTrês passos para o checkout rodar sozinho:\n1. Conecte o calendário (link iCal do Airbnb/Booking)\n2. Convide a diarista (ela entra sem senha)\n3. Cole a mensagem automática no Airbnb\n\nConfigurar: ${s(p.dashboard_url)}`,
    };
  },

  /**
   * Interno: alguém assinou.
   *
   * Vai para a caixa de quem opera a plataforma, não para o cliente. Serve
   * para saber que entrou dinheiro e, principalmente, PARA QUEM ligar quando o
   * cliente novo travar no primeiro passo — que é quando o cancelamento
   * acontece e ninguém fica sabendo.
   */
  "admin-new-subscriber": (p) => {
    const body = `<p>Assinatura nova ativada.</p>
${rows([
      ["Nome", s(p.owner_name, "—")],
      ["E-mail", s(p.owner_email)],
      ["WhatsApp", s(p.owner_phone, "—")],
      ["Plano", s(p.plan_label, s(p.plan))],
      ["Ciclo", s(p.billing_cycle) === "yearly" ? "Anual" : "Mensal"],
      ["Situação", s(p.status) === "trialing" ? "Em teste" : "Ativa"],
      ["Imóveis cadastrados", s(p.property_count, "0")],
    ])}
<p>Se em alguns dias os imóveis continuarem em zero ou sem calendário conectado, é sinal de que travou no primeiro passo.</p>`;

    return {
      subject: `Novo assinante: ${s(p.owner_name, s(p.owner_email))} — ${s(p.plan_label, s(p.plan))}`,
      html: layout("Nova assinatura", body, "Aviso interno da plataforma HospedePay."),
      text: `Nova assinatura.\nNome: ${s(p.owner_name)}\nE-mail: ${s(p.owner_email)}\nWhatsApp: ${s(p.owner_phone)}\nPlano: ${s(p.plan_label, s(p.plan))} (${s(p.billing_cycle)})\nSituação: ${s(p.status)}\nImóveis: ${s(p.property_count, "0")}`,
    };
  },

  /**
   * Recuperação de senha.
   *
   * O link é de uso único e curto de propósito. O texto evita a armadilha
   * clássica de "se você não pediu, ignore": quem não pediu precisa saber que
   * ninguém entrou na conta dele — o pedido de recuperação sozinho não dá
   * acesso a nada, e dizer isso corta o susto pela metade.
   */
  "password-reset": (p) => {
    const minutos = Number(p.expires_minutes ?? 60);
    const body = `<p>Recebemos um pedido para redefinir a senha da conta <strong>${esc(p.email)}</strong>.</p>
<p>Toque no botão abaixo para escolher uma senha nova. O link vale por ${esc(minutos)} minutos e só funciona uma vez.</p>
${button("Criar uma senha nova", s(p.reset_url))}
<p style="margin-top:20px;padding-top:16px;border-top:1px solid #eceef0;font-size:13px;color:#66707a;">
<strong>Não foi você?</strong> Pode ignorar esta mensagem — sua senha atual continua valendo e ninguém entrou na sua conta. Um pedido de recuperação, sozinho, não dá acesso a nada: só quem abre este link consegue trocar a senha.</p>`;

    return {
      subject: "Redefinir sua senha do HospedePay",
      html: layout(
        "Redefinir sua senha",
        body,
        "Este e-mail foi enviado porque alguém pediu a recuperação de senha desta conta.",
      ),
      text: `Pedido de redefinição de senha para ${s(p.email)}.\n\nCrie uma senha nova (link válido por ${minutos} minutos, uso único):\n${s(p.reset_url)}\n\nSe não foi você, ignore: sua senha atual continua valendo e ninguém entrou na sua conta.`,
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
  const email = renderer(payload, locale);
  // O aviso de não-resposta é colado aqui, e não dentro de cada template: o
  // HTML já ganha o dele no `layout`, e a versão texto ganha o dela aqui.
  // Assim não existe caminho para publicar um template sem o aviso.
  return { ...email, text: noReplyText(email.text) };
}

export function hasTemplate(name: string): boolean {
  return name in templates;
}

export const templateNames = Object.keys(templates);
