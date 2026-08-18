import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Cria a sessão de checkout da assinatura.
 *
 * O preço vem SEMPRE da tabela `plans` — nunca do cliente. No backend antigo o
 * checkout de experiências aceitava `price_cents` do navegador, o que permitia
 * pagar R$1,00 por qualquer coisa. Aqui o cliente só escolhe tier e ciclo.
 */

interface Body {
  tier?: "essencial" | "pro" | "ilimitado";
  cycle?: "monthly" | "annual";
}

const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const { tier = "essencial", cycle = "monthly" } = await readJson<Body>(req);

  if (!["essencial", "pro", "ilimitado"].includes(tier)) {
    throw errors.invalid("Plano inválido");
  }
  if (!["monthly", "annual"].includes(cycle)) {
    throw errors.invalid("Ciclo inválido — use monthly ou annual");
  }

  const db = admin();

  const { data: plan } = await db
    .from("plans")
    .select("tier, name, stripe_price_monthly, stripe_price_annual, active")
    .eq("tier", tier)
    .maybeSingle();

  if (!plan || !plan.active) throw errors.notFound("Plano não disponível");

  // O preço é o ID de um Price recorrente do Stripe, gravado em `plans`. Sem
  // ele não há como cobrar — e o erro precisa dizer exatamente o que falta,
  // porque quem vai consertar é quem administra a conta do Stripe, não o
  // cliente que clicou em assinar.
  const priceId = cycle === "annual" ? plan.stripe_price_annual : plan.stripe_price_monthly;
  if (!priceId) {
    throw errors.upstream(
      `O plano ${plan.name} (${cycle === "annual" ? "anual" : "mensal"}) ainda não tem ` +
        `preço configurado no Stripe. Preencha plans.` +
        `${cycle === "annual" ? "stripe_price_annual" : "stripe_price_monthly"} ` +
        `com o ID do Price (price_...).`,
    );
  }
  if (!priceId.startsWith("price_")) {
    throw errors.upstream(
      `O preço do plano ${plan.name} está gravado como "${priceId}", que não é um ID ` +
        `de Price do Stripe. Use o ID que começa com "price_", não o do produto (prod_).`,
    );
  }

  const { data: profile } = await db
    .from("profiles")
    .select("stripe_customer_id, email, full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  // Reaproveita o cliente do Stripe; criar um novo a cada checkout duplica
  // histórico e quebra a conciliação do webhook.
  let customerId = profile?.stripe_customer_id ?? null;

  if (!customerId) {
    const existing = await stripe.customers.list({
      email: profile?.email ?? user.email ?? undefined,
      limit: 1,
    });
    if (existing.data.length > 0) {
      customerId = existing.data[0].id;
    } else {
      const created = await stripe.customers.create({
        email: profile?.email ?? user.email ?? undefined,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = created.id;
    }
    await db.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    // Sem teste grátis: o cartão é obrigatório e a assinatura começa cobrando.
    // `always` + nenhum `trial_period_days` é o que garante isso — deixar o
    // padrão do Stripe aqui reabriria o período de graça sem ninguém notar.
    payment_method_collection: "always",
    subscription_data: { metadata: { supabase_user_id: user.id } },
    success_url: `${env.appBaseUrl()}/assinatura?status=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.appBaseUrl()}/assinatura?status=cancelado`,
    locale: "pt-BR",
    allow_promotion_codes: true,
  });

  await db.from("audit_log").insert({
    actor_id: user.id,
    actor_role: "owner",
    action: "billing.checkout_created",
    entity: "profiles",
    entity_id: user.id,
    metadata: { tier, cycle, session_id: session.id },
  });

  return json({ ok: true, url: session.url, session_id: session.id });
});
