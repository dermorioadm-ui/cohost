import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Calendário mensal de saídas.
 *
 * O painel mostra uma lista das próximas saídas, que responde "o que vem
 * agora". Não responde "como está o mês" — e é isso que o dono olha quando
 * quer saber se vale bloquear uma data ou se a semana está cheia. A grade
 * resolve isso de relance: dia com saída fica marcado, e tocar no dia abre o
 * detalhe embaixo, sem trocar de tela.
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

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Espelha o enum cleaning_status do banco — 'cancelled' não chega aqui, a
// consulta já o descarta.
const STATUS_LABEL: Record<string, string> = {
  pending: "A fazer",
  completed: "Concluída",
};

export default function Calendario() {
  const { user } = useAuth();
  const [cursor, setCursor] = useState(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  useEffect(() => {
    if (!user) return;
    setLoading(true);

    (async () => {
      const first = iso(new Date(year, month, 1));
      const last = iso(new Date(year, month + 1, 0));

      const [props, tsk] = await Promise.all([
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
      ]);

      setProperties(
        Object.fromEntries(
          ((props.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
        ),
      );
      setTasks((tsk.data ?? []) as Task[]);
      setLoading(false);
    })();
  }, [user, year, month]);

  const byDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) (map[t.checkout_date] ??= []).push(t);
    return map;
  }, [tasks]);

  // Começa no domingo da semana do dia 1 e vai até fechar a última semana.
  const cells = useMemo(() => {
    const start = new Date(year, month, 1);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(year, month + 1, 0);
    end.setDate(end.getDate() + (6 - end.getDay()));

    const out: Date[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      out.push(new Date(d));
    }
    return out;
  }, [year, month]);

  const today = iso(new Date());
  const selectedTasks = selected ? (byDate[selected] ?? []) : [];
  const monthTotal = tasks.reduce((sum, t) => sum + Number(t.turnover_price ?? 0), 0);

  const step = (delta: number) => {
    setSelected(null);
    setCursor(new Date(year, month + delta, 1));
  };

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <button
          onClick={() => step(-1)}
          aria-label="Mês anterior"
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <div className="text-center">
          <h1 className="text-lg font-bold capitalize">
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
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </header>

      <div className="rounded-xl border border-border bg-card p-3">
        <div className="mb-1 grid grid-cols-7">
          {WEEKDAYS.map((d, i) => (
            <div key={i} className="py-1 text-center text-[11px] font-medium text-muted-foreground">
              {d}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((date) => {
              const key = iso(date);
              const outOfMonth = date.getMonth() !== month;
              const dayTasks = byDate[key] ?? [];
              const isToday = key === today;
              const isSelected = key === selected;

              return (
                <button
                  key={key}
                  disabled={outOfMonth}
                  onClick={() => setSelected(isSelected ? null : key)}
                  className={cn(
                    "relative flex aspect-square flex-col items-center justify-center rounded-lg text-sm transition-colors",
                    outOfMonth && "text-muted-foreground/30",
                    !outOfMonth && "hover:bg-accent",
                    isToday && !isSelected && "font-bold text-primary",
                    isSelected && "bg-primary text-primary-foreground hover:bg-primary",
                  )}
                >
                  {date.getDate()}
                  {dayTasks.length > 0 && !outOfMonth && (
                    <span
                      className={cn(
                        "absolute bottom-1.5 h-1.5 w-1.5 rounded-full",
                        isSelected ? "bg-primary-foreground" : "bg-primary",
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selected && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            {Number(selected.slice(8))} de {MONTHS[month]}
          </h2>

          {selectedTasks.length === 0 ? (
            <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              Nenhuma saída neste dia.
            </p>
          ) : (
            selectedTasks.map((t) => (
              <article key={t.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {properties[t.property_id] ?? "Imóvel"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Saída às {(t.checkout_time ?? "11:00").slice(0, 5)}
                      {t.next_checkin_date === selected && " · entrada no mesmo dia"}
                    </p>
                    {t.guest_label && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{t.guest_label}</p>
                    )}
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
                  <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                    Entrada no mesmo dia — a limpeza precisa ficar pronta antes.
                  </p>
                )}
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
