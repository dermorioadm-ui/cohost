import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  Receipt,
  Sparkles,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import {
  brl,
  categoryLabel,
  currentMonth,
  type FeeStatus,
  monthEnd,
  monthLabel,
  shiftMonth,
  shortDate,
} from "@/lib/fees";

/** Uma linha por diarista, vinda de owner_month_summary(). */
interface SummaryRow {
  cleaner_id: string | null;
  cleaner_name: string;
  cleanings: number;
  turnover_total: number;
  fees_total: number;
  subtotal: number;
}

interface Fee {
  id: string;
  amount: number;
  status: FeeStatus;
  categories: string[];
  description: string | null;
  property_id: string | null;
  cleaner_id: string;
  receipt_path: string | null;
  decision_note: string | null;
  created_at: string;
}

interface CompletedTask {
  id: string;
  property_id: string;
  checkout_date: string;
  turnover_price: number;
  photo_path: string | null;
}

/**
 * Fechamento do mês.
 *
 * Os números saem de `owner_month_summary()` — a MESMA função que o
 * `job-monthly-report` usa para montar o e-mail do dia 1. Recalcular aqui no
 * cliente seria pedir para a tela e o e-mail discordarem, e o dono acreditar
 * em qual dos dois?
 *
 * Só taxa APROVADA entra no total: o que está aguardando aparece em separado,
 * como decisão pendente, não como despesa.
 */
