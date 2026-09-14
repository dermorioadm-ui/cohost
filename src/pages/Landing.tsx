import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Marca } from "@/components/Marca";
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
 * Esta versão é o desenho definitivo (feito no Claude Design): fotografia de
 * verdade em cada trava, o celular com o vídeo do cadastro, a conta da
 * gestora feita na frente do cliente e o Renato de corpo presente — no botão,
 * na foto e na garantia. Três decisões que sustentam a página:
 *
 *   1. UMA PERGUNTA NO TOPO, e não uma promessa. "Você deixaria um estranho
 *      entrar na sua casa?" é a dor; o produto é a resposta, três travas
 *      depois.
 *   2. QUEM RESPONDE É UMA PESSOA. O botão principal não diz "assinar", diz
 *      "falar agora", e mostra o rosto de quem atende. Num ticket de R$ 97 a
 *      objeção não é preço, é "isso funciona no meu prédio?" — e isso se
 *      resolve numa chamada de 15 minutos, não num FAQ.
 *   3. O PREÇO É COMPARADO, não escondido. R$ 97 fixos ao lado dos 15–25% da
 *      gestora, com a conta feita: R$ 8.630 por ano.
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

/* -------------------------------------------------------------------------
 * Movimento. Um observador só, para tudo o que tem `data-reveal`: quando o
 * elemento entra na tela ele ganha `is-in` e a CSS faz o resto. As barras de
 * progresso (`data-fill`) e os contadores (`data-count`) usam o mesmo
 * observador. Sem JS o conteúdo aparece igual — a classe `lp-js` só esconde o
 * que vai ser revelado depois que o observador existe.
 * ---------------------------------------------------------------------- */
function useReveal(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduz = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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
  }, [root]);
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

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * O herói encolhe e escurece conforme sai de cena, e o título some antes do
 * resto. É o mesmo gesto do desenho original: a página "fecha" a capa e abre
 * o papel branco por baixo.
 */
function useEncolherHero(hero: React.RefObject<HTMLElement>, titulo: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = hero.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
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
  }, [hero, titulo]);
}

const delay = (ms: number): CSSProperties => ({ transitionDelay: `${ms}ms` });

/* ----------------------------------------------------------------- peças */

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

function H2({ children, className, escuro = false }: { children: ReactNode; className?: string; escuro?: boolean }) {
  return (
    <h2
      data-reveal="up"
      className={cn(
        "max-w-[22ch] text-[clamp(34px,5vw,44px)] font-normal leading-[1.04] tracking-titulo [text-wrap:balance]",
        escuro ? "text-white" : "text-black",
        className,
      )}
    >
      {children}
    </h2>
  );
}

/** O traço coral que sublinha cada título de seção. */
function Traco({ className }: { className?: string }) {
  return (
    <div
      data-reveal="line"
      style={delay(200)}
      aria-hidden
      className={cn("h-[3px] w-14 origin-left rounded-[2px] bg-primary", className)}
    />
  );
}

function H3({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn("text-[clamp(20px,3vw,24px)] font-normal leading-[1.2] tracking-[-0.02em] text-black [text-wrap:balance]", className)}>
      {children}
    </h3>
  );
}

