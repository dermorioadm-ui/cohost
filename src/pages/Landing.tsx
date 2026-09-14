import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Marca, MarcaSimbolo } from "@/components/Marca";
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
 * Três decisões que sustentam a página:
 *
 *   1. UMA PERGUNTA NO TOPO, e não uma promessa. "Você deixaria um estranho
 *      entrar na sua casa?" é a dor; o produto é a resposta, três travas
 *      depois. Quem chega de anúncio já sabe o que é um Airbnb — não precisa
 *      de "gestão inteligente de hospedagem".
 *   2. QUEM RESPONDE É UMA PESSOA. O botão principal não diz "assinar", diz
 *      "falar agora", e diz quem atende. Num ticket de R$ 97 a objeção não é
 *      preço, é "isso funciona no meu prédio?" — e isso se resolve numa
 *      chamada de 15 minutos, não num FAQ.
 *   3. O PREÇO É COMPARADO, não escondido. R$ 97 ao lado dos R$ 800 da
 *      gestora, com a conta feita: R$ 8.630 por ano.
 *
 * O que a página lê do ambiente (todos opcionais, ver `.env.example`):
 * endpoint do formulário, número de WhatsApp, estado online/offline, vídeo da
 * prova e foto de quem responde. Sem nada disso ela roda inteira — só o
 * formulário passa a mandar o interessado criar a conta.
 */

const ENV = import.meta.env as Record<string, string | undefined>;
const LEAD_ENDPOINT = (ENV.VITE_LEAD_ENDPOINT ?? "").trim();
// O número pode vir do build (VITE_WHATSAPP) ou do banco (app_settings via
// landing_config), que é o caminho para trocar sem novo deploy.
const WHATSAPP_BUILD = (ENV.VITE_WHATSAPP ?? "").replace(/\D/g, "");
const ESTADO = (ENV.VITE_LP_ESTADO ?? "online") as "online" | "offline" | "auto";
const STATUS_URL = (ENV.VITE_LP_STATUS_URL ?? "").trim();
const VIDEO_PROVA = (ENV.VITE_LP_VIDEO_PROVA ?? "").trim();
const FOTO = (ENV.VITE_LP_FOTO ?? "").trim();

/** Números da seção "Prova": o apartamento de Niterói, de verdade. */
const PROVA = { reservas: 19, hospedes: 27, termos: 15, cadastros: 26 };

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
 * elemento entra 12% na tela ele ganha `is-in` e a CSS faz o resto. As barras
 * de progresso (`data-fill`) e os contadores (`data-count`) usam o mesmo
 * observador. Sem JS o conteúdo aparece igual — a classe `lp` só esconde o
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
      { threshold: 0.12 },
    );
    el.querySelectorAll("[data-reveal],[data-fill],[data-count]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root]);
}

function contar(el: HTMLElement, alvo: number) {
  const t0 = performance.now();
  const dur = 1100;
  const tick = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(alvo * e));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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

/** O botão-pílula branco com o ponto de status, usado quatro vezes na página. */
function BotaoFalar({
  on, label, onClick, escuro = false, className,
}: { on: boolean; label: string; onClick: () => void; escuro?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-14 w-full items-center justify-center gap-2.5 rounded-pill px-6 text-base tracking-corpo transition-[background-color,transform] duration-200 ease-page active:scale-[0.985]",
        escuro
          ? "border border-black bg-white text-black hover:bg-[#f0f0f0]"
          : "bg-white text-black hover:bg-[#f0f0f0]",
        className,
      )}
    >
      <Ponto on={on} />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function H2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      data-reveal="up"
      className={cn("text-[clamp(30px,8vw,44px)] font-normal leading-[1.02] tracking-[-0.027em] text-black [text-wrap:balance]", className)}
    >
      {children}
    </h2>
  );
}

function Numeral({ n, rotulo }: { n: number; rotulo: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-primary text-[14px] leading-none text-white tabular-nums">
        {n}
      </span>
      <span className="rotulo text-primary">{rotulo}</span>
    </div>
  );
}

/* Miniaturas das telas, desenhadas em CSS — a mesma linguagem do painel. */
function Linha({ w, h = 9 }: { w: string; h?: number }) {
  return <div className="rounded-[5px] bg-[#e6e6e6]" style={{ width: w, height: h }} />;
}

