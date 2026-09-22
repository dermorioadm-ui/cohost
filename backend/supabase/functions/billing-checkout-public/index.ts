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
  origem?: "pagina" | "compra-direta";
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const { tier = "essencial", cycle = "annual", origem = "pagina" } = await readJson<Body>(req);
  if (!["essencial", "pro", "ilimitado"].includes(tier)) throw errors.invalid("Plano inválido");
  if (!["monthly", "annual"].includes(cycle)) throw errors.invalid("Ciclo inválido");
  if (!["pagina", "compra-direta"].includes(origem)) throw errors.invalid("Origem inválida");

  // A página de tráfego frio tem uma única oferta aprovada. Validar aqui
  // impede que alguém altere tier/ciclo no navegador e use esta origem para
  // abrir outra condição comercial.
  if (origem === "compra-direta" && cycle !== "monthly") {
    throw errors.invalid("A compra direta usa planos mensais");
  }

  const db = admin();
  const { data: plan } = await db
    .from("plans")
    .select("tier, name, monthly_cents, max_properties, currency, stripe_price_monthly, stripe_price_annual, active")
    .eq("tier", tier)
    .maybeSingle();
  if (!plan || !plan.active) throw errors.notFound("Plano não disponível");
  if (origem === "compra-direta" && (!plan.max_properties || plan.max_properties > 5)) {
    throw errors.invalid("Para mais de 5 imóveis, fale conosco pelo WhatsApp.");
  }

  const priceId = cycle === "annual" ? plan.stripe_price_annual : plan.stripe_price_monthly;
  if (!priceId || !priceId.startsWith("price_")) {
    throw errors.upstream(
      `O plano ${plan.name} (${cycle === "annual" ? "anual" : "mensal"}) ainda não tem preço ` +
        `configurado na Stripe. Rode billing-sync-plans.`,
    );
  }

  const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });
  const base = env.appBaseUrl();

  if (origem === "compra-direta") {
    const price = await stripe.prices.retrieve(priceId);
    if (
      !price.active ||
      price.unit_amount !== plan.monthly_cents ||
      price.currency.toLowerCase() !== String(plan.currency ?? "BRL").toLowerCase() ||
      price.type !== "recurring" ||
      price.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1
    ) {
      throw errors.upstream(
        "O preço mensal na Stripe não corresponde à oferta. Revise a sincronização antes de vender.",
      );
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    // Sem teste grátis: cartão obrigatório, cobrança imediata.
    payment_method_collection: "always",
    // A Stripe já coleta o telefone no mesmo formulário. Na página atual ele
    // também serve ao contato comercial; na compra direta fica vinculado à
    // conta, sem prometer implementação assistida.
    phone_number_collection: { enabled: true },
    metadata: { hospedepay_tier: tier, hospedepay_cycle: cycle, origem },
    subscription_data: { metadata: { hospedepay_tier: tier, hospedepay_cycle: cycle, origem } },
    success_url: `${base}/assinatura?status=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: origem === "compra-direta"
      ? `${base}/compra-direta?checkout=cancelado#oferta`
      : `${base}/?checkout=cancelado#planos`,
    locale: "pt-BR",
    allow_promotion_codes: true,
    // A frase embaixo do botão de pagar: o que acontece no segundo seguinte.
    // É a resposta à única dúvida que sobra na hora do cartão.
    custom_text: {
      submit: {
        message: origem === "compra-direta"
          ? "Depois do pagamento você cria sua senha e configura o imóvel pelo passo a passo da HospedePay."
          : "Depois do pagamento você entra direto, sem senha e sem cadastro. Eu te ligo em até 15 minutos para ligar o seu calendário.",
      },
    },
  });

  await db.from("audit_log").insert({
    actor_role: "owner",
    action: "billing.checkout_publico_criado",
    entity: "checkout",
    entity_id: session.id,
    metadata: { tier, cycle, origem },
  });

  return json({ ok: true, url: session.url });
});
