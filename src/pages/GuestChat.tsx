import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Assinatura } from "@/components/Assinatura";
import {
  ArrowLeft, Building2, CheckCircle2, ChevronRight, Loader2, MessageCircle,
  Plus, Send, Trash2, UserPlus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { guestApi, guestSession, type GuestInput } from "@/lib/api";
import { cn } from "@/lib/utils";

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

const T = {
  pt: {
    welcome: "Bem-vindo!", how: "Como podemos ajudar?",
    register: "Cadastro de acesso ao apartamento",
    registerDone: "Cadastro de acesso concluído",
    support: "Chat de Atendimento",
    required: "Obrigatório antes da chegada — libera as instruções de acesso",
    requiredDone: "Toque para incluir mais alguém na estadia",
    supportHint: "Wi-Fi, acesso, regras da casa — 24 horas",
    back: "Voltar",
    dates: "Datas da estadia", checkin: "Entrada", checkout: "Saída",
    guests: "Hóspedes", add: "Adicionar hóspede", guest: "Hóspede",
    name: "Nome completo", email: "E-mail", phone: "Telefone com DDD",
    term: "Termo de responsabilidade",
    termText:
      "Declaro que cadastrei <b>todas as pessoas</b> que irão se hospedar, respeitando o limite de ocupação. " +
      "Assumo a responsabilidade pelo imóvel e <b>pelas demais pessoas que cadastrei</b> durante toda a estadia. " +
      "Comprometo-me a <b>não receber pessoas que não estão neste check-in</b> sem autorização do anfitrião. " +
      "Estou ciente de que será realizada uma <b>vistoria ao término</b>.",
    signTitle: "Assine o termo",
    signHint: "Assine com o dedo. O documento assinado é enviado ao anfitrião.",
    signMissing: "Assine o termo antes de concluir",
    submit: "Cadastrar e liberar acesso", sending: "Cadastrando…",
    placeholder: "Escreva sua dúvida…", assistant: "Assistente do imóvel",
    hello: "Olá", helpYou: "Como posso te ajudar?",
    done: "Cadastro concluído! As instruções de acesso foram enviadas para o seu e-mail.",
  },
} as const;

const t = T.pt;

const emptyGuest = (): GuestInput => ({ full_name: "", email: "", phone: "" });

export default function GuestChat() {
  const { slug = "" } = useParams();
  const [mode, setMode] = useState<Mode>("choice");
  const [token, setToken] = useState<string | null>(null);
  const [propertyName, setPropertyName] = useState("");

  const [checkin, setCheckin] = useState("");
  const [checkout, setCheckout] = useState("");
  const [guests, setGuests] = useState<GuestInput[]>([emptyGuest()]);
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

  const submitRegistration = async () => {
    setError("");

    if (!checkin || !checkout) return setError("Informe as datas da estadia");
    if (checkout <= checkin) return setError("A saída precisa ser depois da entrada");
    if (!term) return setError("É necessário aceitar o termo de responsabilidade");
    if (!assinatura) return setError(t.signMissing);

    for (const [i, g] of guests.entries()) {
      if (g.full_name.trim().split(" ").length < 2)
        return setError(`Hóspede ${i + 1}: informe o nome completo`);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(g.email.trim()))
        return setError(`Hóspede ${i + 1}: e-mail inválido`);
      if (g.phone.replace(/\D/g, "").length < 10)
        return setError(`Hóspede ${i + 1}: telefone inválido`);
    }

    setBusy(true);
    try {
      const res = await guestApi.register({
        property_slug: slug,
        checkin_date: checkin,
        checkout_date: checkout,
        guests,
        term_accepted: true,
        assinatura,
        locale: "pt",
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
          <section className="rounded-2xl border bg-background p-4 space-y-3">
            <p className="text-sm font-semibold">{t.dates}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t.checkin}</Label>
                <Input type="date" min={today} value={checkin} onChange={(e) => setCheckin(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t.checkout}</Label>
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

              {(["full_name", "email", "phone"] as const).map((field) => (
                <div key={field} className="space-y-1.5">
                  <Label className="text-xs">
                    {field === "full_name" ? t.name : field === "email" ? t.email : t.phone}
                  </Label>
                  <Input
                    value={g[field]}
                    onChange={(e) =>
                      setGuests(guests.map((x, j) => (j === i ? { ...x, [field]: e.target.value } : x)))
                    }
                    type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
                    autoCapitalize={field === "email" ? "off" : "words"}
                  />
                </div>
              ))}
            </section>
          ))}

          <Button variant="outline" className="w-full" onClick={() => setGuests([...guests, emptyGuest()])}>
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
                <Assinatura onChange={setAssinatura} rotulo={t.signTitle} />
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
