import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Check, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  property_id: string;
  checkout_date: string;
  checkout_time: string | null;
  next_checkin_date: string | null;
  status: string;
  turnover_price: number;
  photo_path: string | null;
}

/**
 * Agenda da diarista.
 *
 * Tela de celular, usada em pé, no corredor do prédio. Por isso: um cartão por
 * limpeza, o horário grande, e um botão só. Nada de menu ou filtro.
 *
 * O "entrada no mesmo dia" é a informação que ela mais precisa e que ninguém
 * dava antes — é o que define se ela tem quatro horas ou quarenta minutos.
 */
export default function CleanerAgenda() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
        .toISOString().slice(0, 10);

      const [tsk, props] = await Promise.all([
        supabase
          .from("cleaning_tasks")
          .select("id, property_id, checkout_date, checkout_time, next_checkin_date, status, turnover_price, photo_path")
          .gte("checkout_date", today)
          .lte("checkout_date", monthEnd)
          .neq("status", "cancelled")
          .order("checkout_date")
          .order("checkout_time"),
        supabase.from("properties").select("id, name, address, neighborhood"),
      ]);

      setTasks((tsk.data ?? []) as Task[]);
      setProperties(
        Object.fromEntries(
          ((props.data ?? []) as Array<{ id: string; name: string; address: string | null; neighborhood: string | null }>)
            .map((p) => [p.id, [p.name, p.neighborhood].filter(Boolean).join(" · ")]),
        ),
      );
      setLoading(false);
    })();
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

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="rounded-2xl bg-primary px-5 py-6 text-primary-foreground">
        <p className="text-xs uppercase tracking-widest opacity-70">Sua agenda</p>
        <p className="mt-1 text-2xl font-extrabold">
          {tasks.filter((t) => t.checkout_date === today).length} limpeza(s) hoje
        </p>
        <p className="text-sm opacity-80 mt-1">
          R$ {monthTotal.toFixed(2).replace(".", ",")} concluído neste mês
        </p>
      </header>

      {grouped.length === 0 && (
        <div className="rounded-2xl border bg-background p-8 text-center">
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
              return (
                <article key={task.id} className="rounded-2xl border bg-background p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold leading-tight">
                        {properties[task.property_id] ?? "Imóvel"}
                      </p>
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
                    <Button
                      onClick={() => complete(task.id)}
                      disabled={saving === task.id}
                      className="w-full h-14 mt-4 text-base font-bold"
                    >
                      {saving === task.id ? (
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-2 h-5 w-5" />
                      )}
                      Marcar como concluída
                    </Button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
