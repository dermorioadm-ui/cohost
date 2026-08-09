import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Portal do cliente no Stripe — trocar cartão, ver faturas, cancelar.
 *
 * Cancelamento passa pelo portal (e volta pelo webhook) em vez de um endpoint
 * nosso: assim o estado no Stripe e o estado aqui nunca divergem.
 */

const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const db = admin();

  const { data: profile } = await db
    .from("profiles")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile?.stripe_customer_id) {
    throw errors.invalid("Você ainda não tem uma assinatura para gerenciar.");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${env.appBaseUrl()}/assinatura`,
    locale: "pt-BR",
  });

  return json({ ok: true, url: session.url });
});
