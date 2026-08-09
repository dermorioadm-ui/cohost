/**
 * Taxas de reposição — vocabulário compartilhado entre a tela da diarista e o
 * financeiro do dono.
 *
 * Os valores de `FEE_CATEGORIES` e `FEE_STATUS` são os enums `fee_category` e
 * `fee_status` do banco (migration 0007). Mudou lá, muda aqui.
 */

export const FEE_CATEGORIES = [
  { value: "cleaning_products", label: "Produtos de limpeza" },
  { value: "kitchen_supplies", label: "Cozinha" },
  { value: "toiletries", label: "Higiene" },
  { value: "laundry", label: "Lavanderia" },
  { value: "batteries", label: "Pilhas" },
  { value: "other", label: "Outros" },
] as const;

export type FeeCategory = (typeof FEE_CATEGORIES)[number]["value"];
export type FeeStatus = "pending" | "approved" | "rejected";

const CATEGORY_LABEL = Object.fromEntries(
  FEE_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<FeeCategory, string>;

export const categoryLabel = (v: string) => CATEGORY_LABEL[v as FeeCategory] ?? v;

export const FEE_STATUS_LABEL: Record<FeeStatus, string> = {
  pending: "Aguardando aprovação",
  approved: "Aprovada",
  rejected: "Recusada",
};

export const brl = (value: number | string) =>
  `R$ ${Number(value ?? 0).toFixed(2).replace(".", ",")}`;

/**
 * Datas de competência.
 *
 * Tudo aqui trabalha com a string `AAAA-MM-01` e nunca com `Date` cru: o mês de
 * referência é um `date` no Postgres, e passar por `new Date("2026-08-01")`
 * interpreta como UTC — a oeste de Greenwich isso devolve julho. Foi essa
 * classe de bug que fez o botão de concluir limpeza sumir depois das 21h no
 * produto antigo.
 */
const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Primeiro dia do mês corrente no fuso de São Paulo, como AAAA-MM-01. */
export function currentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  return `${parts}-01`;
}

/** Desloca a competência em N meses, preservando o formato AAAA-MM-01. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/** "agosto de 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} de ${y}`;
}

/** Último dia do mês, como AAAA-MM-DD. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** "14/08" — data curta a partir de AAAA-MM-DD, sem passar por Date. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/**
 * Aceita "18", "18,50" e "18.50" — a diarista digita no teclado do celular,
 * onde a vírgula é o separador natural. Devolve null se não for um valor usável.
 */
export function parseAmount(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
