import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle, CalendarCheck, Check, ChevronRight, Clock,
  Loader2, Plus, Sparkles,
} from "lucide-react";
import { supabase, api, type ActivationState } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  checkout_date: string;
  checkout_time: string | null;
  next_checkin_date: string | null;
  status: string;
  turnover_price: number;
  guest_label: string | null;
  property_id: string;
}

/**
 * Painel do dono.
 *
 * A primeira coisa da tela não é métrica — é o que está travado. Um cliente
 * com o calendário fora do ar precisa ver isso antes de qualquer número, e
 * antes da diarista reclamar que a agenda está vazia.
 */
export default function Dashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [activation, setActivation] = useState<ActivationState[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!user) return;

    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
        .toISOString()
        .slice(0, 10);

      const [act, props, tsk] = await Promise.all([
        supabase.rpc("my_activation"),
        supabase.from("properties").select("id, name").is("archived_at", null),
        supabase
          .from("cleaning_tasks")
          .select("id, checkout_date, checkout_time, next_checkin_date, status, turnover_price, guest_label, property_id")
          .gte("checkout_date", today)
          .lte("checkout_date", monthEnd)
          .neq("status", "cancelled")
          .order("checkout_date"),
      ]);

      setActivation((act.data ?? []) as ActivationState[]);
      setProperties(
        Object.fromEntries(((props.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name])),
      );
      setTasks((tsk.data ?? []) as Task[]);
      setLoading(false);
    })();
  }, [user]);

  const blocked = useMemo(() => activation.filter((a) => a.blocked_at !== "ativo"), [activation]);
  const failing = useMemo(() => activation.filter((a) => a.ical_failing > 0), [activation]);

  const grouped = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) (map[t.checkout_date] ??= []).push(t);
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [tasks]);

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = tasks.filter((t) => t.checkout_date === today).length;
  const pending = tasks.filter((t) => t.status === "pending").length;

  const BLOCK_LABEL: Record<string, string> = {
    sem_ical: "Falta conectar o calendário",
    ical_nao_sincronizou: "O calendário ainda não sincronizou",
    sem_diarista: "Falta vincular a diarista",
    sem_mensagem_automatica: "Falta a mensagem automática no Airbnb",
  };

  const fmtDay = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    if (iso === today) return "Hoje";
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    if (iso === tomorrow) return "Amanhã";
    return d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "short" });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Painel</h1>
          <p className="text-sm text-muted-foreground">O que precisa de você agora.</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/comecar">
            <Plus className="h-4 w-4 mr-1" /> Imóvel
          </Link>
        </Button>
      </header>

      {/* Problemas primeiro — antes de qualquer número */}
      {failing.length > 0 && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex gap-3">
            <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-destructive">Calendário fora do ar</p>
              <p className="text-muted-foreground mt-1 leading-relaxed">
                {failing.map((f) => f.property_name).join(", ")} — reservas novas não estão
                virando limpeza. Normalmente o link foi regerado na plataforma; gere outro e
                cole de novo.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to={failing.length === 1 ? `/imoveis/${failing[0].property_id}` : "/imoveis"}>
                  Atualizar calendário
                </Link>
              </Button>
            </div>
          </div>
        </div>
      )}

      {blocked.length > 0 && (
        <div className="rounded-2xl glass-card p-4 space-y-3">
          <p className="text-sm font-semibold">Falta pouco para o automático</p>
          {blocked.map((b) => (
            <Link
              key={b.property_id}
              to={`/imoveis/${b.property_id}`}
              className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-3 hover:bg-muted transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{b.property_name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {BLOCK_LABEL[b.blocked_at] ?? b.blocked_at}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </Link>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          { value: todayCount, label: "Saídas hoje", icon: CalendarCheck },
          { value: pending, label: "Limpezas pendentes", icon: Clock },
          { value: activation.filter((a) => a.blocked_at === "ativo").length, label: "Imóveis ativos", icon: Sparkles },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl glass-card p-4">
            <s.icon className="h-4 w-4 text-muted-foreground" />
            <p className="mt-2 text-2xl font-extrabold tabular-nums">{s.value}</p>
            <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Próximas saídas</h2>

        {grouped.length === 0 && (
          <div className="rounded-2xl glass-card p-8 text-center">
            <CalendarCheck className="h-8 w-8 text-muted-foreground/40 mx-auto" />
            <p className="mt-3 text-sm font-medium">Nenhuma saída neste mês</p>
            <p className="text-xs text-muted-foreground mt-1">
              Assim que entrar reserva, ela aparece aqui sozinha.
            </p>
          </div>
        )}

        {grouped.map(([date, dayTasks]) => (
          <div key={date}>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={cn(
                  "text-xs font-bold px-2.5 py-1 rounded-full capitalize",
                  date === today ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {fmtDay(date)}
              </span>
              <span className="text-xs text-muted-foreground">
                {dayTasks.length} {dayTasks.length === 1 ? "limpeza" : "limpezas"}
              </span>
            </div>

            <div className="space-y-2">
              {dayTasks.map((t) => (
                <div key={t.id} className="rounded-2xl glass-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">
                        {properties[t.property_id] ?? "Imóvel"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Saída {t.checkout_time?.slice(0, 5) ?? "--:--"}
                        {t.next_checkin_date === t.checkout_date && (
                          <span className="text-amber-600 font-medium"> · entrada no mesmo dia</span>
                        )}
                      </p>
                    </div>
                    <Badge variant={t.status === "completed" ? "default" : "secondary"}>
                      {t.status === "completed" ? (
                        <><Check className="h-3 w-3 mr-1" /> Feita</>
                      ) : (
                        "Pendente"
                      )}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
