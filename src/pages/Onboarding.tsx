import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Calendar, Check, Copy, Home, Loader2, MessageCircle,
  Sparkles, Users, AlertCircle, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AI_FIELDS } from "@/lib/propertyFields";
import { ICAL_CHANNELS, type IcalChannel } from "@/lib/icalChannels";
import { mensagemAutomatica } from "@/lib/mensagemAutomatica";

/**
 * Onboarding guiado — a tela que decide se o cliente ativa ou cancela.
 *
 * A ordem não é arbitrária: o iCal vem antes de tudo porque é o passo que
 * entrega o "aha" ("achei 7 reservas, próxima saída dia 14"). Motivação cai a
 * cada etapa; a melhor parte dela é gasta vendo as reservas aparecerem, não
 * preenchendo formulário.
 */

type Step = 1 | 2 | 3 | 4 | 5;


export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);

  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [chatUrl, setChatUrl] = useState<string>("");

  const [basics, setBasics] = useState({
    name: "", checkin_time: "15:00", checkout_time: "11:00",
    condo_email: "", turnover_price: "120",
  });
  const [icalUrl, setIcalUrl] = useState("");
  const [icalProvider, setIcalProvider] = useState<IcalChannel["provider"]>("airbnb");
  const [icalDone, setIcalDone] = useState<IcalChannel["provider"][]>([]);
  const [icalResult, setIcalResult] = useState<{ ok: boolean; message: string } | null>(null);
  const icalChannel = ICAL_CHANNELS.find((c) => c.provider === icalProvider)!;
  const [cleaner, setCleaner] = useState({ name: "", phone: "" });
  const [waLink, setWaLink] = useState<string | null>(null);
  const [selfClean, setSelfClean] = useState(false);
  const [ai, setAi] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  // ---- passo 1: imóvel ----------------------------------------------------
  const saveBasics = async () => {
    if (basics.name.trim().length < 2) return toast.error("Dê um nome ao imóvel");
    setBusy(true);
    try {
      const res = await api.property.upsert({
        property_id: propertyId ?? undefined,
        name: basics.name.trim(),
        checkin_time: basics.checkin_time,
        checkout_time: basics.checkout_time,
        condo_email: basics.condo_email.trim() || undefined,
        turnover_price: Number(basics.turnover_price) || 0,
      });
      setPropertyId(res.property.id);
      setChatUrl(res.property.chat_url);
      setStep(2);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar");
    } finally {
      setBusy(false);
    }
  };

  // ---- passo 2: iCal — o momento do "aha" ---------------------------------
  const validateIcal = async () => {
    if (!icalUrl.trim()) return toast.error("Cole o link do calendário");
    setBusy(true);
    setIcalResult(null);
    try {
      const res = await api.ical.validate({
        url: icalUrl.trim(),
        property_id: propertyId!,
        save: true,
        provider: icalProvider,
      });
      setIcalResult({ ok: res.ok, message: res.message });
      if (res.ok) {
        toast.success("Calendário conectado!");
        setIcalDone((d) => (d.includes(icalProvider) ? d : [...d, icalProvider]));
        setIcalUrl("");
        // Não avança sozinho: quem anuncia nos dois canais precisa da chance de
        // colar o segundo link aqui. Pular agora e descobrir depois que faltou
        // metade das reservas é pior do que um toque a mais.
      }
    } catch (e) {
      setIcalResult({
        ok: false,
        message: e instanceof Error ? e.message : "Não consegui ler esse link",
      });
    } finally {
      setBusy(false);
    }
  };

  // ---- passo 3: diarista ---------------------------------------------------
  const inviteCleaner = async () => {
    if (selfClean) {
      setBusy(true);
      try {
        await api.property.upsert({ property_id: propertyId!, self_clean: true });
        setStep(4);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (cleaner.name.trim().length < 2) return toast.error("Informe o nome da diarista");
    if (cleaner.phone.replace(/\D/g, "").length < 10) {
      return toast.error("Informe o WhatsApp dela com DDD");
    }

    setBusy(true);
    try {
      const res = await api.cleaner.invite({
        cleaner_name: cleaner.name.trim(),
        cleaner_phone: cleaner.phone,
        property_id: propertyId!,
      });
      setWaLink(res.whatsapp_link);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui gerar o convite");
    } finally {
      setBusy(false);
    }
  };

  // ---- passo 4: cérebro da assistente -------------------------------------
  const saveAi = async () => {
    const missing = AI_FIELDS.filter((f) => f.required && !ai[f.key]?.trim());
    if (missing.length > 0) {
      return toast.error(`Falta preencher: ${missing.map((f) => f.label).join(", ")}`);
    }
    setBusy(true);
    try {
      await api.property.upsert({ property_id: propertyId!, ai_config: ai });
      setStep(5);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar");
    } finally {
      setBusy(false);
    }
  };

  // ---- passo 5: mensagem automática ---------------------------------------
  const autoMessage = mensagemAutomatica(chatUrl);

  const finish = async () => {
    setBusy(true);
    try {
      await api.property.upsert({ property_id: propertyId!, auto_message_confirmed: true });
      toast.success("Pronto! Seu imóvel está no automático.");
      navigate("/painel");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui concluir");
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    { n: 1, label: "Imóvel", icon: Home },
    { n: 2, label: "Calendário", icon: Calendar },
    { n: 3, label: "Diarista", icon: Users },
    { n: 4, label: "Assistente", icon: Sparkles },
    { n: 5, label: "Ativar", icon: MessageCircle },
  ];

  return (
    <div className="min-h-screen bg-muted/30 pb-16">
      <header className="border-b bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3">
          <p className="text-xs font-bold tracking-widest uppercase text-primary">HospedePay</p>
          <div className="mt-3 flex items-center gap-1">
            {steps.map((s) => (
              <div key={s.n} className="flex-1">
                <div
                  className={cn(
                    "h-1 rounded-full transition-colors",
                    step >= s.n ? "bg-primary" : "bg-border",
                  )}
                />
                <p
                  className={cn(
                    "mt-1.5 text-[10px] font-medium truncate",
                    step >= s.n ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-6 space-y-5">
        {/* ------------------------------------------------ 1. Imóvel */}
        {step === 1 && (
          <section className="bg-background rounded-2xl border p-5 space-y-4">
            <div>
              <h2 className="text-lg font-bold">Seu imóvel</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                O básico. Dá pra ajustar depois.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Como você chama esse imóvel</Label>
              <Input
                value={basics.name}
                onChange={(e) => setBasics({ ...basics, name: e.target.value })}
                placeholder="Cobertura Copacabana"
                maxLength={60}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Check-in</Label>
                <Input
                  type="time"
                  value={basics.checkin_time}
                  onChange={(e) => setBasics({ ...basics, checkin_time: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Check-out</Label>
                <Input
                  type="time"
                  value={basics.checkout_time}
                  onChange={(e) => setBasics({ ...basics, checkout_time: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Valor da diária de limpeza</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={basics.turnover_price}
                onChange={(e) => setBasics({ ...basics, turnover_price: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                E-mail da portaria <span className="text-muted-foreground font-normal">(opcional)</span>
              </Label>
              <Input
                type="email"
                value={basics.condo_email}
                onChange={(e) => setBasics({ ...basics, condo_email: e.target.value })}
                placeholder="portaria@condominio.com.br"
              />
              <p className="text-xs text-muted-foreground">
                Preenchendo, a portaria é avisada sozinha a cada reserva.
              </p>
            </div>

            <Button onClick={saveBasics} disabled={busy} className="w-full h-11">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Continuar
            </Button>
          </section>
        )}

        {/* ------------------------------------------------ 2. iCal */}
        {step === 2 && (
          <section className="bg-background rounded-2xl border p-5 space-y-4">
            <div>
              <h2 className="text-lg font-bold">Conectar o calendário</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                É o que faz tudo funcionar sozinho depois.
              </p>
            </div>

            {/* Um canal por vez: o passo continua sendo colar UM link, que é o
                que entrega o "achei 7 reservas". Quem anuncia nos dois volta
                aqui pelo atalho embaixo do resultado. */}
            <div className="grid grid-cols-2 gap-2">
              {ICAL_CHANNELS.map((c) => {
                const active = c.provider === icalProvider;
                const done = icalDone.includes(c.provider);
                return (
                  <button
                    key={c.provider}
                    type="button"
                    onClick={() => {
                      setIcalProvider(c.provider);
                      setIcalResult(null);
                    }}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span className={cn("h-2.5 w-2.5 rounded-full", c.swatch)} aria-hidden />
                    {c.label}
                    {done && <Check className="h-4 w-4 text-emerald-500" />}
                  </button>
                );
              })}
            </div>

            <div className="rounded-xl bg-muted/60 p-4 text-sm space-y-2">
              <p className="font-semibold">No {icalChannel.label}:</p>
              <p className="text-muted-foreground leading-relaxed">{icalChannel.hint}</p>
              <a
                href={icalChannel.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary text-xs font-medium hover:underline"
              >
                Ver no site do {icalChannel.label} <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <div className="space-y-1.5">
              <Label>Link do calendário do {icalChannel.label}</Label>
              <Input
                value={icalUrl}
                onChange={(e) => setIcalUrl(e.target.value)}
                placeholder={icalChannel.placeholder}
                inputMode="url"
                autoCapitalize="off"
              />
            </div>

            {icalResult && (
              <div
                className={cn(
                  "rounded-xl p-4 text-sm flex gap-3",
                  icalResult.ok
                    ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
                    : "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
                )}
              >
                {icalResult.ok ? (
                  <Check className="h-5 w-5 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                )}
                <p className="leading-relaxed">{icalResult.message}</p>
              </div>
            )}

            <Button onClick={validateIcal} disabled={busy} className="w-full h-11">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Conectar {icalChannel.label}
            </Button>

            {icalDone.length > 0 ? (
              <div className="space-y-2">
                <Button onClick={() => setStep(3)} variant="outline" className="w-full h-11">
                  Continuar
                </Button>
                {ICAL_CHANNELS.filter((c) => !icalDone.includes(c.provider)).map((c) => (
                  <button
                    key={c.provider}
                    onClick={() => {
                      setIcalProvider(c.provider);
                      setIcalResult(null);
                    }}
                    className="w-full text-xs font-medium text-primary hover:underline"
                  >
                    Anuncio também no {c.label} — conectar agora
                  </button>
                ))}
              </div>
            ) : (
              <button
                onClick={() => setStep(3)}
                className="w-full text-xs text-muted-foreground hover:text-foreground"
              >
                Fazer isso depois
              </button>
            )}
          </section>
        )}

        {/* ------------------------------------------------ 3. Diarista */}
        {step === 3 && (
          <section className="bg-background rounded-2xl border p-5 space-y-4">
            <div>
              <h2 className="text-lg font-bold">Quem faz a limpeza</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Ela recebe a agenda no celular. Sem senha, sem cadastro.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-xl border p-3 cursor-pointer">
              <Checkbox
                checked={selfClean}
                onCheckedChange={(v) => setSelfClean(Boolean(v))}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-medium">Eu mesmo limpo</span>
                <span className="block text-muted-foreground text-xs mt-0.5">
                  As tarefas aparecem na sua própria agenda.
                </span>
              </span>
            </label>

            {!selfClean && !waLink && (
              <>
                <div className="space-y-1.5">
                  <Label>Nome dela</Label>
                  <Input
                    value={cleaner.name}
                    onChange={(e) => setCleaner({ ...cleaner, name: e.target.value })}
                    placeholder="Maria Souza"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>WhatsApp dela</Label>
                  <Input
                    value={cleaner.phone}
                    onChange={(e) => setCleaner({ ...cleaner, phone: e.target.value })}
                    placeholder="(21) 99999-8888"
                    inputMode="tel"
                  />
                </div>
              </>
            )}

            {waLink && (
              <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950 p-4 space-y-3">
                <p className="text-sm text-emerald-900 dark:text-emerald-100 leading-relaxed">
                  Convite pronto. Envie pelo seu WhatsApp — chegando do seu número,
                  ela clica sem desconfiar.
                </p>
                <Button asChild className="w-full h-11">
                  <a href={waLink} target="_blank" rel="noreferrer">
                    Enviar convite no WhatsApp
                  </a>
                </Button>
              </div>
            )}

            <Button
              onClick={waLink ? () => setStep(4) : inviteCleaner}
              disabled={busy}
              variant={waLink ? "outline" : "default"}
              className="w-full h-11"
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {waLink ? "Já enviei — continuar" : selfClean ? "Continuar" : "Gerar convite"}
            </Button>
          </section>
        )}

        {/* ------------------------------------------------ 4. Assistente */}
        {step === 4 && (
          <section className="bg-background rounded-2xl border p-5 space-y-4">
            <div>
              <h2 className="text-lg font-bold">O que a assistente precisa saber</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                É com isso que ela responde seus hóspedes, 24h, em 3 idiomas.
              </p>
            </div>

            <div className="space-y-3">
              {AI_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label className="flex items-center gap-2 text-sm">
                    <span>{f.icon}</span>
                    {f.label}
                    {!f.required && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-normal">
                        opcional
                      </span>
                    )}
                  </Label>
                  <Textarea
                    value={ai[f.key] ?? ""}
                    onChange={(e) => setAi({ ...ai, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    rows={2}
                    className="resize-none"
                  />
                </div>
              ))}
            </div>

            <Button onClick={saveAi} disabled={busy} className="w-full h-11">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar e continuar
            </Button>
          </section>
        )}

        {/* ------------------------------------------------ 5. Mensagem */}
        {step === 5 && (
          <section className="bg-background rounded-2xl border p-5 space-y-4">
            <div>
              <h2 className="text-lg font-bold">Último passo</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Cole esta mensagem na resposta automática do Airbnb. É ela que
                leva o hóspede até o cadastro e a assistente.
              </p>
            </div>

            <div className="relative rounded-xl bg-muted/60 p-4">
              <pre className="text-xs leading-relaxed whitespace-pre-wrap font-sans text-foreground/90 pr-10">
                {autoMessage}
              </pre>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 h-8 w-8"
                onClick={() => {
                  navigator.clipboard.writeText(autoMessage);
                  setCopied(true);
                  toast.success("Mensagem copiada");
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            <div className="rounded-xl bg-muted/60 p-4 text-sm">
              <p className="font-semibold mb-1">No Airbnb:</p>
              <p className="text-muted-foreground leading-relaxed">
                Mensagens → Respostas rápidas → Mensagens agendadas → nova mensagem
                para "Reserva confirmada"
              </p>
            </div>

            <Button onClick={finish} disabled={busy} className="w-full h-11">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Colei — ativar meu imóvel
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}
