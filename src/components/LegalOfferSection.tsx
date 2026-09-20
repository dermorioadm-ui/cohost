import { useRef } from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import "./LegalOfferSection.css";

/** Apresentação aprovada. A contratação será integrada após a implantação operacional do jurídico. */
export function LegalOfferSection({ onConsult }: { onConsult?: () => void }) {
  const conditionsRef = useRef<HTMLDetailsElement>(null);
  const showConditions = () => {
    if (conditionsRef.current) conditionsRef.current.open = true;
  };

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
        <p id="legal-offer-note" className="legal-offer__note">
          * Assistência jurídica opcional, com contratação anual separada do plano. Consulte disponibilidade, escopo e condições antes de contratar.
        </p>
        <p id="legal-offer-status" className="legal-offer__status">
          Prévia da oferta. Contratação ainda não disponível.
        </p>
      </div>

      <details id="condicoes-assistencia-juridica" ref={conditionsRef} className="legal-offer__conditions">
        <summary>
          Escopo e condições da assistência <Plus aria-hidden size={18} />
        </summary>
        <div className="legal-offer__conditions-content">
          <p>A assistência jurídica tem contratação anual e separada da ferramenta. A apresentação acima não inclui assistência jurídica nos planos.</p>
          <p>Consulte a disponibilidade, os imóveis atendidos, o escopo e as condições de pagamento antes de contratar. A busca por reparação não garante ressarcimento.</p>
          {onConsult && (
            <button type="button" className="legal-offer__consult" onClick={onConsult}>
              Conversar sobre as condições <ArrowUpRight aria-hidden size={16} />
            </button>
          )}
        </div>
      </details>
    </section>
  );
}
