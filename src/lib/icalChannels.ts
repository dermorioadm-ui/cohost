/**
 * Canais de calendário oferecidos na interface.
 *
 * Vive num módulo só porque duas telas pedem o mesmo link — o onboarding e a
 * edição do imóvel. Instrução de "onde achar o link" duplicada diverge na
 * primeira vez que a plataforma mexe no menu dela.
 *
 * O enum `ical_provider` do banco também tem `vrbo` e `other`, e o backend
 * continua aceitando ambos quando adivinha pela URL. Aqui ficam só os que o
 * cliente usa: uma lista de quatro canais faria a tela parecer inacabada.
 */

export type IcalProvider = "airbnb" | "booking" | "vrbo" | "other";

export interface IcalChannel {
  provider: Extract<IcalProvider, "airbnb" | "booking">;
  label: string;
  placeholder: string;
  /** Caminho do menu até o link de exportação, na própria plataforma. */
  hint: string;
  helpUrl: string;
  swatch: string;
}

export const ICAL_CHANNELS: IcalChannel[] = [
  {
    provider: "airbnb",
    label: "Airbnb",
    placeholder: "https://www.airbnb.com.br/calendar/ical/...",
    hint: "Calendário → Disponibilidade → Conectar a outro site → Copiar link",
    helpUrl: "https://www.airbnb.com.br/help/article/99",
    swatch: "bg-primary/70",
  },
  {
    provider: "booking",
    label: "Booking.com",
    placeholder: "https://ical.booking.com/v1/export?t=...",
    hint: "Extranet → Tarifas e Disponibilidade → Sincronizar calendários → Exportar",
    helpUrl: "https://partner.booking.com/pt-br/ajuda/tarifas-disponibilidade/sincronizacao-de-calendarios",
    swatch: "bg-[hsl(var(--booking))]",
  },
];

export const channelOf = (provider: string): IcalChannel | undefined =>
  ICAL_CHANNELS.find((c) => c.provider === provider);
