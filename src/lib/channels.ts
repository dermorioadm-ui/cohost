/**
 * Cor de cada canal de reserva, num lugar só.
 *
 * Nasceu dentro do calendário do dono, onde as faixas já eram coloridas por
 * canal. Saiu de lá quando a mesma distinção passou a valer nos CARTÕES —
 * painel do dono e agenda da diarista: uma tarja vertical na lateral esquerda,
 * na cor do canal, para reconhecer de relance de onde veio aquela limpeza sem
 * precisar ler nada.
 *
 * A tarja é lateral, e não fundo colorido: o cartão é de vidro e o fundo
 * translúcido tingido some contra o gradiente da tela. Uma barra sólida de
 * 4px na borda sobrevive a qualquer fundo, inclusive impressa em preto e
 * branco, onde ainda resta a diferença de tom.
 */

export type Provider = "airbnb" | "booking" | "vrbo" | "other";

export interface ProviderStyle {
  /** Faixa contínua da reserva, no calendário. */
  bar: string;
  /** Pastilha/etiqueta pequena. */
  dot: string;
  /** Tarja vertical na lateral esquerda do cartão. */
  stripe: string;
  label: string;
}

export const PROVIDER_STYLE: Record<Provider, ProviderStyle> = {
  airbnb: {
    bar: "border-primary/45 bg-primary/30",
    dot: "border-primary/40 bg-primary/20",
    stripe: "bg-primary",
    label: "Airbnb",
  },
  booking: {
    bar: "border-[hsl(var(--booking)/0.55)] bg-[hsl(var(--booking)/0.38)]",
    dot: "border-[hsl(var(--booking)/0.45)] bg-[hsl(var(--booking)/0.25)]",
    stripe: "bg-[hsl(var(--booking))]",
    label: "Booking",
  },
  vrbo: {
    bar: "border-[hsl(var(--vrbo)/0.5)] bg-[hsl(var(--vrbo)/0.32)]",
    dot: "border-[hsl(var(--vrbo)/0.4)] bg-[hsl(var(--vrbo)/0.2)]",
    stripe: "bg-[hsl(var(--vrbo))]",
    label: "Vrbo",
  },
  other: {
    bar: "border-white/25 bg-white/15",
    dot: "border-white/20 bg-white/10",
    stripe: "bg-white/30",
    label: "Outro",
  },
};

export const styleOf = (p: string | null | undefined): ProviderStyle =>
  PROVIDER_STYLE[(p ?? "other") as Provider] ?? PROVIDER_STYLE.other;

/**
 * Rótulos que as plataformas mandam quando NÃO revelam quem é o hóspede.
 *
 * O Booking exporta toda estadia como "CLOSED - Not available" e o Airbnb como
 * "Reserved" — nenhum dos dois diz nada, e "CLOSED - Not available" atravessando
 * uma faixa ainda parece defeito. Nesses casos mostramos o nome do canal, que é
 * a informação que sobra e que o dono realmente usa.
 */
export const OPAQUE_LABEL =
  /^(closed|reserved|not available|unavailable|blocked|busy|bloqueado)\b/i;

/** Nome do hóspede quando a plataforma manda; senão, o canal. */
export function guestLabelOf(raw: string | null | undefined, provider: string | null): string {
  const text = raw?.trim() ?? "";
  if (text && !OPAQUE_LABEL.test(text)) return text;
  return styleOf(provider).label;
}
