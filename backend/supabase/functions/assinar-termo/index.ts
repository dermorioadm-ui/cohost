import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireUser } from "../_shared/lib/db.ts";
import { registrarTermo } from "../_shared/lib/termo.ts";

/**
 * Declaração de limpeza concluída, assinada pela diarista.
 *
 * Por que existe: hoje a limpeza "aconteceu" porque alguém apertou um botão.
 * Isso basta para a agenda funcionar e não basta para uma discussão — quando o
 * hóspede reclama que chegou num imóvel sujo, o dono não tem nada além de um
 * registro que o próprio app criou.
 *
 * A data e a hora vêm da DIARISTA, não do relógio do servidor. Ela assina de
 * noite a limpeza que fez de manhã, e a declaração precisa dizer o que ela
 * declarou. O horário do servidor entra em outro campo, junto com a origem, e
 * é isso que separa o que a pessoa afirmou do que o sistema observou.
 */

interface Body {
  cleaning_task_id?: string;
  /** Quando a limpeza foi feita, segundo ela. */
  declarado_em?: string;
  signer_name?: string;
  signer_doc?: string;
  assinatura?: string;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : null;
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

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireUser(req);
  const body = await readJson<Body>(req);
  const db = admin();

  if (!body.cleaning_task_id) throw errors.invalid("Informe a limpeza");
  if (!body.assinatura) throw errors.invalid("Assine antes de enviar");

  const nome = (body.signer_name ?? "").trim();
  if (nome.length < 3) throw errors.invalid("Informe seu nome completo");

  const { data: tarefa } = await db
    .from("cleaning_tasks")
    .select("id, property_id, cleaner_id, checkout_date, assinatura_id, properties(name, owner_id)")
    .eq("id", body.cleaning_task_id)
    .maybeSingle();

  if (!tarefa) throw errors.notFound("Limpeza não encontrada");

  // Só quem faz a limpeza assina por ela. O dono não pode assinar no lugar da
  // diarista: um termo que o interessado consegue emitir sozinho não prova nada.
  if (tarefa.cleaner_id !== user.id) {
    throw errors.forbidden("Só a diarista da limpeza pode assinar esta declaração");
  }

  if (tarefa.assinatura_id) {
    throw errors.invalid("Esta limpeza já tem uma declaração assinada");
  }

  // A data declarada é limitada dos dois lados. Sem limite, um erro de digitação
  // vira uma declaração para 2027 — e o documento nasce contestável.
  const declarado = body.declarado_em ? new Date(body.declarado_em) : new Date();
  if (Number.isNaN(declarado.getTime())) throw errors.invalid("Data inválida");

  const agora = Date.now();
  if (declarado.getTime() > agora + 60 * 60 * 1000) {
    throw errors.invalid("A data da limpeza não pode estar no futuro");
  }
  if (declarado.getTime() < agora - 90 * 24 * 60 * 60 * 1000) {
    throw errors.invalid("Essa data é antiga demais para declarar agora");
  }

  const imovel = tarefa.properties as unknown as { name: string; owner_id: string };

  const termo = await registrarTermo(db, {
    kind: "limpeza_concluida",
    propertyId: tarefa.property_id,
    cleaningTaskId: tarefa.id,
    signerUserId: user.id,
    signerName: nome,
    signerDoc: body.signer_doc?.trim() || null,
    declaradoEm: declarado.toISOString(),
    assinaturaDataUrl: body.assinatura,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    detalhes: [
      ["Imóvel", imovel.name],
      ["Saída do hóspede", tarefa.checkout_date],
      ["Limpeza declarada para", fmtBR(declarado.toISOString())],
    ],
  });

  // A tarefa passa a apontar para a declaração, e fecha junto: assinar é a
  // forma mais forte de dizer "fiz", e obrigar os dois toques seria pedir à
  // pessoa que confirme duas vezes a mesma coisa.
  await db
    .from("cleaning_tasks")
    .update({
      assinatura_id: termo.id,
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: user.id,
    })
    .eq("id", tarefa.id);

  // O dono recebe o PDF. É dele o documento — a diarista assinou para ele ter.
  const { data: dono } = await db
    .from("profiles")
    .select("email, locale")
    .eq("user_id", imovel.owner_id)
    .maybeSingle();

  if (dono?.email) {
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "termo-limpeza",
      _payload: {
        property_name: imovel.name,
        cleaner_name: nome,
        declarado_em: fmtBR(declarado.toISOString()),
        checkout_date: tarefa.checkout_date,
        __anexo_path: termo.pdfPath,
        __anexo_nome: "declaracao-de-limpeza.pdf",
      },
      _to_email: dono.email,
      _to_user_id: imovel.owner_id,
      _idempotency_key: `termo-limpeza:${termo.id}`,
      _locale: dono.locale ?? "pt",
      _entity: "assinaturas",
      _entity_id: termo.id,
    });

    await db
      .from("assinaturas")
      .update({ pdf_enviado_para: dono.email, pdf_enviado_em: new Date().toISOString() })
      .eq("id", termo.id);
  }

  return json({ ok: true, id: termo.id });
});
