import Stripe from "npm:stripe@^18.5.0";
import { handler, json } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Cria (ou reconcilia) na Stripe os produtos e preços de `public.plans`.
 *
 * Antes disso, os seis `price_...` eram digitados à mão no banco depois de
 * alguém montar tudo no dashboard. Isso quebra de três formas: erra-se o ID do
 * produto pelo do preço, esquece-se um dos ciclos, e o valor no dashboard sai
 * do valor da tabela sem ninguém perceber — o cliente vê R$ 97 na página e é
 * cobrado outro valor no checkout.
 *
 * Aqui a tabela é a fonte da verdade e a Stripe é reconciliada com ela.
 *
 * IDEMPOTÊNCIA PELO `lookup_key`. A Stripe garante que ele é único na conta, o
 * que dá um identificador estável nosso ("hospedepay_pro_annual") para achar o
 * preço de novo sem guardar nada. Rodar duas vezes não duplica nada.
 *
 * PREÇO NA STRIPE É IMUTÁVEL. Não dá para editar `unit_amount`. Quando o valor
 * da tabela muda, o caminho certo é criar um preço novo levando o `lookup_key`
 * junto (`transfer_lookup_key`) e arquivar o antigo — assinaturas existentes
 * continuam no preço velho, que é o comportamento desejado: quem já assinou
 * não é reajustado por um deploy.
 *
 * Autoriza pelo segredo de cron (é operação de manutenção, não de usuário),
 * então roda por `SELECT private.call_job('billing-sync-plans')`.
 */

// O cliente nasce DENTRO do handler de propósito. Construído no topo do módulo,
// a falta de STRIPE_SECRET_KEY estourava antes de qualquer código nosso rodar e
// o Supabase devolvia só "WORKER_ERROR: check logs" — quem chamasse não ficava
// sabendo o que faltava. Aqui o erro sai como resposta, com o nome do segredo.
const stripeClient = () =>
  new Stripe(env.stripeSecret(), { apiVersion: "2025-08-27.basil" });

interface PlanRow {
  tier: string;
  name: string;
  monthly_cents: number;
  annual_cents: number;
  currency: string;
  max_properties: number;
  stripe_price_monthly: string | null;
  stripe_price_annual: string | null;
}

type Cycle = "monthly" | "annual";

const lookupKey = (tier: string, cycle: Cycle) => `hospedepay_${tier}_${cycle}`;

export default handler(async (req) => {
  await requireCron(req);

  const stripe = stripeClient();
  const db = admin();

  const { data: plans, error } = await db
    .from("plans")
    .select(
      "tier, name, monthly_cents, annual_cents, currency, max_properties, stripe_price_monthly, stripe_price_annual",
    )
    .eq("active", true)
    .order("sort_order");

  if (error) throw new Error(`Falha ao ler os planos: ${error.message}`);

  const resumo: Array<Record<string, unknown>> = [];

  for (const plan of (plans ?? []) as PlanRow[]) {
    // Um produto por plano. O `metadata` é o que permite reencontrá-lo sem
    // guardar o id em lugar nenhum — e o que identifica que ele é nosso, caso a
    // conta da Stripe também venda outra coisa.
    let productId: string | null = null;

    const busca = await stripe.products.search({
      query: `metadata['hospedepay_tier']:'${plan.tier}'`,
      limit: 1,
    });

    if (busca.data.length > 0) {
      productId = busca.data[0].id;
      await stripe.products.update(productId, {
        name: `HospedePay ${plan.name}`,
        description:
          `Gestão automática de ${plan.max_properties} ` +
          `${plan.max_properties === 1 ? "imóvel" : "imóveis"} de temporada.`,
        metadata: { hospedepay_tier: plan.tier },
      });
    } else {
      const criado = await stripe.products.create({
        name: `HospedePay ${plan.name}`,
        description:
          `Gestão automática de ${plan.max_properties} ` +
          `${plan.max_properties === 1 ? "imóvel" : "imóveis"} de temporada.`,
        metadata: { hospedepay_tier: plan.tier },
      });
      productId = criado.id;
    }

    const ciclos: Array<{ cycle: Cycle; cents: number; interval: "month" | "year"; col: string }> = [
      { cycle: "monthly", cents: plan.monthly_cents, interval: "month", col: "stripe_price_monthly" },
      { cycle: "annual", cents: plan.annual_cents, interval: "year", col: "stripe_price_annual" },
    ];

    const patch: Record<string, string> = {};

    for (const c of ciclos) {
      if (!c.cents || c.cents <= 0) continue;

      const key = lookupKey(plan.tier, c.cycle);
      const moeda = (plan.currency ?? "BRL").toLowerCase();

      const existentes = await stripe.prices.list({ lookup_keys: [key], limit: 1 });
      const atual = existentes.data[0];

      let priceId: string;
      let acao: string;

      if (atual && atual.active && atual.unit_amount === c.cents && atual.currency === moeda) {
        priceId = atual.id;
        acao = "reaproveitado";
      } else {
        const novo = await stripe.prices.create({
          product: productId!,
          currency: moeda,
          unit_amount: c.cents,
          recurring: { interval: c.interval },
          lookup_key: key,
          // Leva a chave junto quando já existia um preço com ela — é o que
          // permite trocar o valor sem perder o identificador estável.
          transfer_lookup_key: Boolean(atual),
          nickname: `${plan.name} · ${c.cycle === "annual" ? "anual" : "mensal"}`,
          metadata: { hospedepay_tier: plan.tier, hospedepay_cycle: c.cycle },
        });

        // Arquiva o antigo para ele sumir do checkout. Quem já assina nele
        // continua assinando — arquivar não cancela assinatura.
        if (atual) await stripe.prices.update(atual.id, { active: false });

        priceId = novo.id;
        acao = atual ? "recriado (valor mudou)" : "criado";
      }

      patch[c.col] = priceId;
      resumo.push({ plano: plan.name, ciclo: c.cycle, valor: c.cents / 100, price_id: priceId, acao });
    }

    if (Object.keys(patch).length > 0) {
      const { error: upErr } = await db.from("plans").update(patch).eq("tier", plan.tier);
      if (upErr) throw new Error(`Falha ao gravar price id de ${plan.tier}: ${upErr.message}`);
    }
  }

  console.log("sync-plans:", JSON.stringify(resumo));
  return json({ ok: true, sincronizados: resumo.length, planos: resumo });
});