function Numeral({ n, rotulo }: { n: number; rotulo: string }) {
  return (
    <div className="flex w-full items-center gap-2.5">
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-primary text-[14px] leading-none text-white tabular-nums">
        {n}
      </span>
      <span className="text-xs leading-normal tracking-[0.08em] text-primary">{rotulo}</span>
    </div>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF385C" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Logos({ tamanho = 40, sombra = false }: { tamanho?: number; sombra?: boolean }) {
  const cls = cn("block rounded-[11px] object-cover", sombra && "shadow-[0_6px_18px_rgba(0,0,0,0.25)]");
  const st = { width: tamanho, height: tamanho, borderRadius: Math.round(tamanho * 0.27) };
  return (
    <div className="flex items-center gap-2">
      <img src="/lp/airbnb.svg" alt="Airbnb" className={cls} style={st} />
      <img src="/lp/booking.webp" alt="Booking.com" className={cls} style={st} />
      <img src="/lp/vrbo.webp" alt="Vrbo" className={cls} style={st} />
    </div>
  );
}

/* --------------------------------------------------------------- conteúdo */

const DORES: ReactNode[] = [
  <>
    A portaria liga: “tem um hóspede aqui dizendo que tem reserva pra hoje, mas não tem acesso.”{" "}
    <span className="font-medium text-primary">Você esqueceu de cadastrar.</span>
  </>,
  <>
    A diarista diz que o sofá está manchado.{" "}
    <span className="font-medium text-primary">Sem contrato, sem compromisso</span> — e você não tem
    nome, documento nem assinatura pra cobrar de ninguém.
  </>,
  <>
    <span className="font-medium text-primary">Você não sabe se o AirCover vai te ressarcir.</span>{" "}
    Dependendo da quebra, ficam dias com a reserva fechada pra reparo.
  </>,
];

const TRAVAS = [
  {
    rotulo: "RESERVA",
    titulo: "Ladrão não deixa documento e selfie pra te roubar.",
    foto: "/lp/trava-ladrao.webp",
    alt: "Ladrão saindo do apartamento com a TV embaixo do braço",
    texto: "Quem entra na sua casa deixa rosto, documento e assinatura antes da chave.",
  },
  {
    rotulo: "CONTRATO",
    titulo: "Ele cuida da sua casa como se fosse dele.",
    foto: "/lp/trava-sofa.webp",
    alt: "Anfitriã em descrença diante da mancha de vinho no sofá branco",
    texto: "Com contrato na mão, os prejuízos tendem a não ter recorrência.",
  },
  {
    rotulo: "PORTARIA",
    titulo: "Você não precisa mais cadastrar o hóspede.",
    foto: "/lp/trava-portaria.webp",
    alt: "Porteiro entregando a chave para a hóspede",
    texto: "O porteiro já sabe quem chega, com nome, documento e horário.",
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
    rotulo: "CHECKOUT AUTOMÁTICO",
    titulo: "A limpeza tem o calendário dos seus apartamentos.",
    texto: "Ela sabe quem entra às 15h e quem sai às 11h, sem você avisar. Fecha o checkout com foto carimbada na hora.",
    foto: "/lp/ainda-limpeza.webp",
    alt: "Diarista conferindo o calendário no celular",
  },
  {
    rotulo: "REPOSIÇÃO AUTOMÁTICA",
    titulo: "Você não se preocupa em repor o papel higiênico.",
    texto: "Taxa combinada por mês, gravada e aceita pela diarista no celular. Ela repõe, você aprova.",
    foto: "/lp/ainda-reposicao.webp",
    alt: "Reposição de papel higiênico e sabonetes no armário",
  },
  {
    rotulo: "IA 24 HORAS",
    titulo: "A IA atende o seu hóspede a qualquer hora.",
    texto: "Você alimenta com as informações do seu apartamento — senha do wi-fi, vaga, chuveiro — e ela responde na hora. Em português, inglês e espanhol.",
    foto: "/lp/ainda-ia.webp",
    alt: "Hóspede lendo a resposta da IA à noite",
  },
  {
    rotulo: "TRÊS CANAIS, UM CALENDÁRIO",
    titulo: "Airbnb, Booking e VRBO no mesmo calendário.",
    texto: "Sincronizado a cada 30 minutos. Data ocupada em um canal fecha nos outros três, sem você tocar.",
    foto: "/lp/ainda-calendario.webp",
    alt: "Calendário com reservas do Airbnb, Booking e VRBO",
    canais: true,
  },
];

const COMPARACAO: { grupo: string; linhas: [string, boolean, boolean][] }[] = [
  {
    grupo: "OS DOIS FAZEM",
    linhas: [
      ["Responde o hóspede", true, true],
      ["Coordena a limpeza", true, true],
      ["Cadastra acesso do hóspede no condomínio", true, true],
    ],
  },
  {
    grupo: "ONDE MUDA",
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
  ["Quem faz a implementação?", "Eu, com você, numa chamada de 15 minutos. Você preenche a ficha, o sistema cadastra tudo. Calendário ligado no mesmo dia."],
  ["E se eu não gostar?", "30 dias. Devolvo tudo."],
];

/* -------------------------------------------------------------- página */

type Plano = (typeof PLANOS_RESERVA)[number];

const IMOVEIS_LABEL = (n: number | null) =>
  n === null ? "sem limite de imóveis" : n === 1 ? "1 imóvel" : n === 3 ? "2 ou 3 imóveis" : n === 5 ? "4 ou 5 imóveis" : `até ${n} imóveis`;

/** Vídeo do cadastro no celular: começa no segundo certo e volta para lá no fim. */
function VideoProva() {
  const ref = useRef<HTMLVideoElement>(null);
  const inicio = useCallback(() => {
    const v = ref.current;
    if (v && v.currentTime < VIDEO_PROVA_INICIO - 0.05) v.currentTime = VIDEO_PROVA_INICIO;
  }, []);
  const reiniciar = useCallback(() => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = VIDEO_PROVA_INICIO;
    v.play().catch(() => undefined);
  }, []);
  return (
    <video
      ref={ref}
      src={VIDEO_PROVA}
      autoPlay
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={inicio}
      onEnded={reiniciar}
      className="block h-full w-full bg-black object-contain"
    />
  );
}

export default function Landing() {
  const raiz = useRef<HTMLDivElement>(null);
  useReveal(raiz);

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
  useEncolherHero(heroRef, tituloRef);
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

  return (
    <div ref={raiz} className="tema-claro relative min-h-screen overflow-x-hidden bg-white text-black">
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
              src="/lp/hero.mp4"
              poster="/lp/hero-poster.webp"
              autoPlay
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

        <div className="relative z-[1] mx-auto flex min-h-[100svh] max-w-[720px] flex-col justify-between gap-[38px] px-5 pb-[76px] pt-24">
          <div data-reveal="up" className="flex flex-wrap items-center justify-center gap-2.5">
            <span className="text-[13px] leading-normal tracking-[0.06em] text-white">Check‑in blindado com:</span>
            <Logos tamanho={40} />
          </div>

          <div className="flex flex-col gap-7">
            <h1
              ref={tituloRef}
              className="flex flex-wrap gap-x-[0.22em] text-[clamp(36px,10.5vw,60px)] font-normal leading-[0.96] tracking-display text-white [text-wrap:balance]"
            >
              {"Você deixaria um estranho entrar na sua casa?".split(" ").map((w, i) => (
                <span key={i} data-reveal="word" style={delay(120 + i * 70)} className="inline-block">
                  {w}
                </span>
              ))}
            </h1>
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

      <main className="mx-auto max-w-[720px] px-5">
        {/* -------------------------------------------------------- a cena */}
        <section className="pt-14">
          <div data-reveal="scale" className="rounded-[32px] bg-[#f0f0f0] px-5 py-6">
            <H2>Você sabe como é.</H2>
            <Traco className="mb-7 mt-5" />
            <div className="relative flex flex-col gap-6 pl-[30px]">
              <div className="absolute bottom-1.5 left-0 top-1.5 w-[2px] overflow-hidden rounded-[2px] bg-[#d9d9d9]">
                <div data-fill className="lp-fill-y absolute inset-0 origin-top bg-primary" />
              </div>
              {DORES.map((d, i) => (
                <p key={i} data-reveal="left" style={delay(i * 90)} className="text-lg leading-[1.33] tracking-[-0.01em] text-black">
                  <span className="mb-1.5 block text-sm leading-normal tracking-titulo text-[#666666]">DOR {i + 1}</span>
                  {d}
                </p>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------- três travas */}
        <section id="como-funciona" className="scroll-mt-20 pt-[120px]">
          <H2>Check‑in Blindado. Você sabe quem dorme na sua casa.</H2>
          <div data-reveal="fade" className="mb-8 mt-10 grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[3px] overflow-hidden rounded-[2px] bg-[#f0f0f0]">
                <div data-fill className="lp-fill h-full origin-left bg-primary" style={delay(i * 180)} />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-6">
            {TRAVAS.map((t, i) => (
              <article key={t.rotulo} data-reveal="up" className="overflow-hidden rounded-3xl border border-[#ececec] bg-white">
                <div className="flex flex-col gap-2.5 px-[22px] pt-[18px]">
                  <Numeral n={i + 1} rotulo={t.rotulo} />
                  <H3>{t.titulo}</H3>
                </div>
                <div className="flex flex-col gap-4 px-[22px] pb-[22px] pt-4">
                  <div className="relative overflow-hidden rounded-3xl bg-[#f0f0f0]" style={{ aspectRatio: "4 / 3" }}>
                    <img src={t.foto} alt={t.alt} loading="lazy" className="block h-full w-full object-cover" />
                  </div>
                  <p className="text-base leading-[1.4] tracking-corpo text-black [text-wrap:pretty]">{t.texto}</p>
                </div>
              </article>
            ))}
          </div>

          {/* O celular: o que o hóspede vê, sem ninguém explicar. */}
          <figure data-reveal="scale" className="mt-16 flex flex-col items-center gap-5">
            <figcaption className="order-[-1] flex w-full flex-col gap-3">
              <span className="text-[clamp(34px,4.4vw,48px)] font-normal leading-[1.02] tracking-[-0.027em] text-black [text-wrap:balance]">
                É isso que o seu hóspede vê.
              </span>
              <span className="text-lg leading-[1.4] tracking-corpo text-[#666666] [text-wrap:pretty]">
                Ele faz sozinho, em menos de um minuto. Você recebe o contrato pronto.
              </span>
            </figcaption>
            <div className="flex justify-center">
              <div
                className="relative h-[620px] max-w-full rounded-[48px] bg-[#0b0b0d] p-2.5"
                style={{ aspectRatio: "9 / 19.5", boxShadow: "0 30px 90px rgba(0,0,0,0.28), inset 0 0 0 1.5px rgba(255,255,255,0.10)" }}
              >
                <div aria-hidden className="absolute -left-0.5 top-[19%] h-[8%] w-[3px] rounded-[2px] bg-[#1a1a1d]" />
                <div aria-hidden className="absolute -left-0.5 top-[29%] h-[8%] w-[3px] rounded-[2px] bg-[#1a1a1d]" />
                <div aria-hidden className="absolute -right-0.5 top-[23%] h-[13%] w-[3px] rounded-[2px] bg-[#1a1a1d]" />
                <div className="relative h-full w-full overflow-hidden rounded-[39px] bg-black">
                  <VideoProva />
                  <div aria-hidden className="absolute left-1/2 top-[9px] h-[22px] w-[34%] -translate-x-1/2 rounded-[20px] bg-black" />
                  <div aria-hidden className="absolute bottom-[7px] left-1/2 h-1 w-[36%] -translate-x-1/2 rounded-[2px] bg-white/85" />
                </div>
              </div>
            </div>
          </figure>

          <ul className="mt-10 flex flex-col overflow-hidden">
            {PASSOS.map((p, i) => (
              <li
                key={p.nome}
                data-reveal="up"
                style={delay(i * 60)}
                className={cn("flex items-center gap-3 py-[18px]", i > 0 && "border-t border-[#f0f0f0]")}
              >
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] bg-primary">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {p.icone}
                  </svg>
                </span>
                <span className="text-[17px] leading-[1.35] tracking-corpo text-black">{p.nome}</span>
                <span className="ml-auto text-xs leading-none tracking-[0.06em] text-[#6b6b6b] tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* --------------------------------------------------------- prova */}
        <section id="prova" className="scroll-mt-20 pt-[120px]">
          <H2>Rodando no meu apartamento em Niterói.</H2>
          <Traco className="mb-10 mt-5" />
          <figure data-reveal="scale" className="relative overflow-hidden rounded-[32px] bg-[#1a1a1a]" style={{ aspectRatio: "4 / 5" }}>
            <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
              <img
                src="/lp/prova-varanda.webp"
                alt="Varanda do apartamento em Niterói com vista para a baía e o Cristo Redentor"
                loading="lazy"
                className="block h-full w-full object-cover [object-position:50%_0%]"
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.72) 72%, rgba(0,0,0,0.9) 100%)" }}
              />
            </div>
            <span className="absolute left-4 top-4 inline-flex h-7 items-center whitespace-nowrap rounded-[20px] border border-white/[0.28] bg-white/[0.16] px-3 text-[11px] leading-none tracking-[0.08em] text-white backdrop-blur-md">
              ÚLTIMOS 30 DIAS
            </span>
            <figcaption className="absolute inset-x-0 bottom-0 p-[26px]">
              <div className="grid grid-cols-2">
                {[
                  [PROVA.reservas, "reservas", "border-b border-r pb-4 pr-3.5"],
                  [PROVA.hospedes, "hóspedes", "border-b pb-4 pl-4"],
                  [PROVA.termos, "contratos assinados", "border-r pr-3.5 pt-4"],
                  [PROVA.cadastros, "cadastros na portaria", "pl-4 pt-4"],
                ].map(([n, r, cls], i) => (
                  <div key={r} data-reveal="up" style={delay(i * 80)} className={cn("flex min-w-0 flex-col gap-1.5 border-white/[0.28]", cls as string)}>
                    <span aria-hidden className="mb-0.5 block h-0.5 w-[22px] rounded-[1px] bg-primary" />
                    <div data-count={n} className="numero-grande text-[clamp(38px,6vw,56px)] text-white">{n}</div>
                    <div className="text-sm leading-[1.35] tracking-[-0.02em] text-white/85">{r}</div>
                  </div>
                ))}
              </div>
            </figcaption>
          </figure>
          <p data-reveal="fade" style={delay(120)} className="mt-4 text-center text-sm leading-normal tracking-[-0.02em] text-[#6b6b6b]">
            <a href={ANUNCIO_AIRBNB} target="_blank" rel="noopener" className="underline decoration-1 underline-offset-[3px] hover:text-black">
              Ver o anúncio no Airbnb
            </a>
          </p>
        </section>

        {/* ------------------------------------------------------- emprego */}
        <section className="pt-[120px]">
          <figure data-reveal="scale" className="relative mt-6 overflow-hidden rounded-[32px] bg-[#1a1a1a]" style={{ aspectRatio: "4 / 5" }}>
            <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
              <img
                src="/lp/emprego.webp"
                alt="Anfitrião cansado à mesa da cozinha, de noite, com o celular na mão"
                loading="lazy"
                className="block h-full w-full object-cover"
              />
              <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.78) 100%)" }} />
            </div>
            <figcaption className="absolute inset-x-0 bottom-0 px-[30px] pb-[34px] pt-8 text-[clamp(30px,4.6vw,40px)] font-normal leading-[1.08] tracking-[-0.035em] text-white [text-wrap:balance]">
              Você não comprou um apartamento. Você comprou um emprego.
            </figcaption>
          </figure>
          <p data-reveal="up" className="mt-6 text-[clamp(22px,3vw,26px)] font-normal leading-[1.25] tracking-[-0.025em] text-black [text-wrap:pretty]">
            Com o HospedePay, além de mais segurança patrimonial e jurídica, você ganha automatização
            completa — e esquece por dias que tem um Airbnb.
          </p>
        </section>

        {/* ------------------------------------------------------- e ainda */}
        <section id="e-ainda" className="scroll-mt-20 pt-[120px]">
          <H2>Você entra pelo check‑in. Fica pelo resto.</H2>
          <Traco className="mt-5" />
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {E_AINDA.map((a, i) => (
              <article key={a.rotulo} data-reveal="up" style={delay(i * 60)} className="flex flex-col gap-3.5">
                <div className={cn("relative overflow-hidden rounded-2xl", a.canais ? "bg-[#fafafa]" : "bg-[#f0f0f0]")} style={{ aspectRatio: "4 / 3" }}>
                  <img src={a.foto} alt={a.alt} loading="lazy" className="block h-full w-full object-cover" />
                  {a.canais && (
                    <>
                      <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.42) 100%)" }} />
                      <div className="absolute inset-x-0 bottom-3.5 flex items-center justify-center">
                        <Logos tamanho={48} sombra />
                      </div>
                    </>
                  )}
                  <span className="absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary text-[15px] leading-none text-white tabular-nums">
                    {i + 1}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-xs leading-normal tracking-[0.08em] text-primary">{a.rotulo}</span>
                  <H3>{a.titulo}</H3>
                  <p className="max-w-[52ch] text-base leading-[1.49] tracking-[-0.014em] text-[#666666] [text-wrap:pretty]">{a.texto}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ esquecer */}
        <section className="pt-[120px]">
          <figure data-reveal="scale" className="relative overflow-hidden rounded-[32px] bg-[#e9e9e9]" style={{ aspectRatio: "4 / 5" }}>
            <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
              <img
                src="/lp/esquecer.webp"
                alt="Mulher sorrindo, relaxada no sofá da própria casa, com o celular apagado sobre a mesa"
                loading="lazy"
                className="block h-full w-full object-cover [object-position:50%_20%]"
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 26%, rgba(0,0,0,0.58) 48%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,0.9) 100%)" }}
              />
            </div>
            <figcaption className="absolute inset-x-0 bottom-0 flex flex-col gap-3 px-7 py-8">
              <p className="text-[clamp(32px,4.6vw,44px)] font-normal leading-[1.06] tracking-[-0.035em] text-white [text-wrap:balance]">
                Nossa meta é você esquecer que o HospedePay existe.
              </p>
              <p className="text-[17px] leading-[1.4] tracking-corpo text-white/[0.86] [text-wrap:pretty]">
                Tudo rodando sozinho, com segurança. Você só lembra quando o dinheiro cai.
              </p>
            </figcaption>
          </figure>
        </section>

        {/* ---------------------------------------------- gestora × hospedepay */}
        <section id="comparacao" className="scroll-mt-20 pt-[120px]">
          <div data-reveal="scale" className="rounded-[32px] bg-[#1c1c1e] px-[30px] py-9">
            <H2 escuro>A gestora leva uma fatia do que você fatura. O HospedePay custa R$97 por mês. Fixo.</H2>
            <Traco className="mt-5" />
            <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
              <div data-reveal="up" className="flex flex-col gap-2 rounded-[20px] bg-white/[0.12] px-[18px] py-5">
                <span className="text-xs leading-normal tracking-[0.08em] text-white/[0.72]">GESTORA</span>
                <span className="numero-grande text-[clamp(34px,9vw,44px)] text-white">15–25%</span>
                <span className="text-sm leading-[1.45] tracking-corpo text-white/[0.72]">do que o apartamento fatura, todo mês, por imóvel.</span>
              </div>
              <div data-reveal="up" style={delay(80)} className="flex flex-col gap-2 rounded-[20px] bg-primary px-[18px] py-5">
                <span className="text-xs leading-normal tracking-[0.08em] text-white">HOSPEDEPAY</span>
                <span className="numero-grande text-[clamp(34px,9vw,44px)] text-white">R$97</span>
                <span className="text-sm leading-[1.45] tracking-corpo text-white">por mês. Fature R$2.000 ou R$10.000, é R$97.</span>
              </div>
            </div>

            <div data-reveal="up" className="mt-6 overflow-hidden rounded-3xl bg-white">
              <div className="grid grid-cols-[1fr_64px_84px] items-end gap-2 border-b border-[#f0f0f0] px-5 pb-3.5 pt-[18px]">
                <span className="text-xs leading-normal tracking-[0.08em] text-[#666666]">O QUE FAZ</span>
                <span className="text-center text-[13px] tracking-corpo text-black">Gestora</span>
                <span className="text-center text-[13px] tracking-corpo text-primary">HospedePay</span>
              </div>
              {COMPARACAO.map((g) => (
                <div key={g.grupo}>
                  <div className="border-b border-t border-[#f0f0f0] bg-[#fafafa] px-5 pb-1.5 pt-2.5 text-xs tracking-[0.08em] text-[#666666]">{g.grupo}</div>
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

            <div data-reveal="up" className="mt-10 flex flex-col gap-[18px] rounded-[28px] bg-[#2a2a2e] px-[26px] py-7">
              <p className="max-w-[52ch] text-base leading-[1.49] tracking-[-0.014em] text-white/[0.72] [text-wrap:pretty]">
                Faça a conta no seu. Um apartamento que fatura R$4.000 por mês:
              </p>
              <div className="flex flex-col">
                {[["Gestora", "R$9.600"], ["HospedePay", "R$970"]].map(([q, v]) => (
                  <div key={q} className="flex items-baseline justify-between gap-4 border-t border-white/[0.14] py-3">
                    <span className="text-[22px] tracking-[-0.014em] text-white">{q}</span>
                    <span className="whitespace-nowrap text-[22px] tracking-[-0.02em] text-white tabular-nums">
                      {v}<span className="text-sm text-white/[0.72]"> / ano</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1 border-t-2 border-black pt-[18px]">
                <span className="text-xs leading-normal tracking-[0.08em] text-white/[0.72]">A DIFERENÇA</span>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="numero-grande text-[clamp(48px,6vw,64px)] text-[#FF8095]">R$8.630</span>
                  <span className="text-base tracking-[-0.014em] text-white/[0.72]">por ano, no seu bolso</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- planos */}
        <section id="planos" ref={planosRef} className="scroll-mt-6 pt-[120px]">
          <H2>Escolha o plano. Eu ligo seu calendário hoje.</H2>
          <Traco className="mt-5" />
          <p data-reveal="up" style={delay(80)} className="mt-5 max-w-[46ch] text-lg leading-[1.33] tracking-[-0.01em] text-[#666666] [text-wrap:pretty]">
            Anual: paga 10 meses, usa 12. Em 10x no cartão dá o mesmo valor do mensal, com
            implementação e suporte inclusos.
          </p>
          {checkoutCancelado && (
            <p className="mt-5 rounded-2xl bg-[#f0f0f0] px-4 py-3 text-[15px] leading-snug tracking-corpo text-black">
              Você saiu antes de pagar. Sem problema: o plano está aqui quando quiser.
            </p>
          )}
          {erroPlano && (
            <p role="alert" className="mt-5 rounded-2xl border border-primary/35 bg-primary/10 px-4 py-3 text-[15px] leading-snug tracking-corpo text-black">
              {erroPlano}
            </p>
          )}
          <div className="mt-10 flex flex-col gap-6">
            {PLANOS.map((p, i) => (
              <article
                key={p.tier}
                id={p.tier}
                data-reveal="up"
                style={{ ...delay(i * 80), scrollMarginTop: 24 }}
                className="flex flex-col overflow-hidden rounded-[28px] border border-[#ececec] bg-white"
              >
                <div className="flex items-center justify-between gap-3 border-b border-[#ececec] bg-[#f7f7f7] px-[22px] py-[18px]">
                  <H3>{p.nome}</H3>
                  <span className="inline-flex h-[30px] items-center whitespace-nowrap rounded-[20px] bg-black px-3.5 text-[13px] leading-none tracking-[-0.02em] text-white">
                    {p.imoveis}
                  </span>
                </div>
                <div className="flex flex-col gap-5 px-[22px] py-6">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="numero-grande text-[clamp(40px,5vw,56px)] text-black">{brl(p.anual)}</span>
                      <span className="text-[15px] tracking-[-0.014em] text-[#666666]">por ano</span>
                    </div>
                    <div className="text-base tracking-corpo text-black tabular-nums">
                      ou <span className="text-primary">10x de {brl(p.mensal)}</span> no cartão
                    </div>
                  </div>
                  <ul className="flex flex-col gap-2.5">
                    {["Implementação incluída", "Suporte incluído", "Garantia de 30 dias"].map((l) => (
                      <li key={l} className="flex items-center gap-2.5 text-[15px] leading-[1.4] tracking-corpo text-black">
                        <Check />
                        <span>{l}</span>
                      </li>
                    ))}
                  </ul>
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
                </div>
              </article>
            ))}
          </div>
          <p data-reveal="up" className="mt-7 text-center">
            <button type="button" onClick={abrir} className="text-base leading-[1.49] tracking-[-0.014em] text-primary underline decoration-1 underline-offset-4 hover:text-primary-hover">
              Mais de 5 imóveis? Toca no botão que a conversa é outra.
            </button>
          </p>
        </section>

        {/* ------------------------------------------------------ garantia */}
        <section id="garantia" className="scroll-mt-20 pt-16">
          <div data-reveal="scale" className="overflow-hidden rounded-[32px] bg-primary">
            <div className="bg-[#f0f0f0]" style={{ aspectRatio: "4 / 3" }}>
              <img
                src="/lp/garantia.webp"
                alt="Aperto de mãos com a entrega das chaves na porta do apartamento"
                loading="lazy"
                className="block h-full w-full object-cover"
              />
            </div>
            <div className="flex flex-col gap-[22px] bg-primary px-5 py-6">
              <div className="flex flex-col gap-1.5">
                <p className="text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-white">Garantia incondicional de 30 dias.</p>
                <p className="text-lg leading-[1.33] tracking-[-0.01em] text-white">Não gostou, devolvo. Sem asterisco.</p>
              </div>
              <div className="h-px bg-white/[0.28]" />
              <div className="flex flex-col gap-1.5">
                <p className="text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-white">Ativação em menos de 24 horas.</p>
                <p className="text-lg leading-[1.33] tracking-[-0.01em] text-white">Escolha o anual e eu resolvo o resto.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------- quem responde */}
        <section id="quem-responde" className="scroll-mt-20 pt-[120px]">
          <div data-reveal="up" className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-7">
            <div className="overflow-hidden rounded-[32px] bg-[#f0f0f0]" style={{ aspectRatio: "4 / 5" }}>
              <img src={FOTO} alt="Renato, anfitrião em Niterói" loading="lazy" className="block h-full w-full object-cover [object-position:50%_30%]" />
            </div>
            <div className="flex flex-col gap-5">
              <p className="text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black [text-wrap:pretty]">
                Sou o Renato. Anfitrião em Niterói. Uso o HospedePay no meu próprio apartamento.
              </p>
              <p className="text-lg leading-[1.33] tracking-[-0.01em] text-black">
                Quem te atende sou eu. A implementação eu faço com você, numa chamada de 15 minutos.
                Seu calendário fica ligado no mesmo dia.
              </p>
              <BotaoFalar on={on} label={textos.btn} onClick={abrir} />
              <p className="-mt-2.5 text-center text-sm leading-normal tracking-titulo text-[#666666]">{textos.linha}</p>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- perguntas */}
        <section id="perguntas" className="scroll-mt-20 pb-24 pt-[120px]">
          <H2>Perguntas que todo mundo faz</H2>
          <Traco className="mb-3 mt-5" />
          <div className="flex flex-col">
            {PERGUNTAS.map(([q, a], i) => (
              <div key={q} data-reveal="up" className={cn("flex flex-col gap-2 py-[22px]", i < PERGUNTAS.length - 1 && "border-b border-[#f0f0f0]")}>
                <H3>{q}</H3>
                <p className="max-w-[52ch] text-base leading-[1.49] tracking-[-0.014em] text-[#666666]">{a}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* ---------------------------------------------------------- fechamento */}
      <section className="relative overflow-hidden bg-black text-white">
        <div aria-hidden className="lp-glow absolute -left-[8%] -top-[8%] h-[116%] w-[116%] opacity-80" />
        <div className="relative z-[1] mx-auto flex max-w-[720px] flex-col gap-10 px-5 pb-[150px] pt-[120px]">
          <h2 data-reveal="up" className="max-w-[20ch] text-[clamp(34px,5vw,44px)] font-normal leading-[1.04] tracking-titulo text-primary [text-wrap:balance]">
            Ninguém dorme no seu apartamento sem ter assinado.
          </h2>
          <div data-reveal="up" style={delay(120)} className="flex flex-col gap-2.5">
            <BotaoFalar on={on} label={textos.btn} onClick={abrir} />
            <p className="text-center text-sm leading-normal tracking-titulo text-white/70">{textos.linha}</p>
          </div>
          <footer className="mt-6 flex flex-col gap-[22px] border-t border-white/[0.14] pt-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Marca size={22} tom="tinta" />
              <Link
                to="/entrar"
                className="inline-flex h-9 items-center whitespace-nowrap rounded-[20px] border border-white/[0.28] px-3.5 text-[13px] tracking-corpo text-white transition-colors hover:bg-white/10"
              >
                Entrar na plataforma
              </Link>
            </div>
            <nav aria-label="Links do rodapé" className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px] leading-normal tracking-corpo">
              <button type="button" onClick={abrir} className="text-left text-white/[0.72] hover:text-white hover:underline hover:underline-offset-[3px]">
                Pedir devolução (30 dias)
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
          "fixed inset-x-0 bottom-0 z-50 border-t border-[#f0f0f0] bg-white/90 px-5 pt-2.5 backdrop-blur-xl transition-[transform,opacity] duration-500 ease-page",
          fab && !formAberto ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0",
        )}
        style={{ paddingBottom: "calc(10px + env(safe-area-inset-bottom, 0px))" }}
      >
        <BotaoFalar on={on} label={textos.btn} onClick={abrir} className="mx-auto max-w-[720px]" />
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
 * CSS das revelações. Vive aqui, e não no index.css, porque só esta página
 * tem entrada cinematográfica — o painel abre pronto, sem cortina.
 */
const LP_CSS = `
.lp-js [data-reveal] { opacity: 0; transition: opacity 1.15s cubic-bezier(.22,.61,.36,1), transform 1.15s cubic-bezier(.22,.61,.36,1), filter 1.15s cubic-bezier(.22,.61,.36,1); }
.lp-js [data-reveal="up"] { transform: translateY(44px); filter: blur(8px); }
.lp-js [data-reveal="left"] { transform: translateX(-36px); filter: blur(8px); }
.lp-js [data-reveal="scale"] { transform: scale(.92) translateY(28px); filter: blur(8px); }
.lp-js [data-reveal="word"] { transform: translateY(.35em); filter: blur(12px); transition-duration: 1s; }
.lp-js [data-reveal="fade"] { transform: none; }
.lp-js [data-reveal="line"] { transform: scaleX(0); opacity: 1; transition: transform .8s cubic-bezier(.22,.61,.36,1); }
.lp-js [data-reveal].is-in { opacity: 1; transform: none; filter: none; }
.lp-js [data-reveal="line"].is-in { transform: scaleX(1); }
.lp-js .lp-fill { transform: scaleX(0); transition: transform .9s cubic-bezier(.22,.61,.36,1); }
.lp-js .lp-fill.is-in { transform: scaleX(1); }
.lp-js .lp-fill-y { transform: scaleY(0); transition: transform 1.4s cubic-bezier(.22,.61,.36,1); }
.lp-js .lp-fill-y.is-in { transform: scaleY(1); }
.lp-glow { pointer-events: none; filter: blur(34px); opacity: .9;
  background: radial-gradient(40% 35% at 20% 25%, rgba(255,56,92,.45), transparent 70%),
              radial-gradient(35% 30% at 80% 70%, rgba(0,166,153,.25), transparent 70%),
              radial-gradient(45% 40% at 55% 90%, rgba(252,100,45,.22), transparent 70%); }
@media (prefers-reduced-motion: reduce) { .lp-js [data-reveal], .lp-js .lp-fill, .lp-js .lp-fill-y { transition: none !important; opacity: 1; transform: none !important; filter: none !important; } }
`;
