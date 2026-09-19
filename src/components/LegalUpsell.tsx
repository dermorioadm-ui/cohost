import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { legalApi, legalPrice, useLegalOffer } from "@/lib/legal";

/** Renderizar somente depois de confirmar a assinatura no servidor. */
export function LegalUpsell() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const offerQuery = useLegalOffer();
  const overview = useQuery({ queryKey: ["legal-overview", user?.id], queryFn: legalApi.overview, enabled: !!user, retry: false });
  const offer = offerQuery.data?.available ? offerQuery.data.offer : null;
  if (dismissed || !user || !offer || !overview.data || overview.data.has_access) return null;
  return <aside className="mt-8 rounded-3xl border border-border p-6 text-left" aria-label="Assistência jurídica opcional">
    <Scale className="h-5 w-5 text-primary" aria-hidden />
    <p className="rotulo mt-4 text-primary">Assistência Jurídica Hospedepay*</p>
    <h2 className="mt-2 text-2xl tracking-titulo">Sua proteção pode ir além do contrato.</h2>
    <p className="mt-3 text-base leading-relaxed">Adicione apoio jurídico para agir e buscar reparação se o hóspede ou a plataforma não assumirem o dano.*</p>
    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{offer.scope_text}</p>
    <p className="mt-4 text-2xl">{legalPrice(offer.annual_price_cents)} <span className="text-sm text-muted-foreground">por ano</span></p>
    <p className="mt-1 text-xs text-muted-foreground">Equivalente a {legalPrice(offer.annual_price_cents / 12)} por mês. Vigência de 12 meses.</p>
    <p className="mt-3 text-sm">O acesso jurídico continua durante a vigência contratada, mesmo se você encerrar a ferramenta.</p>
    <Button asChild variant="outline" className="mt-5 w-full"><Link to="/juridico?origem=pos-compra">Ver condições da assistência</Link></Button>
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">* Contratação anual opcional, separada do plano. Confira o escopo e as condições antes de contratar.</p>
    <button type="button" className="mt-4 w-full text-sm text-muted-foreground underline underline-offset-4" onClick={() => setDismissed(true)}>Agora não</button>
  </aside>;
}
