import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Copy, DoorOpen, Home,
  Link as LinkIcon, Loader2, MessageCircle, ShoppingBasket, Sparkles, Trash2,
  Share2, UserPlus, Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase, api, icalFeedUrl } from "@/lib/api";
import { PorterConnect } from "@/components/PorterConnect";
import { PortariaOferta } from "@/components/PortariaOferta";
import { TermosAssinados } from "@/components/TermosAssinados";
import { useAuth } from "@/hooks/useAuth";
import { HermesCard } from "@/components/HermesCard";
import { AI_FIELDS } from "@/lib/propertyFields";
import { ICAL_CHANNELS, type IcalChannel } from "@/lib/icalChannels";
import { cn, getAppBaseUrl } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Edição de um imóvel já cadastrado.
 *
 * Tudo aqui já existia no backend — `property-upsert` aceita `property_id` e
 * atualiza campo a campo desde sempre. O que não existia era tela: o onboarding
 * começa com `propertyId = null` e por isso só cria. Sem esta página, trocar a
 * diarista de um imóvel exigia cadastrar o imóvel de novo.
 *
 * A tela nasceu como uma página só, com todas as seções empilhadas — e virou
 * uma rolagem sem fim: quem entrava para mudar o horário de saída passava por
 * calendário, diarista, insumos, portaria e assistente antes de achar o campo.
 * Agora é o mesmo trilho do onboarding, com uma diferença que importa: aqui
 * NÃO é um trilho. As etapas são atalhos — dá para tocar em qualquer uma, em
 * qualquer ordem, porque quem já cadastrou o imóvel vem consertar UMA coisa.
 *
 * As seis etapas espelham as quatro automatizações da lista de imóveis, para
 * que "Insumos desligado" lá tenha um lugar óbvio para ser ligado aqui.
 *
 * O formulário continua sendo um só: `save()` grava tudo de uma vez, e por
 * isso o botão de salvar aparece em toda etapa — trocar de etapa não perde o
 * que foi digitado, mas sair da página perderia.
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
  supplies_enabled: boolean;
  supplies_monthly_price: number;
  supplies_items: string[] | null;
  supplies_notes: string | null;
}

/** Sugestão inicial, para o dono não encarar uma caixa vazia ao ligar. */
const SUPPLIES_SUGERIDOS = [
  "Papel higiênico", "Sabonete", "Sabão líquido para as mãos", "Detergente",
  "Esponja", "Saco de lixo", "Café", "Açúcar", "Sal", "Óleo", "Pilha",
  "Produto de limpeza geral",
];

interface IcalSource {
  id: string;
  provider: string;
  url: string;
  last_success_at: string | null;
  consecutive_fails: number;
  events_last_sync: number | null;
}

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

/** O combinado vigente com a diarista deste imóvel (migration 0035). */
interface Agreement {
  status: "pending" | "accepted" | "declined";
  decline_note: string | null;
  turnover_price: number;
  supplies_monthly_price: number;
}

type StepKey = "imovel" | "calendario" | "limpeza" | "insumos" | "atendimento" | "portaria";

const STEPS: { key: StepKey; label: string; icon: typeof Home }[] = [
  { key: "imovel", label: "Imóvel", icon: Home },
  { key: "calendario", label: "Calendário", icon: CalendarDays },
  { key: "limpeza", label: "Limpeza", icon: Users },
  { key: "insumos", label: "Insumos", icon: ShoppingBasket },
  { key: "atendimento", label: "Atendimento", icon: MessageCircle },
  { key: "portaria", label: "Portaria", icon: DoorOpen },
];

const hhmm = (t: string | null | undefined) => (t ?? "").slice(0, 5);

