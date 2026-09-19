import Stripe from "npm:stripe@^18.5.0";
import { admin, requireUser } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { reconcileLegalCheckout } from "../_shared/lib/legal-payments.ts";
export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");
  const user = await requireUser(req);
  const { session_id } = await readJson<{ session_id?: string }>(req);
  if (!session_id || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(session_id))
    throw errors.invalid("Compra inválida.");
  const result = await reconcileLegalCheckout(
    admin(),
    new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" }),
    session_id,
    user.id,
  );
  return json({ ok: true, ...result });
});
