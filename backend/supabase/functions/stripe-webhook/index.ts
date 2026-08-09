import Stripe from "npm:stripe@^18.5.0";
import { corsHeaders, json } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Webhook do Stripe — reconciliação de assinaturas.
 *
 * O backend antigo não tinha webhook nenhum: nenhum pagamento era conciliado,
 * e o status da assinatura era inferido consultando a API do Stripe no login.
 * Isso significa que um cancelamento ou uma cobrança falha só apareciam quando
 * o cliente entrava no app — que é justamente o que ele não faz.
 *
 * Aqui o Stripe é a fonte da verdade e empurra o estado para cá.
 *
 * IMPORTANTE: este endpoint NÃO passa pelo handler() padrão porque precisa do
 * corpo cru (bytes) para validar a assinatura HMAC. Reserializar o JSON quebra
 * a verificação.
 */

const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });

const RELEVANT = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

/** Stripe status -> nosso enum subscription_status. */
function mapStatus(s: string): string {
  switch (s) {
    case "trialing": return "trialing";
    case "active": return "active";
    case "past_due":
    case "unpaid": return "past_due";
    case "canceled": return "canceled";
    case "incomplete_expired": return "expired";
    default: return "expired";
  }
}

async function resolveUserId(
  db: ReturnType<typeof admin>,
  customerId: string | null,
  email: string | null,
): Promise<string | null> {
  if (customerId) {
    const { data } = await db
      .from("profiles")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (data) return data.user_id;
  }
  if (email) {
    const { data } = await db
      .from("profiles")
      .select("user_id")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (data) return data.user_id;
  }
  return null;
}

/** Descobre o tier a partir do price id gravado na tabela plans. */
async function resolvePlan(
  db: ReturnType<typeof admin>,
  priceId: string | null,
): Promise<{ tier: string; cycle: string } | null> {
  if (!priceId) return null;
  const { data } = await db
    .from("plans")
    .select("tier, stripe_price_monthly, stripe_price_annual")
    .or(`stripe_price_monthly.eq.${priceId},stripe_price_annual.eq.${priceId}`)
    .maybeSingle();
  if (!data) return null;
  return {
    tier: data.tier,
    cycle: data.stripe_price_annual === priceId ? "annual" : "monthly",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "assinatura ausente" }, 400);

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw,
      signature,
      env.stripeWebhookSecret(),
    );
  } catch (e) {
    console.error("Assinatura do webhook inválida:", e instanceof Error ? e.message : e);
    return json({ error: "assinatura inválida" }, 400);
  }

  const db = admin();

  // Idempotência: o Stripe reenvia. A UNIQUE em stripe_event_id barra o replay.
  const { error: dupError } = await db.from("billing_events").insert({
    stripe_event_id: event.id,
    type: event.type,
    occurred_at: new Date(event.created * 1000).toISOString(),
    raw: event.data.object as unknown as Record<string, unknown>,
  });

  if (dupError?.code === "23505") {
    return json({ ok: true, duplicate: true });
  }

  if (!RELEVANT.has(event.type)) {
    return json({ ok: true, ignored: event.type });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
        const userId =
          (s.client_reference_id as string | null) ??
          (await resolveUserId(db, customerId, s.customer_details?.email ?? null));

        if (userId && customerId) {
          await db
            .from("profiles")
            .update({
              stripe_customer_id: customerId,
              stripe_subscription_id:
                typeof s.subscription === "string" ? s.subscription : null,
            })
            .eq("user_id", userId);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const userId = await resolveUserId(db, customerId, null);

        if (!userId) {
          console.warn(`Assinatura ${sub.id} sem usuário correspondente (cliente ${customerId})`);
          break;
        }

        const priceId = sub.items.data[0]?.price?.id ?? null;
        const plan = await resolvePlan(db, priceId);

        const status =
          event.type === "customer.subscription.deleted"
            ? "expired"
            : mapStatus(sub.status);

        const patch: Record<string, unknown> = {
          subscription_status: status,
          stripe_customer_id: customerId,
          stripe_subscription_id: sub.id,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
        };

        if (plan) {
          patch.plan = plan.tier;
          patch.billing_cycle = plan.cycle;
        }
        if (sub.trial_end) {
          patch.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
        }

        await db.from("profiles").update(patch).eq("user_id", userId);
        await db.from("billing_events")
          .update({ user_id: userId, stripe_customer_id: customerId, stripe_subscription_id: sub.id, status })
          .eq("stripe_event_id", event.id);

        if (status === "expired" || status === "canceled") {
          const { data: profile } = await db
            .from("profiles").select("email, locale").eq("user_id", userId).maybeSingle();
          if (profile?.email) {
            await db.rpc("enqueue_notification", {
              _channel: "email",
              _template: "subscription-expired",
              _payload: { checkout_url: `${env.appBaseUrl()}/assinatura` },
              _to_email: profile.email,
              _to_user_id: userId,
              _idempotency_key: `sub-expired:${sub.id}:${status}`,
              _locale: profile.locale ?? "pt",
              _entity: "profiles",
              _entity_id: userId,
            });
          }
        }
        break;
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
        const userId = await resolveUserId(db, customerId, inv.customer_email ?? null);

        if (userId) {
          await db.from("billing_events")
            .update({
              user_id: userId,
              amount_cents: inv.amount_paid ?? inv.amount_due ?? null,
              currency: inv.currency ?? null,
              status: event.type === "invoice.paid" ? "paid" : "failed",
              stripe_customer_id: customerId,
            })
            .eq("stripe_event_id", event.id);

          if (event.type === "invoice.payment_failed") {
            await db.from("profiles")
              .update({ subscription_status: "past_due" })
              .eq("user_id", userId);
          }
        }
        break;
      }
    }

    return json({ ok: true, type: event.type });
  } catch (e) {
    console.error(`Falha ao processar ${event.type} (${event.id}):`, e);
    // 500 faz o Stripe reenviar — e a idempotência protege o reprocessamento.
    return json({ error: "erro ao processar evento" }, 500);
  }
});
