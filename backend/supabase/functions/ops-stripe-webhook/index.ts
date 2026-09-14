import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Instala (ou inspeciona) o endpoint de webhook da Stripe apontando para a
 * function `stripe-webhook` deste projeto.
 *
 * Antes isso era um passo manual no dashboard da Stripe seguido de colar o
 * `whsec_` como secret no painel do Supabase — dois lugares, duas chances de
 * esquecer, e um produto que "vende" sem nunca conciliar o pagamento. Aqui o
 * endpoint é criado pela API e a assinatura vai para `private.secrets`, de
 * onde a `stripe-webhook` lê quando a variável de ambiente não existe.
 *
 * Operação de manutenção: autoriza pelo segredo de cron e roda por
 *   SELECT private.call_job('ops-stripe-webhook', '{"acao":"instalar"}');
 *
 * `inspecionar` só lista. `instalar` cria o endpoint quando não há nenhum
 * para a nossa URL — e, quando há um cuja assinatura não temos (a Stripe só a
 * mostra na criação), troca-o por um novo; com `forcar: true` troca sempre.
 * Idempotente: rodar de novo com tudo no lugar não cria nada.
 *
 * `testar` prova que o par endpoint + assinatura funciona de verdade: liga
 * `customer.created` por um instante, cria e apaga um cliente de teste e
 * espera o evento aparecer em `billing_events`. Um segredo colado errado no
 * painel só aparece assim — a Stripe entrega, a function devolve 400 e
 * ninguém vê, até o primeiro cliente pagar e continuar "pendente".
 */

const EVENTO_SONDA = "customer.created";
const EMAIL_SONDA = "sonda-webhook@hospedepay.org";

const EVENTOS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

const API_VERSION = "2025-08-27.basil";
const NOME_SEGREDO = "stripe_webhook_secret";

export default handler(async (req) => {
  await requireCron(req);
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const body = await readJson<{ acao?: string; forcar?: boolean }>(req);
  const acao = body.acao === "instalar" || body.acao === "testar" ? body.acao : "inspecionar";
  const forcar = body.forcar === true;

  const stripe = new Stripe(env.stripeSecret(), { apiVersion: API_VERSION });
  const db = admin();
  const url = `${env.supabaseUrl()}/functions/v1/stripe-webhook`;

  const { data: guardado } = await db.rpc("private_secret", { _name: NOME_SEGREDO });
  const temSegredoNoAmbiente = Boolean(Deno.env.get("STRIPE_WEBHOOK_SECRET")?.trim());
  const temSegredoNoBanco = Boolean(guardado);

  const todos = await stripe.webhookEndpoints.list({ limit: 100 });
  const nossos = todos.data.filter((w) => w.url === url);
  const resumo = (w: Stripe.WebhookEndpoint) => ({
    id: w.id,
    status: w.status,
    api_version: w.api_version,
    eventos: w.enabled_events,
  });

  if (acao === "inspecionar") {
    return json({
      url,
      segredo: { ambiente: temSegredoNoAmbiente, banco: temSegredoNoBanco },
      endpoints: nossos.map(resumo),
      outros: todos.data.filter((w) => w.url !== url).map((w) => ({ id: w.id, url: w.url, status: w.status })),
    });
  }

  const ativo = nossos.find((w) => w.status === "enabled");

  if (acao === "testar") {
    if (!ativo) throw errors.invalid("Não há endpoint ativo para testar");
    const originais = ativo.enabled_events as Stripe.WebhookEndpointUpdateParams.EnabledEvent[];
    const comSonda = originais.includes(EVENTO_SONDA)
      ? originais
      : [...originais, EVENTO_SONDA as Stripe.WebhookEndpointUpdateParams.EnabledEvent];

    await stripe.webhookEndpoints.update(ativo.id, { enabled_events: comSonda });
    let cliente: Stripe.Customer | null = null;
    let visto = false;
    try {
      cliente = await stripe.customers.create({
        email: EMAIL_SONDA,
        name: "Sonda do webhook",
        description: "Criado e apagado pela ops-stripe-webhook para testar a assinatura",
      });
      for (let i = 0; i < 12 && !visto; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data } = await db
          .from("billing_events")
          .select("id")
          .eq("type", EVENTO_SONDA)
          .contains("raw", { id: cliente.id })
          .limit(1);
        visto = (data?.length ?? 0) > 0;
      }
    } finally {
      if (cliente) await stripe.customers.del(cliente.id).catch(() => null);
      await stripe.webhookEndpoints.update(ativo.id, { enabled_events: originais }).catch(() => null);
      await db.from("billing_events").delete().eq("type", EVENTO_SONDA);
    }

    return json({
      ok: visto,
      endpoint: resumo(ativo),
      segredo: { ambiente: temSegredoNoAmbiente, banco: temSegredoNoBanco },
      veredito: visto
        ? "evento assinado chegou e foi validado"
        : "evento não chegou validado em 24s: assinatura errada ou entrega atrasada",
    });
  }

  // Já existe endpoint E temos com que validar a assinatura: nada a fazer.
  if (!forcar && ativo && (temSegredoNoAmbiente || temSegredoNoBanco)) {
    return json({ ok: true, acao: "nada", endpoint: resumo(ativo) });
  }

  // Endpoint sem assinatura conhecida não serve para nada: sai.
  const removidos: string[] = [];
  for (const w of nossos) {
    await stripe.webhookEndpoints.del(w.id);
    removidos.push(w.id);
  }

  const criado = await stripe.webhookEndpoints.create({
    url,
    enabled_events: EVENTOS,
    api_version: API_VERSION,
    description: "HospedePay — conciliação de assinaturas (criado pela ops-stripe-webhook)",
  });

  if (!criado.secret) throw errors.upstream("A Stripe não devolveu a assinatura do endpoint");

  const { error } = await db.rpc("private_secret_set", { _name: NOME_SEGREDO, _value: criado.secret });
  if (error) {
    // Sem onde guardar a assinatura o endpoint vira ruído: desfaz.
    await stripe.webhookEndpoints.del(criado.id);
    throw errors.upstream(`Não consegui guardar a assinatura: ${error.message}`);
  }

  await db.from("audit_log").insert({
    actor_role: "admin",
    action: "billing.webhook_instalado",
    entity: "stripe_webhook_endpoint",
    entity_id: criado.id,
    metadata: { url, removidos, forcado: forcar, api_version: API_VERSION },
  });

  return json({ ok: true, acao: "criado", endpoint: resumo(criado), removidos });
});
