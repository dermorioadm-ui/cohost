import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";
import { completeSoftwareCheckout } from "../_shared/lib/software-checkout-completion.ts";

/** Confirma compra no servidor. URL Checkout nunca gera sessão de autenticação. */
export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");
  const { session_id } = await readJson<{ session_id?: string }>(req);
  if (!session_id || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(session_id))
    throw errors.invalid("Sessão de checkout inválida");
  const stripe = new Stripe(env.stripeSecret(), {
    apiVersion: "2025-08-27.basil",
  });
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
  return json(
    await completeSoftwareCheckout(admin(), stripe, session_id, token),
  );
});
