import { errors, handler, json } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";

/**
 * O hóspede avisa que saiu do apartamento.
 *
 * O checkout contratual é às 11h; a saída real é quando a mala atravessa a
 * porta. A diarista não sabe a hora real, então chega "quando dá" — e o
 * intervalo entre a saída e a chegada dela é tempo morto que ninguém enxerga,
 * justamente no dia em que outro hóspede entra às 15h.
 *
 * Este endpoint transforma o aviso num timestamp que aparece na agenda dela:
 * "o apartamento liberou às 10h42". Sem aprovação, sem mensagem, sem ninguém
 * no meio — que é o combinado do produto inteiro.
 *
 * Autorização pelo token de sessão do cadastro (`x-guest-token`): só quem se
 * cadastrou naquela estadia consegue declarar a saída dela.
 */

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const token = req.headers.get("x-guest-token")?.trim();
  if (!token) throw errors.unauthorized("Sessão ausente");

  const db = admin();

  const { data: hashRow } = await db.rpc("hash_token", { _token: token });
  const { data: sessao } = await db
    .from("guest_sessions")
    .select("id, property_id, registration_id, expires_at")
    .eq("token_hash", hashRow as unknown as string)
    .maybeSingle();

  if (!sessao || new Date(sessao.expires_at) < new Date()) {
    throw errors.unauthorized("Sessão inválida ou expirada");
  }

  const { data: cadastro } = await db
    .from("guest_registrations")
    .select("id, checkin_date, checkout_date, saida_confirmada_em")
    .eq("id", sessao.registration_id)
    .maybeSingle();

  if (!cadastro) throw errors.notFound("Cadastro não encontrado");

  // Idempotente: dois toques no botão, ou duas pessoas da mesma estadia
  // confirmando, não podem virar dois horários diferentes. Vale o primeiro —
  // o apartamento só libera uma vez.
  if (cadastro.saida_confirmada_em) {
    return json({ ok: true, saida_em: cadastro.saida_confirmada_em, ja_confirmado: true });
  }

  const agora = new Date().toISOString();

  await db
    .from("guest_registrations")
    .update({ saida_confirmada_em: agora })
    .eq("id", cadastro.id)
    .is("saida_confirmada_em", null);

  // O mesmo carimbo vai para a tarefa de limpeza da estadia, porque é lá que a
  // diarista olha. Sem tarefa casada (imóvel self-clean, tarefa cancelada), o
  // carimbo do cadastro basta — não é erro.
  await db
    .from("cleaning_tasks")
    .update({ hospede_saiu_em: agora })
    .eq("property_id", sessao.property_id)
    .eq("checkout_date", cadastro.checkout_date)
    .neq("status", "cancelled")
    .is("hospede_saiu_em", null);

  return json({ ok: true, saida_em: agora });
});
