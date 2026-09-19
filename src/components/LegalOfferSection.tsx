import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useLegalOffer } from "@/lib/legal";
import "./LegalOfferSection.css";

/** A oferta jurídica tem condições e vigência próprias; nenhum preço local. */
export function LegalOfferSection({ onConsult }: { onConsult?: () => void }) {
  const { data, isPending, isError } = useLegalOffer();
  const offer = data?.available ? data.offer : null;
  const formatPrice = (cents: number) =>
    (cents / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: offer?.currency || "BRL",
      maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    });

  return (
    <section id="assistencia-juridica" className="legal-offer" aria-labelledby="legal-offer-title">
      <div className="legal-offer__intro" data-reveal="up">
        <p className="legal-offer__eyebrow">
          <span aria-hidden /> Assistência jurídica · opcional
        </p>
        <h2 id="legal-offer-title" className="legal-offer__title">
          E quando o problema pede um <em>advogado?</em>
        </h2>
        <p className="legal-offer__description">
          {offer
            ? offer.scope_text
            : "Estamos preparando uma assistência jurídica para quem opera imóveis de temporada. Será um adicional opcional, com contratação anual separada da ferramenta."}
        </p>
        <p className="legal-offer__separate">
          Você escolhe a ferramenta. A assistência jurídica é uma decisão à parte.
        </p>
      </div>

      <div className="legal-offer__decision" data-reveal="up">
        <p className="legal-offer__product">{offer?.title || "Assistência jurídica"}</p>
        {offer ? (
          <>
            <div className="legal-offer__price">
              <span>{formatPrice(offer.annual_price_cents)}</span>
              <span className="legal-offer__period">por ano</span>
            </div>
            <p className="legal-offer__equivalent">
              Equivalente a {formatPrice(Math.round(offer.annual_price_cents / offer.term_months))}/mês.
              <br />A contratação é anual.
            </p>
            <dl className="legal-offer__facts">
              <div><dt>Vigência</dt><dd>{offer.term_months} meses</dd></div>
              <div><dt>Imóveis atendidos</dt><dd>{offer.property_scope_text}</dd></div>
              <div><dt>Pagamento</dt><dd>{offer.payment_terms}</dd></div>
            </dl>
            <Link to="/juridico" className="legal-offer__action">
              Ver condições e contratar <ArrowUpRight aria-hidden size={18} />
            </Link>
            <p className="legal-offer__note">Confira o escopo e as condições antes de contratar.</p>
          </>
        ) : (
          <>
            <p className="legal-offer__teaser-title">Contratação <em>anual.</em></p>
            <ul className="legal-offer__principles">
              <li>Adicional opcional</li>
              <li>Contrato separado da ferramenta</li>
              <li>Acesso pelo período contratado</li>
            </ul>
            {isPending ? (
              <p className="legal-offer__note" role="status">Consultando as condições…</p>
            ) : (
              <>
                {onConsult && (
                  <button type="button" className="legal-offer__action" onClick={onConsult}>
                    Conhecer a assistência jurídica <ArrowUpRight aria-hidden size={18} />
                  </button>
                )}
                <p className="legal-offer__note" role={isError ? "status" : undefined}>
                  {isError
                    ? "As condições não puderam ser carregadas agora."
                    : "Contratação ainda não disponível."}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
