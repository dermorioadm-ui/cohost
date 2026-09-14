/**
 * O plano que a pessoa escolheu na página de vendas, guardado até o pagamento.
 *
 * Entre clicar em "Assinar o Essencial anual" e pagar existem três telas
 * (cadastro, e-mail de confirmação, primeiro login) e, no meio delas, uma
 * troca de aba: o link do e-mail abre uma janela nova, sem a query string
 * original. O localStorage é o que faz a escolha atravessar esse caminho.
 *
 * É apagado no momento em que o pagamento é confirmado, ou quando a pessoa
 * decide seguir sem assinar.
 */

export type Tier = "essencial" | "pro" | "ilimitado";
export type Ciclo = "monthly" | "annual";

export interface PlanoEscolhido {
  tier: Tier;
  cycle: Ciclo;
}

const CHAVE = "hospedepay.plano-escolhido";

const TIERS: Tier[] = ["essencial", "pro", "ilimitado"];

/** Lê `plano` e `ciclo` da query da página de vendas; ignora o que não conhece. */
export function planoDaQuery(params: URLSearchParams): PlanoEscolhido | null {
  const tier = params.get("plano");
  if (!tier || !TIERS.includes(tier as Tier)) return null;
  const c = params.get("ciclo");
  const cycle: Ciclo = c === "mensal" || c === "monthly" ? "monthly" : "annual";
  return { tier: tier as Tier, cycle };
}

export function guardarPlano(p: PlanoEscolhido) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(p));
  } catch {
    /* modo privado sem storage: a escolha só vale nesta aba */
  }
}

export function planoGuardado(): PlanoEscolhido | null {
  try {
    const raw = localStorage.getItem(CHAVE);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PlanoEscolhido>;
    if (!p.tier || !TIERS.includes(p.tier)) return null;
    return { tier: p.tier, cycle: p.cycle === "monthly" ? "monthly" : "annual" };
  } catch {
    return null;
  }
}

export function esquecerPlano() {
  try {
    localStorage.removeItem(CHAVE);
  } catch {
    /* nada a apagar */
  }
}

export const NOME_TIER: Record<Tier, string> = {
  essencial: "Essencial",
  pro: "Profissional",
  ilimitado: "Portfólio",
};

export const brl = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
