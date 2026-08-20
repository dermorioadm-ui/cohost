import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, CalendarClock, Loader2, MessageSquarePlus,
  Phone, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api, type Estagio, type PipelineLinha } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RegistrarContato } from "@/components/RegistrarContato";

/**
 * O pipeline da equipe de vendas.
 *
 * A tela responde uma pergunta só, e na ordem certa: para quem eu ligo agora?
 *
 * Por isso ela não é um funil bonito de contar. Um funil mostra quantos estão
 * em cada etapa; quem vai trabalhar precisa do nome, do telefone e da frase
 * para dizer. O rótulo do estágio é a última coisa que importa — está lá para
 * agrupar, não para orientar.
 *
 * Follow-up vencido fura a fila, na frente até de cliente com pagamento
 * falhado. Foi a equipe que prometeu voltar naquele dia; promessa quebrada
 * custa mais caro que estágio ruim.
 */

const ESTAGIO: Record<Estagio, { rotulo: string; curto: string; grave?: boolean }> = {
  pagamento_falhou:           { rotulo: "Pagamento falhou", curto: "Cartão", grave: true },
  calendario_quebrado:        { rotulo: "Calendário fora do ar", curto: "Quebrado", grave: true },
  sem_imovel:                 { rotulo: "Assinou e não cadastrou imóvel", curto: "Sem imóvel" },
  sem_calendario:             { rotulo: "Sem calendário conectado", curto: "Sem calendário" },
  calendario_sem_sincronizar: { rotulo: "Calendário não trouxe reserva", curto: "Não sincronizou" },
  sem_diarista:               { rotulo: "Sem diarista vinculada", curto: "Sem diarista" },
  sem_mensagem:               { rotulo: "Sem mensagem automática", curto: "Sem mensagem" },
  consolidado:                { rotulo: "Consolidado", curto: "Pronto" },
  perdido:                    { rotulo: "Cancelou", curto: "Perdido" },
};

const ORDEM: Estagio[] = [
  "pagamento_falhou", "calendario_quebrado", "sem_imovel", "sem_calendario",
  "calendario_sem_sincronizar", "sem_diarista", "sem_mensagem", "consolidado", "perdido",
];

const dias = (iso: string | null): number | null =>
  iso === null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

const desde = (iso: string | null): string => {
  const d = dias(iso);
  if (d === null) return "nunca";
  if (d <= 0) return "hoje";
  if (d === 1) return "ontem";
  return `há ${d} dias`;
};