export default function Financeiro() {
  const { user } = useAuth();
  const [month, setMonth] = useState(currentMonth());
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [fees, setFees] = useState<Fee[]>([]);
  const [tasks, setTasks] = useState<CompletedTask[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Fee | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const isCurrent = month === currentMonth();

  const load = useCallback(async () => {
    setLoading(true);
    const [sum, fee, tsk, props] = await Promise.all([
      supabase.rpc("owner_month_summary", { _month: month }),
      supabase
        .from("cleaner_fees")
        .select(
          "id, amount, status, categories, description, property_id, cleaner_id, receipt_path, decision_note, created_at",
        )
        .eq("reference_month", month)
        .order("created_at", { ascending: false }),
      supabase
        .from("cleaning_tasks")
        .select("id, property_id, checkout_date, turnover_price, photo_path")
        .eq("status", "completed")
        .gte("checkout_date", month)
        .lte("checkout_date", monthEnd(month))
        .order("checkout_date", { ascending: false }),
      supabase.from("properties").select("id, name"),
    ]);

    if (sum.error) toast.error("Não consegui carregar o resumo do mês.");

    setSummary((sum.data ?? []) as SummaryRow[]);
    setFees((fee.data ?? []) as Fee[]);
    setTasks((tsk.data ?? []) as CompletedTask[]);
    setProperties(
      Object.fromEntries(
        ((props.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
      ),
    );
    setLoading(false);
  }, [month]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const decide = async (fee: Fee, status: "approved" | "rejected", note?: string) => {
    setDeciding(fee.id);
    // decided_at e decided_by são carimbados pelo gatilho; o mesmo gatilho
    // impede que o dono altere valor, categoria ou competência.
    const { error } = await supabase
      .from("cleaner_fees")
      .update({ status, decision_note: note?.trim() || null })
      .eq("id", fee.id);

    if (error) {
      toast.error("Não consegui salvar a decisão.");
    } else {
      toast.success(status === "approved" ? "Compra aprovada." : "Compra recusada.");
      await load();
    }
    setDeciding(null);
    setRejecting(null);
  };

  const openPhoto = async (bucket: string, path: string) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
    if (error || !data) {
      toast.error("Não consegui abrir o arquivo.");
      return;
    }
    setPhotoUrl(data.signedUrl);
  };

  const cleanings = summary.reduce((s, r) => s + Number(r.cleanings ?? 0), 0);
  const turnover = summary.reduce((s, r) => s + Number(r.turnover_total ?? 0), 0);
  const feesApproved = summary.reduce((s, r) => s + Number(r.fees_total ?? 0), 0);
  const total = turnover + feesApproved;

  const pending = fees.filter((f) => f.status === "pending");
  const decided = fees.filter((f) => f.status !== "pending");

  const cleanerName = (id: string) =>
    summary.find((r) => r.cleaner_id === id)?.cleaner_name ?? "Diarista";

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold">Financeiro</h1>
          <p className="text-sm capitalize text-muted-foreground">{monthLabel(month)}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Mês anterior"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Próximo mês"
            disabled={isCurrent}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <section className="glass-accent rounded-2xl px-5 py-6">
            <p className="text-xs uppercase tracking-widest opacity-70">Total do mês</p>
            <p className="mt-1 text-3xl font-extrabold tabular-nums">{brl(total)}</p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs opacity-70">Limpezas</p>
                <p className="font-bold tabular-nums">{cleanings}</p>
              </div>
              <div>
                <p className="text-xs opacity-70">Diárias</p>
                <p className="font-bold tabular-nums">{brl(turnover)}</p>
              </div>
              <div>
                <p className="text-xs opacity-70">Reposição</p>
                <p className="font-bold tabular-nums">{brl(feesApproved)}</p>
              </div>
            </div>
          </section>

          {pending.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
                <Wallet className="h-4 w-4 text-amber-600" />
                Esperando sua aprovação ({pending.length})
              </h2>
              <div className="space-y-3">
                {pending.map((fee) => (
                  <article
                    key={fee.id}
                    className="rounded-2xl border border-warning/35 bg-warning/[0.08] p-4 backdrop-blur-sm"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-lg font-extrabold tabular-nums">{brl(fee.amount)}</span>
                      <span className="text-xs text-muted-foreground">
                        {shortDate(fee.created_at.slice(0, 10))}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-medium">
                      {properties[fee.property_id ?? ""] ?? "Sem imóvel"} ·{" "}
                      {cleanerName(fee.cleaner_id)}
                    </p>
                    {fee.categories.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {fee.categories.map(categoryLabel).join(", ")}
                      </p>
                    )}
                    {fee.description && (
                      <p className="mt-1 text-sm text-muted-foreground">{fee.description}</p>
                    )}

                    {fee.receipt_path && (
                      <button
                        type="button"
                        onClick={() => openPhoto("fee-receipts", fee.receipt_path!)}
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                      >
                        <Receipt className="h-3.5 w-3.5" />
                        Ver comprovante
                      </button>
                    )}

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        disabled={deciding === fee.id}
                        onClick={() => setRejecting(fee)}
                      >
                        Recusar
                      </Button>
                      <Button
                        disabled={deciding === fee.id}
                        onClick={() => decide(fee, "approved")}
                      >
                        {deciding === fee.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Aprovar
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {summary.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-bold text-muted-foreground">Por diarista</h2>
              <div className="glass overflow-hidden rounded-2xl">
                {summary.map((row, i) => (
                  <div
                    key={row.cleaner_id ?? `sem-${i}`}
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-3",
                      i > 0 && "border-t",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{row.cleaner_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.cleanings} limpeza(s) · {brl(row.turnover_total)} em diárias
                        {Number(row.fees_total) > 0 && ` · ${brl(row.fees_total)} em compras`}
                      </p>
                    </div>
                    <span className="font-bold tabular-nums">{brl(row.subtotal)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tasks.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-bold text-muted-foreground">
                Limpezas concluídas
              </h2>
              <div className="glass overflow-hidden rounded-2xl">
                {tasks.map((task, i) => (
                  <div
                    key={task.id}
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-3",
                      i > 0 && "border-t",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {properties[task.property_id] ?? "Imóvel"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {shortDate(task.checkout_date)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {task.photo_path && (
                        <button
                          type="button"
                          onClick={() => openPhoto("cleaning-photos", task.photo_path!)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                        >
                          <ImageIcon className="h-3.5 w-3.5" />
                          Foto
                        </button>
                      )}
                      <span className="text-sm font-semibold tabular-nums">
                        {brl(task.turnover_price)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {decided.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-bold text-muted-foreground">Compras decididas</h2>
              <div className="glass overflow-hidden rounded-2xl">
                {decided.map((fee, i) => (
                  <div
                    key={fee.id}
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-3",
                      i > 0 && "border-t",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {properties[fee.property_id ?? ""] ?? "Sem imóvel"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fee.categories.map(categoryLabel).join(", ") || fee.description}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "text-xs font-semibold",
                          fee.status === "approved" ? "text-emerald-600" : "text-destructive",
                        )}
                      >
                        {fee.status === "approved" ? "Aprovada" : "Recusada"}
                      </span>
                      <span className="text-sm font-semibold tabular-nums">{brl(fee.amount)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {total === 0 && pending.length === 0 && (
            <div className="rounded-2xl glass-card p-8 text-center">
              <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-semibold">Nada fechado em {monthLabel(month)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Limpezas concluídas e compras aprovadas aparecem aqui.
              </p>
            </div>
          )}
        </>
      )}

      {/* Recusa — a nota é opcional, mas é ela que a diarista vê. */}
      <Dialog open={rejecting !== null} onOpenChange={(v) => !v && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recusar a compra</DialogTitle>
            <DialogDescription>
              Se escrever um motivo, a diarista vê junto com o lançamento.
            </DialogDescription>
          </DialogHeader>
          <RejectForm
            fee={rejecting}
            busy={deciding !== null}
            onConfirm={(note) => rejecting && decide(rejecting, "rejected", note)}
          />
        </DialogContent>
      </Dialog>

      {/* Buckets são privados: a URL é assinada na hora e vale um minuto. */}
      <Dialog open={photoUrl !== null} onOpenChange={(v) => !v && setPhotoUrl(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Arquivo</DialogTitle>
          </DialogHeader>
          {photoUrl && (
            <img
              src={photoUrl}
              alt="Anexo enviado pela diarista"
              className="max-h-[70dvh] w-full rounded-xl object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RejectForm({
  fee,
  busy,
  onConfirm,
}: {
  fee: Fee | null;
  busy: boolean;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    setNote("");
  }, [fee?.id]);

  return (
    <div className="space-y-4">
      <Textarea
        rows={3}
        placeholder="Ex.: já tinha esse produto no armário"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        variant="destructive"
        className="w-full"
        disabled={busy}
        onClick={() => onConfirm(note)}
      >
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Recusar {fee ? brl(fee.amount) : ""}
      </Button>
    </div>
  );
}
