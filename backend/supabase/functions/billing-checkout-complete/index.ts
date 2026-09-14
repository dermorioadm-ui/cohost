import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";
import { contaDoCheckout } from "../_shared/lib/checkout-publico.ts";

/**
 * A volta do checkout: pagamento confirmado vira conta e sessão.
 *
 * A pessoa chega em /assinatura?status=ok&session=cs_... sem estar logada
 * (a conta ainda nem existia quando ela saiu para a Stripe). Esta function:
 *
 *   1. busca a sessão de checkout NA STRIPE, pelo id — nada do que decide
 *      vem do navegador;
 *   2. exige que o pagamento esteja concluído;
 *   3. cria (ou reencontra) a conta a partir do e-mail do pagamento;
 *   4. devolve uma sessão do Supabase, trocada de um link mágico no
 *      servidor, para a pessoa entrar sem digitar nada.
 *
 * O id da sessão de checkout funciona como chave de entrada uma única vez.
 * Depois disso, quem tiver o mesmo link (histórico do navegador, e-mail
 * encaminhado) não recebe sessão nenhuma — recebe "entre com seu e-mail".
 */

interface Body {
  session_id?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const { session_id } = await readJson<Body>(req);
  if (!session_id || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(session_id)) {
    throw errors.invalid("Sessão de checkout inválida");
  }

  const stripe = new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });
  const db = admin();

  const s = await stripe.checkout.sessions.retrieve(session_id);

  if (s.mode !== "subscription") throw errors.invalid("Esta sessão não é de assinatura");
  if (s.status !== "complete") {
    return json({ ok: false, estado: "pendente" });
  }
  if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
    return json({ ok: false, estado: "pendente" });
  }

  const conta = await contaDoCheckout(db, s);
  if (!conta) throw errors.upstream("O pagamento não trouxe um e-mail. Fale com a gente.");

  // Uso único: a primeira volta ganha a sessão; as seguintes só a confirmação.
  const { data: usado } = await db
    .from("audit_log")
    .select("id")
    .eq("action", "billing.checkout_login")
    .eq("entity_id", s.id)
    .limit(1)
    .maybeSingle();

  if (usado) {
    return json({ ok: true, estado: "ativo", ja_entrou: true, email: conta.email });
  }

  await db.from("audit_log").insert({
    actor_id: conta.userId,
    actor_role: "owner",
    action: "billing.checkout_login",
    entity: "checkout",
    entity_id: s.id,
    metadata: { criada: conta.criada },
  });

  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: conta.email,
  });
  if (linkError || !link.properties?.hashed_token) {
    console.error("Falha ao gerar sessão do checkout:", linkError?.message);
    throw errors.upstream("Conta criada, mas a sessão falhou. Entre com seu e-mail.");
  }

  const { data: verified, error: verifyError } = await db.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (verifyError || !verified.session) {
    console.error("Falha ao validar sessão do checkout:", verifyError?.message);
    throw errors.upstream("Conta criada, mas a sessão falhou. Entre com seu e-mail.");
  }

  return json({
    ok: true,
    estado: "ativo",
    email: conta.email,
    conta_nova: conta.criada,
    session: {
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
    },
  });
});
