import { describe, it, expect, vi } from "vitest";
import { completeSoftwareCheckout } from "../supabase/functions/_shared/lib/software-checkout-completion.ts";
function setup(existing = true) {
  const profile = { user_id: "victim-user" };
  const makeChain = (table: string) => ({
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValue({
        data:
          table === "plans"
            ? {
                tier: "essencial",
                stripe_price_monthly: "price_saas",
                stripe_price_annual: "price_other",
              }
            : existing
              ? profile
              : null,
        error: null,
      }),
    update: vi.fn().mockReturnThis(),
  });
  const db = {
    from: vi.fn(makeChain),
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "attacker" } }, error: null }),
      admin: {
        createUser: vi
          .fn()
          .mockResolvedValue({
            data: { user: { id: "new-user" } },
            error: null,
          }),
        generateLink: vi.fn(),
      },
      verifyOtp: vi.fn(),
    },
  };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: vi
          .fn()
          .mockResolvedValue({
            id: "cs_test_saas",
            mode: "subscription",
            status: "complete",
            payment_status: "paid",
            subscription: "sub_saas",
            customer: "cus_saas",
            client_reference_id: null,
            customer_details: { email: "victim@example.test" },
          }),
      },
    },
    subscriptions: {
      retrieve: vi
        .fn()
        .mockResolvedValue({
          id: "sub_saas",
          status: "active",
          metadata: {},
          items: {
            data: [
              { price: { id: "price_saas" }, current_period_end: 1999999999 },
            ],
          },
        }),
    },
  };
  return { db, stripe };
}
describe("checkout público e identidade — serviços simulados", () => {
  it("payer knowing victim email or checkout URL never receives a login session", async () => {
    const { db, stripe } = setup();
    const result = await completeSoftwareCheckout(
      db as never,
      stripe as never,
      "cs_test_saas",
      "attacker-token",
    );
    expect(result).toMatchObject({
      ok: true,
      requires_login: true,
      email: "victim@example.test",
    });
    expect(result).not.toHaveProperty("session");
    expect(db.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(db.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("new paid accounts remain email unconfirmed until email recovery", async () => {
    const { db, stripe } = setup(false);
    const result = await completeSoftwareCheckout(
      db as never,
      stripe as never,
      "cs_test_saas",
    );
    expect(db.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email_confirm: false }),
    );
    expect(result).toMatchObject({ requires_login: true, conta_nova: true });
    expect(result).not.toHaveProperty("session");
  });
  it("authenticated matching owner receives confirmation, never a replacement login session", async () => {
    const { db, stripe } = setup();
    db.auth.getUser.mockResolvedValue({
      data: { user: { id: "victim-user" } },
      error: null,
    });
    const result = await completeSoftwareCheckout(
      db as never,
      stripe as never,
      "cs_test_saas",
      "owner-token",
    );
    expect(result).toMatchObject({ requires_login: false, estado: "ativo" });
    expect(result).not.toHaveProperty("session");
  });
  it("old checkout cannot claim active if current Stripe subscription is cancelled", async () => {
    const { db, stripe } = setup();
    const sub = await stripe.subscriptions.retrieve();
    stripe.subscriptions.retrieve.mockResolvedValue({
      ...sub,
      status: "canceled",
    });
    expect(
      await completeSoftwareCheckout(
        db as never,
        stripe as never,
        "cs_test_saas",
      ),
    ).toMatchObject({ estado: "inativo" });
  });
  it("one-off legal checkout cannot activate SaaS or create user", async () => {
    const { db, stripe } = setup();
    const s = await stripe.checkout.sessions.retrieve();
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      ...s,
      mode: "payment",
    });
    await expect(
      completeSoftwareCheckout(db as never, stripe as never, "cs_test_saas"),
    ).rejects.toThrow("ferramenta");
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });
});


describe("webhook — recebimento e conclusão distintos",()=>{
  it("allows retry after incomplete processing, ignores only completed duplicates",async()=>{
    const {recordBillingEvent}=await import('../supabase/functions/_shared/lib/billing-event.ts');
    const chain={insert:vi.fn().mockResolvedValue({error:{code:'23505'}}),select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{processed_at:null},error:null})};
    const db={from:vi.fn(()=>chain)};const event={id:'evt_retry',type:'checkout.session.completed',created:1760000000,data:{object:{}}};
    expect(await recordBillingEvent(db as never,event)).toBe('process');
    chain.maybeSingle.mockResolvedValue({data:{processed_at:'2026-09-19'},error:null});
    expect(await recordBillingEvent(db as never,event)).toBe('duplicate');
    chain.insert.mockResolvedValue({error:{code:'database_unavailable'}});
    await expect(recordBillingEvent(db as never,event)).rejects.toEqual({code:'database_unavailable'});
  });
});