export default function Imovel() {
  const { id } = useParams<{ id: string }>();
  const { user, role } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState<PropertyRow | null>(null);
  const [ai, setAi] = useState<Record<string, string>>({});
  const [cleaners, setCleaners] = useState<ConnectedProfile[]>([]);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [porterActive, setPorterActive] = useState(false);
  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [step, setStep] = useState<StepKey>("imovel");

  // Convite de uma diarista nova, a partir desta tela
  const [invite, setInvite] = useState({ name: "", phone: "" });
  const [inviting, setInviting] = useState(false);
  const [waLink, setWaLink] = useState<string | null>(null);

  // Link permanente do painel da diarista já vinculada. Não vem no carregamento:
  // o token só existe em claro no instante em que é gerado.
  const [panelLink, setPanelLink] = useState<{
    cleaner_id: string;
    access_url: string;
    whatsapp_link: string | null;
    replaced_previous: boolean;
  } | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Calendário — uma fonte por canal. O banco já tratava assim desde a 0004
  // (UNIQUE property_id, provider); era a tela que só enxergava uma.
  const [icals, setIcals] = useState<IcalSource[]>([]);
  const [icalUrl, setIcalUrl] = useState<Record<string, string>>({});
  // Token do calendário de saída. Só existe em memória, e só depois de o dono
  // pedir: o banco guarda o hash, então não há como "carregar o link salvo".
  const [feedToken, setFeedToken] = useState<string | null>(null);
  const [feedBusy, setFeedBusy] = useState(false);
  const [checkingIcal, setCheckingIcal] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  // Remoção em dois toques: um botão só, num formulário longo e rolado no
  // celular, é clique acidental esperando acontecer.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicar, setDuplicar] = useState(false);
  const [duplicando, setDuplicando] = useState(false);

  // Retrato do que está gravado. Com as seções separadas em etapas, dá para
  // digitar na primeira e sair pela sexta sem passar por um botão de salvar —
  // e o aviso de alteração pendente é o que impede isso de virar perda.
  const saved = useRef("");

  useEffect(() => {
    if (!user || !id) return;

    (async () => {
      const [prop, conn, inv, src, porter, agr] = await Promise.all([
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
        supabase.from("porter_status").select("active").eq("property_id", id).maybeSingle(),
        supabase
          .from("cleaner_agreements")
          .select("status, decline_note, turnover_price, supplies_monthly_price")
          .eq("property_id", id)
          .maybeSingle(),
      ]);

      if (!prop.data) {
        toast.error("Imóvel não encontrado");
        navigate("/imoveis", { replace: true });
        return;
      }

      const row = prop.data as PropertyRow;
      const connected = (conn.data ?? []) as ConnectedProfile[];

      // Um convite antigo continua `pending` mesmo depois de a diarista entrar
      // por outro link — e o aviso "ainda não aceitou" aparecia embaixo do
      // nome de quem já estava vinculada. Quem já é conexão não é pendência.
      const jaVinculados = new Set(connected.map((c) => c.phone_e164).filter(Boolean));

      setForm(row);
      setAi((row.ai_config ?? {}) as Record<string, string>);
      saved.current = snapshot(row, (row.ai_config ?? {}) as Record<string, string>);
      setCleaners(connected);
      setPending(
        ((inv.data ?? []) as PendingInvite[]).filter(
          (p) => !p.cleaner_phone_e164 || !jaVinculados.has(p.cleaner_phone_e164),
        ),
      );
      setIcals((src.data ?? []) as IcalSource[]);
      setPorterActive(Boolean((porter.data as { active: boolean } | null)?.active));
      setAgreement((agr.data ?? null) as Agreement | null);
      setLoading(false);
    })();
  }, [user, id, navigate]);

  const set = <K extends keyof PropertyRow>(key: K, value: PropertyRow[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const cleanerName = (cid: string) =>
    cleaners.find((c) => c.user_id === cid)?.full_name?.split(" ")[0] ?? "ela";

  const dirty = useMemo(
    () => Boolean(form) && snapshot(form!, ai) !== saved.current,
    [form, ai],
  );

  const goTo = (key: StepKey) => {
    setStep(key);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // Bolinha verde na etapa = a automação daquela etapa está no ar. É a mesma
  // leitura da lista de imóveis, para "Insumos desligado" lá ter um destino aqui.
  const stepDone = (key: StepKey): boolean => {
    if (!form) return false;
    switch (key) {
      case "imovel":
        return Boolean(form.name.trim() && form.address?.trim() && form.city?.trim());
      case "calendario":
        return icals.length > 0;
      case "limpeza":
        return form.self_clean || Boolean(form.cleaner_id);
      case "insumos":
        return form.supplies_enabled;
      case "atendimento":
        return Boolean(form.auto_message_confirmed_at) && form.ai_enabled;
      case "portaria":
        return porterActive;
    }
  };

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

  const duplicarImovel = async () => {
    setDuplicando(true);
    try {
      const r = await api.duplicarImovel(form!.id);

      // O aviso vem antes da navegação: o token do feed do imóvel original é
      // rotacionado para cruzar os dois calendários, e quem já tinha colado a
      // URL antiga no canal precisa colar a nova. Descobrir isso depois seria
      // descobrir por uma data vendida duas vezes.
      if (r.cruzado) {
        toast.success("Anúncio criado e calendários cruzados.", {
          description:
            "Atenção: o link de calendário do imóvel original foi renovado. " +
            "Copie o novo na etapa Calendário e cole no anúncio.",
          duration: 12_000,
        });
      } else {
        toast.warning(r.aviso ?? "Duplicado, mas sem cruzar os calendários.");
      }

      setDuplicar(false);
      navigate(`/imoveis/${r.id}`, { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui duplicar");
    } finally {
      setDuplicando(false);
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
    if (form.name.trim().length < 2) {
      goTo("imovel");
      return toast.error("O imóvel precisa de um nome");
    }

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
        supplies_enabled: form.supplies_enabled,
        supplies_monthly_price: Number(form.supplies_monthly_price),
        supplies_items: form.supplies_items ?? [],
        supplies_notes: form.supplies_notes ?? "",
      });
      saved.current = snapshot(form, ai);
      toast.success("Imóvel atualizado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar");
    } finally {
      setSaving(false);
    }
  };

  const generatePanelLink = async (cleanerId: string) => {
    setLinking(true);
    try {
      const res = await api.cleaner.link(cleanerId);
      setPanelLink({
        cleaner_id: cleanerId,
        access_url: res.access_url,
        whatsapp_link: res.whatsapp_link,
        replaced_previous: res.replaced_previous,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui gerar o link");
    } finally {
      setLinking(false);
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

  /**
   * Botão de salvar + navegação, repetido no rodapé de cada etapa.
   *
   * É um elemento, não um componente: declarado como função dentro do render,
   * cada digitação criaria um tipo novo e o React remontaria o rodapé inteiro.
   */
  const stepFooter = (
    <div className="space-y-2">
      <Button onClick={save} disabled={saving} className="h-12 w-full text-base font-bold">
        {saving && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
        Salvar alterações
      </Button>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={stepIndex === 0}
          onClick={() => goTo(STEPS[stepIndex - 1].key)}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          {stepIndex === 0 ? "Início" : STEPS[stepIndex - 1].label}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={stepIndex === STEPS.length - 1}
          onClick={() => goTo(STEPS[stepIndex + 1].key)}
        >
          {stepIndex === STEPS.length - 1 ? "Fim" : STEPS[stepIndex + 1].label}
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 pb-4">
      <header className="flex items-center gap-3">
        <Link
          to="/imoveis"
          aria-label="Voltar para a lista"
          className="-ml-2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="min-w-0 truncate text-lg font-bold">{form.name}</h1>

        {/* Duplicar e remover ficam aqui, no canto, fora da configuração.
            Antes a remoção morava dentro da etapa "Imóvel", logo abaixo dos
            campos: quem estava ajustando um horário de check-out esbarrava
            numa caixa vermelha de excluir. Ação destrutiva não divide espaço
            com o formulário do dia a dia. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setDuplicar(true)}
            aria-label="Duplicar imóvel"
            title="Duplicar para um segundo anúncio"
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label="Remover imóvel"
            title="Remover imóvel"
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Etapas — atalhos, não trilho. Rolam na horizontal no celular porque
          seis rótulos legíveis não cabem em 375px de largura. */}
      <nav
        aria-label="Etapas da configuração"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {STEPS.map((s) => {
          const active = s.key === step;
          const done = stepDone(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => goTo(s.key)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-white/[0.07] text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <s.icon className="h-4 w-4 shrink-0" />
              {s.label}
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  done ? "bg-success" : "bg-muted-foreground/30",
                )}
              />
            </button>
          );
        })}
      </nav>

      {dirty && (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          Você mudou algo e ainda não salvou. Trocar de etapa não perde nada — sair da página, sim.
        </p>
      )}

      {/* ---------------------------------------------------------- Imóvel */}
      {step === "imovel" && (
        <>
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

          {stepFooter}

        </>
      )}

      {/* ------------------------------------------------------ Calendário */}
      {step === "calendario" && (
        <>
          <section className="space-y-4 rounded-xl glass-card p-5">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold">Calendário</h2>
            </div>

            {icals.length === 0 && (
              <p className="rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                Sem calendário conectado. Enquanto não colar o link, nenhuma reserva entra sozinha e
                a agenda da diarista fica vazia.
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
                          virando limpeza. Normalmente o link foi regerado na plataforma — gere
                          outro e cole abaixo.
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
                    <p className="text-xs text-muted-foreground">
                      No {channel.label}: {channel.hint}
                    </p>
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
              Dá para conectar os dois ao mesmo tempo. Cada canal sincroniza sozinho a cada 15
              minutos, e no calendário as reservas aparecem com a cor do canal de origem.
            </p>
          </section>

          {/* ------------------------------------------- Calendário de saída */}
          <section className="space-y-4 rounded-xl glass-card p-5">
            <div className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold">Bloquear as datas entre os canais</h2>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Colar os links acima faz as reservas <strong>entrarem</strong>. Isto aqui faz elas{" "}
              <strong>saírem</strong>: cada canal passa a enxergar as datas ocupadas nos outros. Sem
              este passo, Airbnb e Booking continuam vendendo as mesmas noites — e a dupla reserva
              só aparece quando dois hóspedes chegam no mesmo dia.
            </p>

            {!feedToken ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={feedBusy}
                onClick={async () => {
                  setFeedBusy(true);
                  try {
                    setFeedToken(await api.ical.issueFeedToken(form!.id));
                  } catch {
                    toast.error("Não consegui gerar o link agora.");
                  } finally {
                    setFeedBusy(false);
                  }
                }}
              >
                {feedBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Gerar os links de saída
              </Button>
            ) : (
              <div className="space-y-3">
                {ICAL_CHANNELS.map((channel) => {
                  const link = icalFeedUrl(feedToken, channel.provider);
                  return (
                    <div
                      key={channel.provider}
                      className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn("h-2.5 w-2.5 rounded-full", channel.swatch)}
                          aria-hidden
                        />
                        <h3 className="text-sm font-semibold">Cole no {channel.label}</h3>
                      </div>
                      <p className="break-all rounded-lg bg-black/20 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {link}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          navigator.clipboard.writeText(link);
                          toast.success(`Link do ${channel.label} copiado`);
                        }}
                      >
                        Copiar
                      </Button>
                    </div>
                  );
                })}

                <p className="rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
                  Guarde os dois links agora — eles não aparecem de novo. Gerar outra vez cria links
                  novos e <strong>derruba estes</strong>: dentro do canal isso vira um calendário que
                  parou de bloquear, sem aviso.
                </p>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  Cada link é o do canal onde ele vai ser colado, e leva só as reservas dos{" "}
                  <strong>outros</strong> canais — nome de hóspede não vai junto. No Airbnb:
                  Calendário → Disponibilidade → Conectar a outro site → Importar calendário.
                </p>
              </div>
            )}
          </section>

          {stepFooter}
        </>
      )}

      {/* --------------------------------------------------------- Limpeza */}
      {step === "limpeza" && (
        <>
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
                          <span className="shrink-0 text-xs font-medium text-primary">
                            Vinculada
                          </span>
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

                    {/* O outro lado do aceite. Sem isto a tela de aprovações
                        dela seria um buraco: ele proporia um valor e nunca
                        saberia se ela concordou. Muda de valor aqui embaixo e o
                        aceite volta a ficar pendente — o gatilho da 0035 cuida. */}
                    {form.cleaner_id && agreement && (
                      <div
                        className={cn(
                          "rounded-xl p-3 text-xs leading-relaxed",
                          agreement.status === "accepted" && "bg-success/10 text-success",
                          agreement.status === "pending" && "bg-warning/10 text-warning",
                          agreement.status === "declined" && "bg-destructive/10 text-destructive",
                        )}
                      >
                        {agreement.status === "accepted" && (
                          <>
                            <span className="font-medium">Ela aceitou o combinado</span> — R${" "}
                            {Number(agreement.turnover_price).toFixed(2).replace(".", ",")} por
                            limpeza
                            {Number(agreement.supplies_monthly_price) > 0 &&
                              ` e R$ ${Number(agreement.supplies_monthly_price).toFixed(2).replace(".", ",")} por mês de reposição`}
                            .
                          </>
                        )}
                        {agreement.status === "pending" && (
                          <>
                            <span className="font-medium">Aguardando o aceite dela.</span> O valor
                            aparece no painel dela em Aprovações. Enquanto ela não responder, o
                            combinado é só uma proposta.
                          </>
                        )}
                        {agreement.status === "declined" && (
                          <>
                            <span className="font-medium">Ela não concordou com o valor.</span>
                            {agreement.decline_note && ` Resposta dela: “${agreement.decline_note}”`}
                          </>
                        )}
                      </div>
                    )}

                    {/* Link do painel dela. Some quando ninguém está vinculado,
                        porque sem vínculo não há agenda para o link abrir. */}
                    {form.cleaner_id && (
                      <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                        <div className="flex items-center gap-2">
                          <LinkIcon className="h-4 w-4 text-muted-foreground" />
                          <p className="text-sm font-medium">Link do painel dela</p>
                        </div>

                        <p className="text-xs leading-relaxed text-muted-foreground">
                          É por ele que {cleanerName(form.cleaner_id)} entra na agenda, vê as saídas
                          do dia e marca a limpeza como feita. Ela digita só o telefone — senha não
                          existe. O link é permanente: vale para salvar na tela inicial do celular
                          dela.
                        </p>

                        {panelLink?.cleaner_id === form.cleaner_id ? (
                          <div className="space-y-2">
                            <p className="break-all rounded-lg bg-muted p-2.5 font-mono text-[11px] leading-relaxed">
                              {panelLink.access_url}
                            </p>

                            {panelLink.replaced_previous && (
                              <p className="text-xs leading-relaxed text-warning">
                                O link anterior deixou de valer. Se ela já tinha um salvo, mande
                                este.
                              </p>
                            )}

                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="flex-1"
                                onClick={() => {
                                  navigator.clipboard.writeText(panelLink.access_url);
                                  setLinkCopied(true);
                                  setTimeout(() => setLinkCopied(false), 2000);
                                }}
                              >
                                {linkCopied ? (
                                  <Check className="mr-2 h-4 w-4" />
                                ) : (
                                  <Copy className="mr-2 h-4 w-4" />
                                )}
                                {linkCopied ? "Copiado" : "Copiar"}
                              </Button>

                              {panelLink.whatsapp_link && (
                                <Button asChild size="sm" className="flex-1">
                                  <a
                                    href={panelLink.whatsapp_link}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Enviar no WhatsApp
                                  </a>
                                </Button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={() => generatePanelLink(form.cleaner_id!)}
                              disabled={linking}
                            >
                              {linking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                              Mostrar o link
                            </Button>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              O link fica guardado embaralhado, então não dá para lê-lo de volta —
                              mostrar gera um novo e derruba o anterior.
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {pending.length > 0 && (
                  <div className="rounded-xl bg-warning/10 p-3">
                    <p className="text-xs font-medium text-warning">Convite ainda não aceito</p>
                    <ul className="mt-1 space-y-0.5">
                      {/* O número aparece porque o mesmo nome pode ter sido
                          convidado duas vezes em números diferentes — e aí o
                          aviso parece contradizer a diarista já vinculada logo
                          acima. Com o telefone à vista, dá para ver qual é qual. */}
                      {pending.map((p) => (
                        <li key={p.id} className="text-xs text-muted-foreground">
                          {p.cleaner_name}
                          {p.cleaner_phone_e164 && ` · ${p.cleaner_phone_e164}`}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      Esse convite foi enviado mas o link não foi aberto. Enquanto não aceitarem,
                      não dá para vincular a nenhum imóvel — o vínculo só existe depois do aceite.
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

          {/* Os termos ficam na etapa da limpeza porque é aqui que a
              declaração da diarista nasce — e o do hóspede vem junto porque o
              dono procura "os documentos", não "os documentos de cada tipo". */}
          <TermosAssinados propertyId={form.id} />

          {stepFooter}
        </>
      )}

      {/* --------------------------------------------------------- Insumos */}
      {step === "insumos" && (
        <>
          <section className="space-y-4 rounded-xl glass-card p-5">
            <div className="flex items-center gap-2">
              <ShoppingBasket className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold">Reposição de itens</h2>
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">
              Um valor fixo por mês para a diarista repor o que acaba — papel, café, sabão, pilha.
              Ela vê a lista na agenda dela; você vê o valor no Financeiro como despesa do mês.
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
              <Checkbox
                checked={form.supplies_enabled}
                onCheckedChange={(v) => {
                  const on = Boolean(v);
                  set("supplies_enabled", on);
                  // Ligar com a lista vazia deixaria a diarista sem saber o que
                  // repor — o combinado começa preenchido e o dono tira o que não usa.
                  if (on && (form.supplies_items ?? []).length === 0) {
                    set("supplies_items", SUPPLIES_SUGERIDOS);
                  }
                }}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-medium">Combinar reposição com a diarista</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Desligado, nada disso aparece para ela.
                </span>
              </span>
            </label>

            {form.supplies_enabled && (
              <>
                <div className="space-y-1.5">
                  <Label>Valor fixo por mês (R$)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="10"
                    value={String(form.supplies_monthly_price ?? 0)}
                    onChange={(e) => set("supplies_monthly_price", Number(e.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">
                    O que você paga a ela por mês, além das diárias de limpeza.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>O que ela repõe</Label>
                  <div className="flex flex-wrap gap-2">
                    {(form.supplies_items ?? []).map((item) => (
                      <span
                        key={item}
                        className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs"
                      >
                        {item}
                        <button
                          type="button"
                          aria-label={`Remover ${item}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            set(
                              "supplies_items",
                              (form.supplies_items ?? []).filter((i) => i !== item),
                            )
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>

                  <Input
                    placeholder="Adicionar item e apertar Enter"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const valor = e.currentTarget.value.trim();
                      if (!valor) return;
                      const atuais = form.supplies_items ?? [];
                      if (!atuais.includes(valor)) set("supplies_items", [...atuais, valor]);
                      e.currentTarget.value = "";
                    }}
                  />

                  {(form.supplies_items ?? []).length === 0 && (
                    <button
                      type="button"
                      className="text-xs font-medium text-primary hover:underline"
                      onClick={() => set("supplies_items", SUPPLIES_SUGERIDOS)}
                    >
                      Usar a lista sugerida
                    </button>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>Observações para a diarista (opcional)</Label>
                  <Textarea
                    rows={2}
                    value={form.supplies_notes ?? ""}
                    onChange={(e) => set("supplies_notes", e.target.value)}
                    placeholder="Ex.: marca do café, onde guardar as compras, guardar a nota."
                  />
                </div>
              </>
            )}
          </section>

          {stepFooter}
        </>
      )}

      {/* ----------------------------------------------------- Atendimento */}
      {step === "atendimento" && (
        <>
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
              <p className="text-center text-xs text-success">
                Você marcou que já configurou no Airbnb.
              </p>
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

          {stepFooter}

          {/* Depois do rodapé de propósito: o cartão tem gravação própria (a
              senha vai para o cofre por outro caminho) e, acima do botão, o
              dono leria "Salvar alterações" como se salvasse a credencial. */}
          <HermesCard propertyId={form.id} />
        </>
      )}

      {/* -------------------------------------------------------- Portaria */}
      {step === "portaria" && (
        <>
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

          {/* O formulário de credenciais NÃO aparece para o dono.
              Colocar a oferta antes dele não resolveu: os seis campos de API
              continuavam logo abaixo, e o efeito de deixá-los à vista é o
              oposto do que o produto promete. A pessoa lê "applicationKey",
              "totpSecret", "deviceId", conclui que precisa entender aquilo
              antes de a portaria funcionar, e desiste da automação inteira —
              ou pior, tenta preencher, erra, e passa a achar que o produto
              não funciona.

              Quem implanta é a equipe técnica, e é ela quem precisa do
              formulário. Por isso ele fica atrás do papel de admin: mesma
              tela, mesmo imóvel, sem exigir uma ferramenta separada. */}
          <PortariaOferta propertyId={form.id} />

          {role === "admin" && (
            <div className="space-y-2">
              <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                Abaixo é a implantação técnica, visível só para a equipe. O dono do imóvel não vê
                esta parte.
              </p>
              <PorterConnect propertyId={form.id} />
            </div>
          )}

          {stepFooter}
        </>
      )}

      {/* ------------------------------------------------- remover imóvel */}
      <Dialog open={confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remover {form.name}?</DialogTitle>
            <DialogDescription>
              Isto muda coisas que a diarista e o calendário vão sentir.
            </DialogDescription>
          </DialogHeader>

          {/* A lista existe porque "tem certeza?" não informa nada. O que a
              pessoa precisa saber antes de confirmar é o que ela não consegue
              desfazer sozinha depois. */}
          <ul className="space-y-2 text-sm">
            {[
              "O imóvel sai da sua lista e para de gerar limpeza.",
              "As limpezas ainda não feitas são canceladas e somem da agenda da diarista.",
              "Os calendários conectados param de trazer reservas novas.",
              "O histórico de reservas e o financeiro dos meses passados ficam guardados — nada de contabilidade se perde.",
            ].map((t) => (
              <li key={t} className="flex gap-2 text-muted-foreground">
                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                <span className="leading-relaxed">{t}</span>
              </li>
            ))}
          </ul>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={archive} disabled={deleting} className="min-h-[44px]">
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remover imóvel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------ duplicar imóvel */}
      <Dialog open={duplicar} onOpenChange={(v) => !v && setDuplicar(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Criar um segundo anúncio</DialogTitle>
            <DialogDescription>
              Mesmo apartamento, outro anúncio — com os calendários travados um contra o outro.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <p className="leading-relaxed text-muted-foreground">
              A cópia leva a configuração toda: endereço, horários, diarista, preço da limpeza e
              as respostas do assistente. Ela não leva reservas nem limpezas — essas pertencem ao
              anúncio que as gerou.
            </p>

            {/* O cruzamento é o motivo de existir este botão, e é o que ninguém
                lembra de fazer na mão. Dito com o nome do problema, não com o
                nome da funcionalidade. */}
            <div className="rounded-lg border border-primary/25 bg-primary/[0.05] p-3">
              <p className="text-xs font-semibold text-primary">Os dois calendários nascem ligados</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Reserva que entrar em um bloqueia a data no outro, automaticamente. É isso que
                impede os dois anúncios de venderem a mesma noite e dois hóspedes chegarem na
                mesma porta.
              </p>
            </div>

            <div className="rounded-lg bg-warning/[0.08] p-3">
              <p className="text-xs leading-relaxed text-warning">
                O link de calendário <strong>deste</strong> imóvel será renovado para fazer a
                ligação. Depois de duplicar, copie o novo na etapa Calendário e cole no seu
                anúncio do Airbnb ou Booking — o antigo para de funcionar.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setDuplicar(false)} disabled={duplicando}>
              Cancelar
            </Button>
            <Button onClick={duplicarImovel} disabled={duplicando} className="min-h-[44px]">
              {duplicando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Criar segundo anúncio
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Só os campos que `save()` grava. iCal, portaria e convite têm gravação
 * própria e não podem contar como "alteração pendente" do formulário.
 */
function snapshot(p: PropertyRow, ai: Record<string, string>): string {
  return JSON.stringify([
    p.name, p.property_type, p.address, p.street_number, p.apt_number, p.block,
    p.neighborhood, p.city, p.state, p.zip_code, p.condo_name, p.condo_email,
    p.condo_notify, hhmm(p.checkin_time), hhmm(p.checkout_time), Number(p.turnover_price),
    p.self_clean, p.cleaner_id, p.ai_enabled, p.supplies_enabled,
    Number(p.supplies_monthly_price), p.supplies_items ?? [], p.supplies_notes ?? "",
    ai,
  ]);
}
