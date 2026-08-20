import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Loader2, TrendingUp } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Visão geral da plataforma.
 *
 * O que esta tela responde, em ordem: o negócio está de pé? alguém está preso?
 * algo quebrou? Ela existe porque o backend da 0013 calculava tudo isso desde
 * sempre e nenhuma rota levava até ele.
 *
 * Os cartões não são todos iguais de propósito. Receita e assinantes são
 * leitura de rotina; "travados" e falhas do sistema são chamadas para agir, e
 * ficam visualmente separados — um painel em que tudo tem o mesmo peso é um
 * painel em que nada chama atenção.
 */

const brl = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

interface Numero {
  rotulo: string;
  valor: string;
  nota?: string;
  alerta?: boolean;
}

function Cartao({ rotulo, valor, nota, alerta }: Numero) {
  return (
    <div
      className={cn(
        "rounded-xl p-4",
        alerta ? "border border-warning/30 bg-warning/[0.06]" : "glass-card",
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">{rotulo}</p>
      {/* tabular-nums evita que a largura dance quando o número muda */}
      <p className={cn("mt-1.5 text-2xl font-extrabold tabular-nums", alerta && "text-warning")}>
        {valor}
      </p>
      {nota && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{nota}</p>}
    </div>
  );
}

export default function AdminVisaoGeral() {
  const navigate = useNavigate();
  const [dados, setDados] = useState<Awaited<ReturnType<typeof api.admin.visaoGeral>> | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api.admin
      .visaoGeral()
      .then(setDados)
      .catch((e) => setErro(e instanceof Error ? e.message : "Não consegui carregar"));
  }, []);

  if (erro) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
        <p className="font-semibold text-destructive">Sem acesso ao painel</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{erro}</p>
      </div>
    );
  }

  // Esqueleto em vez de spinner: o layout já nasce no lugar, então nada salta
  // quando os números chegam.
  if (!dados) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="glass-card h-24 animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  const k = dados.kpis;
  const travados = Number(k.stuck ?? 0);
  const inadimplentes = Number(k.past_due ?? 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-extrabold">Visão geral</h1>
        <p className="mt-1 text-sm text-muted-foreground">A plataforma inteira, em números.</p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Cartao rotulo="Receita recorrente" valor={brl(Number(k.mrr_cents ?? 0))} nota="por mês" />
        <Cartao rotulo="Assinantes ativos" valor={String(k.subscribers_active ?? 0)} />
        <Cartao
          rotulo="Taxa de ativação"
          valor={`${k.activation_rate ?? 0}%`}
          nota="quem conectou calendário e diarista"
        />
        <Cartao rotulo="Novos em 30 dias" valor={String(k.new_30d ?? 0)} />
      </section>

      {/* O que exige ação fica junto e separado do resto. */}
      {(travados > 0 || inadimplentes > 0) && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {travados > 0 && (
            <Cartao
              alerta
              rotulo="Travados no cadastro"
              valor={String(travados)}
              nota="assinaram e não terminaram de configurar"
            />
          )}
          {inadimplentes > 0 && (
            <Cartao
              alerta
              rotulo="Pagamento falhando"
              valor={String(inadimplentes)}
              nota="cartão recusado; o acesso cai em breve"
            />
          )}
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao rotulo="Imóveis" valor={String(k.properties_total ?? 0)} />
        <Cartao rotulo="Diaristas" valor={String(k.cleaners_total ?? 0)} />
        <Cartao rotulo="Limpezas (30d)" valor={String(k.cleanings_30d ?? 0)} />
        <Cartao rotulo="Hóspedes atendidos (30d)" valor={String(k.guest_sessions_30d ?? 0)} />
      </section>

      {/* Funil: onde a fila entope. */}
      {dados.funil.length > 0 && (
        <section className="glass-card space-y-3 rounded-xl p-5">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Onde as pessoas param</h2>
          </div>
          <div className="space-y-2">
            {dados.funil.map((etapa, i) => {
              const total = Number(dados.funil[0]?.count ?? 1) || 1;
              const qtd = Number(etapa.count ?? 0);
              const pct = Math.round((qtd / total) * 100);
              return (
                <div key={i} className="space-y-1">
                  <div className="flex items-baseline justify-between text-sm">
                    <span>{String(etapa.step ?? etapa.etapa ?? "")}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {qtd} · {pct}%
                    </span>
                  </div>
                  {/* Barra e número juntos: a barra dá a forma, o número dá o
                      valor exato. Só a barra obrigaria a estimar de olho. */}
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary/70 transition-[width] duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => navigate("/admin/assinantes?travados=1")}
            className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            Ver quem está travado <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      )}

      {dados.saude && (
        <section className="glass-card space-y-2 rounded-xl p-5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">Saúde do sistema</h2>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(dados.saude).map(([chave, valor]) => (
              <div key={chave} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{chave.replace(/_/g, " ")}</dt>
                <dd className="tabular-nums font-semibold">{String(valor)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
