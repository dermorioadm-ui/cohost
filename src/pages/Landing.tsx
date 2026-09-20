import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Marca } from "@/components/Marca";
import { LegalOfferSection } from "@/components/LegalOfferSection";
import { cn } from "@/lib/utils";
import { api, ApiError, supabase } from "@/lib/api";

/**
 * Página de vendas: "Check-in Blindado".
 *
 * É a página que define a identidade do produto inteiro — papel branco, tinta
 * preta, coral só no que pede atenção, verde-água só no que está no ar. O
 * painel herda tudo daqui (ver `index.css` e `AppShell`), e é por isso que a
 * página mora no mesmo app, e não num site à parte: a pílula que flutua no
 * alto desta tela é a mesma que o cliente vê depois de entrar.
 *
 * A página é montada como uma sessão de cinema, não como um anúncio: o
 * herói é a capa, e daí para baixo cada seção é uma CENA que puxa a próxima.
 * Os quatro benefícios são telas cheias que se empilham (a de cima encolhe e
 * escurece enquanto a próxima desliza por cima); o "e ainda" corre na
 * horizontal enquanto a página desce; a comparação escura cresce até tomar a
 * largura toda; a garantia cresce até a borda. Todo movimento é ligado à
 * rolagem — nada acontece sozinho — e é interpolado com inércia, para a
 * página deslizar em vez de pular. Com `prefers-reduced-motion` tudo vira
 * estático e a leitura é a mesma.
 *
 * A tipografia continua fina (DM Sans 400/500), com um único gesto novo: uma
 * palavra por título em serifa itálica (Instrument Serif) — a palavra que
 * carrega a emoção da frase. É o que separa uma página editorial de um
 * anúncio de imóvel.
 *
 * As fotos e os vídeos vivem em `public/lp/`. O que a página lê do ambiente
 * (todos opcionais, ver `.env.example`): endpoint do formulário, número de
 * WhatsApp (ou o do banco, via `landing_config`), estado online/offline e
 * trocas de vídeo/foto.
 */

const ENV = import.meta.env as Record<string, string | undefined>;
const LEAD_ENDPOINT = (ENV.VITE_LEAD_ENDPOINT ?? "").trim();
// O número pode vir do build (VITE_WHATSAPP) ou do banco (app_settings via
// landing_config), que é o caminho para trocar sem novo deploy.
const WHATSAPP_BUILD = (ENV.VITE_WHATSAPP ?? "").replace(/\D/g, "");
const ESTADO = (ENV.VITE_LP_ESTADO ?? "online") as "online" | "offline" | "auto";
const STATUS_URL = (ENV.VITE_LP_STATUS_URL ?? "").trim();
const VIDEO_PROVA = (ENV.VITE_LP_VIDEO_PROVA ?? "").trim() || "/lp/prova.mp4";
/** Segundo em que o vídeo do cadastro começa (corta a abertura parada). */
const VIDEO_PROVA_INICIO = 4;
const FOTO = (ENV.VITE_LP_FOTO ?? "").trim() || "/lp/renato.webp";
const ANUNCIO_AIRBNB = "https://www.airbnb.com.br/rooms/1497251231116164748";

/** Números da seção "Prova": o apartamento de Niterói, de verdade. */
const PROVA = { reservas: 14, hospedes: 27, termos: 14, cadastros: 26 };

/**
 * Reserva de public.plans, usada até a tabela responder (e se ela não
 * responder). Os três planos são IGUAIS; a única variável é quantos imóveis
 * rodam. Anual paga 10 meses e usa 12. O valor de verdade é o da tabela: é
 * dela que o checkout cobra, e a página nunca pode prometer outro número.
 */
const PLANOS_RESERVA = [
  { tier: "essencial", nome: "Essencial", imoveis: "1 imóvel", mensal: 97, anual: 970 },
  { tier: "pro", nome: "Profissional", imoveis: "2 ou 3 imóveis", mensal: 197, anual: 1970 },
  { tier: "ilimitado", nome: "Portfólio", imoveis: "4 ou 5 imóveis", mensal: 297, anual: 2970 },
];

const brl = (n: number) => `R$${n.toLocaleString("pt-BR")}`;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/* -------------------------------------------------------------------------
 * Movimento.
 *
 * Dois mecanismos, e só dois:
 *
 *   1. REVELAÇÃO. Um observador para tudo o que tem `data-reveal`: quando o
 *      elemento entra na tela ganha `is-in` e a CSS faz o resto (máscara nas
 *      palavras dos títulos, subida nos blocos, traço que cresce, contador).
 *
 *   2. CENA. Tudo o que tem `data-cena` recebe uma variável CSS `--p`, de 0
 *      a 1, com o quanto a rolagem já atravessou aquele elemento. A CSS
 *      transforma `--p` em movimento (empilhar, deslizar, crescer, acender).
 *      O valor é interpolado com inércia a cada frame — é isso que faz a
 *      página deslizar em vez de acompanhar o dedo aos trancos.
 *
 * Sem JS o conteúdo aparece igual — a classe `lp-js` só esconde o que vai
 * ser revelado depois que o observador existe.
 * ---------------------------------------------------------------------- */
function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useReveal(root: React.RefObject<HTMLElement>, reduz: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.classList.add("lp-js");
    if (reduz) {
      el.querySelectorAll<HTMLElement>("[data-reveal],[data-fill]").forEach((n) => n.classList.add("is-in"));
      el.querySelectorAll<HTMLElement>("[data-count]").forEach((n) => (n.textContent = n.dataset.count ?? ""));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = e.target as HTMLElement;
          n.classList.add("is-in");
          if (n.dataset.count) contar(n, Number(n.dataset.count));
          io.unobserve(n);
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -6% 0px" },
    );
    el.querySelectorAll("[data-reveal],[data-fill],[data-count]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root, reduz]);
}

function contar(el: HTMLElement, alvo: number) {
  const t0 = performance.now();
  const dur = 1400;
  const tick = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(2, -10 * p);
    el.textContent = String(Math.round(alvo * e));
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = String(alvo);
  };
  requestAnimationFrame(tick);
}

/**
 * `--p` para cada `data-cena`. Três modos de medir:
 *   pin        — o elemento é mais alto que a tela e tem um filho sticky;
 *                0 quando encosta no topo, 1 quando o fim chega ao topo.
 *   entrar     — 0 quando o topo aparece embaixo, 1 quando chega a 30% da tela.
 *   atravessar — 0 quando entra por baixo, 1 quando sai por cima.
 * Quem tem um `data-trilho` dentro também recebe `--dx`: quantos pixels o
 * trilho precisa andar para mostrar o último cartão.
 */
