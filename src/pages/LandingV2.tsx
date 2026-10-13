import { useEffect, useRef } from "react";
import { CheckInDemoPortal } from "@/components/CheckInDemoPortal";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import Landing from "./Landing";
import styles from "./LandingV2.css?inline";

/** Isolated visual alternative. Landing.tsx, data and checkout are shared unchanged. */
export default function LandingV2({ production = false }: { production?: boolean }) {
  const scope = useRef<HTMLElement>(null);
  useEffect(() => {
    const theme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousTheme = theme?.content;
    if (theme) theme.content = '#ffffff';
    const title = document.title;
    document.title = production ? "HospedePay | Proteção e gestão para seu imóvel" : "HóspedePay | Versão 2 · prévia";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    if (!production) document.head.appendChild(robots);
    const economy = scope.current?.querySelector('.comparacao-economia');
    const summary = document.createElement('p');
    summary.className = 'v2-economy-summary';
    const amount = economy?.querySelector('strong')?.textContent;
    if (economy && amount) {
      const period = economy.textContent?.includes('por mês') ? 'mês' : 'ano';
      summary.textContent = `Neste exemplo: ${amount}/${period} a mais.`;
      economy.appendChild(summary);
    }
    const person = scope.current?.querySelector('#quem-responde');
    const guarantee = scope.current?.querySelector('#garantia');
    const home = document.createComment('v2-person-original-position');
    if (person && guarantee && person.parentNode === guarantee.parentNode) {
      person.before(home);
      guarantee.after(person);
      window.dispatchEvent(new Event('resize'));
    }
    const plans = scope.current?.querySelector('#planos, #oferta');
    const guaranteeHome = document.createComment('v2-guarantee-original-position');
    if (guarantee && plans && guarantee.parentNode === plans.parentNode) {
      guarantee.before(guaranteeHome);
      plans.before(guarantee);
      window.dispatchEvent(new Event('resize'));
    }
    const legal = scope.current?.querySelector('#assistencia-juridica');
    const legalHome = document.createComment('v2-legal-original-position');
    if (legal && guarantee) {
      legal.before(legalHome);
      guarantee.after(legal);
      window.dispatchEvent(new Event('resize'));
    }
    return () => {
      if (legal && legalHome.parentNode) legalHome.replaceWith(legal);
      if (guarantee && guaranteeHome.parentNode) guaranteeHome.replaceWith(guarantee);
      if (theme && previousTheme !== undefined) theme.content = previousTheme;
      summary.remove();
      if (person && home.parentNode) home.replaceWith(person);
      document.title = title; robots.remove();
    };
  }, [production]);

  return (
    <main className="hp-v2" ref={scope}>
      <style>{styles}</style>
      {!production && <div className="v2-review" aria-label="Comparação de versões">
        <span><b>Versão 2</b><span className="v2-review-detail"> · prévia para avaliação</span></span>
        <Link to="/pagina">Ver original <ArrowUpRight size={14} aria-hidden="true" /></Link>
      </div>}
      <a className="v2-skip" href="#check-in">Ir para a demonstração</a>
      <Landing />
      <CheckInDemoPortal scope={scope} />
    </main>
  );
}
