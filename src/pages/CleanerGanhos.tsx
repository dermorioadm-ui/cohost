import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Loader2, ShoppingBasket, Sparkles } from "lucide-react";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { brl, currentMonth, monthLabel, shiftMonth } from "@/lib/fees";
import { cn } from "@/lib/utils";

/**
 * Ganhos da diarista.
 *
 * Ela fechava o mês somando na cabeça: quantas limpezas fez, quanto era cada
 * uma, o que comprou e ainda não foi reembolsado. Aqui isso vira um número só,
 * grande, no topo — que é a pergunta que ela abre a tela para responder.
 *
 * Três decisões de leitura:
 *
 *   1. O TOTAL é um número herói, não um gráfico. Um valor único não vira
 *      visualização; virar significaria decorar a resposta em vez de dá-la.
 *   2. A COMPOSIÇÃO são três blocos com ícone e rótulo, sem código de cor.
 *      Verde e âmbar aqui seriam empréstimo das cores de estado (aprovado,
 *      pendente) — a mesma cor querendo dizer duas coisas na mesma tela.
 *   3. O HISTÓRICO conta só as DIÁRIAS. A reposição é um valor fixo do
 *      combinado de hoje: jogá-la nos meses passados inventaria dinheiro que
 *      ela não recebeu. As barras são uma série só, e por isso não precisam de
 *      legenda — o título já diz o que elas são.
 *
 * Compra pendente aparece à parte e NÃO entra no total: ainda pode ser
 * recusada, e um total que encolhe depois é pior do que um total honesto.
 */

interface Earnings {
  reference_month: string;
  cleanings_done: number;
  cleanings_total: number;
  supplies_total: number;
  fees_approved: number;
  fees_pending: number;
  total: number;
}

interface DoneTask {
  checkout_date: string;
  turnover_price: number;
}

/** Rótulo curto do mês para o eixo das barras: "ago". */
const shortMonth = (month: string) =>
  monthLabel(month).split(" ")[0].slice(0, 3);

