import { errors, handler, json } from "../_shared/lib/http.ts";
import { admin, appToday, addDays, requireCron } from "../_shared/lib/db.ts";

/**
 * Retenção de dados sensíveis (LGPD, art. 15 e 16).
 *
 * O cadastro coleta CPF, foto de documento e foto de rosto. Coletar com
 * consentimento resolve a entrada; o que resolve a PERMANÊNCIA é ter um prazo
 * e cumpri-lo — dado sensível guardado "para sempre" é passivo jurídico e
 * superfície de vazamento, nas mesmas proporções.
 *
 * A regra: 180 dias depois do checkout, a foto do documento e a foto do rosto
 * são apagadas do storage e as colunas apontam para nada. O PDF do termo
 * assinado FICA — ele é documento jurídico com base legal própria (execução de
 * contrato, art. 7º V), e as imagens embutidas nele fazem parte do documento.
 * O que expira é o arquivo solto, não o termo.
 *
 * Roda todo dia pelo pg_cron, em lotes pequenos: o atraso de um dia não
 * importa, e um lote gigante numa madrugada é o que derruba a function.
 */

const DIAS_DE_RETENCAO = 180;
const LOTE = 100;

export default handler(async (req) => {
  await requireCron(req);

  const db = admin();
  const limite = addDays(appToday(), -DIAS_DE_RETENCAO);
  let documentosApagados = 0;
  let rostosApagados = 0;

  // ---- fotos de documento --------------------------------------------------
  const { data: vencidos, error: e1 } = await db
    .from("guest_people")
    .select("id, document_photo_path, guest_registrations!inner(checkout_date)")
    .not("document_photo_path", "is", null)
    .lt("guest_registrations.checkout_date", limite)
    .limit(LOTE);

  if (e1) throw errors.upstream(`Falha ao listar documentos vencidos: ${e1.message}`);

  for (const pessoa of vencidos ?? []) {
    const caminho = pessoa.document_photo_path as string;
    const { error: eRm } = await db.storage.from("documentos").remove([caminho]);
    // Arquivo já ausente não é falha — a coluna é que está atrasada.
    if (eRm && !/not.*found/i.test(eRm.message)) {
      console.error(`Retenção: não removi ${caminho}: ${eRm.message}`);
      continue;
    }
    await db.from("guest_people").update({ document_photo_path: null }).eq("id", pessoa.id);
    documentosApagados++;
  }

  // ---- fotos de rosto ------------------------------------------------------
  const { data: selfies, error: e2 } = await db
    .from("assinaturas")
    .select("id, selfie_path")
    .not("selfie_path", "is", null)
    .lt("assinado_em", `${limite}T00:00:00Z`)
    .limit(LOTE);

  if (e2) throw errors.upstream(`Falha ao listar rostos vencidos: ${e2.message}`);

  for (const a of selfies ?? []) {
    const caminho = a.selfie_path as string;
    const { error: eRm } = await db.storage.from("termos").remove([caminho]);
    if (eRm && !/not.*found/i.test(eRm.message)) {
      console.error(`Retenção: não removi ${caminho}: ${eRm.message}`);
      continue;
    }
    await db.from("assinaturas").update({ selfie_path: null }).eq("id", a.id);
    rostosApagados++;
  }

  // A linha no log é o que prova, numa fiscalização, que a política de
  // retenção não é só um texto — ela roda e deixa rastro.
  if (documentosApagados + rostosApagados > 0) {
    await db.from("system_log").insert({
      origem: "job:retencao",
      acao: "expurgo_lgpd",
      detalhe: `${documentosApagados} documento(s) e ${rostosApagados} rosto(s) apagados (${DIAS_DE_RETENCAO} dias após o checkout)`,
    });
  }

  return json({ ok: true, documentos: documentosApagados, rostos: rostosApagados });
});