function useCenas(root: React.RefObject<HTMLElement>, reduz: boolean) {
  useEffect(() => {
    const raiz = root.current;
    if (!raiz || reduz) return;
    type Item = { el: HTMLElement; modo: string; cur: number; alvo: number; trilho: HTMLElement | null };
    let itens: Item[] = [];
    let raf = 0;

    const coletar = () => {
      itens = Array.from(raiz.querySelectorAll<HTMLElement>("[data-cena]")).map((el) => ({
        el, modo: el.dataset.cena ?? "entrar", cur: -1, alvo: 0,
        trilho: el.querySelector<HTMLElement>("[data-trilho]"),
      }));
    };

    const medir = () => {
      const vh = window.innerHeight;
      for (const it of itens) {
        const r = it.el.getBoundingClientRect();
        let p = 0;
        if (it.modo === "pin") p = r.height > vh ? -r.top / (r.height - vh) : 0;
        else if (it.modo === "atravessar") p = (vh - r.top) / (vh + r.height);
        else p = (vh * 0.92 - r.top) / (vh * 0.62);
        it.alvo = clamp01(p);
        if (it.trilho) {
          const dx = it.trilho.scrollWidth - it.el.clientWidth;
          it.el.style.setProperty("--dx", `${-Math.max(0, dx)}px`);
        }
      }
    };

    const loop = () => {
      raf = 0;
      let vivo = false;
      for (const it of itens) {
        const d = it.alvo - it.cur;
        if (it.cur < 0 || reduz || Math.abs(d) < 0.0006) {
          if (it.cur !== it.alvo) { it.cur = it.alvo; it.el.style.setProperty("--p", it.cur.toFixed(4)); }
          continue;
        }
        it.cur += d * 0.16;
        it.el.style.setProperty("--p", it.cur.toFixed(4));
        vivo = true;
      }
      if (vivo) raf = requestAnimationFrame(loop);
    };

    const rolar = () => { medir(); if (!raf) raf = requestAnimationFrame(loop); };
    const redimensionar = () => { coletar(); rolar(); };

    coletar();
    rolar();
    window.addEventListener("scroll", rolar, { passive: true });
    window.addEventListener("resize", redimensionar);
    // Fontes e imagens mudam alturas depois do primeiro frame.
    const t = window.setTimeout(redimensionar, 600);
    return () => {
      window.removeEventListener("scroll", rolar);
      window.removeEventListener("resize", redimensionar);
      window.clearTimeout(t);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [root, reduz]);
}

/**
 * O herói encolhe e escurece conforme sai de cena, e o título some antes do
 * resto: a página "fecha" a capa e abre o papel branco por baixo.
 */
function useEncolherHero(hero: React.RefObject<HTMLElement>, titulo: React.RefObject<HTMLElement>, reduz: boolean) {
  useEffect(() => {
    const el = hero.current;
    if (!el) return;
    if (reduz) {
      el.style.transform = "";
      el.style.borderRadius = "";
      el.style.filter = "";
      if (titulo.current) titulo.current.style.opacity = "";
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const raw = clamp01(-r.top / (r.height * 0.55));
      const p = raw * raw * (3 - 2 * raw);
      el.style.transform = p > 0.001 ? `scale(${(1 - 0.22 * p).toFixed(4)}) translateY(${(p * 40).toFixed(1)}px)` : "";
      el.style.borderRadius = p > 0.001 ? `${(56 * p).toFixed(1)}px` : "";
      el.style.filter = p > 0.001 ? `brightness(${(1 - 0.34 * p).toFixed(3)})` : "";
      if (titulo.current) {
        const rolado = Math.max(0, -r.top) / r.height;
        titulo.current.style.opacity = String(clamp01(1 - (rolado - 0.25) / 0.5));
      }
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(tick); };
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    tick();
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hero, titulo, reduz]);
}

const delay = (ms: number): CSSProperties => ({ transitionDelay: `${ms}ms` });
const cssVar = (obj: Record<string, string | number>): CSSProperties => obj as CSSProperties;

/* ----------------------------------------------------------------- peças */

/**
 * Título com as palavras saindo de uma máscara, uma a uma. A palavra entre
 * asteriscos vira serifa itálica: é a que carrega a emoção da frase.
 */
function Titulo({
  texto, as: Tag = "h2", className, atraso = 0,
}: { texto: string; as?: "h1" | "h2" | "h3" | "p"; className?: string; atraso?: number }) {
  // Quebra em palavras; a pontuação que vem depois de um trecho em itálico
  // ("Niterói.") fica presa à palavra, e não vira uma "palavra" solta.
  const tokens: { w: string; acento: boolean; sufixo: string }[] = [];
  for (const parte of texto.split(/(\*[^*]+\*)/).filter(Boolean)) {
    const acento = parte.startsWith("*");
    const cru = acento ? parte.slice(1, -1) : parte;
    for (const w of cru.trim().split(/\s+/).filter(Boolean)) {
      if (/^[.,;:!?…]+$/.test(w) && tokens.length) tokens[tokens.length - 1].sufixo += w;
      else tokens.push({ w, acento, sufixo: "" });
    }
    if (!acento && /^[.,;:!?…]/.test(cru) && tokens.length) {
      const m = cru.match(/^[.,;:!?…]+/);
      if (m && tokens[tokens.length - 1].sufixo === "") tokens[tokens.length - 1].sufixo = m[0];
      const resto = tokens[tokens.length - 1];
      if (resto && tokens.length > 1 && resto.w === m?.[0]) tokens.pop();
    }
  }
  return (
    <Tag data-reveal="mask" className={cn("flex flex-wrap gap-x-[0.24em]", className)}>
      {tokens.map((t, i) => (
        <span key={i} className="mask">
          <span className="w" style={cssVar({ "--d": `${atraso + i * 55}ms` })}>
            <span className={cn(t.acento && "acento")}>{t.w}</span>
            {t.sufixo}
          </span>
        </span>
      ))}
    </Tag>
  );
}

function Ponto({ on }: { on: boolean }) {
  return on ? (
    <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-success animate-online-pulse" />
  ) : (
    <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-muted-foreground" />
  );
}

/**
 * O botão coral com o rosto de quem atende, o ponto de status e a frase.
 * Aparece quatro vezes na página e é sempre o mesmo: quem clica já viu quem
 * vai responder.
 */
function BotaoFalar({
  on, label, onClick, className,
}: { on: boolean; label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-14 w-full items-center justify-center gap-2.5 rounded-pill border border-primary bg-primary px-6 text-base tracking-corpo text-white transition-[background-color,transform] duration-200 ease-page hover:bg-primary-hover active:scale-[0.985]",
        className,
      )}
    >
      <img
        src={FOTO}
        alt=""
        aria-hidden
        className="-ml-2 block h-[30px] w-[30px] shrink-0 rounded-full object-cover [object-position:50%_30%]"
      />
      <Ponto on={on} />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

/** O traço coral que sublinha cada título de seção. */
function Traco({ className }: { className?: string }) {
  return (
    <div
      data-reveal="line"
      style={delay(300)}
      aria-hidden
      className={cn("h-[3px] w-14 origin-left rounded-[2px] bg-primary", className)}
    />
  );
}

/** Rótulo em caixa alta, tracejado — o trabalho que outros sites dão à cor. */
function Rotulo({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-xs leading-normal tracking-[0.08em] uppercase", className)}>{children}</span>;
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF385C" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Logos({ tamanho = 40, sombra = false }: { tamanho?: number; sombra?: boolean }) {
  const cls = cn("block object-cover", sombra && "shadow-[0_6px_18px_rgba(0,0,0,0.25)]");
  const st = { width: tamanho, height: tamanho, borderRadius: Math.round(tamanho * 0.27) };
  return (
    <div className="flex items-center gap-2">
      <img src="/lp/airbnb.svg" alt="Airbnb" className={cls} style={st} />
      <img src="/lp/booking.webp" alt="Booking.com" className={cls} style={st} />
      <img src="/lp/vrbo.webp" alt="Vrbo" className={cls} style={st} />
    </div>
  );
}

/** A faixa que corre: o que o produto entrega, em uma linha, sem parar. */
function Faixa({ itens, escuro = false }: { itens: string[]; escuro?: boolean }) {
  const lista = [...itens, ...itens];
  return (
    <div
      aria-hidden
      className={cn("faixa overflow-hidden border-y", escuro ? "border-white/[0.12]" : "border-[#ececec]")}
    >
      <div className="faixa-trilho flex w-max items-center py-3.5">
        {lista.map((t, i) => (
          <span key={i} className={cn("flex items-center gap-6 pr-6 text-xs uppercase tracking-[0.12em] whitespace-nowrap", escuro ? "text-white/70" : "text-[#666666]")}>
            {t}
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- conteúdo */

const FAIXA = ["Reserva confirmada", "Documento com foto", "Selfie", "Assinatura digital", "Contrato antes da chave", "Portaria avisada", "Checkout da diarista", "IA 24 horas"];

const DORES: ReactNode[] = [
  <>
    A portaria liga: “tem um hóspede aqui dizendo que tem reserva pra hoje, mas não tem acesso.”{" "}
    <span className="text-primary">Você esqueceu de cadastrar.</span>
  </>,
  <>
    A diarista diz que o sofá está manchado.{" "}
    <span className="text-primary">Sem contrato, sem compromisso</span> — e você não tem
    nome, documento nem assinatura pra cobrar de ninguém.
  </>,
  <>
    <span className="text-primary">Você não sabe se o AirCover vai te ressarcir.</span>{" "}
    Dependendo da quebra, ficam dias com a reserva fechada pra reparo.
  </>,
];

const TRAVAS = [
  {
    rotulo: "Reserva",
    titulo: "Ladrão não deixa documento e selfie pra te *roubar*.",
    foto: "/lp/trava-ladrao.webp",
    alt: "Ladrão saindo do apartamento com a TV embaixo do braço",
    texto: "Quem entra na sua casa deixa rosto, documento e assinatura antes da chave.",
    posicao: "50% 30%",
  },
  {
    rotulo: "Contrato",
    titulo: "Ele cuida da sua casa como se fosse *dele*.",
    foto: "/lp/trava-sofa-vinho.webp",
    alt: "Cena ilustrativa de uma grande mancha de vinho tinto no sofá branco, com a taça caída e a anfitriã tentando limpar com um pano",
    texto: "Com contrato na mão, os prejuízos tendem a não ter recorrência.",
    posicao: "46% 50%",
  },
  {
    rotulo: "Regras da estadia",
    titulo: "Seu apê não é *casa de festas*.",
    foto: "/lp/trava-festa.webp",
    alt: "Cena ilustrativa de uma festa no apartamento, com hóspedes em pé no sofá, bebidas derramadas e a cortina sendo puxada",
    texto: "Festa, gente a mais, barulho no condomínio e dano no imóvel. Deixe os limites claros no contrato, com o aceite do hóspede antes da chave.",
    posicao: "50% 0%",
  },
  {
    rotulo: "Assistência jurídica",
    titulo: "O problema ficou. Você não fica *sozinho*.",
    foto: "/lp/assistencia-juridica-solucao.webp",
    alt: "Cena ilustrativa de um advogado orientando a anfitriã, com contrato e fotos dos danos organizados sobre a mesa",
    texto: "Contrato, documento, selfie e assinatura antes da chave. Se o hóspede ou a plataforma não assumirem o dano, a Assistência Jurídica HospedePay ajuda você a buscar reparação.*",
    posicao: "54% 42%",
    juridico: true,
  },
];

/** Os cinco passos que o hóspede vê no celular, na ordem em que acontecem. */
const PASSOS: { nome: string; icone: ReactNode }[] = [
  {
    nome: "Cadastro",
    icone: <><path d="M12 13a4 4 0 100-8 4 4 0 000 8z" /><path d="M4.5 20a7.5 7.5 0 0115 0" /></>,
  },
  {
    nome: "Upload de documento",
    icone: <><path d="M8 4h5l5 5v11H8z" /><path d="M13 4v5h5" /><path d="M12 17v-5" /><path d="M9.8 14.2L12 12l2.2 2.2" /></>,
  },
  {
    nome: "Rubrica digital",
    icone: <path d="M4 18.5c2-2.5 3.5-6.5 6-9.5s5 1 3.5 4-3 3.5-1.5 4 5-2 7.5-5.5" />,
  },
  {
    nome: "Identificação facial",
    icone: (
      <>
        <path d="M4 8.5V6a2 2 0 012-2h2.5M20 8.5V6a2 2 0 00-2-2h-2.5M4 15.5V18a2 2 0 002 2h2.5M20 15.5V18a2 2 0 01-2 2h-2.5" />
        <path d="M9.5 10.5v.5M14.5 10.5v.5" />
        <path d="M9.5 14.5c.8.8 1.6 1.2 2.5 1.2s1.7-.4 2.5-1.2" />
      </>
    ),
  },
  {
    nome: "Contrato",
    icone: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /><path d="M10 12h6M10 15.5h6M10 19h3" /></>,
  },
];

const E_AINDA = [
  {
    rotulo: "Checkout automático",
    titulo: "A limpeza tem o calendário dos seus apartamentos.",
    texto: "Ela sabe quem entra às 15h e quem sai às 11h, sem você avisar. Fecha o checkout com foto carimbada na hora.",
    foto: "/lp/ainda-limpeza.webp",
    alt: "Diarista conferindo o calendário no celular",
  },
  {
    rotulo: "Reposição automática",
    titulo: "Você não se preocupa em repor o papel higiênico.",
    texto: "Taxa combinada por mês, gravada e aceita pela diarista no celular. Ela repõe, você aprova.",
    foto: "/lp/ainda-reposicao.webp",
    alt: "Reposição de papel higiênico e sabonetes no armário",
  },
  {
    rotulo: "IA 24 horas",
    titulo: "A IA atende o seu hóspede a qualquer hora.",
    texto: "Você alimenta com as informações do seu apartamento — senha do wi-fi, vaga, chuveiro — e ela responde na hora. Em português, inglês e espanhol.",
    foto: "/lp/ainda-ia.webp",
    alt: "Hóspede lendo a resposta da IA à noite",
  },
  {
    rotulo: "Três canais, um calendário",
    titulo: "Airbnb, Booking e VRBO no mesmo calendário.",
    texto: "Sincronizado a cada 30 minutos. Data ocupada em um canal fecha nos outros três, sem você tocar.",
    foto: "/lp/ainda-calendario.webp",
    alt: "Calendário com reservas do Airbnb, Booking e VRBO",
    canais: true,
  },
];

const COMPARACAO: { grupo: string; linhas: [string, boolean, boolean][] }[] = [
  {
    grupo: "Os dois fazem",
    linhas: [
      ["Responde o hóspede", true, true],
      ["Coordena a limpeza", true, true],
      ["Cadastra acesso do hóspede no condomínio", true, true],
    ],
  },
  {
    grupo: "Onde muda",
    linhas: [
      ["Check-in com documento e assinatura", false, true],
      ["Contrato em PDF com IP e hora", false, true],
      ["Repõe os insumos por taxa combinada", false, true],
      ["Conexão por API com portarias digitais", false, true],
    ],
  },
];

const PERGUNTAS = [
  ["Meu prédio não tem portaria digital.", "A portaria recebe e-mail com nome, documento e horário a cada reserva. Com portaria digital, o acesso abre e fecha sozinho."],
  ["Tenho 2 apartamentos. Pago o dobro?", "Profissional: R$197 pros dois. R$98,50 cada. Uma gestora cobra de 15% a 25% do que cada apartamento fatura."],
  ["É reconhecimento facial?", "Não. Documento, selfie e assinatura na mesma folha, com IP e hora. É prova — e é o que vale numa discussão."],
  ["E o hóspede, quem responde?", "A IA do seu apartamento, no link que ele recebe no fim do cadastro. O que ela não sabe, chega pra você."],
  ["Quem faz a implementação?", "Na compra direta, você configura a ferramenta. Na contratação pelo WhatsApp, a implementação faz parte da condição combinada."],
  ["E se eu não gostar da ferramenta?", "A garantia de 30 dias é da ferramenta. As condições da assistência jurídica são próprias e devem ser consultadas antes da contratação."],
  ["A assistência jurídica já está incluída na ferramenta?", "Não. A assistência jurídica é um adicional opcional, com contratação separada. Confira a disponibilidade e as condições na seção de assistência jurídica."],
  ["Como é a contratação da assistência jurídica?", "A contratação é anual. Quando informado, o equivalente mensal serve para comparar o valor; ele não transforma o contrato em uma assinatura mensal. Consulte o escopo e as condições de pagamento antes de contratar."],
  ["Se eu cancelar a ferramenta, perco a assistência jurídica?", "Quando contratada, a assistência jurídica permanece pelo período do seu contrato, mesmo se você cancelar a ferramenta. São contratações independentes."],
];

/* -------------------------------------------------------------- página */

type Plano = (typeof PLANOS_RESERVA)[number];

const IMOVEIS_LABEL = (n: number | null) =>
  n === null ? "sem limite de imóveis" : n === 1 ? "1 imóvel" : n === 3 ? "2 ou 3 imóveis" : n === 5 ? "4 ou 5 imóveis" : `até ${n} imóveis`;

/** Vídeo do cadastro no celular: começa no segundo certo e volta para lá no fim. */
function VideoProva({ reduz }: { reduz: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (reduz) ref.current?.pause();
  }, [reduz]);
  const inicio = useCallback(() => {
    const v = ref.current;
    if (v && v.currentTime < VIDEO_PROVA_INICIO - 0.05) v.currentTime = VIDEO_PROVA_INICIO;
  }, []);
  const reiniciar = useCallback(() => {
    const v = ref.current;
    if (!v || reduz) return;
    v.currentTime = VIDEO_PROVA_INICIO;
    v.play().catch(() => undefined);
  }, [reduz]);
  return (
    <video
      ref={ref}
      src={VIDEO_PROVA}
      autoPlay={!reduz}
      muted
      playsInline
      controls
      aria-label="Demonstração do cadastro do hóspede"
      preload="metadata"
      onLoadedMetadata={inicio}
      onEnded={reiniciar}
      className="block h-full w-full bg-black object-contain"
    />
  );
}

/** O celular, com o vídeo dentro. Compacto no celular (ao lado dos passos), cheio no desktop. */
function Celular({ reduz }: { reduz: boolean }) {
  return (
    <div
      className="relative h-[320px] w-[148px] rounded-[34px] bg-[#0b0b0d] p-2 lg:h-[620px] lg:w-[286px] lg:rounded-[48px] lg:p-2.5"
      style={{ boxShadow: "0 30px 90px rgba(0,0,0,0.28), inset 0 0 0 1.5px rgba(255,255,255,0.10)" }}
    >
      <div aria-hidden className="absolute -left-0.5 top-[19%] h-[8%] w-[3px] rounded-[2px] bg-[#1a1a1d]" />
      <div aria-hidden className="absolute -left-0.5 top-[29%] h-[8%] w-[3px] rounded-[2px] bg-[#1a1a1d]" />
      <div aria-hidden className="absolute -right-0.5 top-[23%] h-[13%] w-[3px] rounded-[2px] bg-[#1a1a1d]" />
      <div className="relative h-full w-full overflow-hidden rounded-[27px] bg-black lg:rounded-[39px]">
        <VideoProva reduz={reduz} />
        <div aria-hidden className="absolute left-1/2 top-[6px] h-[14px] w-[34%] -translate-x-1/2 rounded-[20px] bg-black lg:top-[9px] lg:h-[22px]" />
        <div aria-hidden className="absolute bottom-[5px] left-1/2 h-[3px] w-[36%] -translate-x-1/2 rounded-[2px] bg-white/85 lg:bottom-[7px] lg:h-1" />
      </div>
    </div>
  );
}

export default function Landing() {
  const raiz = useRef<HTMLDivElement>(null);
  const reduz = useReducedMotion();
  useReveal(raiz, reduz);
  useCenas(raiz, reduz);
  const heroVideoRef = useRef<HTMLVideoElement>(null);
  const [videoPausado, setVideoPausado] = useState(reduz);
  useEffect(() => {
    if (reduz) setVideoPausado(true);
  }, [reduz]);
  useEffect(() => {
    const video = heroVideoRef.current;
    if (!video) return;
    if (videoPausado) video.pause();
    else video.play().catch(() => undefined);
  }, [videoPausado]);

  // O app é escuro; a página é clara. Sem isto o corpo do documento fica
  // preto e aparece atrás dos cantos do herói e no "puxa" da rolagem.
  useEffect(() => {
    document.documentElement.classList.add("tema-claro");
    document.body.classList.add("tema-claro");
    return () => {
      document.documentElement.classList.remove("tema-claro");
      document.body.classList.remove("tema-claro");
    };
  }, []);

  // A rota chega por lazy import: o destino da âncora pode não existir
  // quando o navegador tenta posicionar a página pela primeira vez.
  useEffect(() => {
    if (!window.location.hash) return;
    let id: string;
    try { id = decodeURIComponent(window.location.hash.slice(1)); }
    catch { return; }
    const frame = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Preços da tabela `plans` (leitura pública). Se a rede falhar, a reserva
  // acima segura a página; se a tabela mudar, a página acompanha sem deploy.
  const [PLANOS, setPlanos] = useState<Plano[]>(PLANOS_RESERVA);
  useEffect(() => {
    supabase
      .from("plans")
      .select("tier, name, monthly_cents, annual_cents, max_properties")
      .eq("active", true)
      .order("sort_order")
      .then(({ data }) => {
        if (!data || data.length === 0) return;
        setPlanos(
          data.map((p) => ({
            tier: p.tier as string,
            nome: p.name as string,
            imoveis: IMOVEIS_LABEL(p.max_properties as number | null),
            mensal: Math.round((p.monthly_cents as number) / 100),
            anual: Math.round((p.annual_cents as number) / 100),
          })),
        );
      });
  }, []);

  // WhatsApp do formulário: o do build vale primeiro; sem ele, o do banco.
  const [WHATSAPP, setWhatsapp] = useState(WHATSAPP_BUILD);
  useEffect(() => {
    if (WHATSAPP_BUILD) return;
    supabase.rpc("landing_config").then(({ data }) => {
      const n = String((data as { landing_whatsapp?: string } | null)?.landing_whatsapp ?? "").replace(/\D/g, "");
      if (n) setWhatsapp(n);
    });
  }, []);

  // Estado "online": fixo pelo ambiente, ou lido de uma URL a cada 60s.
  const [onlineAuto, setOnlineAuto] = useState(false);
  useEffect(() => {
    if (ESTADO !== "auto" || !STATUS_URL) return;
    let vivo = true;
    const ler = async () => {
      try {
        const r = await fetch(STATUS_URL, { cache: "no-store" });
        const j = (await r.json()) as { online?: boolean };
        if (vivo) setOnlineAuto(!!j.online);
      } catch {
        if (vivo) setOnlineAuto(false);
      }
    };
    ler();
    const id = setInterval(ler, 60_000);
    return () => { vivo = false; clearInterval(id); };
  }, []);
  const on = ESTADO === "online" ? true : ESTADO === "offline" ? false : onlineAuto;

  const textos = useMemo(
    () => ({
      btn: on ? "Estou online — falar agora" : "Me chama — te ligo em até 1 hora",
      linha: on ? "Quem responde sou eu, o Renato. Não é robô." : "Quem liga sou eu, o Renato. Não é robô.",
      submit: on ? "Me liga agora" : "Pode me ligar",
      feito: on
        ? "Fechado. Te ligo no WhatsApp em até 2 minutos. Deixa o celular perto."
        : "Recebi. Te ligo no WhatsApp em até 1 hora. Se for madrugada, ligo a partir das 9h.",
    }),
    [on],
  );

  // Assinar abre a Stripe na hora. Nome, e-mail e telefone são pedidos lá,
  // uma vez só; a conta nasce depois do pagamento. Nenhuma tela nossa antes
  // do cartão — cada uma era um lugar para desistir.
  const [abrindo, setAbrindo] = useState<string | null>(null);
  const [erroPlano, setErroPlano] = useState<string | null>(null);
  const [params] = useSearchParams();
  const checkoutCancelado = params.get("checkout") === "cancelado";
  const assinar = async (tier: string, cycle: "annual" | "monthly") => {
    setErroPlano(null);
    setAbrindo(`${tier}:${cycle}`);
    try {
      const { url } = await api.billingPublico.checkout({ tier, cycle });
      window.location.href = url;
    } catch (e) {
      setErroPlano(e instanceof ApiError ? e.message : "Não consegui abrir o pagamento agora. Tente de novo.");
      setAbrindo(null);
    }
  };

  // Formulário "me liga".
  const [formAberto, setFormAberto] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [imoveis, setImoveis] = useState("");
  const [portaria, setPortaria] = useState("");
  const [tentou, setTentou] = useState(false);
  const abrir = useCallback(() => { setFormAberto(true); setEnviado(false); setTentou(false); }, []);
  const fechar = useCallback(() => setFormAberto(false), []);

  useEffect(() => {
    if (!formAberto) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => document.querySelector<HTMLInputElement>('input[name="nome"]')?.focus(), 60);
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; clearTimeout(t); };
  }, [formAberto, fechar]);

  const enviar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!imoveis || !portaria) { setTentou(true); return; }
    const fd = new FormData(e.currentTarget);
    const nome = String(fd.get("nome") ?? "").trim();
    const whatsapp = String(fd.get("whatsapp") ?? "").trim();
    const payload = { nome, whatsapp, imoveis, portaria, estado: on ? "online" : "offline", pagina: location.href };
    setEnviando(true);
    try {
      if (LEAD_ENDPOINT) {
        await fetch(LEAD_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (WHATSAPP) {
        const msg = `Oi, Renato. Sou ${nome}. Anuncio ${imoveis} imóvel(is), prédio ${portaria === "sim" ? "com" : "sem"} portaria. Quero o Check-in Blindado.`;
        window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
      }
    } catch { /* o "recebi" abaixo vale de qualquer jeito: a ligação é minha */ }
    try { (window as unknown as { fbq?: (a: string, b: string) => void }).fbq?.("track", "Lead"); } catch { /* sem pixel */ }
    setEnviando(false);
    setEnviado(true);
    setImoveis(""); setPortaria(""); setTentou(false);
  };

  // O herói encolhe ao sair; o botão fixo aparece quando nem o herói nem os
  // planos (que já têm os seus botões) estão na tela.
  const heroRef = useRef<HTMLElement>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const planosRef = useRef<HTMLElement>(null);
  useEncolherHero(heroRef, tituloRef, reduz);
  const [sobreHero, setSobreHero] = useState(true);
  const [sobrePlanos, setSobrePlanos] = useState(false);
  useEffect(() => {
    const h = heroRef.current;
    const p = planosRef.current;
    if (!h || !p) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === h) setSobreHero(e.isIntersecting);
          if (e.target === p) setSobrePlanos(e.isIntersecting);
        }
      },
      { threshold: 0.05 },
    );
    io.observe(h);
    io.observe(p);
    return () => io.disconnect();
  }, []);
  const fab = !sobreHero && !sobrePlanos;

  const pilula = (label: string, val: string, sel: string, set: (v: string) => void) => {
    const ativo = sel === val;
    const falta = tentou && !sel;
    return (
      <button
        key={val}
        type="button"
        onClick={() => set(val)}
        aria-pressed={ativo}
        className={cn(
          "flex h-11 items-center justify-center rounded-pill border px-4 text-[15px] tracking-corpo transition-colors",
          ativo ? "border-black bg-black text-white" : falta ? "border-primary bg-white text-black" : "border-line-strong bg-white text-black",
        )}
      >
        {label}
      </button>
    );
  };

  const h2 = "text-[clamp(34px,5.2vw,58px)] font-normal leading-[1.02] tracking-titulo text-black";

  return (
    <div ref={raiz} className="tema-claro relative min-h-screen [overflow-x:clip] bg-white text-black">
      <style>{LP_CSS}</style>

      {/* ------------------------------------------------------------ nav */}
      <nav className="fixed left-1/2 top-3 z-[60] flex w-[calc(100%-24px)] max-w-[720px] -translate-x-1/2 items-center justify-between gap-3 rounded-[52px] bg-white py-2 pl-4 pr-2 shadow-pill">
        <Marca size={32} />
        <Link
          to="/entrar"
          className="flex h-10 items-center whitespace-nowrap rounded-pill border border-[#ececec] bg-[#f7f7f7] px-[18px] text-sm leading-none tracking-corpo text-black underline decoration-1 underline-offset-[3px] transition-colors hover:bg-[#ececec]"
        >
          Minha conta
        </Link>
      </nav>

      {/* ----------------------------------------------------------- herói */}
      <section ref={heroRef} className="relative origin-top overflow-hidden rounded-b-[28px] bg-black text-white">
        <div aria-hidden className="lp-glow absolute -left-[8%] -top-[8%] h-[116%] w-[116%]" />
        <div className="absolute inset-0 z-0">
          <div className="absolute -inset-[6%] overflow-hidden">
            <video
              ref={heroVideoRef}
              src="/lp/hero.mp4"
              poster="/lp/hero-poster.webp"
              autoPlay={!videoPausado}
              muted
              loop
              playsInline
              aria-hidden
              className="absolute left-0 block w-full object-cover"
              style={{ top: "-22.73%", height: "145.45%" }}
            />
          </div>
          <div
            aria-hidden
            className="absolute inset-0"
            style={{ background: "linear-gradient(180deg, #000 0%, rgba(0,0,0,0.75) 8%, rgba(0,0,0,0.28) 20%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.30) 46%, rgba(0,0,0,0.62) 70%, rgba(0,0,0,0.86) 88%, #000 100%)" }}
          />
        </div>

        <button
          type="button"
          onClick={() => setVideoPausado((paused) => !paused)}
          className="absolute bottom-3 right-5 z-[2] inline-flex min-h-10 items-center rounded-full border border-white/30 bg-black/70 px-4 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        >
          {videoPausado ? "Reproduzir cena" : "Pausar cena"}
        </button>

        <div className="relative z-[1] mx-auto flex min-h-[calc(100svh-72px)] max-w-[720px] flex-col justify-between gap-[38px] px-5 pb-16 pt-24 md:min-h-[100svh] md:pb-[76px]">
          <div data-reveal="up" className="flex flex-wrap items-center justify-center gap-2.5">
            <span className="text-[13px] leading-normal tracking-[0.06em] text-white">Check‑in blindado com:</span>
            <Logos tamanho={40} />
          </div>

          <div className="flex flex-col gap-7">
            <div ref={tituloRef}>
              <Titulo
                as="h1"
                texto="Você deixaria um *estranho* entrar na sua casa?"
                atraso={120}
                className="text-[clamp(38px,10.5vw,64px)] font-normal leading-[0.96] tracking-display text-white"
              />
            </div>
            <p data-reveal="up" style={delay(700)} className="max-w-[34ch] text-[17px] leading-[1.33] tracking-[-0.01em] text-white/[0.68] [text-wrap:pretty]">
              O Airbnb te dá o primeiro nome e você reza pra não precisar do AirCover.
            </p>

            <div
              data-reveal="up"
              style={delay(820)}
              className="flex flex-col gap-3 rounded-3xl border border-white/[0.18] bg-white/[0.08] px-[18px] py-5 backdrop-blur-lg backdrop-saturate-150"
            >
              <p className="text-base leading-[1.43] tracking-corpo text-white [text-wrap:pretty]">
                Reserva confirmada, documento com foto, selfie e assinatura digital. Contrato vem
                antes da chave.
              </p>
              <BotaoFalar on={on} label={textos.btn} onClick={abrir} className="mt-0.5" />
              <p className="text-center text-sm leading-normal tracking-titulo text-white/70">{textos.linha}</p>
            </div>
          </div>
        </div>
      </section>

      <Faixa itens={FAIXA} />

      {/* -------------------------------------------------------- a cena */}
      <section className="mx-auto max-w-[1120px] px-5 pt-24 md:pt-32">
        <div className="md:grid md:grid-cols-12 md:gap-8">
          <div className="md:col-span-5">
            <Titulo texto="Você sabe *como é*." className={h2} />
            <Traco className="mt-6" />
          </div>
          <div className="relative mt-10 flex flex-col gap-9 pl-8 md:col-span-6 md:col-start-7 md:mt-2 md:pl-10">
            <div className="absolute bottom-2 left-0 top-2 w-[2px] overflow-hidden rounded-[2px] bg-[#e6e6e6]">
              <div data-fill className="lp-fill-y absolute inset-0 origin-top bg-primary" />
            </div>
            {DORES.map((d, i) => (
              <p key={i} data-reveal="left" style={delay(i * 110)} className="text-[clamp(19px,2.2vw,24px)] leading-[1.3] tracking-[-0.015em] text-black [text-wrap:pretty]">
                <Rotulo className="mb-2 block text-[#8f8f8f]">Dor 0{i + 1}</Rotulo>
                {d}
              </p>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------- quatro benefícios */}
      <section id="como-funciona" className="scroll-mt-20 pt-24 md:pt-36">
        <div className="mx-auto max-w-[1120px] px-5 pb-12 md:pb-16">
          <Rotulo className="mb-5 block text-primary">Check‑in Blindado</Rotulo>
          <Titulo texto="Você sabe quem *dorme* na sua casa." className={cn(h2, "max-w-[16ch]")} />
        </div>

        {/* Quatro telas cheias que se empilham: a de cima encolhe e escurece
            enquanto a próxima desliza por cima. */}
        <div data-cena="pin" className="cena-pilha" style={cssVar({ "--n": TRAVAS.length })}>
          {TRAVAS.map((t, i) => (
            <article key={t.rotulo} id={t.juridico ? "beneficio-juridico" : undefined} className="cena-painel bg-black text-white" style={cssVar({ "--i": i })}>
              <img
                src={t.foto}
                alt={t.alt}
                loading={i === 0 ? "eager" : "lazy"}
                className="cena-foto absolute inset-0 h-full w-full object-cover"
                style={{ objectPosition: t.posicao }}
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.05) 28%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.88) 100%)" }}
              />
              <div className="cena-sombra absolute inset-0 bg-black" aria-hidden />

              <div className="relative z-[1] mx-auto flex h-full max-w-[1120px] flex-col justify-between px-5 pb-28 pt-8 md:pb-14 md:pt-10">
                <div className="flex items-center justify-between gap-4">
                  <span className="vidro inline-flex h-8 items-center gap-2 rounded-pill px-3.5 text-[11px] uppercase tracking-[0.1em] text-white">
                    <span className="tabular-nums">0{i + 1}</span>
                    <span className="h-1 w-1 rounded-full bg-primary" />
                    {t.rotulo}
                  </span>
                  <div className="flex w-[120px] gap-1.5 md:w-[180px]">
                    {TRAVAS.map((_, k) => (
                      <span key={k} className="h-[2px] flex-1 overflow-hidden rounded bg-white/25">
                        <span className="cena-seg block h-full origin-left bg-white" style={cssVar({ "--i": k })} />
                      </span>
                    ))}
                  </div>
                </div>
                <div className="max-w-[720px]">
                  <Titulo
                    as="h3"
                    texto={t.titulo}
                    className="text-[clamp(32px,6vw,64px)] font-normal leading-[0.98] tracking-display text-white"
                  />
                  <p data-reveal="up" style={delay(350)} className="mt-5 max-w-[42ch] text-[17px] leading-[1.4] tracking-corpo text-white/80 md:text-lg">
                    {t.texto}
                  </p>
                  {t.juridico && (
                    <div data-reveal="up" style={delay(450)} className="mt-6 flex max-w-[46ch] flex-col items-start gap-3">
                      <a href="#assistencia-juridica" className="inline-flex min-h-12 items-center gap-5 rounded-pill bg-white px-5 py-3 text-sm leading-snug tracking-corpo text-black transition-colors hover:bg-[#ededed] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
                        Conhecer a assistência jurídica <span aria-hidden>↗</span>
                      </a>
                      <p className="text-xs leading-[1.5] text-white/80">
                        * Contratação opcional e separada. Consulte a disponibilidade nos planos.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ------------------------------------------ o que o hóspede vê */}
      {/* No celular os passos ficam ao lado de um celular menor; no desktop o celular fica fixo à direita. */}
      <section className="mx-auto max-w-[1120px] px-5 pt-24 md:pt-36">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 lg:grid-cols-12 lg:items-start lg:gap-x-10">
          <div className="col-span-2 lg:col-span-6">
            <Titulo texto="É isso que o seu hóspede *vê*." className={h2} />
            <p data-reveal="up" style={delay(200)} className="mt-5 max-w-[40ch] text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty]">
              Ele faz sozinho, em menos de um minuto. Você recebe o contrato pronto.
            </p>
          </div>

          <ol data-cena="atravessar" className="passos mt-8 flex flex-col lg:col-span-6 lg:mt-10">
            <span aria-hidden className="passos-trilho" />
            {PASSOS.map((p, i) => (
              <li key={p.nome} className="passo flex items-center gap-3 py-3 lg:gap-4 lg:py-[18px]" style={cssVar({ "--i": i })}>
                <span className="passo-icone flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary lg:h-9 lg:w-9 lg:rounded-[11px]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[14px] w-[14px] lg:h-4 lg:w-4">
                    {p.icone}
                  </svg>
                </span>
                <span className="text-[15px] leading-[1.25] tracking-corpo text-black lg:text-[20px] lg:leading-[1.3]">{p.nome}</span>
                <span className="ml-auto hidden text-xs tracking-[0.08em] text-[#8f8f8f] tabular-nums lg:inline">0{i + 1}</span>
              </li>
            ))}
          </ol>

          <div data-reveal="scale" className="mt-8 flex justify-end self-center lg:col-span-6 lg:col-start-7 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-stretch">
            <div className="lg:sticky lg:top-24">
              <Celular reduz={reduz} />
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- prova */}
      <section id="prova" className="scroll-mt-20 pt-24 md:pt-36">
        <div className="mx-auto max-w-[1120px] px-5">
          <div className="md:grid md:grid-cols-12 md:items-end md:gap-8">
            <div className="md:col-span-7">
              <Titulo texto="Rodando no meu apartamento em *Niterói*." className={h2} />
              <Traco className="mt-6" />
            </div>
            <p data-reveal="fade" style={delay(300)} className="mt-6 text-sm tracking-[-0.02em] text-[#6b6b6b] md:col-span-4 md:col-start-9 md:mt-0 md:text-right">
              <a href={ANUNCIO_AIRBNB} target="_blank" rel="noopener" className="underline decoration-1 underline-offset-[3px] hover:text-black">
                Ver o anúncio no Airbnb
              </a>
            </p>
          </div>
        </div>
        <div className="mx-auto mt-10 max-w-[1120px] px-5">
          <figure data-cena="entrar" className="cena-cresce relative aspect-[4/5] overflow-hidden bg-[#1a1a1a] md:aspect-auto md:h-[82svh]">
            <div data-cena="atravessar" className="absolute inset-0 overflow-hidden">
              <img
                src="/lp/prova-varanda.webp"
                alt="Varanda do apartamento em Niterói com vista para a baía e o Cristo Redentor"
                loading="lazy"
                className="cena-parallax block h-full w-full object-cover [object-position:50%_0%]"
              />
            </div>
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.72) 72%, rgba(0,0,0,0.9) 100%)" }}
            />
            <span className="vidro absolute left-5 top-5 inline-flex h-7 items-center rounded-pill px-3 text-[11px] uppercase tracking-[0.1em] text-white">
              Últimos 30 dias
            </span>
            <figcaption className="absolute inset-x-0 bottom-0 mx-auto max-w-[1120px] p-6 md:p-10">
              <div className="grid grid-cols-2 md:grid-cols-4">
                {[
                  [PROVA.reservas, "reservas", "border-b border-r pb-4 pr-3.5 md:border-b-0 md:pb-0"],
                  [PROVA.hospedes, "hóspedes", "border-b pb-4 pl-4 md:border-b-0 md:border-r md:pb-0 md:pr-3.5"],
                  [PROVA.termos, "contratos assinados", "border-r pr-3.5 pt-4 md:pl-4 md:pt-0"],
                  [PROVA.cadastros, "cadastros na portaria", "pl-4 pt-4 md:pt-0"],
                ].map(([n, r, cls], i) => (
                  <div key={r} data-reveal="up" style={delay(i * 80)} className={cn("flex min-w-0 flex-col gap-1.5 border-white/[0.28]", cls as string)}>
                    <span aria-hidden className="mb-0.5 block h-0.5 w-[22px] rounded-[1px] bg-primary" />
                    <div data-count={n} className="numero-grande text-[clamp(38px,6vw,72px)] text-white">{n}</div>
                    <div className="text-sm leading-[1.35] tracking-[-0.02em] text-white/85">{r}</div>
                  </div>
                ))}
              </div>
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ------------------------------------------------------- emprego */}
      {/* Recorte editorial: o texto na coluna de leitura e a foto sangrando
          até a borda direita da tela, sem moldura. No celular o título vem
          antes da foto, que vai de borda a borda. */}
      <section className="pt-24 md:pt-40">
        <div className="md:grid md:grid-cols-2 md:items-center">
          <div className="mx-auto w-full max-w-[1120px] px-5 md:mx-0 md:max-w-none md:pl-[max(20px,calc((100vw-1120px)/2+20px))] md:pr-16">
            <Rotulo className="mb-5 block text-primary">A rotina</Rotulo>
            <Titulo texto="Você não comprou um apartamento. Você comprou um *emprego*." className={cn(h2, "max-w-[14ch]")} />
            <p data-reveal="up" style={delay(200)} className="mt-6 hidden max-w-[40ch] text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty] md:block md:text-xl">
              Com o HospedePay, além de reunir os registros da hospedagem, você ganha
              automatização completa — e esquece por dias que tem um Airbnb.
            </p>
          </div>
          <figure data-cena="atravessar" className="relative ml-5 mr-auto mt-8 aspect-[4/5] w-[78%] max-w-[420px] overflow-hidden rounded-3xl bg-[#1a1a1a] md:ml-0 md:mt-0 md:aspect-auto md:h-[78svh] md:w-auto md:max-w-none md:rounded-l-[36px] md:rounded-r-none">
            <img
              src="/lp/emprego.webp"
              alt="Anfitrião cansado à mesa da cozinha, de noite, com o celular na mão"
              loading="lazy"
              className="cena-parallax block h-full w-full object-cover"
            />
          </figure>
          <p data-reveal="up" style={delay(200)} className="mx-auto mt-6 w-full max-w-[1120px] px-5 text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty] md:hidden">
            Com o HospedePay, além de reunir os registros da hospedagem, você ganha
            automatização completa — e esquece por dias que tem um Airbnb.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- a orla */}
      {/* A cena entre o emprego e o resto: o anfitrião longe do celular.
          Mesmo padrão de revista das outras duas, com a foto do outro lado. */}
      <section className="mx-auto max-w-[1120px] px-5 pt-24 md:pt-40">
        <div className="md:grid md:grid-cols-12 md:items-center md:gap-8">
          <figure data-cena="atravessar" className="relative ml-auto aspect-[3/4] w-[78%] max-w-[420px] overflow-hidden rounded-3xl bg-[#1a1a1a] md:col-span-5 md:ml-0 md:w-full md:max-w-none md:aspect-[4/5]">
            <img
              src="/lp/orla.webp"
              alt="Anfitrião caminhando na orla de Niterói ao entardecer, com o celular no bolso e o Pão de Açúcar ao fundo"
              loading="lazy"
              className="cena-parallax block h-full w-full object-cover [object-position:50%_30%]"
            />
            <span className="vidro absolute left-3 top-3 inline-flex h-7 items-center rounded-pill px-3 text-[11px] uppercase tracking-[0.1em] text-white">
              Sexta, 18h40
            </span>
          </figure>
          <div className="mt-8 md:col-span-6 md:col-start-7 md:mt-0">
            <Rotulo className="mb-5 block text-primary">Enquanto isso</Rotulo>
            <Titulo texto="Hóspede chega amanhã. Você nem sabe. E não *precisa*." className={cn(h2, "max-w-[14ch]")} />
            <p data-reveal="up" style={delay(300)} className="mt-6 max-w-[40ch] text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty] md:text-xl">
              O contrato já chegou no seu e-mail. A portaria já foi avisada. A diarista já sabe.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- e ainda */}
      {/* O título fica parado no alto da tela fixa e o trilho corre por
          baixo dele: nada é cortado, e o título é lido o tempo todo. */}
      <section id="e-ainda" data-cena="pin" className="cena-drift scroll-mt-0 mt-24 md:mt-40">
        <div className="cena-fixo">
          <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-5 md:flex-row md:items-end md:justify-between md:gap-10">
            <div>
              <Rotulo className="mb-4 block text-primary">E ainda</Rotulo>
              <Titulo texto="Você entra pelo check‑in. Fica pelo *resto*." className={cn(h2, "max-w-[14ch]")} />
              <Traco className="mt-5" />
            </div>
            <p data-reveal="up" style={delay(200)} className="max-w-[32ch] text-base leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty] md:pb-1 md:text-lg">
              Quatro coisas que passam a acontecer sozinhas depois que o calendário liga.
            </p>
          </div>
          <div data-trilho className="trilho" tabIndex={0} role="region" aria-label="Outros recursos da ferramenta">
            {E_AINDA.map((a, i) => (
              <article key={a.rotulo} className="flex w-[min(74vw,360px)] shrink-0 flex-col gap-4">
                <div className={cn("relative overflow-hidden rounded-[22px]", a.canais ? "bg-[#fafafa]" : "bg-[#f0f0f0]")} style={{ aspectRatio: "4 / 3" }}>
                  <img src={a.foto} alt={a.alt} loading="lazy" className="block h-full w-full object-cover" />
                  {a.canais && (
                    <>
                      <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.42) 100%)" }} />
                      <div className="absolute inset-x-0 bottom-3 flex items-center justify-center">
                        <Logos tamanho={40} sombra />
                      </div>
                    </>
                  )}
                  <span className="vidro absolute left-3 top-3 inline-flex h-8 items-center rounded-pill px-3 text-[11px] uppercase tracking-[0.1em] text-white">
                    0{i + 1}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Rotulo className="text-primary">{a.rotulo}</Rotulo>
                  <h3 className="text-[clamp(19px,2.2vw,24px)] font-normal leading-[1.15] tracking-[-0.02em] text-black [text-wrap:balance]">{a.titulo}</h3>
                  <p className="text-[15px] leading-[1.45] tracking-[-0.012em] text-[#666666] [text-wrap:pretty]">{a.texto}</p>
                </div>
              </article>
            ))}
            <div className="w-5 shrink-0" aria-hidden />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ esquecer */}
      {/* Depois de duas cenas de foto cheia, uma página de revista: o
          título grande no branco e a foto pequena, quadrada, deslocada. */}
      <section className="mx-auto max-w-[1120px] px-5 pt-24 md:pt-40">
        <div className="md:grid md:grid-cols-12 md:gap-8">
          <div className="md:col-span-7">
            <Rotulo className="mb-5 block text-primary">A meta</Rotulo>
            <Titulo
              texto="Nossa meta é você *esquecer* que o HospedePay existe."
              className="max-w-[12ch] text-[clamp(38px,6.4vw,84px)] font-normal leading-[0.98] tracking-display text-black"
            />
            <p data-reveal="up" style={delay(300)} className="mt-7 max-w-[36ch] text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty] md:text-xl">
              Tudo rodando sozinho, com segurança. Você só lembra quando o dinheiro cai.
            </p>
          </div>
          <figure data-cena="atravessar" className="relative mr-auto mt-10 aspect-square w-[78%] max-w-[420px] overflow-hidden rounded-3xl bg-[#e9e9e9] md:col-span-4 md:col-start-9 md:mt-24 md:w-full md:max-w-none">
            <img
              src="/lp/esquecer.webp"
              alt="Mulher sorrindo, relaxada no sofá da própria casa, com o celular apagado sobre a mesa"
              loading="lazy"
              className="cena-parallax block h-full w-full object-cover [object-position:50%_20%]"
            />
          </figure>
        </div>
      </section>

      {/* ---------------------------------------------- gestora × hospedepay */}
      {/* A cena escura cresce até tomar a largura da tela: um intervalo
          entre a promessa e o preço. */}
      <section id="comparacao" className="scroll-mt-20 mx-auto max-w-[1120px] px-5 pt-24 md:pt-40">
        <div data-cena="entrar" className="cena-cresce bg-black text-white">
          <div className="mx-auto max-w-[1120px] px-6 py-14 md:px-10 md:py-24">
            <div className="md:grid md:grid-cols-12 md:gap-8">
              <div className="md:col-span-7">
                <Rotulo className="mb-5 block text-white/60">Gestora × HospedePay</Rotulo>
                <Titulo
                  texto="A gestora leva uma fatia do que você fatura. O HospedePay custa R$97 por mês. *Fixo.*"
                  className="max-w-[18ch] text-[clamp(32px,4.6vw,56px)] font-normal leading-[1.02] tracking-titulo text-white"
                />
                <Traco className="mt-6" />
              </div>
              <div className="mt-10 grid grid-cols-2 gap-3 md:col-span-5 md:mt-0 md:self-end">
                <div data-reveal="up" className="flex flex-col gap-2 rounded-[22px] border border-white/[0.12] bg-[#141416] px-5 py-6">
                  <Rotulo className="text-white/[0.6]">Gestora</Rotulo>
                  <span className="numero-grande whitespace-nowrap text-[clamp(24px,6.5vw,48px)] text-white">15–25%</span>
                  <span className="text-sm leading-[1.45] tracking-corpo text-white/[0.6]">do que o apartamento fatura, todo mês, por imóvel.</span>
                </div>
                <div data-reveal="up" style={delay(80)} className="flex flex-col gap-2 rounded-[22px] bg-primary px-5 py-6">
                  <Rotulo className="text-white">HospedePay</Rotulo>
                  <span className="numero-grande whitespace-nowrap text-[clamp(24px,6.5vw,48px)] text-white">R$97</span>
                  <span className="text-sm leading-[1.45] tracking-corpo text-white">por mês. Fature R$2.000 ou R$10.000, é R$97.</span>
                </div>
              </div>
            </div>

            <div className="mt-12 md:grid md:grid-cols-12 md:gap-8">
              <div data-reveal="up" className="overflow-hidden rounded-3xl bg-white text-black md:col-span-7">
                <div className="grid grid-cols-[1fr_64px_84px] items-end gap-2 border-b border-[#f0f0f0] px-5 pb-3.5 pt-[18px]">
                  <Rotulo className="text-[#666666]">O que faz</Rotulo>
                  <span className="text-center text-[13px] tracking-corpo text-black">Gestora</span>
                  <span className="text-center text-[13px] tracking-corpo text-primary">HospedePay</span>
                </div>
                {COMPARACAO.map((g) => (
                  <div key={g.grupo}>
                    <div className="border-b border-t border-[#f0f0f0] bg-[#fafafa] px-5 pb-1.5 pt-2.5">
                      <Rotulo className="text-[#666666]">{g.grupo}</Rotulo>
                    </div>
                    {g.linhas.map(([nome, gestora, nos], i) => (
                      <div
                        key={nome}
                        className={cn(
                          "grid grid-cols-[1fr_64px_84px] items-center gap-2 px-5 py-3.5",
                          i < g.linhas.length - 1 && "border-b border-[#f0f0f0]",
                        )}
                      >
                        <span className="text-[15px] leading-[1.4] tracking-corpo text-black">{nome}</span>
                        {[gestora, nos].map((sim, k) => (
                          <span key={k} className="flex justify-center">
                            <span
                              aria-label={sim ? "sim" : "não"}
                              className={cn(
                                "inline-flex h-6 w-6 items-center justify-center rounded-full text-sm leading-none",
                                sim ? "bg-primary text-white" : "bg-[#f0f0f0] text-[#666666]",
                              )}
                            >
                              {sim ? "✓" : "–"}
                            </span>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div data-reveal="up" style={delay(120)} className="mt-6 flex flex-col gap-[18px] rounded-[28px] border border-white/[0.12] bg-[#141416] px-6 py-7 md:col-span-5 md:mt-0 md:self-start">
                <p className="max-w-[52ch] text-base leading-[1.49] tracking-[-0.014em] text-white/[0.7] [text-wrap:pretty]">
                  Faça a conta no seu. Um apartamento que fatura R$4.000 por mês:
                </p>
                <div className="flex flex-col">
                  {[["Gestora", "R$9.600"], ["HospedePay", "R$970"]].map(([q, v]) => (
                    <div key={q} className="flex items-baseline justify-between gap-4 border-t border-white/[0.14] py-3">
                      <span className="text-[20px] tracking-[-0.014em] text-white">{q}</span>
                      <span className="whitespace-nowrap text-[20px] tracking-[-0.02em] text-white tabular-nums">
                        {v}<span className="text-sm text-white/[0.6]"> / ano</span>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-1 border-t border-white/[0.3] pt-[18px]">
                  <Rotulo className="text-white/[0.6]">A diferença</Rotulo>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <span className="numero-grande text-[clamp(48px,6vw,72px)] text-[#FF8095]">R$8.630</span>
                    <span className="text-base tracking-[-0.014em] text-white/[0.7]">por ano, no seu bolso</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- planos */}
      {/* Sem caixas: três colunas separadas por um fio, o preço grande e um
          botão por plano. No celular, três blocos separados por fio. */}
      <section id="planos" ref={planosRef} className="scroll-mt-6 mx-auto max-w-[1120px] px-5 pt-24 md:pt-40">
        <div className="md:grid md:grid-cols-12 md:items-end md:gap-8">
          <div className="md:col-span-7">
            <Rotulo className="mb-5 block text-primary">Planos</Rotulo>
            <Titulo texto="Escolha o plano para o seu *imóvel*." className={h2} />
            <Traco className="mt-6" />
          </div>
          <p data-reveal="up" style={delay(200)} className="mt-6 max-w-[40ch] text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty] md:col-span-4 md:col-start-9 md:mt-0">
            Na compra direta, você configura a ferramenta. Na contratação pelo WhatsApp,
            a implementação faz parte da condição combinada.
          </p>
        </div>
        {checkoutCancelado && (
          <p className="mt-6 rounded-2xl bg-[#f0f0f0] px-4 py-3 text-[15px] leading-snug tracking-corpo text-black">
            Você saiu antes de pagar. Sem problema: o plano está aqui quando quiser.
          </p>
        )}
        {erroPlano && (
          <p role="alert" className="mt-6 rounded-2xl border border-primary/35 bg-primary/10 px-4 py-3 text-[15px] leading-snug tracking-corpo text-black">
            {erroPlano}
          </p>
        )}
        <div className="mt-12 border-t border-[#e6e6e6] md:grid md:grid-cols-3">
          {PLANOS.map((p, i) => (
            <article
              key={p.tier}
              id={p.tier}
              data-reveal="up"
              style={{ ...delay(i * 80), scrollMarginTop: 24 }}
              className={cn(
                "flex flex-col gap-6 border-b border-[#e6e6e6] py-8 md:border-b-0 md:py-10",
                i > 0 && "md:border-l md:pl-8",
                i < PLANOS.length - 1 && "md:pr-8",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[clamp(20px,2.4vw,26px)] font-normal leading-[1.2] tracking-[-0.02em] text-black">{p.nome}</h3>
                <span className="inline-flex h-[30px] items-center whitespace-nowrap rounded-pill bg-black px-3.5 text-[13px] leading-none tracking-[-0.02em] text-white">
                  {p.imoveis}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="numero-grande text-[clamp(44px,4.6vw,60px)] text-black">{brl(p.anual)}</span>
                  <span className="text-[15px] tracking-[-0.014em] text-[#666666]">por ano</span>
                </div>
                <div className="text-base tracking-corpo text-black tabular-nums">
                  Confira as condições de pagamento no checkout.
                </div>
              </div>
              <ul className="flex flex-col gap-2.5">
                {["Configuração por sua conta na compra direta", "Suporte incluído", "Garantia de 30 dias da ferramenta"].map((l) => (
                  <li key={l} className="flex items-center gap-2.5 text-[15px] leading-[1.4] tracking-corpo text-black">
                    <Check />
                    <span>{l}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => assinar(p.tier, "annual")}
                  disabled={abrindo !== null}
                  className="flex h-14 items-center justify-center gap-2 rounded-pill bg-primary px-6 text-base tracking-[-0.01em] text-white transition-[background-color,transform] duration-200 hover:bg-primary-hover active:scale-[0.985] disabled:opacity-60"
                >
                  {abrindo === `${p.tier}:annual` && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Assinar o {p.nome} anual
                </button>
                <button
                  type="button"
                  onClick={() => assinar(p.tier, "monthly")}
                  disabled={abrindo !== null}
                  className="text-center text-sm leading-normal tracking-[-0.02em] text-[#666666] underline decoration-1 underline-offset-[3px] hover:text-black disabled:opacity-60"
                >
                  {abrindo === `${p.tier}:monthly` ? "Abrindo o pagamento…" : `Mensal: ${brl(p.mensal)}/mês`}
                </button>
                <a href="#assistencia-juridica" aria-describedby="legal-offer-note" className="mt-2 text-center text-sm leading-relaxed text-black underline decoration-primary underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
                  Conheça a Assistência Jurídica Hospedepay*
                </a>
              </div>
            </article>
          ))}
        </div>
        <p data-reveal="up" className="mt-8 text-center md:text-left">
          <button type="button" onClick={abrir} className="text-base leading-[1.49] tracking-[-0.014em] text-primary underline decoration-1 underline-offset-4 hover:text-primary-hover">
            Mais de 5 imóveis? Toca no botão que a conversa é outra.
          </button>
        </p>
        <LegalOfferSection
          onConsult={WHATSAPP ? () => {
            const message = "Olá. Quero conhecer a Assistência Jurídica HospedePay e as condições para o meu imóvel.";
            window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
          } : undefined}
        />
      </section>

      {/* ------------------------------------------------------ garantia */}
      <section id="garantia" className="scroll-mt-20 mx-auto max-w-[1120px] px-5 pt-20 md:pt-32">
        <div data-cena="entrar" className="cena-cresce relative overflow-hidden bg-[#f0f0f0] md:grid md:grid-cols-12">
          <div className="relative md:col-span-6" style={{ aspectRatio: "4 / 3" }}>
            <img
              src="/lp/garantia.webp"
              alt="Aperto de mãos com a entrega das chaves na porta do apartamento"
              loading="lazy"
              className="absolute inset-0 block h-full w-full object-cover"
            />
          </div>
          <div className="flex flex-col justify-center gap-7 bg-primary px-6 py-8 text-white md:col-span-6 md:px-12 md:py-16">
            <div className="flex flex-col gap-2">
              <Rotulo className="text-white">Garantia da ferramenta</Rotulo>
              <Titulo as="p" texto="30 dias para usar a ferramenta." className="text-[clamp(26px,3.2vw,40px)] font-normal leading-[1.1] tracking-titulo text-white" />
              <p data-reveal="up" style={delay(300)} className="text-lg leading-[1.33] tracking-[-0.01em] text-white/90">Não gostou da ferramenta, devolvo o valor dela.</p>
            </div>
            <div className="h-px bg-white/[0.3]" />
            <div className="flex flex-col gap-2">
              <Titulo as="p" texto="Da contratação ao calendário." className="text-[clamp(26px,3.2vw,40px)] font-normal leading-[1.1] tracking-titulo text-white" atraso={200} />
              <p data-reveal="up" style={delay(500)} className="text-lg leading-[1.33] tracking-[-0.01em] text-white/90">Configure na compra direta ou combine a implementação na contratação pelo WhatsApp.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- quem responde */}
      <section id="quem-responde" className="scroll-mt-20 mx-auto max-w-[1120px] px-5 pt-20 md:pt-32">
        <div className="md:grid md:grid-cols-12 md:items-end md:gap-8">
          <figure data-cena="atravessar" className="relative overflow-hidden rounded-[28px] bg-[#f0f0f0] md:col-span-6" style={{ aspectRatio: "4 / 5" }}>
            <img src={FOTO} alt="Renato, anfitrião em Niterói" loading="lazy" className="cena-parallax block h-full w-full object-cover [object-position:50%_30%]" />
            <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.65) 100%)" }} />
            <figcaption className="absolute inset-x-0 bottom-0 p-6 md:p-8">
              <span className="vidro inline-flex h-8 items-center gap-2 rounded-pill px-3.5 text-[11px] uppercase tracking-[0.1em] text-white">
                <Ponto on={on} />
                {on ? "Online agora" : "Te ligo em até 1 hora"}
              </span>
            </figcaption>
          </figure>
          <div className="mt-8 flex flex-col gap-5 md:col-span-6 md:mt-0 md:pb-4">
            <Titulo
              as="p"
              texto="Sou o Renato. Anfitrião em Niterói. Uso o HospedePay no meu *próprio* apartamento."
              className="text-[clamp(26px,3.6vw,44px)] font-normal leading-[1.08] tracking-titulo text-black"
            />
            <p data-reveal="up" style={delay(300)} className="max-w-[44ch] text-lg leading-[1.4] tracking-corpo text-[#666666]">
              Quem te atende sou eu. Na contratação pelo WhatsApp, combinamos a implementação
              para colocar seu imóvel na ferramenta.
            </p>
            <div data-reveal="up" style={delay(400)} className="flex flex-col gap-2.5">
              <BotaoFalar on={on} label={textos.btn} onClick={abrir} />
              <p className="text-center text-sm leading-normal tracking-titulo text-[#666666]">{textos.linha}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- perguntas */}
      <section id="perguntas" className="scroll-mt-20 mx-auto max-w-[1120px] px-5 pb-24 pt-24 md:pb-36 md:pt-40">
        <div className="lg:grid lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-5">
            <Titulo texto="Perguntas que *todo mundo* faz" className={h2} />
            <Traco className="mt-6" />
          </div>
          <div className="mt-8 flex flex-col border-t border-[#e6e6e6] lg:col-span-7 lg:mt-0">
            {PERGUNTAS.map(([q, a], i) => (
              <details key={q} data-reveal="up" style={delay(i * 50)} className="pergunta group border-b border-[#e6e6e6]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 [&::-webkit-details-marker]:hidden">
                  <span className="text-[clamp(19px,2.2vw,24px)] font-normal leading-[1.25] tracking-[-0.02em] text-black">{q}</span>
                  <span aria-hidden className="pergunta-mais relative h-8 w-8 shrink-0 rounded-full border border-[#d9d9d9]">
                    <span className="absolute left-1/2 top-1/2 h-[1.5px] w-3.5 -translate-x-1/2 -translate-y-1/2 bg-black" />
                    <span className="pergunta-v absolute left-1/2 top-1/2 h-3.5 w-[1.5px] -translate-x-1/2 -translate-y-1/2 bg-black" />
                  </span>
                </summary>
                <p className="max-w-[56ch] pb-7 text-base leading-[1.5] tracking-[-0.012em] text-[#666666]">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- fechamento */}
      <section className="relative overflow-hidden bg-black text-white">
        <div aria-hidden className="lp-glow absolute -left-[8%] -top-[8%] h-[116%] w-[116%] opacity-80" />
        <Faixa itens={FAIXA} escuro />
        <div className="relative z-[1] mx-auto flex max-w-[1120px] flex-col gap-10 px-5 pb-[150px] pt-[100px] md:pt-[140px]">
          <Titulo
            texto="Ninguém dorme no seu apartamento sem ter *assinado*."
            className="max-w-[14ch] text-[clamp(40px,7vw,96px)] font-normal leading-[0.96] tracking-display text-primary"
          />
          <div data-reveal="up" style={delay(300)} className="flex flex-col gap-2.5 md:max-w-[520px]">
            <BotaoFalar on={on} label={textos.btn} onClick={abrir} />
            <p className="text-center text-sm leading-normal tracking-titulo text-white/70">{textos.linha}</p>
          </div>
          <footer className="mt-10 flex flex-col gap-[22px] border-t border-white/[0.14] pt-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Marca size={22} tom="tinta" />
              <Link
                to="/entrar"
                className="inline-flex h-9 items-center whitespace-nowrap rounded-[20px] border border-white/[0.28] px-3.5 text-[13px] tracking-corpo text-white transition-colors hover:bg-white/10"
              >
                Entrar na plataforma
              </Link>
            </div>
            <nav aria-label="Links do rodapé" className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px] leading-normal tracking-corpo md:flex md:flex-wrap md:gap-x-8">
              <button type="button" onClick={abrir} className="text-left text-white/[0.72] hover:text-white hover:underline hover:underline-offset-[3px]">
                Devolução da ferramenta (30 dias)
              </button>
              <a href="#planos" className="text-white/[0.72] hover:text-white hover:underline hover:underline-offset-[3px]">Planos</a>
              <button type="button" onClick={abrir} className="text-left text-white/[0.72] hover:text-white hover:underline hover:underline-offset-[3px]">
                Contato
              </button>
              <a href="#perguntas" className="text-white/[0.72] hover:text-white hover:underline hover:underline-offset-[3px]">Perguntas</a>
            </nav>
            <div className="flex flex-col gap-2 border-t border-white/10 pt-[18px] text-xs leading-[1.55] tracking-[-0.015em] text-white/[0.55]">
              <p>HospedePay é um produto de RICC Mens Health LLC · Albuquerque, Novo México, EUA.</p>
              <p>Documentos e selfies dos hóspedes ficam guardados com criptografia e são apagados 180 dias depois do checkout.</p>
              <p>© 2026 RICC Mens Health LLC. Todos os direitos reservados.</p>
            </div>
          </footer>
        </div>
      </section>

      {/* -------------------------------------------------------------- fab */}
      <div
        className={cn(
          "fab fixed inset-x-0 bottom-0 z-50 border-t border-[#f0f0f0] bg-white/90 px-5 pt-2.5 backdrop-blur-xl transition-[transform,opacity] duration-500 ease-page",
          "md:inset-x-auto md:bottom-6 md:right-6 md:w-[360px] md:border-0 md:bg-transparent md:px-0 md:pt-0 md:backdrop-blur-0",
          fab && !formAberto ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0",
        )}
      >
        <BotaoFalar on={on} label={textos.btn} onClick={abrir} className="mx-auto max-w-[720px] md:shadow-[0_12px_40px_rgba(0,0,0,0.28)]" />
      </div>

      {/* ------------------------------------------------------- formulário */}
      {formAberto && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4">
          <button type="button" aria-label="Fechar" onClick={fechar} className="absolute inset-0 bg-black/45" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Me liga"
            className="relative max-h-[92vh] w-full max-w-[560px] overflow-auto rounded-t-[28px] bg-white px-5 pt-[22px] shadow-sheet animate-in slide-in-from-bottom-4 fade-in-0 duration-300 sm:rounded-[28px]"
            style={{ paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))" }}
          >
            <button
              type="button"
              onClick={fechar}
              aria-label="Fechar"
              className="absolute right-3.5 top-3.5 flex h-9 w-9 items-center justify-center rounded-full bg-[#f0f0f0] text-xl leading-none text-black hover:bg-[#e6e6e6]"
            >
              ×
            </button>

            {enviado ? (
              <div className="space-y-5 py-7 pr-10">
                <p className="text-[clamp(22px,6vw,26px)] font-normal leading-[1.2] tracking-titulo text-black [text-wrap:pretty]">
                  {textos.feito}
                </p>
                {!LEAD_ENDPOINT && !WHATSAPP && (
                  <Link to="/entrar?modo=cadastro" className="block text-base text-primary underline decoration-1 underline-offset-[3px]">
                    Ou crie sua conta agora e eu te ligo pelo cadastro.
                  </Link>
                )}
              </div>
            ) : (
              <form onSubmit={enviar} className="flex flex-col gap-4 pt-6">
                <label className="flex flex-col gap-1.5 text-sm tracking-corpo text-muted-foreground">
                  Nome
                  <input
                    name="nome"
                    type="text"
                    required
                    autoComplete="name"
                    className="h-[52px] rounded-[14px] border border-line-strong bg-white px-4 text-base text-black outline-none focus:border-black"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm tracking-corpo text-muted-foreground">
                  WhatsApp (com DDD)
                  <input
                    name="whatsapp"
                    type="tel"
                    inputMode="tel"
                    required
                    autoComplete="tel"
                    className="h-[52px] rounded-[14px] border border-line-strong bg-white px-4 text-base text-black outline-none focus:border-black"
                  />
                </label>
                <div className="flex flex-col gap-2">
                  <span className="text-sm tracking-corpo text-muted-foreground">Quantos imóveis você anuncia?</span>
                  <div className="flex flex-wrap gap-2">
                    {["1", "2 ou 3", "4 ou 5", "mais de 5"].map((v) => pilula(v, v, imoveis, setImoveis))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm tracking-corpo text-muted-foreground">Seu prédio tem portaria?</span>
                  <div className="flex flex-wrap gap-2">
                    {["sim", "não"].map((v) => pilula(v, v, portaria, setPortaria))}
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={enviando}
                  className="mt-1.5 flex h-14 w-full items-center justify-center rounded-pill bg-primary text-base tracking-corpo text-white transition-[background-color,transform] duration-200 hover:bg-primary-hover active:scale-[0.985] disabled:opacity-60"
                >
                  {enviando ? "Enviando…" : textos.submit}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CSS do movimento. Vive aqui, e não no index.css, porque só esta página
 * tem entrada cinematográfica — o painel abre pronto, sem cortina.
 *
 * Tudo o que depende da rolagem lê `--p` (0 a 1), que o `useCenas` escreve
 * no elemento marcado com `data-cena` e os filhos herdam.
 */
const LP_CSS = `
html.tema-claro, body.tema-claro { background: #ffffff; }
.acento { font-family: "Instrument Serif", Georgia, "Times New Roman", serif; font-style: italic; font-weight: 400; letter-spacing: -0.01em; }

/* --- revelação -------------------------------------------------------- */
.lp-js [data-reveal] { opacity: 0; transition: opacity 1.1s cubic-bezier(.22,.61,.36,1), transform 1.1s cubic-bezier(.22,.61,.36,1); }
.lp-js [data-reveal="up"] { transform: translateY(28px); }
.lp-js [data-reveal="left"] { transform: translateX(-24px); }
.lp-js [data-reveal="scale"] { transform: scale(.96) translateY(24px); }
.lp-js [data-reveal="fade"] { transform: none; }
.lp-js [data-reveal="line"] { transform: scaleX(0); opacity: 1; transition: transform .9s cubic-bezier(.22,.61,.36,1); }
.lp-js [data-reveal="mask"] { opacity: 1; transition: none; }
.lp-js [data-reveal].is-in { opacity: 1; transform: none; }
.lp-js [data-reveal="line"].is-in { transform: scaleX(1); }
.mask { display: inline-block; overflow: hidden; vertical-align: bottom; padding: 0.06em 0.04em 0.14em 0; margin: -0.06em -0.04em -0.14em 0; }
.mask .w { display: inline-block; }
.lp-js .mask .w { transform: translateY(112%); transition: transform 1.05s cubic-bezier(.22,.61,.36,1) var(--d, 0ms); }
.lp-js .is-in .mask .w { transform: none; }
.lp-js .lp-fill-y { transform: scaleY(0); transition: transform 1.6s cubic-bezier(.22,.61,.36,1); }
.lp-js .lp-fill-y.is-in { transform: scaleY(1); }

/* --- faixa que corre ---------------------------------------------------- */
.faixa-trilho { animation: faixa 42s linear infinite; }
.fab { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
@media (min-width: 768px) { .fab { padding-bottom: 0; } }
@keyframes faixa { to { transform: translate3d(-50%, 0, 0); } }

/* --- vidro -------------------------------------------------------------- */
.vidro { background: rgba(200,200,200,0.14); backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4); box-shadow: rgba(0,0,0,0.25) 0 10px 30px, inset 0 1px 0 rgba(255,255,255,0.12); }

/* --- as quatro telas que se empilham -------------------------------- */
.cena-pilha { position: relative; height: calc(var(--n) * 100svh); background: #000; }
.cena-painel {
  position: sticky; top: 0; height: 100svh; overflow: hidden;
  --c: clamp(0, calc(var(--p, 0) * (var(--n) - 1) - var(--i)), 1);
  --a: clamp(0, calc(var(--p, 0) * (var(--n) - 1) - var(--i) + 1), 1);
  transform: scale(calc(1 - 0.08 * var(--c))) translateY(calc(-32px * var(--c)));
  transform-origin: 50% 35%;
  border-radius: calc(36px * (1 - var(--a))) calc(36px * (1 - var(--a))) 0 0;
  will-change: transform;
}
.cena-painel .cena-foto { transform: scale(calc(1.12 - 0.12 * var(--a))) translateY(calc(-3% * var(--c))); transform-origin: 50% 50%; }
.cena-painel .cena-sombra { opacity: calc(0.7 * var(--c)); pointer-events: none; }
.cena-seg { transform: scaleX(clamp(0, calc(var(--p, 0) * (var(--n) - 1) - var(--i) + 1), 1)); }

/* --- o trilho que corre na horizontal ---------------------------------- */
.cena-drift { position: relative; height: 320svh; }
@media (min-width: 768px) { .cena-drift { height: 260svh; } }
.cena-fixo { position: sticky; top: 0; height: 100svh; display: flex; flex-direction: column; justify-content: center; gap: 28px; overflow: hidden; padding-top: 72px; }
@media (min-width: 768px) { .cena-fixo { gap: 40px; padding-top: 48px; } }
.trilho { display: flex; align-items: flex-start; gap: 20px; width: max-content; padding-left: 20px; transform: translate3d(calc(var(--p, 0) * var(--dx, 0px)), 0, 0); will-change: transform; }
@media (min-width: 768px) { .trilho { gap: 28px; padding-left: max(20px, calc((100vw - 1120px) / 2 + 20px)); } }
.trilho:focus-visible { outline: 2px solid #000; outline-offset: -2px; }
@media (max-width: 767px) {
  .cena-drift { height: auto; }
  .cena-fixo { position: static; height: auto; overflow: visible; padding-top: 0; }
  .trilho { width: 100%; overflow-x: auto; padding: 0 20px 18px; transform: none; will-change: auto; scroll-snap-type: x proximity; scroll-padding-inline: 20px; }
  .trilho > article { scroll-snap-align: start; }
}

/* --- crescer até a borda da tela --------------------------------------- */
.cena-cresce { --g: var(--p, 0); border-radius: calc(32px * (1 - var(--g))); margin-inline: calc((100% - 100vw) / 2 * var(--g)); }
@media (min-width: 1200px) { .cena-cresce { margin-inline: calc((100% - min(100vw, 1440px)) / 2 * var(--g)); } }

/* --- parallax leve dentro das molduras --------------------------------- */
.cena-parallax { transform: translate3d(0, calc((var(--p, .5) - .5) * -10%), 0) scale(1.12); will-change: transform; }

/* --- os passos do hóspede acendem conforme a lista passa ---------------- */
.passos { position: relative; }
.passos-trilho { position: absolute; left: 15px; top: 14px; bottom: 14px; width: 2px; background: #ececec; }
@media (min-width: 1024px) { .passos-trilho { left: 17px; top: 18px; bottom: 18px; } }
.passos-trilho::after { content: ""; position: absolute; inset: 0; background: #FF385C; transform-origin: top; transform: scaleY(clamp(0, calc((var(--p, 0) - .18) / .5), 1)); }
.passo { --k: clamp(0, calc((var(--p, 0) - .18 - var(--i) * .1) / .08), 1); opacity: calc(0.28 + 0.72 * var(--k)); position: relative; }
.passo + .passo { border-top: 1px solid #f0f0f0; }
.passo-icone { position: relative; z-index: 1; transform: scale(calc(0.86 + 0.14 * var(--k))); }

/* --- perguntas ---------------------------------------------------------- */
.pergunta .pergunta-v { transition: transform .35s cubic-bezier(.22,.61,.36,1); }
.pergunta[open] .pergunta-v { transform: translate(-50%, -50%) rotate(90deg); }
.pergunta .pergunta-mais { transition: background-color .25s, border-color .25s; }
.pergunta[open] .pergunta-mais { background: #000; border-color: #000; }
.pergunta[open] .pergunta-mais span { background: #fff; }

.lp-glow { pointer-events: none; filter: blur(34px); opacity: .9;
  background: radial-gradient(40% 35% at 20% 25%, rgba(255,56,92,.45), transparent 70%),
              radial-gradient(35% 30% at 80% 70%, rgba(0,166,153,.25), transparent 70%),
              radial-gradient(45% 40% at 55% 90%, rgba(252,100,45,.22), transparent 70%); }

@media (prefers-reduced-motion: reduce) {
  .lp-js [data-reveal], .lp-js .lp-fill-y, .lp-js .mask .w { transition: none !important; opacity: 1; transform: none !important; }
  .faixa-trilho { animation: none; }
  .cena-pilha { height: auto; }
  .cena-painel { position: relative; transform: none; border-radius: 0; will-change: auto; }
  .cena-painel .cena-foto, .cena-parallax { transform: none; }
  .cena-painel .cena-sombra { opacity: 0; }
  .cena-cresce { margin-inline: 0; border-radius: 32px; }
  .cena-drift { height: auto; }
  .cena-fixo { position: static; height: auto; overflow: visible; padding-top: 0; }
  .trilho { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); width: 100%; max-width: 1120px; margin-inline: auto; padding: 0 20px; transform: none; will-change: auto; overflow: visible; }
  .trilho > article { width: auto; min-width: 0; }
  .trilho > [aria-hidden] { display: none; }
  .passos-trilho::after, .passo-icone { transform: none; }
  .passo { opacity: 1; }
  .fab, .pergunta .pergunta-v, .pergunta .pergunta-mais { transition: none; }
}
`;
