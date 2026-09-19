import type Stripe from "npm:stripe@^18.5.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { errors } from "./http.ts";
import { contaDoCheckout } from "./checkout-publico.ts";

/** Testable server boundary: payment reconciliation never creates a login session. */
export async function completeSoftwareCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  sessionId: string,
  token?: string,
) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.mode !== "subscription")
    throw errors.invalid("Esta sessão não é de assinatura da ferramenta");
  if (
    session.status !== "complete" ||
    !["paid", "no_payment_required"].includes(session.payment_status)
  )
    return { ok: false, estado: "pendente" };
  const subId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  if (!subId) throw errors.invalid("Assinatura não encontrada");
  const subscription = await stripe.subscriptions.retrieve(subId);
  const account = await contaDoCheckout(db, session, subscription);
  if (!account)
    throw errors.upstream(
      "Não foi possível vincular o pagamento. Fale com o atendimento.",
    );
  let authenticated = false;
  if (token) {
    const { data, error } = await db.auth.getUser(token);
    authenticated = !error && data.user?.id === account.userId;
  }
  return {
    ok: true,
    estado: ["active", "past_due"].includes(subscription.status)
      ? "ativo"
      : "inativo",
    requires_login: !authenticated,
    email: account.email,
    conta_nova: account.criada,
  };
}
