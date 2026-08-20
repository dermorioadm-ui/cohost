import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BadgeCheck,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  ImageUp,
  Loader2,
  Receipt,
  ShoppingBasket,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AssinarLimpeza } from "@/components/AssinarLimpeza";
import { AssinaturasPendentes } from "@/components/AssinaturasPendentes";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { styleOf, type Provider } from "@/lib/channels";
import { cn } from "@/lib/utils";
import {
  brl,
  currentMonth,
  FEE_CATEGORIES,
  type FeeCategory,
  type FeeStatus,
  FEE_STATUS_LABEL,
  monthLabel,
  parseAmount,
  shiftMonth,
} from "@/lib/fees";

interface Task {
  id: string;
  property_id: string;
  reservation_id: string | null;
  checkout_date: string;
  checkout_time: string | null;
  next_checkin_date: string | null;
  status: string;
  turnover_price: number;
  photo_path: string | null;
}

interface Property {
  id: string;
  name: string;
  neighborhood: string | null;
  owner_id: string;
  supplies_enabled: boolean | null;
  supplies_items: string[] | null;
  supplies_notes: string | null;
}

interface Fee {
  id: string;
  amount: number;
  status: FeeStatus;
  categories: string[];
  description: string | null;
  property_id: string | null;
  decision_note: string | null;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // igual ao limite do bucket (0014)

/**
 * Agenda da diarista.
 *
 * Tela de celular, usada em pé, no corredor do prédio. Por isso: um cartão por
 * limpeza, o horário grande, e um botão só. Nada de menu ou filtro.
 *
 * O "entrada no mesmo dia" é a informação que ela mais precisa e que ninguém
 * dava antes — é o que define se ela tem quatro horas ou quarenta minutos.
 *
 * A foto e o lançamento de compra são deliberadamente secundários: ficam em
 * botão discreto, para não disputar atenção com "concluir", que é o que ela
 * abriu o app para fazer.
 */
export default function CleanerAgenda() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [fees, setFees] = useState<Fee[]>([]);
  /** reservation_id -> canal. É o que pinta a tarja lateral do cartão. */
  const [providers, setProviders] = useState<Record<string, Provider>>({});
  const [pendentes, setPendentes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [feeOpen, setFeeOpen] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const month = currentMonth();

  const propertyById = useMemo(
    () => Object.fromEntries(properties.map((p) => [p.id, p])),
    [properties],
  );

  const propertyLabel = (id: string | null) => {
    if (!id) return "Sem imóvel";
    const p = propertyById[id];
    return p ? [p.name, p.neighborhood].filter(Boolean).join(" · ") : "Imóvel";
  };

  const loadFees = async () => {
    const { data } = await supabase
      .from("cleaner_fees")
      .select("id, amount, status, categories, description, property_id, decision_note")
      .eq("reference_month", month)
      .order("created_at", { ascending: false });
    setFees((data ?? []) as Fee[]);
  };

  useEffect(() => {
    if (!user) return;
    (async () => {
      const monthEndDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
        .toISOString().slice(0, 10);

      const [tsk, props, cal, agr] = await Promise.all([
        supabase
          .from("cleaning_tasks")
          .select("id, property_id, reservation_id, checkout_date, checkout_time, next_checkin_date, status, turnover_price, photo_path")
          .gte("checkout_date", today)
          .lte("checkout_date", monthEndDate)
          .neq("status", "cancelled")
          .order("checkout_date")
          .order("checkout_time"),
        // Não lê `properties` direto: a tabela guarda código de fechadura e
        // senha de Wi-Fi na mesma linha, e RLS filtra linha, não coluna. A
        // função devolve só as colunas de trabalho (migration 0022).
        supabase.rpc("my_cleaning_properties"),
        // Só para saber de qual canal veio cada limpeza — a tarja do cartão.
        // Pela mesma razão, é função e não a tabela: `reservations` carrega
        // quem é o hóspede, e isso não é dela.
        supabase.rpc("my_cleaning_calendar", { _from: today, _to: monthEndDate }),
        supabase
          .from("cleaner_agreements")
          .select("id")
          .eq("status", "pending"),
      ]);

      setTasks((tsk.data ?? []) as Task[]);
      setProperties((props.data ?? []) as Property[]);
      setProviders(
        Object.fromEntries(
          ((cal.data ?? []) as Array<{ id: string; provider: Provider }>).map((r) => [
            r.id,
            r.provider,
          ]),
        ),
      );
      setPendentes((agr.data ?? []).length);
      await loadFees();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, today]);

  const complete = async (id: string) => {
    setSaving(id);
    // completed_at e completed_by são carimbados pelo gatilho no banco —
    // não confiamos no relógio do celular.
    const { error } = await supabase
      .from("cleaning_tasks")
      .update({ status: "completed" })
      .eq("id", id);

    if (error) {
      toast.error("Não consegui salvar. Tente de novo.");
    } else {
      setTasks((t) => t.map((x) => (x.id === id ? { ...x, status: "completed" } : x)));
      toast.success("Limpeza concluída! O cliente foi avisado.");
    }
    setSaving(null);
  };

  /**
   * A foto vai para `cleaning-photos/<task_id>/<arquivo>`. O primeiro segmento
   * do caminho não é enfeite: a policy do bucket confere que ele é o id de uma
   * tarefa atribuída a quem está enviando.
   */
  const sendPhoto = async (task: Task, file: File) => {
    if (file.size > MAX_PHOTO_BYTES) {
      toast.error("Essa foto é muito grande. Tente tirar outra.");
      return;
    }

    setUploading(task.id);
    const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
    const path = `${task.id}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("cleaning-photos")
      .upload(path, file, { contentType: file.type || undefined });

    if (uploadError) {
      toast.error("Não consegui enviar a foto. Tente de novo.");
      setUploading(null);
      return;
    }

    // photo_taken_at é carimbado pelo gatilho quando photo_path muda.
    const { error } = await supabase
      .from("cleaning_tasks")
      .update({ photo_path: path })
      .eq("id", task.id);

    if (error) {
      toast.error("A foto subiu, mas não consegui salvar. Tente de novo.");
    } else {
      setTasks((t) => t.map((x) => (x.id === task.id ? { ...x, photo_path: path } : x)));
      toast.success("Foto enviada.");
    }
    setUploading(null);
  };

  const grouped = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) (map[t.checkout_date] ??= []).push(t);
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [tasks]);

  const fmtDay = (iso: string) => {
    if (iso === today) return "Hoje";
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    if (iso === tomorrow) return "Amanhã";
    return new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", {
      weekday: "long", day: "numeric", month: "short",
    });
  };

  const monthTotal = tasks
    .filter((t) => t.status === "completed")
    .reduce((s, t) => s + Number(t.turnover_price), 0);

  const feesApproved = fees
    .filter((f) => f.status === "approved")
    .reduce((s, f) => s + Number(f.amount), 0);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="glass-accent rounded-2xl px-5 py-6">
        <p className="text-xs uppercase tracking-widest opacity-70">Sua agenda</p>
        <p className="mt-1 text-2xl font-extrabold">
          {tasks.filter((t) => t.checkout_date === today).length} limpeza(s) hoje
        </p>
        <p className="text-sm opacity-80 mt-1">
          {brl(monthTotal)} concluído neste mês
          {feesApproved > 0 && ` · ${brl(feesApproved)} em compras aprovadas`}
        </p>
      </header>

      {/* O que já venceu vem antes do que ainda vai acontecer. Assinatura
          atrasada é a única coisa da agenda que já deveria estar feita — e,
          desde que a fatura só cobra o assinado, é dinheiro parado. */}
      <AssinaturasPendentes />

      {/* Combinado esperando resposta. Fica acima de tudo porque é dinheiro
          dela: sem o aceite, o valor da limpeza continua sendo uma proposta. */}
      {pendentes > 0 && (
        <Link
          to="/aprovacoes"
          className="flex items-center gap-3 rounded-2xl bg-warning/10 px-4 py-3.5 text-warning"
        >
          <BadgeCheck className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1 text-sm font-semibold">
            {pendentes === 1
              ? "1 combinado esperando você aceitar"
              : `${pendentes} combinados esperando você aceitar`}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Link>
      )}

      {properties.length > 0 && (
        <Button
          variant="outline"
          onClick={() => setFeeOpen(true)}
          className="w-full h-12 justify-start gap-3 font-semibold"
        >
          <ShoppingBasket className="h-5 w-5 shrink-0 text-primary" />
          Comprei alguma coisa para o apartamento
        </Button>
      )}

      {/* O combinado de reposição. Fica no topo, junto do botão de compra, e
          não dentro de cada tarefa: é acordo do mês, não do dia — repetir em
          toda limpeza viraria ruído que ela para de ler. */}
      {properties
        .filter((p) => p.supplies_enabled && (p.supplies_items ?? []).length > 0)
        .map((p) => (
          <section key={p.id} className="rounded-2xl glass-card p-4">
            <div className="flex items-center gap-2">
              <ShoppingBasket className="h-4 w-4 shrink-0 text-primary" />
              <h2 className="text-sm font-semibold">
                Reposição combinada
                {properties.length > 1 && (
                  <span className="font-normal text-muted-foreground"> · {p.name}</span>
                )}
              </h2>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              Estes itens você repõe e já estão pagos no valor fixo do mês — não
              precisa lançar como compra avulsa.
            </p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {(p.supplies_items ?? []).map((item) => (
                <span key={item} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                  {item}
                </span>
              ))}
            </div>

            {p.supplies_notes && (
              <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
                {p.supplies_notes}
              </p>
            )}
          </section>
        ))}

      {grouped.length === 0 && (
        <div className="rounded-2xl glass-card p-8 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto" />
          <p className="mt-3 font-semibold">Nada por enquanto</p>
          <p className="text-sm text-muted-foreground mt-1">
            Quando entrar reserva, aparece aqui sozinho.
          </p>
        </div>
      )}

      {grouped.map(([date, dayTasks]) => (
        <section key={date}>
          <h2
            className={cn(
              "text-sm font-bold capitalize mb-2",
              date === today ? "text-primary" : "text-muted-foreground",
            )}
          >
            {fmtDay(date)}
          </h2>

          <div className="space-y-3">
            {dayTasks.map((task) => {
              const sameDay = task.next_checkin_date === task.checkout_date;
              const provider = task.reservation_id ? providers[task.reservation_id] : undefined;

              return (
                <article
                  key={task.id}
                  className="relative overflow-hidden rounded-2xl glass-card p-5 pl-6"
                >
                  {/* Tarja do canal: Airbnb e Booking têm cores diferentes, e é
                      isso que ela lê de relance sem precisar de rótulo. Some na
                      limpeza avulsa, que não veio de reserva nenhuma. */}
                  {provider && (
                    <span
                      aria-hidden
                      title={styleOf(provider).label}
                      className={cn("absolute inset-y-0 left-0 w-1.5", styleOf(provider).stripe)}
                    />
                  )}

                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold leading-tight">
                        {propertyLabel(task.property_id)}
                      </p>
                      {provider && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {styleOf(provider).label}
                        </p>
                      )}
                      <p className="mt-2 text-2xl font-extrabold tabular-nums">
                        {task.checkout_time?.slice(0, 5) ?? "--:--"}
                      </p>
                      {sameDay && (
                        <p className="mt-1 text-xs font-semibold text-amber-600">
                          Entrada no mesmo dia — precisa estar pronto
                        </p>
                      )}
                    </div>
                    <span className="text-lg font-bold text-primary whitespace-nowrap">
                      R$ {Number(task.turnover_price).toFixed(0)}
                    </span>
                  </div>

                  {task.status === "completed" ? (
                    <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950 px-4 py-3 text-emerald-700 dark:text-emerald-300">
                      <Check className="h-5 w-5" />
                      <span className="font-semibold text-sm">Concluída</span>
                    </div>
                  ) : date === today ? (
                    /* Assinar substituiu "marcar como concluída": o toque é o
                       mesmo, e o que sai do outro lado deixou de ser um
                       registro que o app criou sozinho e passou a ser uma
                       declaração dela, com data, hora e assinatura. */
                    <AssinarLimpeza
                      taskId={task.id}
                      imovel={properties.find((p) => p.id === task.property_id)?.name ?? "o imóvel"}
                      onPronto={() =>
                        setTasks((t) =>
                          t.map((x) => (x.id === task.id ? { ...x, status: "completed" } : x)),
                        )
                      }
                    />
                  ) : null}

                  <PhotoButton
                    task={task}
                    busy={uploading === task.id}
                    onPick={(file) => sendPhoto(task, file)}
                  />
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {fees.length > 0 && (
        <section>
          <h2 className="text-sm font-bold text-muted-foreground mb-2">
            Suas compras de {monthLabel(month)}
          </h2>
          <div className="space-y-2">
            {fees.map((fee) => (
              <article
                key={fee.id}
                className="rounded-xl glass-card px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{brl(fee.amount)}</span>
                  <span
                    className={cn(
                      "text-xs font-semibold",
                      fee.status === "approved" && "text-emerald-600",
                      fee.status === "rejected" && "text-destructive",
                      fee.status === "pending" && "text-amber-600",
                    )}
                  >
                    {FEE_STATUS_LABEL[fee.status]}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {propertyLabel(fee.property_id)}
                  {fee.description ? ` · ${fee.description}` : ""}
                </p>
                {fee.status === "rejected" && fee.decision_note && (
                  <p className="mt-1 text-xs text-destructive">{fee.decision_note}</p>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <FeeDialog
        open={feeOpen}
        onOpenChange={setFeeOpen}
        properties={properties}
        defaultPropertyId={
          tasks.find((t) => t.checkout_date === today)?.property_id ?? properties[0]?.id ?? ""
        }
        cleanerId={user?.id ?? ""}
        onSaved={loadFees}
      />
    </div>
  );
}

/** Botão de foto — discreto, e some do caminho quando já existe uma. */
function PhotoButton({
  task,
  busy,
  onPick,
}: {
  task: Task;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Zera o valor para permitir reenviar o mesmo arquivo depois de um erro.
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className={cn(
          "mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed py-2.5 text-sm font-medium transition-colors",
          task.photo_path
            ? "border-emerald-300 text-emerald-700 dark:text-emerald-400"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          busy && "opacity-60",
        )}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : task.photo_path ? (
          <ImageUp className="h-4 w-4" />
        ) : (
          <Camera className="h-4 w-4" />
        )}
        {busy ? "Enviando…" : task.photo_path ? "Foto enviada — trocar" : "Enviar foto do imóvel"}
      </button>
    </>
  );
}

/**
 * Lançamento de compra.
 *
 * A competência é escolhida na mão porque comprar dia 31 e lançar dia 1 é o
 * caso normal, não a exceção — e foi somar tudo no mês errado que quebrou o
 * fechamento financeiro do produto antigo.
 */
function FeeDialog({
  open,
  onOpenChange,
  properties,
  defaultPropertyId,
  cleanerId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  properties: Property[];
  defaultPropertyId: string;
  cleanerId: string;
  onSaved: () => Promise<void>;
}) {
  const thisMonth = currentMonth();
  const lastMonth = shiftMonth(thisMonth, -1);

  const [propertyId, setPropertyId] = useState(defaultPropertyId);
  const [reference, setReference] = useState(thisMonth);
  const [categories, setCategories] = useState<FeeCategory[]>([]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPropertyId(defaultPropertyId);
      setReference(thisMonth);
      setCategories([]);
      setAmount("");
      setDescription("");
      setReceipt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultPropertyId]);

  const toggle = (value: FeeCategory) =>
    setCategories((c) => (c.includes(value) ? c.filter((x) => x !== value) : [...c, value]));

  const save = async () => {
    const value = parseAmount(amount);
    if (value === null) {
      toast.error("Digite quanto você gastou, por exemplo 18,50.");
      return;
    }
    // Espelha o CHECK fee_has_content: sem categoria e sem descrição o banco
    // recusaria, e a diarista veria um erro que não explica nada.
    if (categories.length === 0 && description.trim() === "") {
      toast.error("Marque o que você comprou ou escreva no campo abaixo.");
      return;
    }
    const property = properties.find((p) => p.id === propertyId);
    if (!property) {
      toast.error("Escolha o apartamento.");
      return;
    }

    setSaving(true);
    const { data: created, error } = await supabase
      .from("cleaner_fees")
      .insert({
        owner_id: property.owner_id,
        cleaner_id: cleanerId,
        property_id: property.id,
        reference_month: reference,
        categories,
        description: description.trim() || null,
        amount: value,
      })
      .select("id")
      .single();

    if (error || !created) {
      toast.error("Não consegui lançar. Tente de novo.");
      setSaving(false);
      return;
    }

    // O comprovante só pode subir depois do lançamento existir: o caminho no
    // bucket é <fee_id>/<arquivo>, e a policy confere esse id.
    if (receipt) {
      const ext = (receipt.name.split(".").pop() ?? "jpg").toLowerCase();
      const path = `${created.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("fee-receipts")
        .upload(path, receipt, { contentType: receipt.type || undefined });

      if (upErr) {
        toast.warning("Lancei a compra, mas o comprovante não subiu.");
      } else {
        await supabase.from("cleaner_fees").update({ receipt_path: path }).eq("id", created.id);
      }
    }

    await onSaved();
    setSaving(false);
    onOpenChange(false);
    toast.success("Lançado! O cliente vai aprovar.");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>O que você comprou?</DialogTitle>
          <DialogDescription>
            O cliente aprova e o valor entra no fechamento do mês.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {properties.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="fee-property">Apartamento</Label>
              <select
                id="fee-property"
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
                className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {[p.name, p.neighborhood].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="fee-amount">Quanto foi</Label>
            <Input
              id="fee-amount"
              inputMode="decimal"
              placeholder="18,50"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-12 text-lg font-semibold"
            />
          </div>

          <div className="space-y-2">
            <Label>O que era</Label>
            <div className="flex flex-wrap gap-2">
              {FEE_CATEGORIES.map((c) => {
                const on = categories.includes(c.value);
                return (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => toggle(c.value)}
                    className={cn(
                      "rounded-full border px-3 py-2 text-sm font-medium transition-colors",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fee-note">Detalhe (opcional)</Label>
            <Textarea
              id="fee-note"
              rows={2}
              placeholder="2 sabonetes e 1 detergente"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Mês da compra</Label>
            <div className="grid grid-cols-2 gap-2">
              {[thisMonth, lastMonth].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setReference(m)}
                  className={cn(
                    "rounded-xl border px-3 py-2.5 text-sm font-medium capitalize transition-colors",
                    reference === m
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {monthLabel(m)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fee-receipt" className="flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Foto do comprovante (opcional)
            </Label>
            <Input
              id="fee-receipt"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
              className="h-11 py-2 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-sm"
            />
          </div>
        </div>

        <Button onClick={save} disabled={saving} className="h-14 w-full text-base font-bold">
          {saving && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
          Lançar compra
        </Button>
      </DialogContent>
    </Dialog>
  );
}
