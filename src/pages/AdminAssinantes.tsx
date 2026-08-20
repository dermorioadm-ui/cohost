import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, Check, Eye, Loader2, Search, X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Assinantes: a lista, e a conta de cada um por dentro.
 *
 * O filtro "travados" existe porque essa é a pergunta que o operador faz de
 * verdade. Ninguém abre o painel para "ver os assinantes" — abre para achar
 * quem pagou e não conseguiu usar, que é onde o cancelamento nasce. Por isso
 * ele tem botão próprio e vem por link da visão geral.
 *
 * VER COMO é leitura. O admin não assume a sessão de ninguém: ele abre uma
 * ficha com o que a conta tem e em que pé está. Alterar continua exigindo as
 * ações de admin, que saem no nome dele. E toda abertura é registrada ANTES de
 * os dados aparecerem — auditoria que só grava quando dá tudo certo não é
 * auditoria.
 */

const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "2-digit" }) : "—";

const SELO: Record<string, { texto: string; classe: string }> = {
  active:   { texto: "Ativa",       classe: "bg-success/15 text-success" },
  past_due: { texto: "Falhando",    classe: "bg-warning/15 text-warning" },
  trialing: { texto: "Em teste",    classe: "bg-primary/15 text-primary" },
  canceled: { texto: "Cancelada",   classe: "bg-white/[0.06] text-muted-foreground" },
  expired:  { texto: "Sem acesso",  classe: "bg-white/[0.06] text-muted-foreground" },
};

interface Linha {
  owner_id: string;
  full_name: string | null;
  email: string | null;
  phone_e164: string | null;
  plan: string | null;
  subscription_status: string;
  properties_count: number;
  is_activated: boolean;
  stuck_step: string | null;
  created_at: string;
  mrr_cents?: number;
}

