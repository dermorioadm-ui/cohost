import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Checkout direto da página de vendas, sem conta.
 *
 * O botão "Assinar" abre a Stripe na hora. Nome, e-mail e telefone são
 * pedidos lá, uma vez só; a conta nasce depois do pagamento (ver
 * `_shared/lib/checkout-publico.ts`). Antes, o caminho era cadastro →
 * e-mail de confirmação → login → checkout: três telas em que se desiste
 * antes de pagar.
 *
 * Público, e por isso só aceita duas coisas do cliente: tier e ciclo. O preço
 * vem SEMPRE de `plans`. Quem já tem conta e está logado usa
 * `billing-checkout`, que amarra o checkout ao usuário desde o início.
 */

interface Body {
  tier?: "essencial" | "pro" | "ilimitado";
  cycle?: "monthly" | "annual";
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const { tier = "essencial", cycle = "annual" } = await readJson<Body>(req);
  if (!["essencial", "pro", "ilimitado"].includes(tier)) throw errors.invalid("Plano inválido");
  if (!["monthly", "annual"].includes(cycle)) throw errors.invalid("Ciclo inválido");

  const db = admin();
  const { data: plan } = await db
    .from("plans")
    .select("tier, name, stripe_price_monthly, stripe_price_annual, active")
    .eq("tier", tier)
    .maybeSingle();
  if (!plan || !plan.active) throw errors.notFound("Plano não disponível");

  const priceId = cycle === "annual" ? plan.stripe_price_annual : plan.stripe_price_monthly;
  if (!priceId || !priceId.startsWith("price_")) {
    throw errors.upstream(
      `O plano ${plan.name} (${cycle === "annual" ? "anual" : "mensal"}) ainda não tem preço ` +
        `configurado na Stripe. Rode billing-sync-plans.`,
    );
  }

  const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });
  const base = env.appBaseUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    // Sem teste grátis: cartão obrigatório, cobrança imediata.
    payment_method_collection: "always",
    // O telefone é o WhatsApp do anfitrião — o único canal em que a
    // implementação de 15 minutos acontece. A Stripe já tem o campo.
    phone_number_collection: { enabled: true },
    metadata: { hospedepay_tier: tier, hospedepay_cycle: cycle, origem: "pagina" },
    subscription_data: { metadata: { hospedepay_tier: tier, hospedepay_cycle: cycle } },
    success_url: `${base}/assinatura?status=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/?checkout=cancelado#planos`,
    locale: "pt-BR",
    allow_promotion_codes: true,
    // A frase embaixo do botão de pagar: o que acontece no segundo seguinte.
    // É a resposta à única dúvida que sobra na hora do cartão.
    custom_text: {
      submit: {
        message: "Depois do pagamento, entre com o e-mail usado na compra. Se ainda não tiver senha, solicite o link para criá-la. Em seguida, configure seu imóvel.",
      },
    },
  });

  await db.from("audit_log").insert({
    actor_role: "owner",
    action: "billing.checkout_publico_criado",
    entity: "checkout",
    entity_id: session.id,
    metadata: { tier, cycle },
  });

  return json({ ok: true, url: session.url });
});
