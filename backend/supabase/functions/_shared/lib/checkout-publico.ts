import type Stripe from "npm:stripe@^18.5.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * A conta nasce do pagamento, não do cadastro.
 *
 * O caminho de menor atrito é: botão da página → checkout da Stripe → conta
 * criada com o e-mail que a pessoa digitou na Stripe → onboarding. A Stripe
 * já pediu nome, e-mail e telefone; pedir de novo num formulário nosso antes
 * do pagamento era a segunda tela em que a pessoa podia desistir.
 *
 * Esta função é chamada de dois lugares, e precisa ser idempotente entre eles:
 *
 *   - `billing-checkout-complete`, quando a pessoa volta do checkout para o
 *     site (é o caminho rápido: ela quer entrar agora);
 *   - `stripe-webhook`, em `checkout.session.completed` (é a rede de
 *     segurança: se ela fechou a aba antes de voltar, a conta existe do mesmo
 *     jeito e o e-mail de boas-vindas explica como entrar).
 *
 * Os dois podem correr ao mesmo tempo. Por isso a busca vem antes da criação,
 * e um "e-mail já existe" na criação é tratado como "achei", não como erro.
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
): Promise<ContaDoCheckout | null> {
  const email = (s.customer_details?.email ?? s.customer_email ?? "").trim().toLowerCase();
  if (!email) return null;

  const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
  const subscriptionId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null;
  const tier = s.metadata?.hospedepay_tier ?? null;
  const cycle = s.metadata?.hospedepay_cycle ?? null;

  // 1. Já existe? Pelo cliente da Stripe primeiro (é o vínculo forte), depois
  //    pelo e-mail (é o que a pessoa digitou nas duas pontas).
  let userId: string | null = null;
  if (customerId) {
    const { data } = await db
      .from("profiles").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) {
    const { data } = await db.from("profiles").select("user_id").eq("email", email).maybeSingle();
    userId = data?.user_id ?? null;
  }

  let criada = false;

  // 2. Não existe: cria confirmada. O e-mail é dado como verificado porque a
  //    Stripe acabou de cobrar um cartão nele — e o recibo da Stripe já foi
  //    para essa caixa. Exigir um clique de confirmação aqui seria pedir prova
  //    de algo que o pagamento provou melhor.
  if (!userId) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      email_confirm: true,
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
          .from("profiles").select("user_id").eq("email", email).maybeSingle();
        userId = again?.user_id ?? null;
      }
      if (!userId) throw new Error(`Falha ao criar a conta do checkout: ${error.message}`);
    } else {
      userId = data.user.id;
      criada = true;
    }
  }

  // 3. Grava o vínculo com a Stripe e libera o acesso. O webhook de
  //    `customer.subscription.*` vai reafirmar o status depois; marcar
  //    'active' aqui evita que a pessoa caia no painel com "conta inativa"
  //    nos segundos entre o pagamento e o evento.
  const patch: Record<string, unknown> = {};
  if (customerId) patch.stripe_customer_id = customerId;
  if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
  if (tier) patch.plan = tier;
  if (cycle) patch.billing_cycle = cycle;
  if (s.payment_status === "paid" || s.payment_status === "no_payment_required") {
    patch.subscription_status = "active";
  }
  if (Object.keys(patch).length > 0) {
    await db.from("profiles").update(patch).eq("user_id", userId);
  }

  return { userId, email, criada };
}
