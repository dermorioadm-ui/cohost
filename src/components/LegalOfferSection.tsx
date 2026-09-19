import { useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Plus } from "lucide-react";
import { useLegalOffer } from "@/lib/legal";
import "./LegalOfferSection.css";

/** A proposta permanece visível; preço e contratação exigem oferta ativa do servidor. */
export function LegalOfferSection({ onConsult }: { onConsult?: () => void }) {
  const { data, isPending, isError } = useLegalOffer();
  const offer = data?.available ? data.offer : null;
  const conditionsRef = useRef<HTMLDetailsElement>(null);
  const showConditions = () => {
    if (conditionsRef.current) conditionsRef.current.open = true;
  };
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
          <span aria-hidden /> Assistência Jurídica HospedePay
          <a href="#legal-offer-note" aria-label="Condições da assistência jurídica">*</a>
        </p>
        <h2 id="legal-offer-title" className="legal-offer__title">
          Da proteção do imóvel à busca por <em>reparação.</em>
        </h2>
        <div className="legal-offer__benefits">
          <p><span aria-hidden>01</span>Documento, identificação facial e contrato assinado ajudam a proteger antes da estadia.</p>
          <p><span aria-hidden>02</span>A assistência jurídica acrescenta apoio para buscar reparação quando o dano já aconteceu.*</p>
        </div>
      </div>

      <div className="legal-offer__decision" data-reveal="up">
        {offer ? (
          <>
            <p className="legal-offer__product">{offer.title}</p>
            <div className="legal-offer__price">
              <span>{formatPrice(offer.annual_price_cents)}</span>
              <span className="legal-offer__period">por ano</span>
            </div>
            <p className="legal-offer__equivalent">
              Equivalente a {formatPrice(Math.round(offer.annual_price_cents / offer.term_months))}/mês.
              <br />A contratação é anual.
            </p>
            <Link to="/juridico" className="legal-offer__action" aria-describedby="legal-offer-note">
              Ver condições da assistência <ArrowUpRight aria-hidden size={18} />
            </Link>
          </>
        ) : (
          <>
            <p className="legal-offer__teaser-title">Apoio para buscar <em>reparação.</em></p>
            {onConsult ? (
              <button type="button" className="legal-offer__action" onClick={onConsult} aria-describedby="legal-offer-note legal-offer-status">
                Conhecer a assistência jurídica <ArrowUpRight aria-hidden size={18} />
              </button>
            ) : (
              <a href="#condicoes-assistencia-juridica" className="legal-offer__action" onClick={showConditions} aria-describedby="legal-offer-note legal-offer-status">
                Conhecer a assistência jurídica <ArrowUpRight aria-hidden size={18} />
              </a>
            )}
          </>
        )}
        <p id="legal-offer-note" className="legal-offer__note">
          * Assistência jurídica opcional, com contratação anual separada do plano. Consulte disponibilidade, escopo e condições antes de contratar.
        </p>
        {!offer && (
          <p id="legal-offer-status" className="legal-offer__status" role="status">
            {isPending
              ? "Prévia da oferta. Consultando a disponibilidade de contratação…"
              : isError
                ? "Prévia da oferta. Não foi possível consultar a disponibilidade de contratação agora."
                : "Prévia da oferta. Contratação ainda não disponível."}
          </p>
        )}
      </div>

      <details id="condicoes-assistencia-juridica" ref={conditionsRef} className="legal-offer__conditions">
        <summary>
          Escopo e condições da assistência <Plus aria-hidden size={18} />
        </summary>
        {offer ? (
          <div className="legal-offer__conditions-content">
            <p>{offer.scope_text}</p>
            <dl className="legal-offer__facts">
              <div><dt>Vigência</dt><dd>{offer.term_months} meses</dd></div>
              <div><dt>Imóveis atendidos</dt><dd>{offer.property_scope_text}</dd></div>
              <div><dt>Pagamento</dt><dd>{offer.payment_terms}</dd></div>
            </dl>
            <p>{offer.service_terms}</p>
          </div>
        ) : (
          <div className="legal-offer__conditions-content">
            <p>A assistência jurídica tem contratação anual e separada da ferramenta. A apresentação acima não inclui assistência jurídica nos planos.</p>
            <p>Consulte a disponibilidade, os imóveis atendidos, o escopo e as condições de pagamento antes de contratar. A busca por reparação não garante ressarcimento.</p>
            {onConsult && (
              <button type="button" className="legal-offer__consult" onClick={onConsult}>
                Conversar sobre as condições <ArrowUpRight aria-hidden size={16} />
              </button>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