export default function AdminAssinantes() {
  const [params, setParams] = useSearchParams();
  const [busca, setBusca] = useState("");
  const [soTravados, setSoTravados] = useState(params.get("travados") === "1");
  const [lista, setLista] = useState<Linha[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const aberto = params.get("id");

  useEffect(() => {
    const t = setTimeout(() => {
      setLista(null);
      api.admin
        .metrics("subscribers", {
          ...(busca.trim() ? { q: busca.trim() } : {}),
          ...(soTravados ? { stuck: "true" } : {}),
          limit: "100",
        })
        .then((r) => setLista(r.subscribers as Linha[]))
        .catch((e) => setErro(e instanceof Error ? e.message : "Não consegui carregar"));
    }, 300);
    return () => clearTimeout(t);
  }, [busca, soTravados]);

  if (aberto) return <Ficha ownerId={aberto} aoVoltar={() => setParams({})} />;

  if (erro) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
        <p className="font-semibold text-destructive">Sem acesso</p>
        <p className="mt-1.5 text-sm text-muted-foreground">{erro}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold">Assinantes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {lista ? `${lista.length} conta(s)` : "Carregando…"}
        </p>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome, e-mail ou telefone"
            className="pl-9"
            aria-label="Buscar assinante"
          />
        </div>
        <button
          onClick={() => setSoTravados((v) => !v)}
          aria-pressed={soTravados}
          className={cn(
            "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors",
            soTravados
              ? "bg-warning/15 text-warning"
              : "bg-white/[0.04] text-muted-foreground hover:text-foreground",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
          Só os travados
        </button>
      </div>

      {!lista ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card h-20 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : lista.length === 0 ? (
        <div className="glass-card rounded-xl p-8 text-center">
          <p className="font-semibold">
            {soTravados ? "Ninguém travado" : busca ? "Nada encontrado" : "Nenhum assinante ainda"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {soTravados
              ? "Todo mundo que assinou conseguiu configurar. É o melhor resultado possível desta tela."
              : "Quando alguém assinar, aparece aqui."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {lista.map((s) => {
            const selo = SELO[s.subscription_status] ?? SELO.expired;
            return (
              <button
                key={s.owner_id}
                onClick={() => setParams({ id: s.owner_id })}
                className="glass-card w-full rounded-xl p-4 text-left transition-colors hover:bg-white/[0.04]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{s.full_name ?? s.email ?? "Sem nome"}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold",
                      selo.classe,
                    )}
                  >
                    {selo.texto}
                  </span>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{s.properties_count} imóvel(is)</span>
                  <span>desde {dia(s.created_at)}</span>
                  {s.is_activated ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <Check className="h-3 w-3" /> configurado
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <AlertTriangle className="h-3 w-3" />
                      {s.stuck_step ? `travado: ${s.stuck_step}` : "não configurado"}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A conta por dentro. Abrir isto é uma ação registrada. */
function Ficha({ ownerId, aoVoltar }: { ownerId: string; aoVoltar: () => void }) {
  const [dados, setDados] = useState<Record<string, unknown> | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Registra ANTES de ler. Se o log falhar, a ficha não abre.
        await api.admin.registrarVisita(ownerId, "abriu a ficha no painel");
        const r = await api.admin.metrics("subscriber", { id: ownerId });
        setDados(r.subscriber as Record<string, unknown>);
      } catch (e) {
        setErro(e instanceof Error ? e.message : "Não consegui abrir");
      }
    })();
  }, [ownerId]);

  if (erro) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={aoVoltar}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
        </Button>
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
          <p className="text-sm text-destructive">{erro}</p>
        </div>
      </div>
    );
  }

  if (!dados) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const perfil = (dados.profile ?? {}) as Record<string, unknown>;
  const ativacao = (dados.activation ?? {}) as Record<string, unknown>;
  const imoveis = (dados.properties ?? []) as Array<Record<string, unknown>>;
  const selo = SELO[String(perfil.subscription_status)] ?? SELO.expired;

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={aoVoltar}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Todos os assinantes
      </Button>

      {/* O selo de leitura fica no topo e não sai. Sem ele, um admin cansado
          esquece de qual conta está olhando e confunde com a própria. */}
      <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] px-4 py-2.5">
        <Eye className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="text-xs leading-relaxed text-primary">
          Você está <strong>vendo</strong> a conta de {String(perfil.full_name ?? perfil.email)}.
          Esta visita ficou registrada. Alterações continuam saindo no seu nome.
        </p>
      </div>

      <header className="glass-card rounded-xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-extrabold">
              {String(perfil.full_name ?? "Sem nome")}
            </h1>
            <p className="truncate text-sm text-muted-foreground">{String(perfil.email ?? "")}</p>
            {Boolean(perfil.phone_e164) && (
              <p className="text-sm text-muted-foreground">{String(perfil.phone_e164)}</p>
            )}
          </div>
          <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold", selo.classe)}>
            {selo.texto}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Plano</dt>
            <dd className="font-semibold">{String(perfil.plan ?? "—")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cliente desde</dt>
            <dd className="font-semibold tabular-nums">{dia(perfil.created_at as string)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Imóveis</dt>
            <dd className="font-semibold tabular-nums">{imoveis.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Configuração</dt>
            <dd className={cn("font-semibold", ativacao.is_activated ? "text-success" : "text-warning")}>
              {ativacao.is_activated ? "Completa" : String(ativacao.stuck_step ?? "Incompleta")}
            </dd>
          </div>
        </dl>
      </header>

      <section className="space-y-2">
        <h2 className="font-semibold">Imóveis</h2>
        {imoveis.length === 0 ? (
          <div className="glass-card rounded-xl p-5 text-center text-sm text-muted-foreground">
            Assinou e nunca cadastrou um imóvel. É o travamento mais caro que existe: paga e não
            usa.
          </div>
        ) : (
          imoveis.map((im) => (
            <div key={String(im.id)} className="glass-card space-y-2.5 rounded-xl p-4">
              <p className="font-medium">{String(im.name)}</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { ok: Boolean(im.has_ical), texto: "Calendário" },
                  { ok: Boolean(im.has_cleaner), texto: "Diarista" },
                  { ok: Boolean(im.auto_message), texto: "Mensagem automática" },
                  { ok: Boolean(im.condo), texto: "Portaria" },
                  { ok: Boolean(im.ai), texto: "Atendimento 24h" },
                ].map((t) => (
                  <span
                    key={t.texto}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                      t.ok ? "bg-success/15 text-success" : "bg-white/[0.05] text-muted-foreground",
                    )}
                  >
                    {t.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    {t.texto}
                  </span>
                ))}
              </div>
              {Number(im.ical_failing ?? 0) > 0 && (
                <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
                  Calendário falhando. Reservas novas não estão virando limpeza.
                </p>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
