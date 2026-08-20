import { useEffect, useState } from "react";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Saúde do sistema.
 *
 * Esta tela existe para uma pergunta só: tem alguma coisa quebrada que o
 * cliente vai sentir antes de mim? Por isso ela não é uma lista neutra de
 * métricas — cada linha tem um limite, e cruzar o limite muda a cor.
 *
 * Uma tela de saúde que mostra tudo em cinza obriga o operador a lembrar de cor
 * quais valores são ruins. Ele não lembra, e é justamente por isso que a falha
 * chega pelo WhatsApp do cliente em vez de chegar por aqui.
 */

/** Nome legível e limite a partir do qual a linha vira aviso. */
const REGRAS: Record<string, { rotulo: string; ruimAcima?: number; ruimAbaixo?: number; ajuda: string }> = {
  emails_failed: {
    rotulo: "E-mails falhados",
    ruimAcima: 0,
    ajuda: "Hóspede sem Wi-Fi e sem código da fechadura liga para o dono — que foi o que ele pagou para não acontecer.",
  },
  emails_queued: {
    rotulo: "E-mails na fila",
    ruimAcima: 20,
    ajuda: "Fila normal esvazia a cada minuto. Se cresce, o worker parou.",
  },
  ical_failing: {
    rotulo: "Calendários fora do ar",
    ruimAcima: 0,
    ajuda: "Reserva nova não vira limpeza. O dono só descobre quando a diarista não aparece.",
  },
  porter_pending: {
    rotulo: "Portaria: cadastros na fila",
    ruimAcima: 5,
    ajuda: "Hóspede que chega antes do cadastro entrar fica parado na recepção.",
  },
  porter_failed: {
    rotulo: "Portaria: cadastros recusados",
    ruimAcima: 0,
    ajuda: "A Kiper recusou. Normalmente é credencial vencida do prédio.",
  },
};

export default function AdminSistema() {
  const [saude, setSaude] = useState<Record<string, unknown> | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarregando, setRecarregando] = useState(false);

  const carregar = async () => {
    setRecarregando(true);
    try {
      const r = await api.admin.visaoGeral();
      setSaude(r.saude);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não consegui carregar");
    } finally {
      setRecarregando(false);
    }
  };

  useEffect(() => {
    carregar();
  }, []);

  if (erro) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
        <p className="font-semibold text-destructive">Sem acesso</p>
        <p className="mt-1.5 text-sm text-muted-foreground">{erro}</p>
      </div>
    );
  }

  if (!saude) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const linhas = Object.entries(saude).map(([chave, bruto]) => {
    const valor = Number(bruto);
    const regra = REGRAS[chave];
    const ruim =
      regra && Number.isFinite(valor)
        ? (regra.ruimAcima !== undefined && valor > regra.ruimAcima) ||
          (regra.ruimAbaixo !== undefined && valor < regra.ruimAbaixo)
        : false;
    return { chave, valor: bruto, regra, ruim };
  });

  const problemas = linhas.filter((l) => l.ruim);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Sistema</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {problemas.length === 0
              ? "Nada quebrado agora."
              : `${problemas.length} coisa(s) precisando de atenção.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={carregar} disabled={recarregando}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", recarregando && "animate-spin")} />
          Atualizar
        </Button>
      </header>

      {/* O que está ruim sobe para o topo. Ordem fixa faria o operador caçar. */}
      {problemas.length > 0 && (
        <section className="space-y-2">
          {problemas.map((l) => (
            <div
              key={l.chave}
              className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-semibold text-warning">
                  {l.regra?.rotulo ?? l.chave.replace(/_/g, " ")}
                </p>
                <p className="tabular-nums text-xl font-extrabold text-warning">{String(l.valor)}</p>
              </div>
              {l.regra && (
                <p className="mt-1 text-xs leading-relaxed text-warning/90">{l.regra.ajuda}</p>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="glass-card overflow-hidden rounded-xl">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold">Todos os indicadores</h2>
        </div>
        <dl className="divide-y divide-white/[0.04]">
          {linhas.map((l) => (
            <div key={l.chave} className="flex items-baseline justify-between gap-3 px-4 py-3">
              <dt className="text-sm text-muted-foreground">
                {l.regra?.rotulo ?? l.chave.replace(/_/g, " ")}
              </dt>
              <dd
                className={cn(
                  "tabular-nums text-sm font-semibold",
                  l.ruim ? "text-warning" : "text-foreground",
                )}
              >
                {String(l.valor)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
