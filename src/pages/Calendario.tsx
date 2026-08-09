import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Calendário mensal.
 *
 * A grade mostra duas camadas diferentes, e a distinção importa:
 *
 *   - A RESERVA é uma faixa contínua, da entrada à saída. É o que ocupa o
 *     imóvel, e é por isso que ela atravessa os dias em vez de virar um ponto:
 *     olhando de relance o dono vê onde há buraco para bloquear uma data.
 *   - A LIMPEZA é um selo de um dia só, na data de saída. É trabalho, não
 *     ocupação.
 *
 * O vidro não é enfeite gratuito: as faixas se sobrepõem às células, e um
 * fundo translúcido deixa a grade continuar legível por baixo delas.
 */

interface Task {
  id: string;
  checkout_date: string;
  checkout_time: string | null;
  next_checkin_date: string | null;
  status: string;
  turnover_price: number | null;
  guest_label: string | null;
  property_id: string;
}

interface Reservation {
  id: string;
  property_id: string;
  checkin_date: string;
  checkout_date: string;
  guest_label: string | null;
}

/** Uma faixa já posicionada dentro de uma semana da grade. */
interface Bar {
  key: string;
  startCol: number;
  span: number;
  row: number;
  label: string;
  openLeft: boolean;
  openRight: boolean;
}

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const STATUS_LABEL: Record<string, string> = {
  pending: "A fazer",
  completed: "Concluída",
};

/**
 * Quantas faixas cabem numa célula antes de virar "+N".
 *
 * Duas, e não três: a célula tem 4.5rem no celular, a camada de faixas começa
 * 1.75rem abaixo do topo e cada linha ocupa 1.25rem com o respiro. Três linhas
 * dariam 4.5rem cravado, e a terceira vazaria por cima da semana seguinte.
 */
const MAX_BAR_ROWS = 2;

