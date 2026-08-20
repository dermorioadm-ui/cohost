import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { AssinarLimpeza } from "@/components/AssinarLimpeza";
import { supabase } from "@/lib/api";

/**
 * Os checkouts que passaram do dia sem assinatura.
 *
 * Até aqui, o quadro de assinar só aparecia no DIA da limpeza. Passada a
 * meia-noite, a tarefa continuava na agenda sem nenhuma ação possível — e como
 * a fatura só cobra o que foi assinado, o esquecimento de um dia virava
 * dinheiro que não apareceu no fim do mês, sem que nada na tela tivesse
 * avisado.
 *
 * A pendência fica no topo da agenda dela, à frente do dia de hoje, porque é a
 * única coisa ali que já deveria ter sido feita. E a assinatura continua
 * possível: o termo separa a data do FATO da data da assinatura, então assinar
 * hoje o checkout de terça não falsifica nada — declara terça, e registra que
 * foi declarado hoje.
 */

interface Pendente {
  id: string;
  property_id: string;
  imovel: string;
  checkout_date: string;
  turnover_price: number;
  dias_atrasada: number;
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const quando = (dias: number) =>
  dias === 1 ? "ontem" : dias < 7 ? `há ${dias} dias` : `há ${Math.floor(dias / 7)} semana(s)`;

export function AssinaturasPendentes({ onAssinou }: { onAssinou?: () => void }) {
  const [lista, setLista] = useState<Pendente[] | null>(null);

  const carregar = useCallback(async () => {
    const { data, error } = await supabase.rpc("limpezas_pendentes_de_assinatura");
    // Falha aqui não mostra erro: é um bloco a mais na agenda, e um alerta
    // vermelho de sistema no topo da tela dela assusta sem informar nada que
    // ela possa resolver.
    if (error) return setLista([]);
    setLista((data ?? []) as Pendente[]);
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (lista === null) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (lista.length === 0) return null;

  const total = lista.reduce((s, p) => s + Number(p.turnover_price), 0);

  return (
    <section className="space-y-3 rounded-2xl border border-warning/30 bg-warning/[0.07] p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-warning">
            {lista.length === 1
              ? "1 limpeza esperando sua assinatura"
              : `${lista.length} limpezas esperando sua assinatura`}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Só entra na sua fatura o checkout que você assinou. Estas somam{" "}
            <strong className="text-foreground">{brl(total)}</strong> e ainda dá para assinar — a
            data que vale é a da limpeza, não a de hoje.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {lista.map((p) => (
          <div key={p.id} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 truncate text-sm font-medium">{p.imovel}</p>
              <p className="shrink-0 text-sm font-semibold tabular-nums">
                {brl(Number(p.turnover_price))}
              </p>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Saída de{" "}
              {new Date(`${p.checkout_date}T12:00:00`).toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
              })}{" "}
              · {quando(p.dias_atrasada)}
            </p>

            <div className="mt-2">
              <AssinarLimpeza
                taskId={p.id}
                imovel={p.imovel}
                onPronto={() => {
                  setLista((l) => (l ?? []).filter((x) => x.id !== p.id));
                  onAssinou?.();
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
