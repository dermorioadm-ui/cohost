import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Assinatura } from "@/components/Assinatura";
import { CapturaFacial } from "@/components/CapturaFacial";
import {
  AlertCircle, ArrowLeft, Building2, CalendarDays, Camera, Check, CheckCircle2,
  ChevronRight, Download, Loader2, MessageCircle, Plus, Send, Trash2, UserPlus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { guestApi, guestSession, supabase, type GuestInput } from "@/lib/api";
import { cn } from "@/lib/utils";
import { T, IDIOMAS, idiomaInicial, salvarIdioma, type Idioma } from "@/lib/guestI18n";
import { bandeira, paises, paisPorIso } from "@/lib/paises";
import { cpfValido, formatarCpf, passaporteValido, soDigitos } from "@/lib/documentos";
import { prepararImagem } from "@/lib/imagem";
import {
  TelefonePais, paraE164, telefoneCompleto, type ValorTelefone,
} from "@/components/TelefonePais";

/**
 * Página pública do hóspede. Duas portas na entrada:
 *   - fazer o cadastro (obrigatório, libera as instruções de acesso)
 *   - falar com o atendimento 24h
 *
 * A escolha é SEMPRE a entrada. Antes, quem já tinha se cadastrado era jogado
 * direto no chat — o token fica no localStorage porque a estadia dura dias e a
 * aba não. Parecia atalho, mas tirava do hóspede a única porta de volta: ele
 * não conseguia mais abrir o cadastro para incluir alguém que chegou depois, e
 * quem testava o link achava que a tela de escolha não existia.
 *
 * Agora o token só pré-carrega o chat. A escolha continua na frente, com o
 * primeiro botão mostrando que o cadastro já foi feito.
 */

type Mode = "choice" | "register" | "sucesso" | "chat";
type Msg = { role: "user" | "assistant"; content: string };



/** Um hóspede em edição. `telefone` fica separado porque o campo tem país. */
interface Rascunho extends GuestInput {
  telefone: ValorTelefone;
  estrangeiro: boolean;
  cpf: string;
  passaporte: string;
  nacionalidade: string;
  fotoNome: string;
  fotoDataUrl: string;
}

/**
 * Marca de campo obrigatório.
 *
 * O asterisco vai no rótulo e o `aria-hidden` o esconde do leitor de tela —
 * quem usa leitor recebe a obrigatoriedade pelo `required` do próprio campo,
 * e ouvir "asterisco" no meio de cada rótulo só atrapalha.
 */
const Obrigatorio = () => (
  <span aria-hidden className="ml-0.5 text-destructive">*</span>
);

const novoHospede = (): Rascunho => ({
  full_name: "",
  email: "",
  phone: "",
  telefone: { iso: "BR", numero: "" },
  estrangeiro: false,
  cpf: "",
  passaporte: "",
  nacionalidade: "",
  fotoNome: "",
  fotoDataUrl: "",
});

export default function GuestChat() {
  const { slug = "" } = useParams();
  const [mode, setMode] = useState<Mode>("choice");
  const [token, setToken] = useState<string | null>(null);
  const [propertyName, setPropertyName] = useState("");

  const [checkin, setCheckin] = useState("");
  const [checkout, setCheckout] = useState("");
  const [guests, setGuests] = useState<Rascunho[]>([novoHospede()]);
  const [idioma, setIdioma] = useState<Idioma>(idiomaInicial);
  const [fotoOcupada, setFotoOcupada] = useState<number | null>(null);
  /** 1 datas · 2 hóspedes · 3 termo. */
  const [passo, setPasso] = useState<1 | 2 | 3>(1);
  /**
   * O passo mais adiantado que já foi liberado.
   *
   * Existe para que voltar não custe caro: quem desce ao passo 1 para corrigir
   * uma data volta ao termo num toque, em vez de reatravessar o formulário
   * inteiro apertando "Continuar". Guardar o máximo, e não só o atual, é o que
   * separa "voltar" de "recomeçar".
   */
  const [maxPasso, setMaxPasso] = useState<1 | 2 | 3>(1);

  /** Todo texto da tela sai daqui. Trocar o idioma troca a tela inteira. */
  const t = T[idioma];
  const [term, setTerm] = useState(false);
  const [assinatura, setAssinatura] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<string | null>(null);
  /** URL assinada do PDF, devolvida pelo cadastro. Só vale por algumas horas. */
  const [termoUrl, setTermoUrl] = useState<string | null>(null);
  /** Texto integral do termo ATIVO, lido do banco. Ver `carregarTermo`. */
  const [termoCompleto, setTermoCompleto] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Recupera a sessão, mas NÃO pula a escolha: o token só evita pedir cadastro
  // de novo. Quem decide para onde ir continua sendo o hóspede.
  useEffect(() => {
    const saved = guestSession.get(slug);
    if (saved) setToken(saved);
  }, [slug]);

  /**
   * Abre o cadastro sempre pelo primeiro passo.
   *
   * Quem volta ao link para incluir mais alguém entraria no passo em que
   * parou — a tela de assinar, com tudo já preenchido —, e a primeira coisa
   * que veria seria o fim de um formulário que ela ainda não recomeçou.
   */
  function abrirCadastro() {
    setPasso(1);
    setMaxPasso(1);
    setError("");
    setMode("register");
  }

  /**
   * Nova leva de pessoas, mesma estadia.
   *
   * As datas ficam — é a mesma hospedagem, e repetir check-in e check-out é
   * pedir para alguém digitar diferente da primeira vez. O que zera é o que
   * pertence às pessoas e ao ato de assinar: cada leva assina o próprio termo,
   * com o próprio rosto. Reaproveitar a assinatura anterior produziria um
   * documento em que alguém se responsabiliza por quem ele não cadastrou.
   */
  function cadastrarMaisPessoas() {
    setGuests([novoHospede()]);
    setTerm(false);
    setAssinatura(null);
    setSelfie(null);
    setTermoUrl(null);
    abrirCadastro();
  }

  function abrirChat() {
    setMode("chat");
    setMessages((m) =>
      m.length ? m : [{ role: "assistant", content: `${t.hello}! ${t.helpYou}` }],
    );
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  /**
   * Texto integral do termo, lido da MESMA linha que o servidor vai copiar
   * para dentro do PDF.
   *
   * O resumo com as frases em negrito continua existindo — ninguém lê onze
   * cláusulas numa caixa de seleção. Mas o resumo mora no código do frontend e
   * o termo mora no banco, e toda vez que uma cláusula nova entrou, os dois
   * ficaram fora de sincronia até o próximo deploy. Quem assinasse no meio
   * marcaria um resumo sem a cláusula e assinaria um PDF com ela.
   *
   * Buscando o texto ativo aqui, o que a pessoa consegue abrir e ler é
   * literalmente o que ela vai assinar. A `term_versions` tem policy de
   * leitura pública para a versão ativa, então isto não abre nada novo.
   */
  useEffect(() => {
    let vivo = true;

    (async () => {
      const buscar = (locale: string) =>
        supabase
          .from("term_versions")
          .select("body")
          .eq("kind", "cadastro_hospede")
          .eq("locale", locale)
          .eq("active", true)
          .maybeSingle();

      // Mesma queda para português do servidor: melhor a pessoa ler no
      // tradutor do que não ter o que ler.
      let { data } = await buscar(idioma);
      if (!data && idioma !== "pt") ({ data } = await buscar("pt"));

      if (vivo) setTermoCompleto((data?.body as string | undefined) ?? "");
    })();

    return () => {
      vivo = false;
    };
  }, [idioma]);

  const today = new Date().toISOString().slice(0, 10);

  /** Lista de países no idioma da tela, para a nacionalidade. */
  const listaPaises = useMemo(() => paises(idioma), [idioma]);

  /** Altera um hóspede pelo índice, sem reescrever a lista à mão em cada campo. */
  const trocar = (i: number, patch: Partial<Rascunho>) =>
    setGuests((atual) => atual.map((g, j) => (j === i ? { ...g, ...patch } : g)));

  /**
   * Recebe a foto do documento e a reduz antes de guardar no estado.
   *
   * A redução acontece AQUI, e não no envio: se ficasse para o submit, a
   * pessoa descobriria que a imagem é grande demais depois de preencher a
   * ficha inteira — no pior momento possível.
   */
  const pegarFoto = async (i: number, arquivo: File) => {
    setFotoOcupada(i);
    setError("");
    try {
      const { dataUrl } = await prepararImagem(arquivo);
      trocar(i, { fotoDataUrl: dataUrl, fotoNome: arquivo.name });
    } catch {
      setError(`${t.guest} ${i + 1}: ${t.errPhoto}`);
    } finally {
      setFotoOcupada(null);
    }
  };

  /**
   * O que falta NESTE passo, ou null.
   *
   * A validação é fatiada de propósito. Numa página única, o erro do primeiro
   * campo só aparecia depois de a pessoa preencher tudo e apertar enviar — e
   * ela tinha que caçar, numa rolagem longa, qual dos vinte campos era. Aqui o
   * erro sempre está na tela em que ele nasceu.
   */
  const faltaNoPasso = (n: 1 | 2 | 3): string | null => {
    if (n === 1) {
      if (!checkin || !checkout) return t.errDates;
      if (checkout <= checkin) return t.errOrder;

      for (const [i, g] of guests.entries()) {
        const quem = `${t.guest} ${i + 1}`;
        if (g.full_name.trim().split(/\s+/).length < 2) return `${quem}: ${t.errName}`;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(g.email.trim())) return `${quem}: ${t.errEmail}`;
        if (!telefoneCompleto(g.telefone)) return `${quem}: ${t.errPhone}`;

        if (g.estrangeiro) {
          if (!g.nacionalidade) return `${quem}: ${t.errNationality}`;
          if (!passaporteValido(g.passaporte)) return `${quem}: ${t.errPassport}`;
        } else if (!cpfValido(g.cpf)) {
          return `${quem}: ${t.errCpf}`;
        }

        // A foto do documento passou a ser obrigatória. Sem ela, o termo
        // assinado prova que ALGUÉM assinou com aquele nome e aquele número —
        // e é exatamente essa a parte que se contesta depois.
        if (!g.fotoDataUrl) return `${quem}: ${t.photo}`;
      }
      return null;
    }

    if (n === 2) {
      if (!term) return t.errTerm;
      if (!assinatura) return t.signMissing;
      return null;
    }

    if (!selfie) return t.errFace;
    return null;
  };

  /** Entra num passo já liberado. O topo, porque o passo começa do começo. */
  const abrirPasso = (n: 1 | 2 | 3) => {
    setError("");
    setPasso(n);
    setMaxPasso((m) => (n > m ? n : m));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const avancar = () => {
    const falta = faltaNoPasso(passo);
    if (falta) return setError(falta);
    abrirPasso(passo === 3 ? 3 : ((passo + 1) as 1 | 2 | 3));
  };

  const voltar = () => {
    setError("");
    if (passo === 1) return setMode("choice");
    abrirPasso((passo - 1) as 1 | 2 | 3);
  };

  /**
   * Salto pelo indicador de passos.
   *
   * Para trás é sempre livre. Para a frente, revalida cada passo do caminho e
   * para no primeiro que ficou incompleto — senão o atalho levaria a pessoa a
   * uma tela que ela seria obrigada a abandonar no primeiro erro.
   */
  const irPara = (n: 1 | 2 | 3) => {
    if (n === passo) return;
    if (n > passo) {
      for (let k = passo; k < n; k++) {
        const falta = faltaNoPasso(k as 1 | 2 | 3);
        if (falta) {
          setPasso(k as 1 | 2 | 3);
          return setError(falta);
        }
      }
    }
    abrirPasso(n);
  };

  /** Data no formato curto do idioma da tela — só para o resumo. */
  const dataCurta = (iso: string) =>
    iso
      ? new Date(`${iso}T12:00:00`).toLocaleDateString(idioma, {
          day: "2-digit",
          month: "short",
        })
      : "—";

  /** Noites da estadia, para o resumo do cabeçalho. */
  const noites =
    checkin && checkout
      ? Math.max(
          0,
          Math.round(
            (new Date(`${checkout}T12:00:00`).getTime() -
              new Date(`${checkin}T12:00:00`).getTime()) /
              86_400_000,
          ),
        )
      : 0;

  const submitRegistration = async () => {
    setError("");

    // Revalida os TRÊS passos, e não só o último. A pessoa pode voltar e
    // esvaziar um campo do passo 1 depois de já ter passado por ele; confiar
    // em "já validei antes" deixaria esse caso escapar para o servidor.
    for (const n of [1, 2, 3] as const) {
      const falta = faltaNoPasso(n);
      if (falta) {
        setPasso(n);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return setError(falta);
      }
    }

    // O laço acima já garantiu que a assinatura existe, mas o compilador não
    // enxerga isso através da função de validação. Esta linha é o que faz o
    // tipo bater sem um `!` — e continua correta se a validação mudar.
    if (!assinatura) return setError(t.signMissing);

    setBusy(true);
    try {
      const res = await guestApi.register({
        property_slug: slug,
        checkin_date: checkin,
        checkout_date: checkout,
        guests: guests.map((g) => ({
          full_name: g.full_name.trim(),
          email: g.email.trim(),
          // O telefone sai daqui em E.164, com o DDI do país escolhido. É esse
          // formato que a portaria digital aceita — e a falta dele foi o que
          // fez a Kiper recusar cadastro lendo "+21" como código de país.
          phone: paraE164(g.telefone, idioma),
          // O DDI vai em separado: o comprimento do número não distingue
          // "+34 612345678" de um brasileiro com DDD, e a portaria recusa
          // número formatado com o país errado.
          phone_ddi: paisPorIso(g.telefone.iso, idioma)?.ddi ?? "",
          document_type: g.estrangeiro ? "passaporte" : "cpf",
          document_number: g.estrangeiro
            ? g.passaporte.trim().toUpperCase()
            : soDigitos(g.cpf),
          nationality: g.estrangeiro ? g.nacionalidade : "BR",
          document_photo: g.fotoDataUrl || undefined,
        })),
        term_accepted: true,
        assinatura,
        selfie: selfie ?? undefined,
        locale: idioma,
      });

      guestSession.set(slug, res.session_token);
      setToken(res.session_token);
      setPropertyName(res.property.name);
      setTermoUrl(res.termo_url);
      setMode("sucesso");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não consegui concluir o cadastro");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || !token) return;

    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setStreaming(true);

    try {
      await guestApi.chat(token, text, (chunk) => {
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = {
            role: "assistant",
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
      });
    } catch (e) {
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          role: "assistant",
          content: e instanceof Error ? e.message : "Não consegui responder agora.",
        };
        return next;
      });
    } finally {
      setStreaming(false);
    }
  };

  // ------------------------------------------------------------- escolha
  if (mode === "choice") {
    const jaCadastrou = Boolean(token);

    const portas = [
      {
        // Cadastro em cima: é ele que libera o acesso ao apartamento, e sem
        // ele o hóspede chega na porta sem código. A ordem não é estética.
        chave: "cadastro",
        Icone: jaCadastrou ? CheckCircle2 : UserPlus,
        cor: jaCadastrou ? "text-success" : "text-primary",
        fundo: jaCadastrou ? "bg-success/10" : "bg-primary/10",
        titulo: jaCadastrou ? t.registerDone : t.register,
        apoio: jaCadastrou ? t.requiredDone : t.required,
        ir: abrirCadastro,
      },
      {
        chave: "chat",
        Icone: MessageCircle,
        cor: "text-primary",
        fundo: "bg-primary/10",
        titulo: t.support,
        apoio: t.supportHint,
        ir: abrirChat,
      },
    ];

    return (
      <div className="mesh-gradient min-h-screen">
        <div className="mesh-blob-3 animate-blob" aria-hidden />

        <div className="mx-auto w-full max-w-sm px-4 pb-12 pt-10">
          <header className="text-center">
            <span className="glass-accent inline-flex h-14 w-14 items-center justify-center rounded-2xl">
              <Building2 className="h-6 w-6 text-primary-foreground" aria-hidden />
            </span>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{t.welcome}</h1>
            {propertyName && (
              <p className="mt-1 text-sm font-semibold text-primary">{propertyName}</p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">{t.how}</p>
          </header>

          {/* Idioma ACIMA dos botões, e não escondido num menu.
              O hóspede estrangeiro é o caso normal num apartamento de
              temporada. Se ele precisa achar um seletor para entender os dois
              botões, o seletor chegou tarde demais — e ele já desistiu ou
              apertou o botão errado. */}
          <div
            role="group"
            aria-label="Idioma / Language / Idioma"
            className="mt-6 flex items-center justify-center gap-2"
          >
            {IDIOMAS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  setIdioma(l.id);
                  salvarIdioma(l.id);
                }}
                aria-pressed={idioma === l.id}
                className={cn(
                  "inline-flex min-h-[44px] items-center gap-2 rounded-full border px-3.5 text-sm transition-colors",
                  idioma === l.id
                    ? "border-primary/50 bg-primary/15 font-semibold text-primary"
                    : "border-white/[0.08] text-muted-foreground hover:bg-white/[0.04]",
                )}
              >
                <span className="text-lg leading-none">{bandeira(l.iso)}</span>
                <span className="text-xs">{l.nome}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {portas.map(({ chave, Icone, cor, fundo, titulo, apoio, ir }) => (
              <button
                key={chave}
                onClick={ir}
                className="glass-card w-full rounded-2xl p-5 text-left"
              >
                <div className="flex items-center gap-4">
                  <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", fundo)}>
                    <Icone className={cn("h-5 w-5", cor)} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-tight">{titulo}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{apoio}</p>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- cadastro
  if (mode === "register") {
    const etapas: Array<{ n: 1 | 2 | 3; rotulo: string }> = [
      // As datas ficam junto dos nomes: são dois campos, e uma tela só para
      // eles fazia a pessoa apertar "Continuar" para preencher o que caberia
      // acima do primeiro hóspede. O rosto ganhou a tela que as datas
      // devolveram — ele abre a câmera, e câmera dividindo espaço com um
      // formulário longo é câmera que fica fora do campo de visão.
      { n: 1, rotulo: t.stepStay },
      { n: 2, rotulo: t.stepTerm },
      { n: 3, rotulo: t.stepFace },
    ];

    return (
      <div className="mesh-gradient flex min-h-screen flex-col">
        <div className="mesh-blob-3 animate-blob" aria-hidden />

        {/* O cabeçalho fica fixo porque é ele que responde "onde eu estou e
            quanto falta". Rolando junto com o formulário, a resposta some
            exatamente no trecho longo em que a pergunta aparece. */}
        <header className="glass-nav sticky top-0 z-20 border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-md px-4 pb-2 pt-3">
            <div className="flex items-center gap-2">
              {/* Sem esta volta, a escolha vira porta de mão única: o hóspede
                  que entra no cadastro por engano fica preso e recarrega. */}
              <button
                type="button"
                onClick={voltar}
                aria-label={t.back}
                className="-ml-2 rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <h1 className="min-w-0 flex-1 truncate text-sm font-bold">{t.register}</h1>
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                {t.stepOf(passo, 3)}
              </span>
            </div>

            <nav aria-label={t.stepOf(passo, 3)} className="mt-1">
              <ol className="flex items-stretch">
                {etapas.map(({ n, rotulo }) => {
                  const feito = n < passo;
                  const atual = n === passo;
                  return (
                    <li key={n} className="min-w-0 flex-1">
                      <button
                        type="button"
                        // Só passo já visitado é clicável. Pular para a frente
                        // sem preencher o que veio antes leva a pessoa a uma
                        // tela que ela vai ter de abandonar no primeiro erro.
                        disabled={n > maxPasso}
                        onClick={() => irPara(n)}
                        aria-current={atual ? "step" : undefined}
                        className="flex min-h-[44px] w-full items-center gap-1.5 px-1 disabled:cursor-default"
                      >
                        <span
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors",
                            feito
                              ? "bg-success/20 text-success"
                              : atual
                                ? "bg-primary text-primary-foreground"
                                : "bg-white/[0.06] text-muted-foreground",
                          )}
                        >
                          {feito ? <Check className="h-3 w-3" aria-hidden /> : n}
                        </span>
                        <span
                          className={cn(
                            "truncate text-[11px] font-medium",
                            atual ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {rotulo}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              <div className="flex gap-1 pb-1" aria-hidden>
                {etapas.map(({ n }) => (
                  <span
                    key={n}
                    className={cn(
                      "h-1 flex-1 rounded-full transition-colors",
                      n <= passo ? "bg-primary" : "bg-white/[0.08]",
                    )}
                  />
                ))}
              </div>
            </nav>
          </div>
        </header>

        {/* O padding de baixo abre espaço para a barra fixa do rodapé: sem
            ele, o último campo nasce embaixo do botão que o envia. */}
        <main className="mx-auto w-full max-w-md flex-1 space-y-4 px-4 pb-36 pt-5">
          {/* Dito uma vez, no topo. Repetir "obrigatório" em cada campo
              transforma a marca em ruído, e a pessoa deixa de enxergá-la. */}
          <p className="text-xs text-muted-foreground">
            <span aria-hidden className="text-destructive">*</span> {t.requiredHint}
          </p>

          {passo === 1 && (
            <section className="glass-card space-y-4 rounded-2xl p-4">
              <div>
                <p className="text-sm font-semibold">{t.dates}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t.required}</p>
              </div>

              {/* `min-w-0` na célula, e não só `w-full` no campo.
                  Célula de grid não encolhe abaixo do conteúdo, e o campo de
                  data nativo do iPhone tem largura intrínseca maior que metade
                  da tela: sem isto os dois campos empurram a coluna, encostam
                  um no outro e vazam para fora do cartão. */}
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    {
                      chave: "checkin" as const,
                      rotulo: t.checkin,
                      valor: checkin,
                      minimo: today,
                      set: setCheckin,
                    },
                    {
                      chave: "checkout" as const,
                      rotulo: t.checkout,
                      valor: checkout,
                      minimo: checkin || today,
                      set: setCheckout,
                    },
                  ]
                ).map(({ chave, rotulo, valor, minimo, set }) => (
                  <div key={chave} className="min-w-0 space-y-1.5">
                    <Label htmlFor={chave} className="text-xs">
                      {rotulo}
                      <Obrigatorio />
                    </Label>

                    <div className="relative min-w-0">
                      <Input
                        id={chave}
                        type="date"
                        min={minimo}
                        value={valor}
                        onChange={(e) => set(e.target.value)}
                        className="min-h-[44px] w-full min-w-0"
                      />

                      {/* O campo de data vazio não desenha nada no Safari do
                          iPhone — fica uma caixa em branco, e a pessoa não
                          sabe que aquilo se toca. A tampa cobre também o
                          "dd/mm/aaaa" que o Android desenha, para o convite
                          ser o mesmo nos dois. `pointer-events-none` deixa o
                          toque passar direto para o campo. */}
                      {!valor && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-y-px left-px flex items-center gap-1.5 rounded-l-md bg-background pl-3 pr-2 text-sm text-muted-foreground"
                        >
                          <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                          {t.datePick}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* A conta aparece assim que as duas datas existem. Ver "3
                  noites" na hora é como a pessoa percebe que digitou o mês
                  errado — antes de descobrir isso na portaria. */}
              {noites > 0 && (
                <p className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-muted-foreground">
                  <CalendarDays className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                  {t.nights(noites)}
                </p>
              )}
            </section>
          )}

          {passo === 1 && (
            <>
              {guests.map((g, i) => (
                <section key={i} className="glass-card space-y-3 rounded-2xl p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">
                      {t.guest} {i + 1}
                      {i === 0 && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {" "}· {t.responsible}
                        </span>
                      )}
                    </p>
                    {i > 0 && (
                      <button
                        type="button"
                        onClick={() => setGuests(guests.filter((_, j) => j !== i))}
                        className="-mr-2 rounded-full p-2 text-muted-foreground transition-colors hover:text-destructive"
                        aria-label={`${t.removeGuest} ${i + 1}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Nome e e-mail */}
                  {(["full_name", "email"] as const).map((field) => (
                    <div key={field} className="space-y-1.5">
                      <Label className="text-xs">
                        {field === "full_name" ? t.name : t.email}
                        <Obrigatorio />
                      </Label>
                      <Input
                        value={g[field] ?? ""}
                        onChange={(e) =>
                          trocar(i, { [field]: e.target.value } as Partial<Rascunho>)
                        }
                        type={field === "email" ? "email" : "text"}
                        autoComplete={field === "full_name" ? "name" : "email"}
                        className="min-h-[44px]"
                      />
                    </div>
                  ))}

                  {/* Telefone com país. O DDI explícito é o que a portaria exige. */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t.phone}<Obrigatorio /></Label>
                    <TelefonePais
                      valor={g.telefone}
                      onChange={(v) => trocar(i, { telefone: v })}
                      locale={idioma}
                      rotuloBusca={t.phoneSearch}
                    />
                  </div>

                  {/* ------------------------------------------------ documento */}
                  <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs font-semibold">{t.docTitle}<Obrigatorio /></Label>
                      {/* O "sou estrangeiro" fica AO LADO do campo, e não numa
                          tela antes: quem tem CPF nunca precisa pensar nele, e
                          quem não tem descobre a saída no momento em que trava. */}
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={g.estrangeiro}
                          onCheckedChange={(v) =>
                            trocar(i, { estrangeiro: Boolean(v), cpf: "", passaporte: "" })
                          }
                        />
                        {t.foreign}
                      </label>
                    </div>

                    {!g.estrangeiro ? (
                      <div className="space-y-1.5">
                        <Input
                          value={g.cpf}
                          onChange={(e) => trocar(i, { cpf: formatarCpf(e.target.value) })}
                          inputMode="numeric"
                          placeholder="000.000.000-00"
                          aria-label={t.cpf}
                          className={cn(
                            "min-h-[44px]",
                            g.cpf.length === 14 && !cpfValido(g.cpf) && "border-destructive",
                          )}
                        />
                        {/* O aviso só aparece quando o campo está cheio: avisar
                            a cada dígito é acusar a pessoa de errar enquanto
                            ainda está digitando. */}
                        {g.cpf.length === 14 && !cpfValido(g.cpf) && (
                          <p className="text-xs text-destructive">{t.errCpf}</p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs">{t.nationality}<Obrigatorio /></Label>
                          <select
                            value={g.nacionalidade}
                            onChange={(e) => trocar(i, { nacionalidade: e.target.value })}
                            className="min-h-[44px] w-full rounded-lg border border-input bg-background px-3 text-sm"
                          >
                            <option value="">{t.nationalityPick}</option>
                            {listaPaises.map((p) => (
                              <option key={p.iso} value={p.iso}>
                                {p.bandeira} {p.nome}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">{t.passport}<Obrigatorio /></Label>
                          <Input
                            value={g.passaporte}
                            onChange={(e) =>
                              trocar(i, { passaporte: e.target.value.toUpperCase().slice(0, 12) })
                            }
                            autoCapitalize="characters"
                            spellCheck={false}
                            className="min-h-[44px]"
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">{t.foreignHint}</p>
                      </div>
                    )}

                    {/* Foto do documento — obrigatória, e com peso de campo
                        obrigatório. Antes eram dois retângulos tracejados,
                        cinza sobre cinza, do tamanho de uma legenda: quem
                        olhava a tela lia aquilo como enfeite e passava direto.

                        E eram DOIS por precaução mal calibrada. O seletor
                        genérico do sistema já traz a câmera junto: no iPhone
                        ele abre "Fototeca / Tirar Foto / Escolher Ficheiro", e
                        no Android o seletor de `image/*` lista a câmera entre
                        as origens. O segundo botão só fazia falta porque o
                        `accept` misturava PDF, e o Android com `accept`
                        misturado manda direto para o gerenciador de arquivos —
                        sem câmera. Tirado o PDF, um botão faz o trabalho dos
                        dois. */}
                    <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
                      <Label className="text-xs">{t.photo}<Obrigatorio /></Label>

                      {g.fotoDataUrl && fotoOcupada !== i ? (
                        <div className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/[0.07] p-2.5">
                          {/* A miniatura, e não só o nome do arquivo: é ela que
                              deixa a pessoa ver que fotografou o documento
                              certo, e não a mesa embaixo dele. */}
                          <img
                            src={g.fotoDataUrl}
                            alt=""
                            className="h-12 w-12 shrink-0 rounded-lg object-cover"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-sm font-medium text-success">
                              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              {t.photoDone}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{g.fotoNome}</p>
                          </div>
                          <label className="shrink-0 cursor-pointer rounded-lg px-2.5 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10">
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) pegarFoto(i, f);
                                e.target.value = "";
                              }}
                            />
                            {t.photoRemove}
                          </label>
                        </div>
                      ) : fotoOcupada === i ? (
                        <div className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-input text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          {t.photoSending}
                        </div>
                      ) : (
                        <label className="flex min-h-[56px] w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-transform active:scale-[0.98]">
                          <input
                            type="file"
                            // Sem `capture` e sem PDF: é esta combinação que
                            // faz os dois sistemas oferecerem câmera E galeria
                            // na mesma folha.
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) pegarFoto(i, f);
                              e.target.value = "";
                            }}
                          />
                          <Camera className="h-4 w-4 shrink-0" aria-hidden />
                          {t.photoOpen}
                        </label>
                      )}

                      <p className="text-xs text-muted-foreground">{t.photoHint}</p>
                    </div>
                  </div>
                </section>
              ))}

              <Button
                variant="outline"
                className="min-h-[44px] w-full"
                onClick={() => setGuests([...guests, novoHospede()])}
              >
                <Plus className="mr-1 h-4 w-4" /> {t.add}
              </Button>
            </>
          )}

          {passo === 2 && (
            <>
              {/* O resumo existe porque este é o passo em que a pessoa ASSINA.
                  Assinar sem ver o que está assinando é o que transforma um
                  termo em papel sem valor — e o erro de data descoberto aqui
                  custa um clique, não uma discussão na portaria. */}
              <section className="glass-card space-y-3 rounded-2xl p-4">
                {/* Os dois voltam para o mesmo passo: datas e hóspedes
                    agora moram na mesma tela. */}
                {[
                  {
                    chave: "datas",
                    rotulo: t.dates,
                    Icone: CalendarDays,
                    principal: `${dataCurta(checkin)} → ${dataCurta(checkout)}`,
                    apoio: t.nights(noites),
                  },
                  {
                    chave: "hospedes",
                    rotulo: t.guests,
                    Icone: UserPlus,
                    principal: t.reviewCount(guests.length),
                    apoio: guests.map((g) => g.full_name.trim()).filter(Boolean).join(" · "),
                  },
                ].map(({ chave, rotulo, Icone, principal, apoio }) => (
                  <div key={chave} className="flex items-start gap-3">
                    <Icone className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {rotulo}
                      </p>
                      <p className="text-sm font-medium">{principal}</p>
                      {apoio && (
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">{apoio}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => irPara(1)}
                      className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                    >
                      {t.edit}
                    </button>
                  </div>
                ))}
              </section>

              <section className="glass-card space-y-4 rounded-2xl p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    checked={term}
                    onCheckedChange={(v) => setTerm(Boolean(v))}
                    className="mt-0.5"
                  />
                  <span
                    className="text-xs leading-relaxed text-muted-foreground"
                    dangerouslySetInnerHTML={{ __html: t.termText }}
                  />
                </label>

                {/* O texto integral, atrás de um toque.
                    `<details>` e não um estado: o navegador já sabe abrir e
                    fechar isto, e o leitor de tela já sabe anunciar. E fora do
                    `<label>` de propósito — dentro dele, abrir o texto marcaria
                    a caixa de aceite, que é o oposto do que se quer aqui. */}
                {termoCompleto && (
                  <details className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
                    <summary className="flex min-h-[44px] cursor-pointer list-none items-center px-3 text-xs font-semibold text-primary">
                      {t.termFull}
                    </summary>
                    <div className="max-h-64 overflow-y-auto border-t border-white/[0.06] px-3 py-3">
                      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                        {termoCompleto}
                      </p>
                    </div>
                  </details>
                )}

                {/* A assinatura só aparece depois do aceite. Mostrar o quadro
                    de assinar acima da caixa que a pessoa ainda não marcou é
                    pedir que ela assine algo que ainda não disse ter lido. */}
                {term && (
                  <div className="border-t border-white/[0.06] pt-4">
                    <Assinatura onChange={setAssinatura} rotulo={t.signTitle} obrigatorio />
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {t.signHint}
                    </p>
                  </div>
                )}
              </section>
            </>
          )}

          {/* A confirmação facial vem DEPOIS da assinatura, e numa tela só
              dela. Pedir o rosto antes seria pedir o rosto de quem ainda não
              se comprometeu com nada — é o vínculo entre o rosto e o traço que
              dá valor aos dois. E a câmera precisa da tela inteira: dividindo
              espaço com o fim de um formulário longo, ela nasce fora do campo
              de visão de quem vai se enquadrar nela. */}
          {passo === 3 && (
            <section className="glass-card rounded-2xl p-4">
              <CapturaFacial onChange={setSelfie} textos={t.face} obrigatorio />
            </section>
          )}

          {/* `role="alert"` porque o erro nasce depois de um toque no botão:
              quem usa leitor de tela precisa ouvir o que travou sem ter de
              varrer a página atrás da mensagem nova. */}
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </p>
          )}
        </main>

        {/* A ação principal mora numa barra fixa: no passo dos hóspedes a
            página cresce a cada pessoa adicionada, e um botão no fim do
            documento vira um botão que ninguém encontra. */}
        <footer className="glass-nav safe-area-bottom sticky bottom-0 z-20">
          <div className="mx-auto flex w-full max-w-md items-center gap-3 px-4 py-3">
            <Button
              variant="ghost"
              onClick={voltar}
              disabled={busy}
              className="min-h-[48px] shrink-0 px-3 text-muted-foreground"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              {t.back}
            </Button>

            {passo < 3 ? (
              <Button onClick={avancar} className="min-h-[48px] flex-1 font-semibold">
                {t.next}
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={submitRegistration}
                disabled={busy}
                className="min-h-[48px] flex-1 font-semibold"
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t.sending}
                  </>
                ) : (
                  t.submit
                )}
              </Button>
            )}
          </div>
        </footer>
      </div>
    );
  }

  // ------------------------------------------------------------- conclusão
  if (mode === "sucesso") {
    return (
      <div className="mesh-gradient flex min-h-screen flex-col">
        <div className="mesh-blob-3 animate-blob" aria-hidden />

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
          <div className="text-center">
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-8 w-8 text-success" aria-hidden />
            </span>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{t.okTitle}</h1>
            {propertyName && (
              <p className="mt-1 text-sm font-semibold text-primary">{propertyName}</p>
            )}
            <p className="mx-auto mt-2 max-w-[19rem] text-sm leading-relaxed text-muted-foreground">
              {t.okText}
            </p>
          </div>

          <div className="mt-7 space-y-3">
            {/* O download some quando o termo não pôde ser gerado. Botão que
                promete um arquivo inexistente é pior que botão nenhum: a
                pessoa toca, não acontece nada, e passa a duvidar do resto da
                tela — inclusive do "cadastro concluído". */}
            {termoUrl && (
              <Button asChild className="min-h-[52px] w-full text-base font-semibold">
                {/* `download` e `rel` num link comum, e não `window.open` num
                    handler: o bloqueador de pop-up do celular mata a segunda
                    forma sem avisar ninguém. */}
                <a href={termoUrl} download rel="noopener">
                  <Download className="mr-2 h-4 w-4" aria-hidden />
                  {t.okDownload}
                </a>
              </Button>
            )}

            <Button
              variant="outline"
              onClick={cadastrarMaisPessoas}
              className="min-h-[52px] w-full text-base font-semibold"
            >
              <UserPlus className="mr-2 h-4 w-4" aria-hidden />
              {t.okMore}
            </Button>
          </div>

          {/* Separado dos dois de cima, e mais leve: as ações do documento
              terminam o assunto do cadastro; falar com o anfitrião abre outro. */}
          <button
            onClick={abrirChat}
            className="glass-card mt-6 w-full rounded-2xl p-4 text-left"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <MessageCircle className="h-4 w-4 text-primary" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t.okAsk}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t.supportHint}</p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            </div>
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- chat
  return (
    <div className="mesh-gradient flex min-h-screen flex-col">
      <div className="mesh-blob-3 animate-blob" aria-hidden />

      <header className="glass-nav sticky top-0 z-20 flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <button
          type="button"
          onClick={() => setMode("choice")}
          aria-label={t.back}
          className="-ml-2 rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <MessageCircle className="h-4 w-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{propertyName || t.assistant}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-success">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
            <span className="truncate">{t.supportHint}</span>
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                m.role === "user"
                  ? "rounded-br-md bg-primary text-primary-foreground"
                  : "glass-card rounded-bl-md",
              )}
            >
              {m.role === "assistant" ? (
                m.content ? (
                  <div className="prose prose-sm prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </main>

      <footer className="glass-nav safe-area-bottom sticky bottom-0 px-3 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="mx-auto flex max-w-2xl gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.placeholder}
            disabled={streaming}
            className="h-12 rounded-full"
          />
          <Button
            type="submit"
            size="icon"
            disabled={streaming || !input.trim()}
            className="h-12 w-12 shrink-0 rounded-full"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </footer>
    </div>
  );
}
