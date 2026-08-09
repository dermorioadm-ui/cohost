import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays, Check, ChevronLeft, Clock, Copy, Loader2,
  MessageCircle, Sparkles, Trash2, UserPlus, Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase, api } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { AI_FIELDS } from "@/lib/propertyFields";
import { cn, getAppBaseUrl } from "@/lib/utils";

/**
 * Edição de um imóvel já cadastrado.
 *
 * Tudo aqui já existia no backend — `property-upsert` aceita `property_id` e
 * atualiza campo a campo desde sempre. O que não existia era tela: o onboarding
 * começa com `propertyId = null` e por isso só cria. Sem esta página, trocar a
 * diarista de um imóvel exigia cadastrar o imóvel de novo.
 *
 * O bloco da diarista é o motivo desta tela existir, então ele explica o
 * estado em vez de só oferecer um campo: quem já aceitou aparece para escolher,
 * quem foi convidada e não respondeu aparece como pendente — que é o caso em
 * que o dono acha que atribuiu e não atribuiu.
 */

interface PropertyRow {
  id: string;
  name: string;
  property_type: string;
  address: string | null;
  street_number: string | null;
  apt_number: string | null;
  block: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  condo_name: string | null;
  condo_email: string | null;
  condo_notify: boolean;
  checkin_time: string;
  checkout_time: string;
  turnover_price: number;
  self_clean: boolean;
  cleaner_id: string | null;
  ai_config: Record<string, string> | null;
  ai_enabled: boolean;
  public_slug: string;
  auto_message_confirmed_at: string | null;
}

interface IcalSource {
  id: string;
  provider: string;
  url: string;
  last_success_at: string | null;
  consecutive_fails: number;
  events_last_sync: number | null;
}

/**
 * Canais oferecidos na tela.
 *
 * O enum do banco também tem `vrbo` e `other`, e o backend continua aceitando
 * os dois quando adivinha pela URL. Aqui ficam só os que este cliente usa —
 * quatro caixas vazias fariam a tela parecer trabalho pendente.
 */
interface IcalChannel {
  provider: "airbnb" | "booking";
  label: string;
  placeholder: string;
  hint: string;
  swatch: string;
}

const ICAL_CHANNELS: IcalChannel[] = [
  {
    provider: "airbnb",
    label: "Airbnb",
    placeholder: "https://www.airbnb.com.br/calendar/ical/...",
    hint: "Calendário → Disponibilidade → Sincronizar calendários → Exportar calendário.",
    swatch: "bg-primary/70",
  },
  {
    provider: "booking",
    label: "Booking.com",
    placeholder: "https://ical.booking.com/v1/export?t=...",
    hint: "Extranet → Tarifas e Disponibilidade → Sincronizar calendários → Exportar.",
    swatch: "bg-[hsl(var(--booking))]",
  },
];

interface ConnectedProfile {
  user_id: string;
  full_name: string | null;
  phone_e164: string | null;
}

interface PendingInvite {
  id: string;
  cleaner_name: string;
  cleaner_phone_e164: string | null;
}

const hhmm = (t: string | null | undefined) => (t ?? "").slice(0, 5);

