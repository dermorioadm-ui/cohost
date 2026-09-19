/** Regras puras também exercitadas nos testes locais. */
export const LEGAL_PRODUCT = "legal_assistance";
export const LEGAL_CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
export interface LegalOrder {
  id: string;
  user_id: string;
  offer_id: string;
  offer_version: number;
  offer_snapshot: {
    title: string;
    term_months: number;
    [key: string]: unknown;
  };
  amount_cents: number;
  currency: string;
  stripe_price_id: string;
  stripe_session_id: string | null;
  status: string;
  created_at: string;
}
export function legalPriceMatches(
  price: {
    id: string;
    active: boolean;
    type: string;
    currency: string;
    unit_amount: number | null;
    livemode: boolean;
    product: string | { deleted?: boolean | void; active?: boolean };
    billing_scheme: string;
  },
  order: Pick<LegalOrder, "stripe_price_id" | "amount_cents" | "currency">,
  livemode: boolean,
): boolean {
  return (
    price.id === order.stripe_price_id &&
    price.active &&
    price.type === "one_time" &&
    price.currency === order.currency &&
    price.unit_amount === order.amount_cents &&
    price.livemode === livemode &&
    price.billing_scheme === "per_unit" &&
    typeof price.product !== "string" &&
    !price.product.deleted &&
    price.product.active === true
  );
}
export function checkoutBelongsToOrder(
  session: {
    id: string;
    mode: string | null;
    client_reference_id: string | null;
    metadata: Record<string, string> | null;
    amount_total: number | null;
    currency: string | null;
    line_items?: {
      data: Array<{ quantity: number | null; price: { id: string } | null }>;
    };
  },
  order: LegalOrder,
): boolean {
  const items = session.line_items?.data ?? [];
  return (
    session.mode === "payment" &&
    session.id === order.stripe_session_id &&
    session.client_reference_id === order.user_id &&
    session.metadata?.product === LEGAL_PRODUCT &&
    session.metadata?.legal_order_id === order.id &&
    session.amount_total === order.amount_cents &&
    session.currency === order.currency &&
    items.length === 1 &&
    items[0].quantity === 1 &&
    items[0].price?.id === order.stripe_price_id
  );
}
