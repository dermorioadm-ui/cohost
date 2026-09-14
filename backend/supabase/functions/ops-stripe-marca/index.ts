import Stripe from "npm:stripe@^18.5.0";
import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * A marca no Checkout da Stripe: o que o cliente vê na hora de pagar.
 *
 * A conta Stripe é a da LLC e nasceu para outro produto — o Checkout mostrava
 * "CleanerBNB", sem logo, sem cor, e os produtos sem imagem. Esta function
 * corrige o que a API deixa corrigir e tenta o resto:
 *
 *   inspecionar — o que a conta, os produtos e os métodos de pagamento têm hoje.
 *   produtos    — imagem, descrição e descritor de fatura dos três planos
 *                 (só os produtos ligados aos preços de `plans`).
 *   marcar      — sobe logo e ícone (public/stripe/*.png, servidos pelo site)
 *                 e tenta gravar nome, site, cores e descritor na conta. A
 *                 Stripe só permite isso pela API em contas conectadas; se
 *                 recusar, a resposta traz a mensagem e o caminho é o painel.
 *
 * Operação de manutenção, autoriza pelo segredo de cron:
 *   SELECT private.call_job('ops-stripe-marca', '{"acao":"produtos"}');
 */

const CORAL = "#FF385C";
const DESCRITOR = "HOSPEDEPAY";
const DESCRICAO: Record<string, string> = {
  essencial: "Check-in Blindado para 1 imóvel. Implementação e suporte incluídos. Garantia de 30 dias.",
  pro: "Check-in Blindado para 2 ou 3 imóveis. Implementação e suporte incluídos. Garantia de 30 dias.",
  ilimitado: "Check-in Blindado para 4 ou 5 imóveis. Implementação e suporte incluídos. Garantia de 30 dias.",
};

async function subirArquivo(chave: string, url: string, purpose: "business_logo" | "business_icon", nome: string) {
  const r = await fetch(url);
  if (!r.ok) throw errors.upstream(`Não consegui baixar ${url} (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const fd = new FormData();
  fd.append("purpose", purpose);
  fd.append("file", new Blob([bytes], { type: "image/png" }), nome);
  const up = await fetch("https://files.stripe.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}` },
    body: fd,
  });
  const j = await up.json();
  if (!up.ok) throw errors.upstream(`Upload de ${nome} falhou: ${j?.error?.message ?? up.status}`);
  return j.id as string;
}

export default handler(async (req) => {
  await requireCron(req);
  if (req.method !== "POST") throw errors.invalid("Use POST");
  const body = await readJson<{ acao?: string; nome?: string; suporte?: string }>(req);
  const acao = body.acao ?? "inspecionar";
  const chave = env.stripeSecret();
  const stripe = new Stripe(chave, { apiVersion: "2025-08-27.basil" });
  const base = env.appBaseUrl();

  if (acao === "inspecionar") {
    const conta = await stripe.accounts.retrieve();
    const produtos = await stripe.products.list({ limit: 20, active: true });
    return json({
      conta: {
        id: conta.id,
        nome: conta.business_profile?.name ?? null,
        url: conta.business_profile?.url ?? null,
        suporte: conta.business_profile?.support_email ?? null,
        marca: conta.settings?.branding ?? null,
        descritor: conta.settings?.payments?.statement_descriptor ?? null,
      },
      produtos: produtos.data.map((p) => ({ id: p.id, nome: p.name, imagens: p.images, descricao: p.description, descritor: p.statement_descriptor })),
    });
  }

  if (acao === "produtos") {
    const db = admin();
    const { data: planos } = await db.from("plans").select("tier, name, stripe_price_monthly, stripe_price_annual").eq("active", true);
    const feitos: Record<string, unknown>[] = [];
    for (const p of planos ?? []) {
      const ids = new Set<string>();
      for (const priceId of [p.stripe_price_monthly, p.stripe_price_annual]) {
        if (!priceId) continue;
        const price = await stripe.prices.retrieve(priceId);
        ids.add(typeof price.product === "string" ? price.product : price.product.id);
      }
      for (const id of ids) {
        const prod = await stripe.products.update(id, {
          name: `HospedePay ${p.name}`,
          description: DESCRICAO[p.tier as string] ?? undefined,
          images: [`${base}/stripe/produto.png`],
          statement_descriptor: DESCRITOR,
        });
        feitos.push({ tier: p.tier, id: prod.id, nome: prod.name, imagens: prod.images });
      }
    }
    return json({ ok: true, produtos: feitos });
  }

  if (acao === "marcar") {
    const conta = await stripe.accounts.retrieve();
    const icone = await subirArquivo(chave, `${base}/stripe/icone.png`, "business_icon", "icone.png");
    const logo = await subirArquivo(chave, `${base}/stripe/logo.png`, "business_logo", "logo.png");
    try {
      const nova = await stripe.accounts.update(conta.id, {
        business_profile: {
          name: body.nome ?? "HospedePay",
          url: base,
          ...(body.suporte ? { support_email: body.suporte } : {}),
        },
        settings: {
          branding: { icon: icone, logo, primary_color: CORAL, secondary_color: "#000000" },
          payments: { statement_descriptor: DESCRITOR },
        },
      });
      return json({ ok: true, via: "api", marca: nova.settings?.branding, nome: nova.business_profile?.name });
    } catch (e) {
      return json({
        ok: false,
        via: "painel",
        arquivos: { icone, logo },
        motivo: e instanceof Error ? e.message : String(e),
      });
    }
  }

  throw errors.invalid("Ação desconhecida");
});