export default function Imovel() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState<PropertyRow | null>(null);
  const [ai, setAi] = useState<Record<string, string>>({});
  const [cleaners, setCleaners] = useState<ConnectedProfile[]>([]);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Convite de uma diarista nova, a partir desta tela
  const [invite, setInvite] = useState({ name: "", phone: "" });
  const [inviting, setInviting] = useState(false);
  const [waLink, setWaLink] = useState<string | null>(null);

  // Calendário — uma fonte por canal. O banco já tratava assim desde a 0004
  // (UNIQUE property_id, provider); era a tela que só enxergava uma.
  const [icals, setIcals] = useState<IcalSource[]>([]);
  const [icalUrl, setIcalUrl] = useState<Record<string, string>>({});
  const [checkingIcal, setCheckingIcal] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  // Remoção em dois toques: um botão só, num formulário longo e rolado no
  // celular, é clique acidental esperando acontecer.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!user || !id) return;

    (async () => {
      const [prop, conn, inv, src] = await Promise.all([
        supabase.from("properties").select("*").eq("id", id).maybeSingle(),
        supabase.rpc("connected_profiles"),
        supabase
          .from("cleaner_invites")
          .select("id, cleaner_name, cleaner_phone_e164")
          .eq("status", "pending"),
        supabase
          .from("property_ical_sources")
          .select("id, provider, url, last_success_at, consecutive_fails, events_last_sync")
          .eq("property_id", id)
          .eq("active", true),
      ]);

      if (!prop.data) {
        toast.error("Imóvel não encontrado");
        navigate("/imoveis", { replace: true });
        return;
      }

      const row = prop.data as PropertyRow;
      setForm(row);
      setAi((row.ai_config ?? {}) as Record<string, string>);
      setCleaners((conn.data ?? []) as ConnectedProfile[]);
      setPending((inv.data ?? []) as PendingInvite[]);
      setIcals((src.data ?? []) as IcalSource[]);
      setLoading(false);
    })();
  }, [user, id, navigate]);

  const set = <K extends keyof PropertyRow>(key: K, value: PropertyRow[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const saveIcal = async (provider: IcalChannel["provider"]) => {
    const url = (icalUrl[provider] ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return toast.error("Cole o link do calendário (começa com http)");

    setCheckingIcal(provider);
    try {
      const res = await api.ical.validate({ url, property_id: form!.id, save: true, provider });
      if (!res.ok) return toast.error(res.message);

      toast.success(
        res.events ? `${res.events} reserva(s) encontradas. Calendário conectado.` : res.message,
      );
      setIcalUrl((u) => ({ ...u, [provider]: "" }));

      const { data } = await supabase
        .from("property_ical_sources")
        .select("id, provider, url, last_success_at, consecutive_fails, events_last_sync")
        .eq("property_id", form!.id)
        .eq("active", true);
      setIcals((data ?? []) as IcalSource[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui ler esse link");
    } finally {
      setCheckingIcal(null);
    }
  };

  const archive = async () => {
    setDeleting(true);
    try {
      // Arquiva em vez de apagar: as reservas e limpezas já feitas continuam
      // no histórico, e o registro financeiro do mês não muda de valor por
      // causa de uma remoção. O app filtra por archived_at em toda listagem.
      const { error } = await supabase
        .from("properties")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", form!.id);
      if (error) throw new Error(error.message);

      // Limpeza que ainda não aconteceu não pode continuar na agenda da
      // diarista de um imóvel que saiu do ar.
      await supabase
        .from("cleaning_tasks")
        .update({ status: "cancelled" })
        .eq("property_id", form!.id)
        .eq("status", "pending");

      toast.success("Imóvel removido.");
      navigate("/imoveis", { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui remover");
      setDeleting(false);
    }
  };

  const confirmAutoMessage = async () => {
    setSaving(true);
    try {
      await api.property.upsert({ property_id: form!.id, auto_message_confirmed: true });
      set("auto_message_confirmed_at", new Date().toISOString());
      toast.success("Anotado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!form) return;
    if (form.name.trim().length < 2) return toast.error("O imóvel precisa de um nome");

    setSaving(true);
    try {
      await api.property.upsert({
        property_id: form.id,
        name: form.name.trim(),
        property_type: form.property_type,
        address: form.address ?? "",
        street_number: form.street_number ?? "",
        apt_number: form.apt_number ?? "",
        block: form.block ?? "",
        neighborhood: form.neighborhood ?? "",
        city: form.city ?? "",
        state: form.state ?? "",
        zip_code: form.zip_code ?? "",
        condo_name: form.condo_name ?? "",
        condo_email: form.condo_email ?? "",
        condo_notify: form.condo_notify,
        checkin_time: hhmm(form.checkin_time),
        checkout_time: hhmm(form.checkout_time),
        turnover_price: Number(form.turnover_price),
        self_clean: form.self_clean,
        cleaner_id: form.cleaner_id,
        ai_config: ai,
        ai_enabled: form.ai_enabled,
      });
      toast.success("Imóvel atualizado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar");
    } finally {
      setSaving(false);
    }
  };

  const sendInvite = async () => {
    if (invite.name.trim().length < 2) return toast.error("Informe o nome dela");
    if (invite.phone.replace(/\D/g, "").length < 10) {
      return toast.error("Informe o WhatsApp dela com DDD");
    }

    setInviting(true);
    try {
      const res = await api.cleaner.invite({
        cleaner_name: invite.name.trim(),
        cleaner_phone: invite.phone,
        property_id: form!.id,
      });
      setWaLink(res.whatsapp_link);
      setPending((p) => [
        ...p,
        { id: res.invite_id, cleaner_name: invite.name.trim(), cleaner_phone_e164: invite.phone },
      ]);
      setInvite({ name: "", phone: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui gerar o convite");
    } finally {
      setInviting(false);
    }
  };

  const chatUrl = form ? `${getAppBaseUrl()}/c/${form.public_slug}` : "";
  const autoMessage =
    `Olá! Seja muito bem-vindo(a) 😊\n\n` +
    `Antes da sua chegada, faça seu cadastro obrigatório aqui — é rápido e ` +
    `libera as instruções de acesso, Wi-Fi e tudo mais:\n\n${chatUrl}\n\n` +
    `Qualquer dúvida, o assistente responde 24h nesse mesmo link.`;

  if (loading || !form) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-4">
      <header className="flex items-center gap-3">
        <Link
          to="/imoveis"
          aria-label="Voltar"
          className="-ml-2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="min-w-0 truncate text-lg font-bold">{form.name}</h1>
      </header>

      {/* ---------------------------------------------------- Identificação */}
      <section className="space-y-4 rounded-xl glass-card p-5">
        <h2 className="font-semibold">Identificação</h2>

        <div className="space-y-1.5">
          <Label>Nome do imóvel</Label>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Bairro</Label>
            <Input
              value={form.neighborhood ?? ""}
              onChange={(e) => set("neighborhood", e.target.value)}
              placeholder="Icaraí"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Cidade</Label>
            <Input
              value={form.city ?? ""}
              onChange={(e) => set("city", e.target.value)}
              placeholder="Niterói"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Endereço</Label>
          <Input
            value={form.address ?? ""}
            onChange={(e) => set("address", e.target.value)}
            placeholder="Rua Ator Paulo Gustavo"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label>Número</Label>
            <Input
              value={form.street_number ?? ""}
              onChange={(e) => set("street_number", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Apto</Label>
            <Input
              value={form.apt_number ?? ""}
              onChange={(e) => set("apt_number", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Bloco</Label>
            <Input value={form.block ?? ""} onChange={(e) => set("block", e.target.value)} />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Calendário */}
      <section className="space-y-4 rounded-xl glass-card p-5">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Calendário</h2>
        </div>

        {icals.length === 0 && (
          <p className="rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
            Sem calendário conectado. Enquanto não colar o link, nenhuma reserva entra sozinha e a
            agenda da diarista fica vazia.
          </p>
        )}

        {ICAL_CHANNELS.map((channel) => {
          const source = icals.find((s) => s.provider === channel.provider);
          const busy = checkingIcal === channel.provider;

          return (
            <div
              key={channel.provider}
              className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
            >
              <div className="flex items-center gap-2">
                <span className={cn("h-2.5 w-2.5 rounded-full", channel.swatch)} aria-hidden />
                <h3 className="text-sm font-semibold">{channel.label}</h3>
              </div>

              {source && (
                <div
                  className={cn(
                    "rounded-lg p-2.5 text-xs leading-relaxed",
                    source.consecutive_fails > 0
                      ? "bg-destructive/10 text-destructive"
                      : "bg-success/10 text-success",
                  )}
                >
                  {source.consecutive_fails > 0 ? (
                    <>
                      Falhando há {source.consecutive_fails} tentativa(s). Reserva nova não está
                      virando limpeza. Normalmente o link foi regerado na plataforma — gere outro e
                      cole abaixo.
                    </>
                  ) : (
                    <>
                      Conectado
                      {source.events_last_sync !== null &&
                        ` · ${source.events_last_sync} reserva(s) na última leitura`}
                    </>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{source ? "Trocar o link" : "Link do calendário (iCal)"}</Label>
                <Input
                  value={icalUrl[channel.provider] ?? ""}
                  onChange={(e) =>
                    setIcalUrl((u) => ({ ...u, [channel.provider]: e.target.value }))
                  }
                  placeholder={channel.placeholder}
                  inputMode="url"
                />
                <p className="text-xs text-muted-foreground">No {channel.label}: {channel.hint}</p>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => saveIcal(channel.provider)}
                disabled={busy}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Validar e salvar
              </Button>
            </div>
          );
        })}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Dá para conectar os dois ao mesmo tempo. Cada canal sincroniza sozinho a cada 15 minutos,
          e no calendário as reservas aparecem com a cor do canal de origem.
        </p>
      </section>

      {/* --------------------------------------------------------- Operação */}
      <section className="space-y-4 rounded-xl glass-card p-5">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Operação</h2>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Entrada</Label>
            <Input
              type="time"
              value={hhmm(form.checkin_time)}
              onChange={(e) => set("checkin_time", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Saída</Label>
            <Input
              type="time"
              value={hhmm(form.checkout_time)}
              onChange={(e) => set("checkout_time", e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Valor pago por limpeza (R$)</Label>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={String(form.turnover_price)}
            onChange={(e) => set("turnover_price", Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            É o que aparece na agenda da diarista e no total do mês.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------------- Diarista */}
      <section className="space-y-4 rounded-xl glass-card p-5">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Quem faz a limpeza</h2>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
          <Checkbox
            checked={form.self_clean}
            onCheckedChange={(v) => {
              set("self_clean", Boolean(v));
              if (v) set("cleaner_id", null);
            }}
            className="mt-0.5"
          />
          <span className="text-sm">
            <span className="font-medium">Eu mesmo limpo</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              As tarefas aparecem na sua própria agenda.
            </span>
          </span>
        </label>

        {!form.self_clean && (
          <>
            {cleaners.length > 0 && (
              <div className="space-y-2">
                <Label>Diarista deste imóvel</Label>
                {cleaners.map((c) => (
                  <button
                    key={c.user_id}
                    type="button"
                    onClick={() => set("cleaner_id", c.user_id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                      form.cleaner_id === c.user_id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {c.full_name ?? "Diarista"}
                      </span>
                      {c.phone_e164 && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.phone_e164}
                        </span>
                      )}
                    </span>
                    {form.cleaner_id === c.user_id && (
                      <span className="shrink-0 text-xs font-medium text-primary">Vinculada</span>
                    )}
                  </button>
                ))}

                {form.cleaner_id && (
                  <button
                    type="button"
                    onClick={() => set("cleaner_id", null)}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Desvincular
                  </button>
                )}
              </div>
            )}

            {pending.length > 0 && (
              <div className="rounded-xl bg-warning/10 p-3">
                <p className="text-xs font-medium text-warning">Convite ainda não aceito</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {pending.map((p) => p.cleaner_name).join(", ")} recebeu o convite mas ainda não
                  abriu o link. Enquanto ela não aceitar, não dá para vincular a nenhum imóvel —
                  o vínculo só existe depois do aceite dela.
                </p>
              </div>
            )}

            {cleaners.length === 0 && pending.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nenhuma diarista vinculada ainda. Convide abaixo.
              </p>
            )}

            {/* Convidar (ou reenviar para quem não aceitou) */}
            <div className="space-y-3 rounded-xl border border-dashed border-border p-3">
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Convidar diarista</p>
              </div>

              <div className="space-y-1.5">
                <Label>Nome dela</Label>
                <Input
                  value={invite.name}
                  onChange={(e) => setInvite({ ...invite, name: e.target.value })}
                  placeholder="Aline"
                />
              </div>
              <div className="space-y-1.5">
                <Label>WhatsApp dela</Label>
                <Input
                  value={invite.phone}
                  onChange={(e) => setInvite({ ...invite, phone: e.target.value })}
                  placeholder="(21) 99999-8888"
                  inputMode="tel"
                />
              </div>

              {waLink && (
                <div className="space-y-2 rounded-lg bg-success/10 p-3">
                  <p className="text-xs leading-relaxed text-success">
                    Convite gerado. Envie pelo seu WhatsApp — chegando do seu número, ela clica
                    sem desconfiar.
                  </p>
                  <Button asChild size="sm" className="w-full">
                    <a href={waLink} target="_blank" rel="noreferrer">
                      Enviar no WhatsApp
                    </a>
                  </Button>
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={sendInvite}
                disabled={inviting}
              >
                {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Gerar convite
              </Button>
            </div>
          </>
        )}
      </section>

      {/* ------------------------------------------------------- Condomínio */}
      <section className="space-y-4 rounded-xl glass-card p-5">
        <h2 className="font-semibold">Condomínio</h2>

        <div className="space-y-1.5">
          <Label>Nome do condomínio</Label>
          <Input
            value={form.condo_name ?? ""}
            onChange={(e) => set("condo_name", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>E-mail da portaria</Label>
          <Input
            type="email"
            value={form.condo_email ?? ""}
            onChange={(e) => set("condo_email", e.target.value)}
            placeholder="portaria@condominio.com.br"
          />
          <p className="text-xs text-muted-foreground">
            Sem esse e-mail, o aviso de cada reserva não sai.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={form.condo_notify}
            onCheckedChange={(v) => set("condo_notify", Boolean(v))}
            className="mt-0.5"
          />
          <span className="text-sm">Avisar a portaria a cada reserva</span>
        </label>
      </section>

      {/* ----------------------------------------------- Mensagem automática */}
      <section className="space-y-3 rounded-xl glass-card p-5">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Mensagem automática</h2>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          É ela que leva o hóspede ao cadastro e ao assistente. Cole no Airbnb em Mensagens
          programadas, na reserva confirmada.
        </p>

        <pre className="whitespace-pre-wrap rounded-xl bg-muted p-3 text-xs leading-relaxed">
          {autoMessage}
        </pre>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            navigator.clipboard.writeText(autoMessage);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? "Copiado" : "Copiar mensagem"}
        </Button>

        {form.auto_message_confirmed_at ? (
          <p className="text-center text-xs text-success">Você marcou que já configurou no Airbnb.</p>
        ) : (
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={confirmAutoMessage}
            disabled={saving}
          >
            Já coloquei no Airbnb
          </Button>
        )}
      </section>

      {/* ------------------------------------------------------- Assistente */}
      <section className="space-y-4 rounded-xl glass-card p-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">O que a assistente sabe</h2>
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={form.ai_enabled}
            onCheckedChange={(v) => set("ai_enabled", Boolean(v))}
            className="mt-0.5"
          />
          <span className="text-sm">Responder os hóspedes automaticamente</span>
        </label>

        {AI_FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label>
              {f.icon} {f.label}
              {f.required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <Textarea
              rows={2}
              value={ai[f.key] ?? ""}
              onChange={(e) => setAi({ ...ai, [f.key]: e.target.value })}
              placeholder={f.placeholder}
            />
          </div>
        ))}
      </section>

      <Button onClick={save} disabled={saving} className="h-12 w-full text-base font-bold">
        {saving && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
        Salvar alterações
      </Button>

      {/* ------------------------------------------------------------ Remover */}
      <section className="space-y-3 rounded-xl border border-destructive/30 p-5">
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-destructive" />
          <h2 className="font-semibold text-destructive">Remover imóvel</h2>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Ele sai do app e para de gerar limpeza. O histórico de reservas fica
          guardado, então nada de contabilidade se perde — mas as limpezas ainda não
          feitas deste imóvel são canceladas e somem da agenda da diarista.
        </p>

        {confirmDelete ? (
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="flex-1"
              onClick={archive}
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancelar
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            Remover {form.name}
          </Button>
        )}
      </section>
    </div>
  );
}
