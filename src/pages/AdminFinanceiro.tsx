import { useEffect, useState } from "react";
import { DoorOpen, Info, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Financeiro da plataforma.
 *
 * A regra que organiza esta tela: separar o que ENTROU do que PROMETE entrar.
 * MRR é projeção — a soma do que os planos ativos valem por mês. Receita é
 * caixa: o que a Stripe confirmou. Misturar os dois num "faturamento" só é
 * como um dono se convence de que vai bem enquanto o dinheiro não chega.
 *
 * LTV e churn aparecem com o tamanho da amostra grudado. Com poucos clientes
 * esses números balançam a cada cancelamento, e quem precisa saber disso é
 * justamente quem vai usá-los para decidir preço.
 */

const brl = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

const mesCurto = (iso: string) => {
  const [ano, mes] = iso.split("-");
  return `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(mes) - 1]}/${ano.slice(2)}`;
};

export default function AdminFinanceiro() {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.admin.financeiro>> | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api.admin
      .financeiro(12)
      .then(setD)
      .catch((e) => setErro(e instanceof Error ? e.message : "Não consegui carregar"));
  }, []);

  if (erro) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
        <p className="font-semibold text-destructive">Sem acesso</p>
        <p className="mt-1.5 text-sm text-muted-foreground">{erro}</p>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const mrr = d.por_plano.reduce((s, p) => s + p.mrr_cents, 0);
  const pico = Math.max(1, ...d.serie_mensal.map((m) => m.receita_cents));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-extrabold">Financeiro</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          O que já entrou, e o que os contratos ativos prometem por mês.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="glass-card rounded-xl p-4">
          <p className="text-xs font-medium text-muted-foreground">Recorrente por mês</p>
          <p className="mt-1.5 text-2xl font-extrabold tabular-nums">{brl(mrr)}</p>
          <p className="mt-1 text-xs text-muted-foreground">projeção dos planos ativos</p>
        </div>
        <div className="glass-card rounded-xl p-4">
          <p className="text-xs font-medium text-muted-foreground">Recebido até hoje</p>
          <p className="mt-1.5 text-2xl font-extrabold tabular-nums">
            {brl(d.receita_total_cents)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {d.clientes_pagantes} cliente{d.clientes_pagantes === 1 ? "" : "s"} pagante
            {d.clientes_pagantes === 1 ? "" : "s"}
          </p>
        </div>
        <div className="glass-card rounded-xl p-4">
          <p className="text-xs font-medium text-muted-foreground">LTV realizado</p>
          <p className="mt-1.5 text-2xl font-extrabold tabular-nums">
            {brl(d.ltv_realizado_cents)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">média já deixada por cliente</p>
        </div>
        <div className="glass-card rounded-xl p-4">
          <p className="text-xs font-medium text-muted-foreground">Churn mensal</p>
          <p className="mt-1.5 text-2xl font-extrabold tabular-nums">{d.churn_mensal_pct}%</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {d.vida_media_meses ? `vida média ${d.vida_media_meses} meses` : "sem cancelamentos"}
          </p>
        </div>
      </section>

      {/* O aviso vem junto do número, não num rodapé que ninguém lê. */}
      {!d.amostra_confiavel && (
        <div className="flex gap-3 rounded-xl border border-warning/30 bg-warning/[0.06] p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-xs leading-relaxed text-warning">
            <strong>Amostra pequena.</strong> Com {d.clientes_pagantes} pagante
            {d.clientes_pagantes === 1 ? "" : "s"}, LTV e churn mudam muito a cada entrada ou saída.
            Servem para acompanhar a direção, não para decidir preço.
          </p>
        </div>
      )}

      {/* Série mensal de caixa. */}
      <section className="glass-card space-y-4 rounded-xl p-5">
        <h2 className="font-semibold">Recebido por mês</h2>
        {d.serie_mensal.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhum pagamento confirmado ainda. Assim que a Stripe cobrar o primeiro cliente, ele
            aparece aqui.
          </p>
        ) : (
          <div className="flex items-end gap-2 overflow-x-auto pb-1" style={{ minHeight: 140 }}>
            {d.serie_mensal.map((m) => (
              <div key={m.mes} className="flex min-w-[44px] flex-1 flex-col items-center gap-1.5">
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {brl(m.receita_cents)}
                </span>
                <div
                  className="w-full rounded-t bg-primary/60"
                  style={{ height: `${Math.max(4, (m.receita_cents / pico) * 100)}px` }}
                  role="img"
                  aria-label={`${mesCurto(m.mes)}: ${brl(m.receita_cents)} em ${m.cobrancas} cobrança(s)`}
                />
                <span className="text-[10px] text-muted-foreground">{mesCurto(m.mes)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Receita por plano. */}
      <section className="glass-card space-y-3 rounded-xl p-5">
        <h2 className="font-semibold">Por plano</h2>
        <div className="space-y-2">
          {d.por_plano.map((p) => (
            <div
              key={p.tier}
              className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2.5"
            >
              <div>
                <p className="text-sm font-medium">{p.nome}</p>
                <p className="text-xs text-muted-foreground">
                  {p.assinantes} assinante{p.assinantes === 1 ? "" : "s"}
                </p>
              </div>
              <p className="tabular-nums text-sm font-semibold">{brl(p.mrr_cents)}/mês</p>
            </div>
          ))}
        </div>
      </section>

      {/* Portaria: receita de serviço, e fila de trabalho da equipe. */}
      <section className="glass-card space-y-3 rounded-xl p-5">
        <div className="flex items-center gap-2">
          <DoorOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Implantação de portaria</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Interessados</p>
            <p className="text-xl font-bold tabular-nums">{d.portaria_interessados}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Pagos, na fila</p>
            <p
              className={cn(
                "text-xl font-bold tabular-nums",
                d.portaria_pagos_nao_implantados > 0 && "text-warning",
              )}
            >
              {d.portaria_pagos_nao_implantados}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Implantados</p>
            <p className="text-xl font-bold tabular-nums">{d.portaria_implantados}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Receita</p>
            <p className="text-xl font-bold tabular-nums">{brl(d.portaria_receita_cents)}</p>
          </div>
        </div>
        {d.portaria_pagos_nao_implantados > 0 && (
          <p className="rounded-lg bg-warning/[0.08] p-3 text-xs leading-relaxed text-warning">
            {d.portaria_pagos_nao_implantados} cliente
            {d.portaria_pagos_nao_implantados === 1 ? "" : "s"} pagou e ainda espera. É serviço
            vendido e não entregue — a fila mais cara que existe.
          </p>
        )}
      </section>
    </div>
  );
}
