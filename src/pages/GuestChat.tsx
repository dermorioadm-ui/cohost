import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Assinatura } from "@/components/Assinatura";
import {
  ArrowLeft, Building2, Camera, Check, CheckCircle2, ChevronRight,
  Image as ImageIcon, Loader2, MessageCircle, Plus, Send, Trash2, UserPlus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { guestApi, guestSession, type GuestInput } from "@/lib/api";
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

type Mode = "choice" | "register" | "chat";
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

  /** Todo texto da tela sai daqui. Trocar o idioma troca a tela inteira. */
  const t = T[idioma];
  const [term, setTerm] = useState(false);
  const [assinatura, setAssinatura] = useState<string | null>(null);
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

  function abrirChat() {
    setMode("chat");
    setMessages((m) =>
      m.length ? m : [{ role: "assistant", content: `${t.hello}! ${t.helpYou}` }],
    );
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

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

  const submitRegistration = async () => {
    setError("");

    if (!checkin || !checkout) return setError(t.errDates);
    if (checkout <= checkin) return setError(t.errOrder);
    if (!term) return setError(t.errTerm);
    if (!assinatura) return setError(t.signMissing);

    for (const [i, g] of guests.entries()) {
      const quem = `${t.guest} ${i + 1}`;
      if (g.full_name.trim().split(/\s+/).length < 2) return setError(`${quem}: ${t.errName}`);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(g.email.trim()))
        return setError(`${quem}: ${t.errEmail}`);
      if (!telefoneCompleto(g.telefone)) return setError(`${quem}: ${t.errPhone}`);

      // O documento é o que dá validade ao termo assinado. Sem ele, a
      // assinatura identifica um nome — e nome não é identificação.
      if (g.estrangeiro) {
        if (!g.nacionalidade) return setError(`${quem}: ${t.errNationality}`);
        if (!passaporteValido(g.passaporte)) return setError(`${quem}: ${t.errPassport}`);
      } else if (!cpfValido(g.cpf)) {
        return setError(`${quem}: ${t.errCpf}`);
      }
    }

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
        locale: idioma,
      });

      guestSession.set(slug, res.session_token);
      setToken(res.session_token);
      setPropertyName(res.property.name);
      setMode("chat");
      setMessages([
        { role: "assistant", content: `${t.done}\n\n${t.helpYou}` },
      ]);
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

    return (
      <div className="min-h-screen flex flex-col bg-muted/30">
        <div className="bg-primary text-primary-foreground px-6 py-10 text-center">
          <Building2 className="h-9 w-9 mx-auto opacity-90" />
          <h1 className="mt-3 text-xl font-bold">{t.welcome}</h1>
          {propertyName && <p className="mt-1 text-sm font-medium opacity-90">{propertyName}</p>}
          <p className="mt-1 text-sm opacity-80">{t.how}</p>
        </div>

        <div className="flex-1 px-4 py-6 max-w-sm mx-auto w-full space-y-3">
          {/* Idioma ACIMA dos botões, e não escondido num menu.
              O hóspede estrangeiro é o caso normal num apartamento de
              temporada. Se ele precisa achar um seletor para entender os dois
              botões, o seletor chegou tarde demais — e ele já desistiu ou
              apertou o botão errado. */}
          <div
            role="group"
            aria-label="Idioma / Language / Idioma"
            className="flex items-center justify-center gap-2 pb-1"
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
                    ? "border-primary bg-primary/10 font-semibold text-primary"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                <span className="text-lg leading-none">{bandeira(l.iso)}</span>
                <span className="text-xs">{l.nome}</span>
              </button>
            ))}
          </div>

          {/* Cadastro em cima: é ele que libera o acesso ao apartamento, e sem
              ele o hóspede chega na porta sem código. A ordem não é estética. */}
          <button
            onClick={() => setMode("register")}
            className="w-full rounded-2xl border bg-background p-5 text-left transition-colors hover:border-primary"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {jaCadastrou ? (
                  <CheckCircle2 className="h-5 w-5 text-success" />
                ) : (
                  <UserPlus className="h-5 w-5 text-primary" />
                )}
                <p className="mt-3 font-semibold">
                  {jaCadastrou ? t.registerDone : t.register}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {jaCadastrou ? t.requiredDone : t.required}
                </p>
              </div>
              <ChevronRight className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
          </button>

          <button
            onClick={abrirChat}
            className="w-full rounded-2xl border bg-background p-5 text-left transition-colors hover:border-primary"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <MessageCircle className="h-5 w-5 text-primary" />
                <p className="mt-3 font-semibold">{t.support}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.supportHint}</p>
              </div>
              <ChevronRight className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- cadastro
  if (mode === "register") {
    return (
      <div className="min-h-screen bg-muted/30 pb-10">
        {/* Sem esta volta, a escolha vira porta de mão única: o hóspede que
            entra no cadastro por engano fica preso e recarrega a página. */}
        <div className="bg-primary text-primary-foreground px-5 py-6">
          <button
            type="button"
            onClick={() => setMode("choice")}
            className="mb-3 flex items-center gap-1.5 text-xs opacity-80 hover:opacity-100"
          >
            <ArrowLeft className="h-4 w-4" />
            {t.back}
          </button>
          <h1 className="text-lg font-bold">{t.register}</h1>
          <p className="text-sm opacity-80 mt-0.5">{t.required}</p>
        </div>

        <div className="max-w-sm mx-auto px-4 pt-5 space-y-4">
          {/* Dito uma vez, no topo. Repetir "obrigatório" em cada campo
              transforma a marca em ruído, e a pessoa deixa de enxergá-la. */}
          <p className="text-xs text-muted-foreground">
            <span aria-hidden className="text-destructive">*</span> {t.requiredHint}
          </p>

          <section className="rounded-2xl border bg-background p-4 space-y-3">
            <p className="text-sm font-semibold">{t.dates}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t.checkin}<Obrigatorio /></Label>
                <Input type="date" min={today} value={checkin} onChange={(e) => setCheckin(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t.checkout}<Obrigatorio /></Label>
                <Input type="date" min={checkin || today} value={checkout} onChange={(e) => setCheckout(e.target.value)} />
              </div>
            </div>
          </section>

          {guests.map((g, i) => (
            <section key={i} className="rounded-2xl border bg-background p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  {t.guest} {i + 1}
                  {i === 0 && <span className="text-xs text-muted-foreground font-normal"> · responsável</span>}
                </p>
                {i > 0 && (
                  <button
                    onClick={() => setGuests(guests.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remover hóspede"
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
              <div className="space-y-2 rounded-xl bg-muted/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-semibold">{t.docTitle}<Obrigatorio /></Label>
                  {/* O "sou estrangeiro" fica AO LADO do campo, e não numa tela
                      antes: quem tem CPF nunca precisa pensar nele, e quem não
                      tem descobre a saída no exato momento em que trava. */}
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
                    {/* O aviso só aparece quando o campo está cheio: avisar a
                        cada dígito é acusar a pessoa de errar enquanto digita. */}
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

                {/* Foto do documento */}
                <div className="space-y-1.5 border-t pt-2">
                  <Label className="text-xs">{t.photo}</Label>

                  {/* DUAS entradas, e não uma.
                      Com `capture` o navegador abre a câmera direto e não
                      oferece a galeria — quem já fotografou o RG na semana
                      passada não consegue usar a foto que tem. Sem `capture`,
                      parte dos Android vai direto para o gerenciador de
                      arquivos e esconde a câmera. Nenhum dos dois sozinho
                      atende os dois sistemas, então os dois ficam à vista. */}
                  {g.fotoDataUrl && fotoOcupada !== i ? (
                    <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-success/50 px-3 text-sm">
                      <Check className="h-4 w-4 shrink-0 text-success" />
                      <span className="min-w-0 flex-1 truncate">{g.fotoNome}</span>
                      <button
                        type="button"
                        onClick={() => trocar(i, { fotoDataUrl: "", fotoNome: "" })}
                        className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
                      >
                        {t.photoRemove}
                      </button>
                    </div>
                  ) : fotoOcupada === i ? (
                    <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-dashed border-input px-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t.photoSending}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-input text-sm text-muted-foreground">
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) pegarFoto(i, f);
                            e.target.value = "";
                          }}
                        />
                        <Camera className="h-4 w-4 shrink-0" aria-hidden />
                        {t.photoCamera}
                      </label>

                      <label className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-input text-sm text-muted-foreground">
                        <input
                          type="file"
                          // Sem `capture`: o iPhone abre "Fototeca / Tirar foto /
                          // Escolher ficheiro" e o Android abre o seletor com
                          // galeria e arquivos. PDF entra por aqui também.
                          accept="image/*,application/pdf"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) pegarFoto(i, f);
                            e.target.value = "";
                          }}
                        />
                        <ImageIcon className="h-4 w-4 shrink-0" aria-hidden />
                        {t.photoGallery}
                      </label>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">{t.photoHint}</p>
                </div>
              </div>
            </section>
          ))}

          <Button variant="outline" className="w-full" onClick={() => setGuests([...guests, novoHospede()])}>
            <Plus className="h-4 w-4 mr-1" /> {t.add}
          </Button>

          <section className="space-y-4 rounded-2xl border bg-background p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox checked={term} onCheckedChange={(v) => setTerm(Boolean(v))} className="mt-0.5" />
              <span
                className="text-xs leading-relaxed text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: t.termText }}
              />
            </label>

            {/* A assinatura só aparece depois do aceite. Mostrar o quadro de
                assinar acima da caixa que a pessoa ainda não marcou é pedir
                que ela assine algo que ainda não disse ter lido. */}
            {term && (
              <div className="border-t pt-4">
                <Assinatura
                  onChange={setAssinatura}
                  rotulo={t.signTitle}
                  obrigatorio
                />
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t.signHint}</p>
              </div>
            )}
          </section>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-xl p-3">{error}</p>
          )}

          <Button onClick={submitRegistration} disabled={busy} className="w-full h-12">
            {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t.sending}</> : t.submit}
          </Button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- chat
  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <header className="bg-background border-b px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button
          type="button"
          onClick={() => setMode("choice")}
          aria-label={t.back}
          className="-ml-1 rounded-full p-1.5 text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
          <MessageCircle className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{propertyName || t.assistant}</p>
          <p className="text-[11px] text-emerald-600">online · responde 24h</p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                m.role === "user"
                  ? "bg-primary text-primary-foreground rounded-br-md"
                  : "bg-background border rounded-bl-md",
              )}
            >
              {m.role === "assistant" ? (
                m.content ? (
                  <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1.5 prose-ul:my-1.5">
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

      <footer className="border-t bg-background px-3 py-3 sticky bottom-0">
        <form
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="flex gap-2 max-w-2xl mx-auto"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.placeholder}
            disabled={streaming}
            className="h-11 rounded-full"
          />
          <Button
            type="submit"
            size="icon"
            disabled={streaming || !input.trim()}
            className="h-11 w-11 rounded-full shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </footer>
    </div>
  );
}
