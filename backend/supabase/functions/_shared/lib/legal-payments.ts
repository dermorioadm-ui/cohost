import type Stripe from "npm:stripe@^18.5.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { AppError } from "./http.ts";
import {
  checkoutBelongsToOrder,
  LEGAL_PRODUCT,
  type LegalOrder,
} from "./legal-rules.ts";

/** Always reads the current Stripe object: stale webhook snapshots cannot grant access. */
export async function reconcileLegalCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  sessionId: string,
  userId?: string,
  eventKey?: string,
) {
  const { data, error } = await db
    .from("legal_orders")
    .select("*")
    .eq("stripe_session_id", sessionId)
    .maybeSingle();
  if (error) throw error;
  const order = data as LegalOrder | null;
  if (!order || (userId && order.user_id !== userId))
    throw new AppError("not_found", "Compra não encontrada.", 404);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items", "payment_intent.latest_charge"],
  });
  if (!checkoutBelongsToOrder(session, order))
    throw new Error("Legal checkout does not match stored order");
  const intent =
    typeof session.payment_intent === "object" ? session.payment_intent : null;
  const charge =
    intent && typeof intent.latest_charge === "object"
      ? intent.latest_charge
      : null;
  const paid =
    session.status === "complete" &&
    session.payment_status === "paid" &&
    intent?.status === "succeeded";
  if (
    paid &&
    (!charge?.paid ||
      intent.amount_received !== order.amount_cents ||
      intent.currency !== order.currency ||
      intent.metadata.product !== LEGAL_PRODUCT ||
      intent.metadata.legal_order_id !== order.id)
  ) {
    throw new Error("Legal payment details do not match stored order");
  }
  // Reembolso/disputa abre revisão financeira. Política de revogação não foi definida;
  // esta implementação não inventa cancelamento do jurídico nem altera o SaaS.
  const review =
    !!charge &&
    (charge.refunded || charge.amount_refunded > 0 || charge.disputed);
  const failed =
    session.status === "complete" &&
    intent &&
    ["canceled", "requires_payment_method"].includes(intent.status);
  const state = review
    ? "payment_review"
    : paid
      ? "paid"
      : session.status === "expired"
        ? "expired"
        : failed
          ? "failed"
          : "pending";
  const { data: result, error: applyError } = await db.rpc(
    "legal_apply_payment",
    {
      _order_id: order.id,
      _session_id: session.id,
      _payment_intent_id: intent?.id ?? null,
      _event_key: eventKey ?? `reconcile:${session.id}:${state}`,
      _state: state,
      _paid_at:
        paid && charge ? new Date(charge.created * 1000).toISOString() : null,
    },
  );
  if (applyError) throw applyError;
  return result as {
    state: "active" | "pending" | "failed";
    entitlement: unknown;
  };
}
