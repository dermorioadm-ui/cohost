import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { asUser } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Duplicar o imóvel para um segundo anúncio.
 *
 * A função vive no banco (`duplicar_imovel`) porque criar a cópia e cruzar os
 * dois calendários precisa acontecer numa transação só: se o par nascesse pela
 * metade, o dono teria dois anúncios do mesmo apartamento sem bloqueio entre
 * eles — exatamente a situação que a duplicação existe para evitar, só que
 * agora com a aparência de estar resolvida.
 *
 * O que esta camada acrescenta é a BASE da URL do feed. Ela não pode vir do
 * cliente: quem escolhe o endereço do feed escolhe para onde o calendário do
 * imóvel é publicado.
 *
 * Roda no contexto do usuário (`asUser`) de propósito. A função no banco
 * autoriza pelo `auth.uid()`, e usar o cliente de serviço aqui apagaria essa
 * checagem — qualquer id de imóvel passaria a duplicar o imóvel de qualquer um.
 */

interface Body {
  property_id?: string;
  nome?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) throw errors.unauthorized();

  const body = await readJson<Body>(req);
  if (!body.property_id) throw errors.invalid("Informe o imóvel");

  const db = asUser(auth);

  const { data, error } = await db.rpc("duplicar_imovel", {
    _property_id: body.property_id,
    _nome: body.nome?.trim() || null,
    _feed_base: `${env.supabaseUrl()}/functions/v1/ical-feed`,
  });

  if (error) {
    // 42501 é a recusa da própria função quando o imóvel não é de quem pediu.
    if (error.code === "42501") throw errors.notFound("Imóvel não encontrado");
    console.error("Falha ao duplicar:", error.message);
    throw errors.upstream("Não consegui duplicar o imóvel");
  }

  return json({ ok: true, ...(data as Record<string, unknown>) });
});
