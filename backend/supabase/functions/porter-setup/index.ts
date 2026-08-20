import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Implantação da portaria digital — o serviço de taxa avulsa.
 *
 * Por que isto é serviço e não funcionalidade: cada prédio usa um sistema
 * diferente, com credenciais que só o síndico entrega e um fluxo de captura
 * que muda a cada versão do app da portaria. Não existe "ligar sozinho". O que
 * o cliente compra é o trabalho da equipe técnica de fazer aquele prédio
 * específico falar com a plataforma.
 *
 * O preço vem do BANCO, não do corpo da requisição. Aceitar valor do cliente
 * num endpoint de pagamento é deixá-lo escolher quanto pagar.
 *
 * O status também não vem daqui: o `checkout.session.completed` da Stripe é
 * quem promove `interessado` para `pago`. Marcar como pago no clique deixaria
 * a fila da equipe cheia de gente que desistiu no cartão.
 */

const PRECO_PADRAO_CENTS = 19700;

interface Body {
  property_id?: string;
  condo_name?: string;
  condo_system?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const body = await readJson<Body>(req);

  if (!body.property_id) throw errors.invalid("Informe o imóvel");

  const db = admin();

  const { data: imovel } = await db
    .from("properties")
    .select("id, name")
    .eq("id", body.property_id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!imovel) throw errors.notFound("Imóvel não encontrado");

  // Já existe pedido vivo? Devolve o que existe em vez de criar outro. O índice
  // único no banco barraria de qualquer jeito, mas devolver o estado é melhor
  // resposta do que um erro de constraint traduzido para o cliente.
  const { data: existente } = await db
    .from("porter_setup_requests")
    .select("id, status, paid_at")
    .eq("property_id", imovel.id)
    .neq("status", "cancelado")
    .maybeSingle();

  if (existente && existente.status !== "interessado") {
    return json({
      ok: true,
      ja_existe: true,
      status: existente.status,
      message:
        existente.status === "implantado"
          ? "A portaria deste imóvel já está implantada."
          : "Já recebemos seu pedido. Nossa equipe entra em contato.",
    });
  }

  const pedidoId =
    existente?.id ??
    (
      await db
        .from("porter_setup_requests")
        .insert({
          property_id: imovel.id,
          owner_id: user.id,
          status: "interessado",
          amount_cents: PRECO_PADRAO_CENTS,
          condo_name: body.condo_name?.trim() || null,
          condo_system: body.condo_system?.trim() || null,
        })
        .select("id")
        .single()
    ).data?.id;

  if (!pedidoId) throw errors.upstream("Não consegui registrar o pedido");

  const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });

  const sessao = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: PRECO_PADRAO_CENTS,
          product_data: {
            name: "Implantação da portaria digital",
            description:
              `Integração do ${imovel.name} com o sistema da portaria, feita pela nossa ` +
              `equipe técnica. Depois dela o hóspede é cadastrado no prédio sozinho.`,
          },
        },
      },
    ],
    // O id do pedido viaja com a sessão: é por ele que o webhook sabe qual
    // linha promover quando o pagamento entrar.
    metadata: { porter_setup_id: pedidoId, property_id: imovel.id },
    success_url: `${env.appBaseUrl()}/portaria?implantacao=ok`,
    cancel_url: `${env.appBaseUrl()}/portaria?implantacao=cancelado`,
  });

  await db
    .from("porter_setup_requests")
    .update({ stripe_session_id: sessao.id, updated_at: new Date().toISOString() })
    .eq("id", pedidoId);

  return json({ ok: true, checkout_url: sessao.url });
});