function MockTrava1() {
  return (
    <div className="w-[min(100%,300px)] space-y-3 rounded-[22px] bg-white p-4 shadow-[0_10px_40px_rgba(0,0,0,0.08)]">
      <div className="flex items-center gap-2">
        <MarcaSimbolo size={22} />
        <span className="text-[14px] font-medium tracking-titulo">Check-in</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {["ENTRADA", "SAÍDA"].map((r) => (
          <div key={r} className="rounded-xl border border-[#f0f0f0] px-3 py-2.5">
            <div className="text-[11px] tracking-[0.06em] text-muted-foreground">{r}</div>
            <div className="mt-2"><Linha w="70%" h={10} /></div>
          </div>
        ))}
      </div>
      <div className="rounded-[14px] border border-primary/35 bg-primary/10 px-3.5 py-3 text-[13px] leading-snug text-black">
        Essas datas não batem com nenhuma reserva confirmada.
      </div>
      <div className="flex h-11 items-center justify-center rounded-pill bg-[#f0f0f0] text-[14px] text-muted-foreground">
        Continuar
      </div>
    </div>
  );
}

function MockTrava2() {
  return (
    <div className="w-[min(100%,320px)] space-y-3 rounded-lg bg-white p-4 shadow-[0_10px_40px_rgba(0,0,0,0.10)]">
      <div className="flex items-center justify-between text-[11px] tracking-[0.08em] text-muted-foreground">
        <span>CONTRATO · PDF</span><span>1 / 1</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1.5">
          <div className="aspect-[3/4] rounded-md bg-gradient-to-b from-[#d9dbdf] to-[#bfc2c8]" />
          <span className="text-[11px] text-muted-foreground">Documento</span>
        </div>
        <div className="space-y-1.5">
          <div className="aspect-[3/4] rounded-md bg-gradient-to-b from-[#e2ddd6] to-[#c6bfb5]" />
          <span className="text-[11px] text-muted-foreground">Selfie</span>
        </div>
        <div className="space-y-1.5">
          <div className="flex aspect-[3/4] items-center justify-center rounded-md border border-[#e6e6e6] font-serif text-2xl italic text-black">
            R.
          </div>
          <span className="text-[11px] text-muted-foreground">Assinatura</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-[7px] w-[84%] rounded bg-[#ececec]" />
        <div className="h-[7px] w-[66%] rounded bg-[#ececec]" />
        <div className="h-[7px] w-[76%] rounded bg-[#ececec]" />
      </div>
      <div className="border-t border-[#f0f0f0] pt-2 text-[11px] tracking-[0.06em] text-muted-foreground">
        IP · HORA · NAVEGADOR
      </div>
    </div>
  );
}

function MockTrava3() {
  return (
    <div className="w-[min(100%,320px)] space-y-2.5 rounded-2xl bg-white p-4 shadow-[0_10px_40px_rgba(0,0,0,0.10)]">
      <div className="flex items-center gap-2.5 border-b border-[#f0f0f0] pb-2.5">
        <div className="h-7 w-7 shrink-0 rounded-full bg-primary" />
        <div className="min-w-0 space-y-1">
          <Linha w="120px" />
          <div className="text-[11px] tracking-[0.06em] text-muted-foreground">PARA: PORTARIA</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 text-[11px] tracking-[0.08em] text-muted-foreground">
        <span>NOME</span><span>DOCUMENTO</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5"><Linha w="78%" /><Linha w="62%" /></div>
      <div className="grid grid-cols-2 gap-2.5"><Linha w="66%" /><Linha w="62%" /></div>
      <div className="mt-0.5 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-success/30 bg-success/10 px-3 py-2.5">
          <div className="text-[11px] tracking-[0.06em] text-muted-foreground">ENTRADA</div>
          <div className="mt-0.5 text-xl font-medium tracking-titulo text-success">15h</div>
        </div>
        <div className="rounded-xl border border-[#f0f0f0] bg-surface px-3 py-2.5">
          <div className="text-[11px] tracking-[0.06em] text-muted-foreground">SAÍDA</div>
          <div className="mt-0.5 text-xl font-medium tracking-titulo text-black">11h</div>
        </div>
      </div>
    </div>
  );
}

const TRAVAS = [
  {
    titulo: "Só entra quem tem reserva.",
    texto:
      "O link de check-in confere as datas com a reserva do Airbnb, da Booking ou do VRBO. Data que não bate, não passa. Print antigo, link encaminhado, hóspede de outra vez: barrado.",
    Mock: MockTrava1,
  },
  {
    titulo: "Cada pessoa, documento na mão.",
    texto:
      "Até 16 pessoas por estadia. Cada uma: documento, selfie e assinatura de próprio punho. Vira um contrato em PDF com IP, hora e navegador. Chega no seu e-mail e no dele antes da chave. E muda o comportamento dele: o próprio rosto, o próprio documento e a própria assinatura estão no que ele acabou de assinar.",
    Mock: MockTrava2,
  },
  {
    titulo: "A portaria já sabe.",
    texto:
      "Você nunca mais cadastra um hóspede. Por e-mail ou por API, nas portarias digitais, o condomínio recebe nome, documento e horário a cada reserva. Ele entra às 15h do dia da chegada e para de entrar às 11h do checkout. Nada mais passa por você.",
    Mock: MockTrava3,
  },
];

const DORES = [
  "A portaria liga: “tem um hóspede aqui dizendo que tem reserva pra hoje, mas não tem acesso.” Você esqueceu de cadastrar.",
  "“Oi, qual a senha do wi-fi?” São 23h.",
  "A diarista diz que o sofá está manchado. Sem contrato, sem compromisso — e você não tem nome, documento nem assinatura pra cobrar de ninguém.",
  "Você não sabe se o AirCover vai te ressarcir. Dependendo da quebra, ficam dias com a reserva fechada pra reparo.",
];

const E_AINDA = [
  { rotulo: "CHECKOUT AUTOMÁTICO", titulo: "A limpeza tem o calendário dos seus apartamentos.", texto: "Ela sabe quem entra às 15h e quem sai às 11h, sem você avisar. Fecha o checkout com foto carimbada na hora." },
  { rotulo: "REPOSIÇÃO AUTOMÁTICA", titulo: "Você não se preocupa em repor o papel higiênico.", texto: "Taxa combinada por mês, gravada e aceita pela diarista no celular. Ela repõe, você aprova." },
  { rotulo: "IA 24 HORAS", titulo: "A IA atende o seu hóspede a qualquer hora.", texto: "Você alimenta com as informações do seu apartamento — senha do wi-fi, vaga, chuveiro — e ela responde na hora. Em português, inglês e espanhol." },
  { rotulo: "TRÊS CANAIS, UM CALENDÁRIO", titulo: null, texto: "Airbnb, Booking e VRBO no mesmo calendário, sincronizado a cada 30 minutos." },
];

const PERGUNTAS = [
  ["Meu prédio não tem portaria digital.", "A portaria recebe e-mail com nome, documento e horário a cada reserva. Com portaria digital, o acesso abre e fecha sozinho."],
  ["Tenho 2 apartamentos. Pago o dobro?", "Profissional: R$197 pros dois. R$98,50 cada. Uma gestora cobra R$800 por apartamento."],
  ["É reconhecimento facial?", "Não. Documento, selfie e assinatura na mesma folha, com IP e hora. É prova — e é o que vale numa discussão."],
  ["E o hóspede, quem responde?", "A IA do seu apartamento, no link que ele recebe no fim do cadastro. O que ela não sabe, chega pra você."],
  ["Quem faz a implementação?", "Eu, com você, numa chamada de 15 minutos. Você preenche a ficha, o sistema cadastra tudo. Calendário ligado no mesmo dia."],
  ["E se eu não gostar?", "30 dias. Devolvo tudo."],
];

/* -------------------------------------------------------------- página */

type Plano = (typeof PLANOS_RESERVA)[number];

const IMOVEIS_LABEL = (n: number | null) =>
  n === null ? "sem limite de imóveis" : n === 1 ? "1 imóvel" : n === 3 ? "2 ou 3 imóveis" : n === 5 ? "4 ou 5 imóveis" : `até ${n} imóveis`;

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
      pill: on ? "online agora" : "te ligo em até 1 hora",
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
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; };
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

  // O botão fixo no rodapé aparece depois que o herói (que já tem o botão) sai.
  const heroRef = useRef<HTMLElement>(null);
  const [fab, setFab] = useState(false);
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setFab(!e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

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
        <div className="flex items-center gap-1.5">
          <div className="flex h-10 items-center gap-2 whitespace-nowrap rounded-pill border border-[#f0f0f0] bg-white pl-3 pr-3.5 text-[13px] leading-none tracking-corpo">
            <Ponto on={on} />
            <span>{textos.pill}</span>
          </div>
          <Link
            to="/entrar"
            className="flex h-10 items-center rounded-pill bg-black px-4 text-[13px] leading-none tracking-corpo text-white transition-colors hover:bg-[#1a1a1a]"
          >
            Entrar
          </Link>
        </div>
      </nav>

      {/* ----------------------------------------------------------- herói */}
      <section ref={heroRef} className="relative overflow-hidden rounded-b-[28px] bg-black text-white">
        <div aria-hidden className="lp-glow absolute -left-[8%] -top-[8%] h-[116%] w-[116%]" />
        <div className="absolute inset-0 z-0">
          <div className="absolute inset-x-0 -top-[6%] bottom-0 overflow-hidden">
            <video
              src="/lp/hero.mp4"
              poster="/lp/hero-poster.png"
              autoPlay
              muted
              loop
              playsInline
              aria-hidden
              className="block h-full w-full object-cover"
            />
          </div>
          <div
            aria-hidden
            className="absolute inset-0"
            style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.45) 26%, rgba(0,0,0,0.88) 62%, #000 100%)" }}
          />
        </div>

        <div className="relative z-[1] mx-auto flex min-h-[100svh] max-w-[720px] flex-col justify-between gap-6 px-5 pb-14 pt-[84px]">
          <div data-reveal="fade" className="rotulo text-white/70">
            Check-in Blindado · para anfitrião de Airbnb, Booking e VRBO
          </div>

          <div className="flex flex-col gap-[18px]">
            <h1 className="flex flex-wrap gap-x-[0.22em] text-[clamp(36px,10.5vw,60px)] font-normal leading-[0.96] tracking-display text-white">
              {"Você deixaria um estranho entrar na sua casa?".split(" ").map((w, i) => (
                <span key={i} data-reveal="word" style={delay(120 + i * 70)} className="inline-block">
                  {w}
                </span>
              ))}
            </h1>
            <p data-reveal="up" style={delay(700)} className="max-w-[34ch] text-[17px] leading-[1.33] tracking-[-0.01em] text-white/60">
              O Airbnb te dá o primeiro nome e você reza pra não precisar do AirCover.
            </p>

            <div
              data-reveal="up"
              style={delay(820)}
              className="flex flex-col gap-3 rounded-3xl border border-white/[0.18] bg-white/[0.08] p-[18px] pt-5 backdrop-blur-md"
            >
              <p className="text-base leading-[1.43] tracking-corpo text-white [text-wrap:pretty]">
                Reserva confirmada, documento com foto, selfie e assinatura digital. Contrato vem
                antes da chave.
              </p>
              <BotaoFalar on={on} label={textos.btn} onClick={abrir} />
              <p className="text-center text-sm leading-normal tracking-titulo text-white/70">{textos.linha}</p>
            </div>

            <p data-reveal="up" style={delay(940)} className="rounded-2xl bg-primary px-4 py-3.5 text-[15px] leading-snug tracking-corpo text-white">
              Entra na chamada e sai com o Check-in Blindado ligado. 15 minutos, feito por mim.
            </p>

            <div data-reveal="up" style={delay(1060)} className="flex flex-wrap items-center justify-center gap-3.5">
              <span className="rotulo text-white/60">Sincroniza com</span>
              <div className="flex items-center gap-2.5">
                <img src="/lp/airbnb.svg" alt="Airbnb" className="h-[52px] w-[52px] rounded-[13px]" />
                <img src="/lp/booking.webp" alt="Booking.com" className="h-[52px] w-[52px] rounded-[13px]" />
                <img src="/lp/vrbo.webp" alt="Vrbo" className="h-[52px] w-[52px] rounded-[13px]" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-[720px] px-5">
        {/* --------------------------------------------------- três travas */}
        <section id="como-funciona" className="scroll-mt-20 pt-20">
          <H2>Check-in Blindado. Três travas antes da chave.</H2>
          <div data-reveal="fade" className="my-9 mb-6 grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[3px] overflow-hidden rounded bg-[#f0f0f0]">
                <div data-fill className="lp-fill h-full origin-left bg-primary" style={delay(i * 180)} />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-10">
            {TRAVAS.map((t, i) => (
              <article key={i} data-reveal="up" className="flex flex-col gap-4">
                <div className="flex min-h-[240px] items-center justify-center overflow-hidden rounded-card bg-[#f0f0f0] p-6 shadow-[0_27px_104px_rgba(0,0,0,0.12)]">
                  <t.Mock />
                </div>
                <div className="flex flex-col gap-2.5">
                  <Numeral n={i + 1} rotulo={`Trava ${i + 1}`} />
                  <h3 className="text-[clamp(20px,5vw,23px)] font-normal leading-[1.2] tracking-[-0.02em] text-black [text-wrap:balance]">
                    {t.titulo}
                  </h3>
                  <p className="text-base leading-[1.49] tracking-[-0.014em] text-muted-foreground [text-wrap:pretty]">{t.texto}</p>
                </div>
              </article>
            ))}
          </div>
          <p data-reveal="up" className="mt-10 text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black [text-wrap:balance]">
            Resposta simples pra um problema gigante. Ninguém entra sem reserva, sem documento e sem assinar.
          </p>
        </section>

        {/* -------------------------------------------------------- a cena */}
        <section className="pt-20">
          <div data-reveal="scale" className="paper-panel px-[22px] py-7">
            <H2 className="mb-7">Você sabe como é.</H2>
            <div className="relative flex flex-col gap-6 pl-[30px]">
              <div className="absolute bottom-1.5 left-0 top-1.5 w-[2px] overflow-hidden rounded bg-[#d9d9d9]">
                <div data-fill className="lp-fill-y absolute inset-0 origin-top bg-primary" />
              </div>
              {DORES.map((d, i) => (
                <p key={i} data-reveal="left" style={delay(i * 90)} className="text-lg leading-[1.33] tracking-[-0.01em] text-black">
                  <span className="mb-1.5 block text-sm leading-normal tracking-titulo text-primary">DOR {i + 1}</span>
                  {d}
                </p>
              ))}
            </div>
            <p data-reveal="up" className="mt-9 border-t border-[#d9d9d9] pt-6 text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black [text-wrap:balance]">
              Você não comprou um apartamento. Você comprou um emprego.
            </p>
          </div>
        </section>

        {/* --------------------------------------------------------- prova */}
        <section id="prova" className="scroll-mt-20 pt-20">
          <H2>Rodando no meu apartamento em Niterói.</H2>
          <div className="mt-7 grid grid-cols-2 gap-x-3.5 gap-y-6">
            {[
              [PROVA.reservas, "reservas"],
              [PROVA.hospedes, "hóspedes"],
              [PROVA.termos, "contratos assinados"],
              [PROVA.cadastros, "cadastros na portaria"],
            ].map(([n, r], i) => (
              <div key={r} data-reveal="up" style={delay(i * 80)} className="flex flex-col gap-2 border-t border-[#f0f0f0] pt-4">
                <div data-count={n} className="numero-grande text-[clamp(40px,12vw,60px)] text-black">
                  0
                </div>
                <div className="text-sm leading-normal tracking-titulo text-muted-foreground">{r}</div>
              </div>
            ))}
          </div>
          {VIDEO_PROVA && (
            <figure data-reveal="scale" className="mt-9 flex flex-col gap-2.5">
              <div className="relative max-h-[560px] overflow-hidden rounded-card bg-[#111] shadow-[0_27px_104px_rgba(0,0,0,0.12)]" style={{ aspectRatio: "9 / 16" }}>
                <video src={VIDEO_PROVA} autoPlay muted loop playsInline className="block h-full w-full object-cover" />
              </div>
              <figcaption className="text-sm leading-normal tracking-titulo text-muted-foreground">
                Alguém tenta se cadastrar com data errada. Recusado.
              </figcaption>
            </figure>
          )}
        </section>

        {/* ------------------------------------------------- quem responde */}
        <section id="quem-responde" className="scroll-mt-20 pt-20">
          <div data-reveal="up" className="paper-frame grid items-start gap-7 px-5 py-[22px] sm:grid-cols-2">
            <div className="overflow-hidden rounded-card bg-[#f0f0f0]" style={{ aspectRatio: "4 / 5" }}>
              {FOTO ? (
                <img src={FOTO} alt="Renato, anfitrião em Niterói" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <MarcaSimbolo size={56} />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-4">
              <p className="text-[clamp(22px,6vw,26px)] font-normal leading-[1.2] tracking-titulo text-black">
                Sou o Renato. Anfitrião em Niterói. Uso o HospedePay no meu próprio apartamento.
              </p>
              <p className="text-base leading-[1.49] tracking-[-0.014em] text-muted-foreground">
                Quem te atende sou eu. A implementação eu faço com você, numa chamada de 15 minutos.
                Seu calendário fica ligado no mesmo dia.
              </p>
              <BotaoFalar on={on} label={textos.btn} onClick={abrir} escuro />
              <p className="text-center text-sm leading-normal tracking-titulo text-muted-foreground">{textos.linha}</p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- e ainda */}
        <section id="e-ainda" className="scroll-mt-20 pt-20">
          <H2 className="mb-2">Você entra pelo check-in. Fica pelo resto.</H2>
          <div className="flex flex-col">
            {E_AINDA.map((a, i) => (
              <article key={a.rotulo} data-reveal="up" style={delay(i * 60)} className="flex flex-col gap-2.5 border-b border-[#f0f0f0] py-6">
                <Numeral n={i + 1} rotulo={a.rotulo} />
                {a.titulo && (
                  <h3 className="text-[clamp(20px,5vw,23px)] font-normal leading-[1.2] tracking-[-0.02em] text-black [text-wrap:balance]">
                    {a.titulo}
                  </h3>
                )}
                <p className="text-base leading-[1.49] tracking-[-0.014em] text-muted-foreground">{a.texto}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------- gestora × hospedepay */}
        <section id="comparacao" className="scroll-mt-20 pt-20">
          <h2 data-reveal="up" className="text-[clamp(28px,7.8vw,40px)] font-normal leading-[1.04] tracking-[-0.027em] text-black [text-wrap:balance]">
            O que uma gestora faz por R$800 por mês. O que o HospedePay faz por R$97.
          </h2>
          <div className="mt-7 grid items-stretch gap-3.5 sm:grid-cols-2">
            <article data-reveal="up" className="flex flex-col gap-4 rounded-card bg-white px-[18px] py-[22px] shadow-card">
              <h3 className="text-[clamp(20px,5vw,23px)] font-normal leading-[1.25] tracking-[-0.02em]">Gestora</h3>
              <div>
                <div className="rotulo">a partir de</div>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="numero-grande text-[40px] text-black">R$800</span>
                  <span className="text-sm tracking-titulo text-muted-foreground">por mês, por imóvel</span>
                </div>
                <div className="mt-1 text-sm tracking-titulo text-muted-foreground">R$9.600 por ano</div>
              </div>
              <ul className="flex flex-col">
                {["Responde o hóspede.", "Coordena a limpeza.", "Faz o check-in.", "Fala com a portaria."].map((l) => (
                  <li key={l} className="border-t border-[#f0f0f0] py-[11px] text-base leading-[1.49] tracking-[-0.014em]">{l}</li>
                ))}
              </ul>
            </article>
            <article data-reveal="up" style={delay(80)} className="flex flex-col gap-4 rounded-card bg-white px-[18px] py-[22px] shadow-card ring-1 ring-primary/35">
              <h3 className="flex items-center gap-2 text-[clamp(20px,5vw,23px)] font-normal leading-[1.25] tracking-[-0.02em]">
                <MarcaSimbolo size={22} /> HospedePay
              </h3>
              <div>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="numero-grande text-[40px] text-primary">R$97</span>
                  <span className="text-sm tracking-titulo text-muted-foreground">por mês</span>
                </div>
                <div className="mt-1 text-sm tracking-titulo text-muted-foreground">R$970 por ano</div>
              </div>
              <ul className="flex flex-col">
                {["Check-in blindado.", "Portaria avisada.", "Checkout da diarista.", "Reposição de insumos.", "Suporte 24h com IA.", "Três canais, um calendário."].map((l) => (
                  <li key={l} className="border-t border-[#f0f0f0] py-[11px] text-base leading-[1.49] tracking-[-0.014em]">{l}</li>
                ))}
              </ul>
            </article>
          </div>
          <article data-reveal="up" className="mt-3.5 rounded-card bg-[#f0f0f0] px-[18px] py-[22px]">
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <h3 className="text-[clamp(20px,5vw,23px)] font-normal leading-[1.25] tracking-[-0.02em]">O que sobra pra você</h3>
              <span className="text-sm tracking-titulo text-muted-foreground">nos dois casos.</span>
            </div>
            <ul className="mt-3 flex flex-col">
              {["Aprovar a reserva.", "Decidir o preço.", "Resolver o vazamento.", "Pagar a diarista."].map((l) => (
                <li key={l} className="border-t border-[#d9d9d9] py-[11px] text-base leading-[1.49] tracking-[-0.014em]">{l}</li>
              ))}
            </ul>
          </article>
          <p data-reveal="up" className="mt-9 text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black">
            O trabalho que sobra é o mesmo.
          </p>
          <p data-reveal="up" className="mt-2 text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black">
            A diferença é{" "}
            <span className="relative inline-block whitespace-nowrap text-primary">
              R$8.630
              <span data-reveal="line" style={delay(500)} className="absolute -bottom-0.5 left-0 h-[3px] w-full origin-left rounded bg-primary" />
            </span>{" "}
            por ano.
          </p>
        </section>

        {/* -------------------------------------------------------- planos */}
        <section id="planos" className="scroll-mt-20 pt-20">
          <H2>Escolha o plano. Eu ligo seu calendário hoje.</H2>
          <p data-reveal="up" style={delay(80)} className="mt-3 text-base leading-[1.49] tracking-[-0.014em] text-muted-foreground">
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
          <div className="mt-7 grid gap-3.5">
            {PLANOS.map((p, i) => (
              <article
                key={p.tier}
                id={p.tier}
                data-reveal="up"
                style={{ ...delay(i * 80), scrollMarginTop: 24 }}
                className={cn("flex flex-col gap-3.5 rounded-card bg-white px-6 py-7 shadow-card", p.tier === "pro" && "ring-1 ring-primary/35")}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[clamp(20px,5vw,23px)] font-normal leading-[1.25] tracking-[-0.02em]">{p.nome}</h3>
                  <span className="text-sm tracking-titulo text-muted-foreground">{p.imoveis}</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="numero-grande text-[44px] text-black">{brl(p.anual)}</span>
                  <span className="text-sm tracking-titulo text-muted-foreground">por ano</span>
                </div>
                <div className="text-sm tracking-titulo text-muted-foreground">10x de {brl(p.mensal)}</div>
                <button
                  type="button"
                  onClick={() => assinar(p.tier, "annual")}
                  disabled={abrindo !== null}
                  className="mt-2 flex h-14 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-base tracking-[-0.01em] text-white transition-[background-color,transform] duration-200 hover:bg-primary-hover active:scale-[0.985] disabled:opacity-60"
                >
                  {abrindo === `${p.tier}:annual` && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Assinar o {p.nome} anual
                </button>
                <button
                  type="button"
                  onClick={() => assinar(p.tier, "monthly")}
                  disabled={abrindo !== null}
                  className="text-center text-sm leading-normal tracking-titulo text-muted-foreground underline decoration-1 underline-offset-[3px] hover:text-black disabled:opacity-60"
                >
                  {abrindo === `${p.tier}:monthly` ? "Abrindo o pagamento…" : `Mensal: ${brl(p.mensal)}/mês`}
                </button>
              </article>
            ))}
          </div>
          <p data-reveal="up" className="mt-6 text-center">
            <button type="button" onClick={abrir} className="text-base tracking-corpo text-primary underline decoration-1 underline-offset-[3px] hover:text-primary-hover">
              Mais de 5 imóveis? Toca no botão que a conversa é outra.
            </button>
          </p>
        </section>

        {/* ------------------------------------------------------ garantia */}
        <section id="garantia" className="scroll-mt-20 pt-16">
          <div data-reveal="scale" className="paper-frame flex flex-col gap-6 px-5 py-6">
            <div className="flex flex-col gap-1.5">
              <p className="text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black">Garantia incondicional de 30 dias.</p>
              <p className="text-lg leading-[1.33] tracking-[-0.01em] text-black">Não gostou, devolvo. Sem asterisco.</p>
            </div>
            <div className="h-px bg-[#f0f0f0]" />
            <div className="flex flex-col gap-1.5">
              <p className="text-[clamp(23px,6.4vw,30px)] font-normal leading-[1.14] tracking-titulo text-black">Ativação em menos de 24 horas.</p>
              <p className="text-lg leading-[1.33] tracking-[-0.01em] text-black">Escolha o anual e eu resolvo o resto.</p>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- perguntas */}
        <section id="perguntas" className="scroll-mt-20 pb-16 pt-20">
          <H2 className="mb-2">Perguntas que todo mundo faz</H2>
          <div className="flex flex-col">
            {PERGUNTAS.map(([q, a]) => (
              <div key={q} data-reveal="up" className="flex flex-col gap-2 border-b border-[#f0f0f0] py-[26px]">
                <h3 className="text-[clamp(20px,5vw,23px)] font-normal leading-[1.25] tracking-[-0.02em] text-black">{q}</h3>
                <p className="text-base leading-[1.49] tracking-[-0.014em] text-muted-foreground">{a}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* ---------------------------------------------------------- fechamento */}
      <section className="relative overflow-hidden bg-black text-white">
        <div aria-hidden className="lp-glow absolute -left-[8%] -top-[8%] h-[116%] w-[116%] opacity-80" />
        <div className="relative z-[1] mx-auto flex max-w-[720px] flex-col gap-7 px-5 pb-[132px] pt-[72px]">
          <h2 data-reveal="up" className="text-[clamp(34px,10vw,56px)] font-normal leading-[0.96] tracking-display text-primary [text-wrap:balance]">
            Ninguém dorme no seu apartamento sem ter assinado.
          </h2>
          <div data-reveal="up" style={delay(120)} className="flex flex-col gap-3">
            <BotaoFalar on={on} label={textos.btn} onClick={abrir} />
            <p className="text-center text-sm leading-normal tracking-titulo text-white/70">{textos.linha}</p>
          </div>
          <footer className="mt-6 flex flex-col gap-3 border-t border-white/[0.14] pt-7">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs leading-relaxed tracking-[-0.02em] text-white/60">
              <Marca size={20} tom="tinta" />
              <span>·</span>
              <Link to="/entrar" className="hover:text-white">Entrar</Link>
              <span>·</span>
              <a href="#planos" className="hover:text-white">Planos</a>
              <span>·</span>
              <a href="#perguntas" className="hover:text-white">Perguntas</a>
            </div>
            <p className="text-xs leading-relaxed tracking-[-0.02em] text-white/60">
              Documentos e selfies dos hóspedes ficam guardados com criptografia e são apagados 180
              dias depois do checkout.
            </p>
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
        <BotaoFalar on={on} label={textos.btn} onClick={abrir} escuro className="mx-auto max-w-[720px]" />
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
.lp-js [data-reveal] { opacity: 0; transition: opacity .7s cubic-bezier(.22,.61,.36,1), transform .7s cubic-bezier(.22,.61,.36,1); }
.lp-js [data-reveal="up"], .lp-js [data-reveal="word"] { transform: translateY(16px); }
.lp-js [data-reveal="left"] { transform: translateX(-12px); }
.lp-js [data-reveal="scale"] { transform: scale(.98); }
.lp-js [data-reveal="line"] { transform: scaleX(0); opacity: 1; transition: transform .6s cubic-bezier(.22,.61,.36,1); }
.lp-js [data-reveal].is-in { opacity: 1; transform: none; }
.lp-js [data-reveal="line"].is-in { transform: scaleX(1); }
.lp-js .lp-fill { transform: scaleX(0); transition: transform .9s cubic-bezier(.22,.61,.36,1); }
.lp-js .lp-fill.is-in { transform: scaleX(1); }
.lp-js .lp-fill-y { transform: scaleY(0); transition: transform 1.4s cubic-bezier(.22,.61,.36,1); }
.lp-js .lp-fill-y.is-in { transform: scaleY(1); }
.lp-glow { pointer-events: none; filter: blur(34px); opacity: .9;
  background: radial-gradient(40% 35% at 20% 25%, rgba(255,56,92,.45), transparent 70%),
              radial-gradient(35% 30% at 80% 70%, rgba(0,166,153,.25), transparent 70%); }
@media (prefers-reduced-motion: reduce) { .lp-js [data-reveal], .lp-js .lp-fill, .lp-js .lp-fill-y { transition: none !important; opacity: 1; transform: none !important; } }
`;
