import { describe, it, expect, vi } from "vitest";
import {
  checkoutBelongsToOrder,
  legalPriceMatches,
  LEGAL_PRODUCT,
  type LegalOrder,
} from "../supabase/functions/_shared/lib/legal-rules.ts";
import { reconcileLegalCheckout } from "../supabase/functions/_shared/lib/legal-payments.ts";
const order: LegalOrder = {
  id: "order-a",
  user_id: "owner-a",
  offer_id: "legal-annual",
  offer_version: 1,
  offer_snapshot: { title: "Test", term_months: 12 },
  amount_cents: 116400,
  currency: "brl",
  stripe_price_id: "price_legal",
  stripe_session_id: "cs_test_legal",
  status: "pending",
  created_at: new Date().toISOString(),
};
const session = () => ({
  id: order.stripe_session_id!,
  mode: "payment",
  client_reference_id: order.user_id,
  metadata: { product: LEGAL_PRODUCT, legal_order_id: order.id },
  amount_total: 116400,
  currency: "brl",
  line_items: { data: [{ quantity: 1, price: { id: "price_legal" } }] },
  status: "complete",
  payment_status: "paid",
  payment_intent: {
    id: "pi_test",
    status: "succeeded",
    amount_received: 116400,
    currency: "brl",
    metadata: { product: LEGAL_PRODUCT, legal_order_id: order.id },
    latest_charge: {
      id: "ch_test",
      paid: true,
      created: 1760000000,
      refunded: false,
      amount_refunded: 0,
      disputed: false,
    },
  },
});
const stubs = () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: order, error: null }),
  };
  return {
    db: {
      from: vi.fn(() => chain),
      rpc: vi
        .fn()
        .mockResolvedValue({
          data: { state: "active", entitlement: {} },
          error: null,
        }),
    },
    stripe: {
      checkout: {
        sessions: { retrieve: vi.fn().mockResolvedValue(session()) },
      },
    },
  };
};
describe("jurídico — validação e reconciliação com serviços simulados", () => {
  it("rejects unconfigured/inactive/recurring/wrong currency or price/test-live mismatch", () => {
    const price = {
      id: "price_legal",
      active: true,
      type: "one_time",
      currency: "brl",
      unit_amount: 116400,
      livemode: false,
      product: { active: true },
      billing_scheme: "per_unit",
    };
    expect(legalPriceMatches(price, order, false)).toBe(true);
    for (const delta of [
      { active: false },
      { type: "recurring" },
      { currency: "usd" },
      { unit_amount: 1 },
      { livemode: true },
      { product: { active: false } },
    ])
      expect(legalPriceMatches({ ...price, ...delta }, order, false)).toBe(
        false,
      );
  });
  it("checks product,user,price,total and one line item", () => {
    expect(checkoutBelongsToOrder(session(), order)).toBe(true);
    for (const delta of [
      { client_reference_id: "intruder" },
      { amount_total: 1 },
      { mode: "subscription" },
      { line_items: { data: [] } },
      { metadata: { product: "saas", legal_order_id: order.id } },
    ])
      expect(checkoutBelongsToOrder({ ...session(), ...delta }, order)).toBe(
        false,
      );
  });
  it("refuses another client before reading Stripe or writing entitlement", async () => {
    const { db, stripe } = stubs();
    await expect(
      reconcileLegalCheckout(
        db as never,
        stripe as never,
        "cs_test_legal",
        "intruder",
      ),
    ).rejects.toThrow("Compra não encontrada");
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("unpaid current session stays pending even when webhook says completed", async () => {
    const { db, stripe } = stubs();
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      ...session(),
      payment_status: "unpaid",
    });
    await reconcileLegalCheckout(
      db as never,
      stripe as never,
      "cs_test_legal",
      undefined,
      "evt_completed",
    );
    expect(db.rpc).toHaveBeenCalledWith(
      "legal_apply_payment",
      expect.objectContaining({ _state: "pending", _paid_at: null }),
    );
  });
  it("uses current Stripe object and retries after database failure", async () => {
    const { db, stripe } = stubs();
    db.rpc.mockResolvedValueOnce({
      data: null,
      error: new Error("temporary database failure"),
    });
    await expect(
      reconcileLegalCheckout(
        db as never,
        stripe as never,
        "cs_test_legal",
        undefined,
        "evt_paid",
      ),
    ).rejects.toThrow("temporary");
    await reconcileLegalCheckout(
      db as never,
      stripe as never,
      "cs_test_legal",
      undefined,
      "evt_paid",
    );
    expect(db.rpc).toHaveBeenLastCalledWith(
      "legal_apply_payment",
      expect.objectContaining({ _state: "paid", _event_key: "evt_paid" }),
    );
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(2);
  });
  it("routes refunds to review without touching SaaS profiles", async () => {
    const { db, stripe } = stubs();
    const refunded = session();
    refunded.payment_intent.latest_charge.amount_refunded = 116400;
    stripe.checkout.sessions.retrieve.mockResolvedValue(refunded);
    await reconcileLegalCheckout(db as never, stripe as never, "cs_test_legal");
    expect(db.rpc).toHaveBeenCalledWith(
      "legal_apply_payment",
      expect.objectContaining({ _state: "payment_review" }),
    );
    expect(db.from).toHaveBeenCalledWith("legal_orders");
    expect(db.from).not.toHaveBeenCalledWith("profiles");
  });
});