export default function Calendario() {
  const { user } = useAuth();
  const [cursor, setCursor] = useState(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  useEffect(() => {
    if (!user) return;
    setLoading(true);

    (async () => {
      const first = iso(new Date(year, month, 1));
      const last = iso(new Date(year, month + 1, 0));

      const [props, tsk, res] = await Promise.all([
        supabase.from("properties").select("id, name").is("archived_at", null),
        supabase
          .from("cleaning_tasks")
          .select(
            "id, checkout_date, checkout_time, next_checkin_date, status, turnover_price, guest_label, property_id",
          )
          .gte("checkout_date", first)
          .lte("checkout_date", last)
          .neq("status", "cancelled")
          .order("checkout_date"),
        // Reserva que ENCOSTA no mês, não só a que começa nele — senão uma
        // estadia que atravessa a virada do mês desaparece da grade.
        supabase
          .from("reservations")
          .select("id, property_id, checkin_date, checkout_date, guest_label")
          .eq("status", "confirmed")
          .lte("checkin_date", last)
          .gte("checkout_date", first)
          .order("checkin_date"),
      ]);

      setProperties(
        Object.fromEntries(
          ((props.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
        ),
      );
      setTasks((tsk.data ?? []) as Task[]);
      setReservations((res.data ?? []) as Reservation[]);
      setLoading(false);
    })();
  }, [user, year, month]);

  const byDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) (map[t.checkout_date] ??= []).push(t);
    return map;
  }, [tasks]);

  // Começa no domingo da semana do dia 1 e vai até fechar a última semana.
  const weeks = useMemo(() => {
    const start = new Date(year, month, 1);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(year, month + 1, 0);
    end.setDate(end.getDate() + (6 - end.getDay()));

    const days: Date[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(new Date(d));

    const out: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [year, month]);

  /**
   * Empacota as reservas em linhas dentro de cada semana.
   *
   * Uma reserva que cruza a virada da semana é cortada e redesenhada na semana
   * seguinte — por isso `openLeft`/`openRight`, que arredondam só a ponta que
   * é ponta de verdade. Sem isso a faixa parece terminar num domingo qualquer.
   */
  const barsByWeek = useMemo(() => {
    return weeks.map((week) => {
      const weekStart = iso(week[0]);
      const weekEnd = iso(week[6]);

      const inWeek = reservations
        .filter((r) => r.checkin_date <= weekEnd && r.checkout_date >= weekStart)
        .sort(
          (a, b) =>
            a.checkin_date.localeCompare(b.checkin_date) ||
            b.checkout_date.localeCompare(a.checkout_date),
        );

      const rows: boolean[][] = [];
      const bars: Bar[] = [];
      const overflow: Record<string, number> = {};

      for (const r of inWeek) {
        const startIdx = r.checkin_date <= weekStart
          ? 0
          : week.findIndex((d) => iso(d) === r.checkin_date);
        const endIdx = r.checkout_date >= weekEnd
          ? 6
          : week.findIndex((d) => iso(d) === r.checkout_date);
        if (startIdx < 0 || endIdx < 0) continue;

        let row = rows.findIndex((used) => !used.slice(startIdx, endIdx + 1).some(Boolean));
        if (row === -1) {
          rows.push(new Array(7).fill(false));
          row = rows.length - 1;
        }
        for (let i = startIdx; i <= endIdx; i++) rows[row][i] = true;

        if (row >= MAX_BAR_ROWS) {
          for (let i = startIdx; i <= endIdx; i++) {
            overflow[iso(week[i])] = (overflow[iso(week[i])] ?? 0) + 1;
          }
          continue;
        }

        bars.push({
          key: r.id,
          startCol: startIdx + 1,
          span: endIdx - startIdx + 1,
          row,
          label: r.guest_label?.trim() || properties[r.property_id] || "Reserva",
          openLeft: r.checkin_date < weekStart,
          openRight: r.checkout_date > weekEnd,
        });
      }

      return { bars, overflow };
    });
  }, [weeks, reservations, properties]);

  const today = iso(new Date());
  const selectedTasks = selected ? (byDate[selected] ?? []) : [];
  const selectedReservations = selected
    ? reservations.filter((r) => r.checkin_date <= selected && r.checkout_date >= selected)
    : [];
  const monthTotal = tasks.reduce((sum, t) => sum + Number(t.turnover_price ?? 0), 0);

  const step = (delta: number) => {
    setSelected(null);
    setCursor(new Date(year, month + delta, 1));
  };

  /**
   * Concluir a limpeza pelo lado do dono.
   *
   * Existe porque a agenda da diarista só enxerga tarefa com `cleaner_id` igual
   * a ela: imóvel sem diarista vinculada, ou imóvel que o próprio dono limpa,
   * ficaria sem ninguém capaz de fechar a tarefa — e o mês fecharia em zero
   * para sempre.
   *
   * O gatilho `tg_cleaning_tasks_guard` só carimba `completed_at` quando quem
   * atualiza é a diarista; pelo caminho do dono ele devolve a linha como veio,
   * então a marcação de tempo vai explícita daqui.
   */
  const setCompleted = async (task: Task, done: boolean) => {
    if (!user) return;
    setSaving(task.id);

    const { error } = await supabase
      .from("cleaning_tasks")
      .update(
        done
          ? { status: "completed", completed_at: new Date().toISOString(), completed_by: user.id }
          : { status: "pending", completed_at: null, completed_by: null },
      )
      .eq("id", task.id);

    if (error) {
      toast.error("Não consegui salvar. Tente de novo.");
    } else {
      setTasks((list) =>
        list.map((t) => (t.id === task.id ? { ...t, status: done ? "completed" : "pending" } : t)),
      );
      toast.success(done ? "Limpeza concluída." : "Limpeza reaberta.");
    }
    setSaving(null);
  };

  return (
    <div className="animate-fade-up space-y-5">
      <header className="glass flex items-center justify-between rounded-2xl px-2 py-2">
        <button
          onClick={() => step(-1)}
          aria-label="Mês anterior"
          className="rounded-xl p-2.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <div className="text-center">
          <h1 className="text-lg font-bold capitalize tracking-tight">
            {MONTHS[month]} {year}
          </h1>
          <p className="text-xs text-muted-foreground">
            {tasks.length === 0
              ? "Nenhuma saída"
              : `${tasks.length} ${tasks.length === 1 ? "saída" : "saídas"} · R$ ${monthTotal.toFixed(2).replace(".", ",")}`}
          </p>
        </div>

        <button
          onClick={() => step(1)}
          aria-label="Próximo mês"
          className="rounded-xl p-2.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </header>

      <div className="glass rounded-2xl p-3">
        <div className="mb-2 grid grid-cols-7">
          {WEEKDAYS.map((d, i) => (
            <div
              key={i}
              className="py-1 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"
            >
              {d}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-1">
            {weeks.map((week, wi) => {
              const { bars, overflow } = barsByWeek[wi];

              return (
                <div key={wi} className="relative">
                  {/* Camada 1 — as células do dia. */}
                  <div className="grid grid-cols-7 gap-1">
                    {week.map((date) => {
                      const key = iso(date);
                      const outOfMonth = date.getMonth() !== month;
                      const isToday = key === today;
                      const isSelected = key === selected;
                      const dayTasks = byDate[key] ?? [];

                      return (
                        <button
                          key={key}
                          disabled={outOfMonth}
                          onClick={() => setSelected(isSelected ? null : key)}
                          className={cn(
                            "relative h-[4.5rem] rounded-xl border text-left transition-all duration-200 sm:h-24",
                            outOfMonth
                              ? "border-transparent bg-transparent"
                              : "border-white/[0.07] bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.07]",
                            isSelected &&
                              "border-primary/60 bg-primary/[0.12] ring-1 ring-primary/40",
                          )}
                        >
                          <span
                            className={cn(
                              "absolute left-1.5 top-1 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                              outOfMonth && "text-muted-foreground/25",
                              !outOfMonth && !isToday && "text-foreground/85",
                              isToday &&
                                "bg-primary font-bold text-primary-foreground shadow-[0_0_16px_hsl(var(--primary)/0.55)]",
                            )}
                          >
                            {date.getDate()}
                          </span>

                          {/* Selo da limpeza — um dia só, na data de saída. */}
                          {!outOfMonth && dayTasks.length > 0 && (
                            <span
                              className={cn(
                                "absolute right-1.5 top-2 h-1.5 w-1.5 rounded-full",
                                dayTasks.every((t) => t.status === "completed")
                                  ? "bg-[hsl(var(--success))] shadow-[0_0_8px_hsl(var(--success)/0.8)]"
                                  : "bg-[hsl(var(--warning))] shadow-[0_0_8px_hsl(var(--warning)/0.8)]",
                              )}
                            />
                          )}

                          {!outOfMonth && overflow[key] > 0 && (
                            <span className="absolute bottom-1 right-1.5 text-[10px] font-semibold text-muted-foreground">
                              +{overflow[key]}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Camada 2 — as faixas de reserva, alinhadas à mesma grade. */}
                  <div
                    className="pointer-events-none absolute inset-x-0 top-7 grid grid-cols-7 gap-x-1"
                    style={{ gridAutoRows: "1.05rem", rowGap: "0.2rem" }}
                  >
                    {bars.map((bar) => (
                      <div
                        key={bar.key}
                        style={{
                          gridColumn: `${bar.startCol} / span ${bar.span}`,
                          gridRow: bar.row + 1,
                        }}
                        className={cn(
                          "flex items-center overflow-hidden border-y border-primary/40 bg-primary/25 px-1.5 backdrop-blur-sm",
                          bar.openLeft ? "border-l-0" : "rounded-l-full border-l border-l-primary/40 pl-2",
                          bar.openRight ? "border-r-0" : "rounded-r-full border-r border-r-primary/40",
                        )}
                        title={bar.label}
                      >
                        <span className="truncate text-[10px] font-semibold leading-none text-primary-foreground/95">
                          {bar.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected && (
        <section className="animate-fade-up space-y-2">
          <h2 className="px-1 text-sm font-semibold">
            {Number(selected.slice(8))} de {MONTHS[month]}
          </h2>

          {selectedReservations.length === 0 && selectedTasks.length === 0 ? (
            <p className="glass-card rounded-2xl px-4 py-6 text-center text-sm text-muted-foreground">
              Nada neste dia.
            </p>
          ) : (
            <>
              {selectedReservations.map((r) => (
                <article key={r.id} className="glass-card rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {r.guest_label?.trim() || "Reserva"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {properties[r.property_id] ?? "Imóvel"}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-primary/40 bg-primary/20 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground/90">
                      {r.checkin_date === selected
                        ? "Entrada"
                        : r.checkout_date === selected
                          ? "Saída"
                          : "Hospedado"}
                    </span>
                  </div>
                </article>
              ))}

              {selectedTasks.map((t) => (
                <article key={t.id} className="glass-card rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        Limpeza · {properties[t.property_id] ?? "Imóvel"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Saída às {(t.checkout_time ?? "11:00").slice(0, 5)}
                        {t.next_checkin_date === selected && " · entrada no mesmo dia"}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold">
                        R$ {Number(t.turnover_price ?? 0).toFixed(2).replace(".", ",")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {STATUS_LABEL[t.status] ?? t.status}
                      </p>
                    </div>
                  </div>

                  {t.next_checkin_date === selected && (
                    <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      Entrada no mesmo dia — a limpeza precisa ficar pronta antes.
                    </p>
                  )}

                  <Button
                    variant={t.status === "completed" ? "ghost" : "outline"}
                    size="sm"
                    disabled={saving === t.id}
                    onClick={() => setCompleted(t, t.status !== "completed")}
                    className="mt-3 w-full"
                  >
                    {saving === t.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : t.status === "completed" ? (
                      <Undo2 className="mr-2 h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                    )}
                    {t.status === "completed" ? "Reabrir limpeza" : "Marcar como concluída"}
                  </Button>
                </article>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}