export default function AdminPipeline() {
  const [linhas, setLinhas] = useState<PipelineLinha[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Estagio | null>(null);
  const [recarregando, setRecarregando] = useState(false);
  const [registrando, setRegistrando] = useState<PipelineLinha | null>(null);

  const carregar = useCallback(async () => {
    setRecarregando(true);
    try {
      setLinhas(await api.admin.pipeline());
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não consegui carregar o pipeline");
    } finally {
      setRecarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const porEstagio = useMemo(() => {
    const m = new Map<Estagio, number>();
    for (const l of linhas ?? []) m.set(l.estagio, (m.get(l.estagio) ?? 0) + 1);
    return m;
  }, [linhas]);

  const visiveis = useMemo(
    () => (linhas ?? []).filter((l) => !filtro || l.estagio === filtro),
    [linhas, filtro],
  );

  const vencidos = useMemo(
    () =>
      (linhas ?? []).filter(
        (l) => l.proximo_passo_em && l.proximo_passo_em <= new Date().toISOString().slice(0, 10),
      ),
    [linhas],
  );

  if (erro) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
        <p className="font-semibold text-destructive">Sem acesso</p>
        <p className="mt-1.5 text-sm text-muted-foreground">{erro}</p>
      </div>
    );
  }

  if (!linhas) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const urgentes = (porEstagio.get("pagamento_falhou") ?? 0) + (porEstagio.get("calendario_quebrado") ?? 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Pipeline</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {urgentes > 0
              ? `${urgentes} precisa${urgentes === 1 ? "" : "m"} de ligação hoje.`
              : "Nada urgente. Trabalhe de cima para baixo."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={carregar} disabled={recarregando}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", recarregando && "animate-spin")} />
          Atualizar
        </Button>
      </header>

      {/* Promessa vencida antes de qualquer estágio: foi a equipe que marcou
          o dia de voltar, e quem some depois de prometer perde o cliente que
          já estava disposto a ouvir. */}
      {vencidos.length > 0 && (
        <section className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4">
          <div className="flex gap-3">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-warning">
                {vencidos.length} retorno{vencidos.length === 1 ? "" : "s"} combinado
                {vencidos.length === 1 ? "" : "s"} venceu
              </p>
              <p className="mt-1 text-xs leading-relaxed text-warning/90">
                {vencidos.slice(0, 4).map((v) => v.full_name ?? v.email).join(", ")}
                {vencidos.length > 4 && ` e mais ${vencidos.length - 4}`}. Eles já estão no topo da
                lista.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Os filtros carregam a contagem: é o funil, sem virar uma tela à parte
          que ninguém abre. */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFiltro(null)}
          className={cn(
            "min-h-[36px] rounded-full border px-3 text-xs font-medium transition-colors",
            filtro === null
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/[0.08] text-muted-foreground hover:bg-muted/50",
          )}
        >
          Todos ({linhas.length})
        </button>
        {ORDEM.filter((e) => (porEstagio.get(e) ?? 0) > 0).map((e) => (
          <button
            key={e}
            onClick={() => setFiltro(filtro === e ? null : e)}
            className={cn(
              "min-h-[36px] rounded-full border px-3 text-xs font-medium transition-colors",
              filtro === e
                ? "border-primary bg-primary text-primary-foreground"
                : ESTAGIO[e].grave
                  ? "border-warning/40 text-warning hover:bg-warning/10"
                  : "border-white/[0.08] text-muted-foreground hover:bg-muted/50",
            )}
          >
            {ESTAGIO[e].curto} ({porEstagio.get(e)})
          </button>
        ))}
      </div>

      <ul className="space-y-3">
        {visiveis.map((l) => {
          const info = ESTAGIO[l.estagio];
          const vencido =
            l.proximo_passo_em && l.proximo_passo_em <= new Date().toISOString().slice(0, 10);
          return (
            <li
              key={l.owner_id}
              className={cn(
                "rounded-xl p-4",
                vencido || info.grave
                  ? "border border-warning/30 bg-warning/[0.06]"
                  : "glass-card",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    to={`/admin/conta/${l.owner_id}`}
                    className="truncate font-semibold hover:underline"
                  >
                    {l.full_name ?? l.email ?? "Sem nome"}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {l.plano ?? "sem plano"} · {l.imoveis} imóve{l.imoveis === 1 ? "l" : "is"} ·
                    assinou {desde(l.assinou_em)}
                  </p>
                </div>
                <Badge variant={info.grave ? "default" : "secondary"} className="shrink-0">
                  {info.rotulo}
                </Badge>
              </div>

              {/* A frase do que fazer, com o porquê logo abaixo. Sem o porquê
                  a equipe segue o roteiro sem convicção — e o cliente escuta
                  isso do outro lado da linha. */}
              <div className="mt-3 rounded-lg bg-muted/40 p-3">
                <p className="flex gap-2 text-sm font-medium">
                  {info.grave && (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  )}
                  <span>{l.acao}</span>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{l.porque}</p>
              </div>

              {l.proximo_passo && (
                <p
                  className={cn(
                    "mt-2 flex items-start gap-1.5 text-xs leading-relaxed",
                    vencido ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    Combinado: {l.proximo_passo}
                    {l.proximo_passo_em &&
                      ` — para ${new Date(`${l.proximo_passo_em}T12:00:00`).toLocaleDateString("pt-BR")}`}
                  </span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                <p className="text-xs text-muted-foreground">
                  {l.contatos === 0
                    ? "Nunca foi contatado"
                    : `${l.contatos} contato${l.contatos === 1 ? "" : "s"} · último ${desde(l.ultimo_contato_em)}`}
                </p>

                <div className="flex flex-wrap gap-2">
                  {l.phone_e164 && (
                    <Button asChild size="sm" variant="outline" className="min-h-[36px]">
                      <a
                        href={`https://wa.me/${l.phone_e164.replace(/\D/g, "")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Phone className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        WhatsApp
                      </a>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-[36px]"
                    onClick={() => setRegistrando(l)}
                  >
                    <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Registrar
                  </Button>
                  <Button asChild size="sm" className="min-h-[36px]">
                    <Link to={`/admin/conta/${l.owner_id}`}>
                      Ver o painel
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {visiveis.length === 0 && (
        <div className="glass-card rounded-xl p-8 text-center">
          <p className="text-sm font-medium">Ninguém neste estágio</p>
        </div>
      )}

      {registrando && (
        <RegistrarContato
          userId={registrando.owner_id}
          nome={registrando.full_name ?? registrando.email ?? "este cliente"}
          onFechar={() => setRegistrando(null)}
          onSalvo={() => {
            setRegistrando(null);
            carregar();
          }}
        />
      )}
    </div>
  );
}