export default function CleanerGanhos() {
  const { user } = useAuth();
  const [month, setMonth] = useState(currentMonth());
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [history, setHistory] = useState<DoneTask[]>([]);
  const [loading, setLoading] = useState(true);

  const thisMonth = currentMonth();

  useEffect(() => {
    if (!user) return;
    (async () => {
      // Seis meses de diárias concluídas, numa consulta só. O agrupamento é
      // feito aqui porque são dezenas de linhas, não milhares.
      const desde = shiftMonth(thisMonth, -5);

      const [earn, hist] = await Promise.all([
        supabase.rpc("my_cleaning_earnings", { _month: month }),
        supabase
          .from("cleaning_tasks")
          .select("checkout_date, turnover_price")
          .eq("status", "completed")
          .gte("checkout_date", desde),
      ]);

      const row = Array.isArray(earn.data) ? earn.data[0] : earn.data;
      setEarnings((row ?? null) as Earnings | null);
      setHistory((hist.data ?? []) as DoneTask[]);
      setLoading(false);
    })();
  }, [user, month, thisMonth]);

  /** Os seis meses na ordem, com o total de diárias de cada um. */
  const bars = useMemo(() => {
    const soma: Record<string, number> = {};
    for (const t of history) {
      const key = `${t.checkout_date.slice(0, 7)}-01`;
      soma[key] = (soma[key] ?? 0) + Number(t.turnover_price);
    }
    return Array.from({ length: 6 }, (_, i) => {
      const m = shiftMonth(thisMonth, i - 5);
      return { month: m, value: soma[m] ?? 0 };
    });
  }, [history, thisMonth]);

  const maxBar = Math.max(...bars.map((b) => b.value), 1);
  const temHistorico = bars.some((b) => b.value > 0);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const e = earnings;

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------- Total do mês (herói) */}
      <header className="glass-accent rounded-2xl px-5 py-6">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setMonth(shiftMonth(month, -1))}
            aria-label="Mês anterior"
            className="-ml-2 rounded-xl p-2 opacity-70 transition-opacity hover:opacity-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>

          <p className="text-xs uppercase tracking-widest opacity-70">
            {monthLabel(month)}
          </p>

          <button
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= thisMonth}
            aria-label="Próximo mês"
            className="-mr-2 rounded-xl p-2 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-20"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-3 text-center text-4xl font-extrabold tabular-nums">
          {brl(e?.total ?? 0)}
        </p>
        <p className="mt-1 text-center text-sm opacity-80">
          {e?.cleanings_done ?? 0}{" "}
          {(e?.cleanings_done ?? 0) === 1 ? "limpeza concluída" : "limpezas concluídas"}
        </p>
      </header>

      {/* ------------------------------------------------------- Composição */}
      <section className="space-y-2">
        <h2 className="px-1 text-sm font-semibold text-muted-foreground">
          De onde vem
        </h2>

        <div className="space-y-2">
          {[
            {
              icon: Sparkles,
              label: "Diárias de limpeza",
              hint: `${e?.cleanings_done ?? 0} concluída(s) neste mês`,
              value: e?.cleanings_total ?? 0,
            },
            {
              icon: ShoppingBasket,
              label: "Reposição combinada",
              hint: "Valor fixo do mês, dos combinados que você aceitou",
              value: e?.supplies_total ?? 0,
            },
            {
              icon: Clock,
              label: "Compras reembolsadas",
              hint: "O que você adiantou e o cliente aprovou",
              value: e?.fees_approved ?? 0,
            },
          ].map((tile) => (
            <div
              key={tile.label}
              className="flex items-center gap-3 rounded-2xl glass-card px-4 py-3.5"
            >
              <tile.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{tile.label}</p>
                <p className="mt-0.5 text-xs leading-tight text-muted-foreground">
                  {tile.hint}
                </p>
              </div>
              <span className="shrink-0 font-bold tabular-nums">{brl(tile.value)}</span>
            </div>
          ))}
        </div>

        {(e?.fees_pending ?? 0) > 0 && (
          <p className="rounded-xl bg-warning/10 px-4 py-3 text-xs leading-relaxed text-warning">
            <span className="font-semibold">{brl(e!.fees_pending)}</span> em compras ainda
            esperando o cliente aprovar. Não entra no total acima até ele responder.
          </p>
        )}
      </section>

      {/* --------------------------------------------------- Últimos 6 meses */}
      <section className="rounded-2xl glass-card p-5">
        <h2 className="text-sm font-semibold">Diárias por mês</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          Só as limpezas concluídas — reposição e reembolso não entram aqui,
          porque o combinado de hoje não valia nos meses passados.
        </p>

        {temHistorico ? (
          <>
            <div className="mt-5 flex h-36 items-end gap-2">
              {bars.map((b) => {
                const atual = b.month === month;
                // 2px de piso para o mês vazio continuar sendo uma coluna
                // legível, e não um buraco que parece defeito da tela.
                const altura = b.value > 0 ? Math.max((b.value / maxBar) * 100, 4) : 0;

                return (
                  <div key={b.month} className="flex flex-1 flex-col items-center gap-1.5">
                    {atual && b.value > 0 && (
                      <span className="text-[10px] font-bold tabular-nums text-foreground">
                        {brl(b.value)}
                      </span>
                    )}

                    <div className="flex w-full flex-1 items-end">
                      <div
                        role="img"
                        aria-label={`${monthLabel(b.month)}: ${brl(b.value)}`}
                        title={`${monthLabel(b.month)} · ${brl(b.value)}`}
                        style={{ height: `${altura}%` }}
                        className={cn(
                          "w-full rounded-t transition-colors",
                          b.value === 0
                            ? "h-px bg-white/[0.08]"
                            : atual
                              ? "bg-primary"
                              : "bg-primary/35",
                        )}
                      />
                    </div>

                    <span
                      className={cn(
                        "text-[10px] capitalize",
                        atual ? "font-bold text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {shortMonth(b.month)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Linha de base: o zero precisa existir para a altura significar algo. */}
            <div className="mt-1 h-px bg-white/[0.08]" aria-hidden />

            {/* A mesma informação em texto, para quem não lê a altura da barra. */}
            <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]">
              {bars.map((b) => (
                <div key={b.month} className="flex justify-between gap-1">
                  <dt className="capitalize text-muted-foreground">{shortMonth(b.month)}</dt>
                  <dd className="tabular-nums">{brl(b.value)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Assim que você concluir a primeira limpeza, o histórico começa a aparecer aqui.
          </p>
        )}
      </section>
    </div>
  );
}
