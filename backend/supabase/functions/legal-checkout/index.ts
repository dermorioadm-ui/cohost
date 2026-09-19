import Stripe from "npm:stripe@^18.5.0";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";
import {
  AppError,
  errors,
  handler,
  json,
  readJson,
} from "../_shared/lib/http.ts";
import {
  LEGAL_PRODUCT,
  legalPriceMatches,
  type LegalOrder,
} from "../_shared/lib/legal-rules.ts";
import { reconcileLegalCheckout } from "../_shared/lib/legal-payments.ts";

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");
  const user = await requireRole(req, "owner");
  const body = await readJson<{
    offer_id?: string;
    offer_version?: number;
    accepted_terms?: boolean;
    request_id?: string;
  }>(req);
  if (
    body.offer_id !== "legal-annual" ||
    !Number.isInteger(body.offer_version) ||
    body.accepted_terms !== true ||
    !body.request_id ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.request_id)
  )
    throw errors.invalid("Confira as condições da oferta antes de continuar.");
  const db = admin();
  const { data, error } = await db.rpc("legal_reserve_order", {
    _user_id: user.id,
    _offer_id: body.offer_id,
    _offer_version: body.offer_version,
    _request_key: body.request_id,
  });
  if (error) {
    if (error.message.includes("legal_already_active"))
      throw new AppError(
        "legal_already_active",
        "Você já tem assistência jurídica vigente. Acesse seus atendimentos.",
        409,
      );
    if (error.message.includes("legal_checkout_pending"))
      throw new AppError(
        "legal_checkout_pending",
        "Há uma compra anterior em conferência. Acompanhe o pagamento antes de tentar novamente.",
        409,
      );
    if (error.message.includes("legal_offer_changed"))
      throw new AppError(
        "legal_offer_changed",
        "As condições foram atualizadas. Confira a oferta novamente.",
        409,
      );
    if (error.message.includes("legal_offer_unavailable"))
      throw new AppError(
        "legal_offer_unavailable",
        "A contratação ainda não está disponível.",
        409,
      );
    throw error;
  }
  const order = data as LegalOrder;
  const stripe = new Stripe(env.stripeSecret(), {
    apiVersion: "2025-08-27.basil",
  });
  if (order.stripe_session_id) {
    const result = await reconcileLegalCheckout(
      db,
      stripe,
      order.stripe_session_id,
      user.id,
    );
    if (result.state === "active")
      throw new AppError(
        "legal_already_active",
        "Pagamento confirmado. Acesse seus atendimentos.",
        409,
      );
    const previous = await stripe.checkout.sessions.retrieve(
      order.stripe_session_id,
    );
    if (previous.status === "open" && previous.url)
      return json({ ok: true, url: previous.url, session_id: previous.id });
    throw new AppError(
      "legal_checkout_pending",
      result.state === "failed"
        ? "Esta tentativa foi encerrada. Atualize a página para começar uma nova compra."
        : "Estamos confirmando sua compra. Acompanhe o pagamento nesta página.",
      409,
    );
  }
  if (
    order.status !== "creating" ||
    Date.now() - Date.parse(order.created_at) > 55 * 60 * 1000
  )
    throw new AppError(
      "legal_checkout_pending",
      "Há uma tentativa em conferência. Fale com o atendimento antes de tentar novamente.",
      409,
    );
  const price = await stripe.prices.retrieve(order.stripe_price_id, {
    expand: ["product"],
  });
  if (
    !legalPriceMatches(price, order, /^(sk|rk)_live_/.test(env.stripeSecret()))
  ) {
    const { error: invalidPriceError } = await db
      .from("legal_orders")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("status", "creating");
    if (invalidPriceError) throw invalidPriceError;
    throw new AppError(
      "legal_offer_unavailable",
      "A contratação ainda não está disponível.",
      409,
    );
  }
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      client_reference_id: user.id,
      line_items: [{ price: order.stripe_price_id, quantity: 1 }],
      payment_method_types: ["card"],
      payment_method_options: { card: { installments: { enabled: false } } },
      metadata: {
        product: LEGAL_PRODUCT,
        legal_order_id: order.id,
        supabase_user_id: user.id,
      },
      payment_intent_data: {
        metadata: {
          product: LEGAL_PRODUCT,
          legal_order_id: order.id,
          supabase_user_id: user.id,
        },
      },
      success_url: `${env.appBaseUrl()}/juridico?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appBaseUrl()}/juridico?checkout=cancelado`,
      locale: "pt-BR",
      expires_at: Math.floor(Date.parse(order.created_at) / 1000) + 3600,
      custom_text: {
        submit: {
          message:
            "Contratação anual independente da ferramenta, sem renovação automática.",
        },
      },
    },
    { idempotencyKey: `legal-order:${order.id}` },
  );
  const { error: saveError } = await db
    .from("legal_orders")
    .update({
      stripe_session_id: session.id,
      status: "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id)
    .eq("status", "creating");
  if (saveError) throw saveError;
  if (!session.url)
    throw errors.upstream(
      "Não foi possível abrir o pagamento. Tente novamente.",
    );
  return json({ ok: true, url: session.url, session_id: session.id });
});
