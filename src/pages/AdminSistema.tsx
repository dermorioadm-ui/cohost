import { useEffect, useState } from "react";
import { Activity, Loader2, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, supabase } from "@/lib/api";
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

interface LinhaLog {
  origem: string;
  acao: string;
  ator_nome: string | null;
  alvo: string | null;
  detalhe: string | null;
  created_at: string;
}

/** Rótulo legível por ação. O que não está aqui aparece como veio. */
const ACAO: Record<string, string> = {
  "admin.view_as": "Abriu o painel de",
  erro_interno: "Erro interno em",
  expurgo_lgpd: "Expurgo LGPD",
};

export default function AdminSistema() {
  const [saude, setSaude] = useState<Record<string, unknown> | null>(null);
  const [log, setLog] = useState<LinhaLog[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarregando, setRecarregando] = useState(false);

  const carregar = async () => {
    setRecarregando(true);
    try {
      const r = await api.admin.visaoGeral();
      setSaude(r.saude);
      setErro(null);
      // O log carrega junto, mas a falha dele não derruba a tela: os
      // indicadores continuam sendo a parte que responde "tem algo quebrado?".
      const { data } = await supabase.rpc("log_do_sistema", { _limite: 100 });
      setLog((data ?? []) as LinhaLog[]);
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

      {/* -------------------------------------------------- registro de sistema
          A linha do tempo do que aconteceu por trás das telas: admin entrando
          em conta de assinante (auditoria que já era gravada), erro interno de
          function e expurgo da retenção. Existe para a pergunta "o que houve?"
          ter onde ser respondida — sem ela, a resposta é o log efêmero da
          function, que some em horas. */}
      <section className="glass-card overflow-hidden rounded-xl">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <ScrollText className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold">Registro de sistema</h2>
        </div>

        {log === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : log.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            Nenhum evento registrado ainda.
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {log.map((l, i) => (
              <li key={i} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 text-sm">
                    <span className={cn(
                      "font-medium",
                      l.acao === "erro_interno" && "text-destructive",
                    )}>
                      {ACAO[l.acao] ?? l.acao}
                    </span>
                    {l.alvo && <span className="text-muted-foreground"> {l.alvo}</span>}
                  </p>
                  <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {new Date(l.created_at).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[l.ator_nome, l.origem !== "admin" ? l.origem : null, l.detalhe]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
