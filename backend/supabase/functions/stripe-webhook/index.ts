import Stripe from "npm:stripe@^18.5.0";
import { corsHeaders, json } from "../_shared/lib/http.ts";
import { admin, adminNotifyEmails } from "../_shared/lib/db.ts";
import { env, optional } from "../_shared/lib/env.ts";
import { contaDoCheckout } from "../_shared/lib/checkout-publico.ts";

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

/**
 * Assinaturas com que validar o evento, em ordem: a variável de ambiente
 * (quando alguém a colou no painel) e a guardada em `private.secrets` pela
 * `ops-stripe-webhook` ao criar o endpoint pela API. As duas são tentadas
 * porque um endpoint recriado invalida o segredo antigo sem avisar ninguém —
 * e o painel não tem como saber qual dos dois está vivo.
 */
async function segredosDoWebhook(db: ReturnType<typeof admin>): Promise<string[]> {
  const lista: string[] = [];
  const doAmbiente = optional("STRIPE_WEBHOOK_SECRET");
  if (doAmbiente) lista.push(doAmbiente);
  const { data, error } = await db.rpc("private_secret", { _name: "stripe_webhook_secret" });
  if (error) console.error("Falha ao ler a assinatura do webhook no banco:", error.message);
  else if (typeof data === "string" && data.length > 0 && !lista.includes(data)) lista.push(data);
  return lista;
}

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

/**
 * Assinatura nova no ar: avisa o cliente e avisa a plataforma.
 *
 * Os dois e-mails saem juntos de propósito. O do cliente é a lista dos três
 * passos que fazem o produto funcionar — quem assina e não conecta o
 * calendário não vê valor nenhum e cancela no primeiro mês. O interno existe
 * para que esse silêncio não passe despercebido: se dias depois o cliente
 * continuar com zero imóvel, alguém sabe para quem ligar.
 */
async function notifyNewSubscriber(
  db: ReturnType<typeof admin>,
  userId: string,
  info: { status: string; plan: string | null; cycle: string | null; subscriptionId: string },
): Promise<void> {
  const { data: profile } = await db
    .from("profiles")
    .select("email, full_name, phone_e164, locale, plan, billing_cycle")
    .eq("user_id", userId)
    .maybeSingle();

  if (!profile?.email) return;

  const tier = info.plan ?? profile.plan ?? null;
  const { data: planRow } = tier
    ? await db.from("plans").select("name").eq("tier", tier).maybeSingle()
    : { data: null };

  const planLabel = planRow?.name ?? tier ?? "";
  const cycle = info.cycle ?? profile.billing_cycle ?? "monthly";

  await db.rpc("enqueue_notification", {
    _channel: "email",
    _template: "welcome-subscriber",
    _payload: {
      owner_name: profile.full_name ?? "",
      plan_label: planLabel,
      dashboard_url: `${env.appBaseUrl()}/imoveis`,
    },
    _to_email: profile.email,
    _to_user_id: userId,
    _idempotency_key: `sub-welcome:${info.subscriptionId}`,
    _locale: profile.locale ?? "pt",
    _entity: "profiles",
    _entity_id: userId,
  });

  // Sem ninguém para avisar, o aviso interno simplesmente não sai — não é
  // motivo para derrubar o webhook nem para segurar o e-mail do cliente.
  const destinos = await adminNotifyEmails(db);
  if (destinos.length === 0) return;

  const { count } = await db
    .from("properties")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", userId)
    .is("archived_at", null);

  // A chave de idempotência leva o destinatário junto. Sem isso, com dois
  // admins no banco a segunda chamada seria descartada como repetida e só um
  // deles receberia o aviso.
  for (const destino of destinos) {
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "admin-new-subscriber",
      _payload: {
        owner_name: profile.full_name ?? "",
        owner_email: profile.email,
        owner_phone: profile.phone_e164 ?? "",
        plan: tier ?? "",
        plan_label: planLabel,
        billing_cycle: cycle,
        status: info.status,
        property_count: count ?? 0,
      },
      _to_email: destino,
      _idempotency_key: `sub-admin:${info.subscriptionId}:${destino}`,
      _locale: "pt",
      _entity: "profiles",
      _entity_id: userId,
    });
  }
}

/**
 * Fim do período corrente. Nas versões novas da API (basil) o campo saiu da
 * assinatura e foi para cada item; contas antigas ainda mandam no topo.
 */
