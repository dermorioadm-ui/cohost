import { useQuery } from "@tanstack/react-query";
import { ApiError, request, supabase } from "@/lib/api";

export interface LegalOffer {
  id: string;
  version: number;
  title: string;
  annual_price_cents: number;
  currency: string;
  term_months: 12;
  scope_text: string;
  property_scope_text: string;
  service_terms: string;
  payment_terms: string;
  terms_url: string;
}
export interface LegalOfferResponse { available: boolean; offer: LegalOffer | null }
export type LegalRequestStatus = "received" | "in_review" | "waiting_customer" | "completed";
export interface LegalRequest {
  id: string;
  subject: string;
  description: string;
  status: LegalRequestStatus;
  public_reply: string;
  created_at: string;
  updated_at: string;
  user_id?: string;
  email?: string;
  messages?: { id: string; author_role: "owner" | "admin"; message: string; created_at: string }[];
}
export interface LegalEntitlement {
  id: string;
  status: "active" | "revoked";
  starts_at: string;
  ends_at: string;
  offer_snapshot: LegalOffer;
}
export interface LegalOverview {
  has_access: boolean;
  entitlements: LegalEntitlement[];
  requests: LegalRequest[];
  orders: { id: string; status: string; created_at: string }[];
}
export const LEGAL_STATUS: Record<LegalRequestStatus, string> = {
  received: "Recebido", in_review: "Em análise", waiting_customer: "Aguardando você", completed: "Concluído",
};

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new ApiError(error.message, "Não foi possível consultar o atendimento. Tente novamente.", 400);
  return data as T;
}
export const legalApi = {
  offer: () => rpc<LegalOfferResponse>("legal_offer"),
  overview: () => rpc<LegalOverview>("legal_overview"),
  createRequest: (subject: string, description: string, key: string) => rpc<LegalRequest>("legal_create_request", {
    _subject: subject, _description: description, _request_key: key,
  }),
  adminRequests: () => rpc<LegalRequest[]>("admin_legal_requests"),
  replyRequest: (id: string, message: string, key: string) => rpc<LegalRequest>("legal_reply_request", {
    _id: id, _message: message, _request_key: key,
  }),
  paymentReviews: () => rpc<{ id: string; user_id: string; email: string; status: string; stripe_session_id: string | null; updated_at: string }[]>("admin_legal_payment_reviews"),
  updateRequest: (id: string, status: LegalRequestStatus, reply: string) => rpc<LegalRequest>("admin_legal_update_request", {
    _id: id, _status: status, _public_reply: reply,
  }),
  checkout: (offer: LegalOffer, key: string) => request<{ ok: boolean; url: string; session_id: string }>("legal-checkout", {
    body: { offer_id: offer.id, offer_version: offer.version, accepted_terms: true, request_id: key },
  }),
  checkoutStatus: (session: string) => request<{ ok: boolean; state: "pending" | "active" | "failed"; entitlement?: LegalEntitlement }>(
    "legal-checkout-status", { body: { session_id: session } },
  ),
};
export function useLegalOffer() {
  return useQuery({ queryKey: ["legal-offer"], queryFn: legalApi.offer, staleTime: 30_000, retry: false });
}
export function legalPrice(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}
export function legalDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" }).format(new Date(value));
}
export function legalError(error: unknown) {
  const messages: Record<string, string> = {
    legal_offer_unavailable: "A contratação está indisponível neste momento.",
    legal_offer_changed: "As condições foram atualizadas. Confira a oferta novamente antes de continuar.",
    legal_already_active: "Você já tem assistência jurídica vigente. Atualize esta página para acessar.",
    legal_access_required: "É preciso ter assistência jurídica vigente para abrir um atendimento.",
  };
  return error instanceof ApiError ? messages[error.code] ?? error.message : "Não foi possível concluir. Tente novamente.";
}
/** Aceita somente o domínio do checkout hospedado; nunca redireciona para URL recebida sem validação. */
export function legalCheckoutUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) {
    throw new Error("Invalid checkout URL");
  }
  return url.href;
}
