import type Stripe from "npm:stripe@^18.5.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Vincula uma assinatura reconhecida ao cliente após consulta real na Stripe.
 * Webhook e retorno podem repetir: criação tolera corrida de email existente.
 * O email do cartão nunca é prova de identidade; contas novas ficam não
 * confirmadas até recuperação por email. Esta função não autentica ninguém.
 */

export interface ContaDoCheckout {
  userId: string;
  email: string;
  /** true quando a conta foi criada agora, por este pagamento. */
  criada: boolean;
}

export async function contaDoCheckout(
  db: SupabaseClient,
  s: Stripe.Checkout.Session,
  subscription?: Stripe.Subscription,
): Promise<ContaDoCheckout | null> {
  const email = (s.customer_details?.email ?? s.customer_email ?? "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  if (!subscription || s.mode !== "subscription")
    throw new Error("Verified SaaS subscription required");

  const customerId =
    typeof s.customer === "string" ? s.customer : (s.customer?.id ?? null);
  const subscriptionId =
    typeof s.subscription === "string"
      ? s.subscription
      : (s.subscription?.id ?? null);
  const priceId = subscription.items.data[0]?.price.id;
  if (!priceId) throw new Error("Missing SaaS price");
  const { data: plan, error: planError } = await db
    .from("plans")
    .select("tier,stripe_price_monthly,stripe_price_annual")
    .or(`stripe_price_monthly.eq.${priceId},stripe_price_annual.eq.${priceId}`)
    .maybeSingle();
  if (planError || !plan) throw new Error("Unknown SaaS price");
  const tier = plan.tier;
  const cycle = plan.stripe_price_annual === priceId ? "annual" : "monthly";

  // 1. Já existe? Pelo cliente da Stripe primeiro (é o vínculo forte), depois
  //    pelo e-mail (é o que a pessoa digitou nas duas pontas).
  let userId: string | null =
    s.client_reference_id ?? subscription.metadata.supabase_user_id ?? null;
  if (!userId && customerId) {
    const { data } = await db
      .from("profiles")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) {
    const { data } = await db
      .from("profiles")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }

  let criada = false;

  // Pagamento não comprova controle do email. A conta só é confirmada
  // quando o dono segue o link de recuperação recebido na própria caixa.
  if (!userId) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: {
        full_name: s.customer_details?.name ?? "",
        whatsapp: s.customer_details?.phone ?? null,
        origem: "checkout",
      },
    });

    if (error) {
      // Corrida com o webhook: o outro lado criou primeiro. Reencontra.
      if (/already|registered|exists/i.test(error.message)) {
        const { data: again } = await db
          .from("profiles")
          .select("user_id")
          .eq("email", email)
          .maybeSingle();
        userId = again?.user_id ?? null;
      }
      if (!userId)
        throw new Error(`Falha ao criar a conta do checkout: ${error.message}`);
    } else {
      userId = data.user.id;
      criada = true;
    }
  }

  // Sincroniza o estado ATUAL verificado da assinatura SaaS. Nunca usar
  // payment_status de uma sessão antiga para reativar assinatura cancelada.
  const patch: Record<string, unknown> = {};
  if (customerId) patch.stripe_customer_id = customerId;
  if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
  if (tier) patch.plan = tier;
  if (cycle) patch.billing_cycle = cycle;
  const status = subscription.status;
  patch.subscription_status =
    status === "active"
      ? "active"
      : ["past_due", "unpaid"].includes(status)
        ? "past_due"
        : "expired";
  const end = subscription.items.data[0]?.current_period_end;
  patch.current_period_end = end ? new Date(end * 1000).toISOString() : null;
  if (Object.keys(patch).length > 0) {
    const { error } = await db
      .from("profiles")
      .update(patch)
      .eq("user_id", userId);
    if (error) throw error;
  }

  return { userId, email, criada };
}