function fimDoPeriodo(sub: Stripe.Subscription): string | null {
  const legado = (sub as unknown as { current_period_end?: number }).current_period_end;
  const fim = sub.items?.data?.[0]?.current_period_end ?? legado ?? null;
  return fim ? new Date(fim * 1000).toISOString() : null;
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
  const db = admin();

  const segredos = await segredosDoWebhook(db);
  if (segredos.length === 0) {
    console.error("Webhook da Stripe sem assinatura configurada (STRIPE_WEBHOOK_SECRET ou private.secrets)");
    return json({ error: "webhook não configurado" }, 500);
  }

  let event: Stripe.Event | null = null;
  let falha: unknown = null;
  for (const segredo of segredos) {
    try {
      event = await stripe.webhooks.constructEventAsync(raw, signature, segredo);
      break;
    } catch (e) {
      falha = e;
    }
  }
  if (!event) {
    console.error("Assinatura do webhook inválida:", falha instanceof Error ? falha.message : falha);
    return json({ error: "assinatura inválida" }, 400);
  }

  // Idempotência: o Stripe reenvia. A UNIQUE em stripe_event_id barra o replay.
  const { error: dupError } = await db.from("billing_events").insert({
    stripe_event_id: event.id,
    type: event.type,
    occurred_at: new Date(event.created * 1000).toISOString(),
    raw: event.data.object as unknown as Record<string, unknown>,
  });

  if (dupError?.code === "23505") {
    const { data: anterior } = await db
      .from("billing_events")
      .select("status")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    // Um evento gravado mas ainda sem status pode ser a sobra de uma falha
    // entre a reserva idempotente e o efeito. Nesse caso o retry precisa
    // concluir o processamento; eventos já marcados encerram aqui.
    if (anterior?.status) return json({ ok: true, duplicate: true });
  } else if (dupError) {
    console.error("Falha ao reservar evento Stripe:", dupError.message);
    return json({ error: "erro ao registrar evento" }, 500);
  }

  if (!RELEVANT.has(event.type)) {
    return json({ ok: true, ignored: event.type });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;

        // Implantação de portaria: pagamento avulso, não assinatura.
        //
        // É AQUI que `interessado` vira `pago`, e não no clique do botão. Quem
        // desiste na tela do cartão não pode entrar na fila da equipe técnica —
        // senão a fila enche de trabalho que ninguém comprou.
        const setupId = s.metadata?.porter_setup_id;
        if (setupId) {
          await db
            .from("porter_setup_requests")
            .update({
              status: "pago",
              paid_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", setupId)
            .eq("status", "interessado");

          // Avisa quem vai executar. O pedido já está na fila do painel
          // (/admin/portaria) faça o e-mail o que fizer — este aviso é para
          // encurtar a espera, não para ser o único registro dela.
          for (const destino of await adminNotifyEmails(db)) {
            await db.rpc("enqueue_notification", {
              _channel: "email",
              _template: "admin-new-subscriber",
              _payload: {
                owner_email: s.customer_details?.email ?? "",
                owner_name: s.customer_details?.name ?? "",
                plan_label: "Implantação de portaria",
                billing_cycle: "avulso",
                status: "pago",
                property_count: "1",
              },
              _to_email: destino,
              _idempotency_key: `porter-setup-pago:${setupId}:${destino}`,
              _locale: "pt",
            });
          }

          await db.from("billing_events")
            .update({ status: "paid" })
            .eq("stripe_event_id", event.id);

          // Pagamento avulso não mexe em assinatura. Sair aqui evita que o
          // fluxo abaixo tente casar este checkout com um plano.
          break;
        }

        const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
        let userId =
          (s.client_reference_id as string | null) ??
          (await resolveUserId(db, customerId, s.customer_details?.email ?? null));

        // Checkout vindo direto da página: a conta ainda não existe. É aqui
        // que ela nasce quando a pessoa fechou a aba antes de voltar ao site
        // (a volta normal passa por billing-checkout-complete, que chama a
        // mesma função — os dois lados são idempotentes entre si).
        if (!userId && s.mode === "subscription") {
          const conta = await contaDoCheckout(db, s);
          userId = conta?.userId ?? null;
        }

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

        // O retorno público da compra direta só avança depois desta marca.
        // Ela nasce de um evento assinado e é idempotente pelo stripe_event_id.
        await db.from("billing_events")
          .update({
            user_id: userId,
            status: "paid",
            stripe_customer_id: customerId,
            stripe_subscription_id:
              typeof s.subscription === "string" ? s.subscription : null,
          })
          .eq("stripe_event_id", event.id);
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
          current_period_end: fimDoPeriodo(sub),
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

        // Assinatura entrando no ar: dois e-mails, um para cada lado.
        //
        // A chave de idempotência é a ASSINATURA, sem o status: o Stripe manda
        // `created` e logo em seguida um ou mais `updated` para a mesma
        // assinatura, e sem isso o cliente receberia as boas-vindas duas ou
        // três vezes seguidas. Renovação mensal não passa por aqui — ela chega
        // como `invoice.paid`, tratado mais abaixo.
        if (status === "active" || status === "trialing") {
          await notifyNewSubscriber(db, userId, {
            status,
            plan: plan?.tier ?? null,
            cycle: plan?.cycle ?? null,
            subscriptionId: sub.id,
          });
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
