import { useCallback, useEffect, useState } from "react";
import {
  Building2, Check, Clock, DoorOpen, Loader2, Mail, Phone, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api, type PorterPedido } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * A fila da implantação da portaria.
 *
 * Esta tela existe porque contar não atende ninguém. O financeiro já mostrava
 * "3 pagos não implantados"; o número sozinho não diz quem são, nem como falar
 * com eles, nem quanto tempo cada um está esperando. Alguém pagou R$ 197 por um
 * trabalho manual — a tela precisa entregar o telefone da pessoa e o botão que
 * move a fila, ou a equipe vai atender por e-mail e perder o rastro.
 *
 * Quem pagou primeiro aparece primeiro. Ordenar pela data do clique colocaria
 * na frente gente que nem chegou no cartão.
 */

const ROTULO: Record<PorterPedido["status"], string> = {
  interessado: "Clicou, não pagou",
  pago: "Pagou — aguardando a equipe",
  em_andamento: "Em andamento",
  implantado: "Implantado",
  cancelado: "Cancelado",
};

/** Para onde este pedido pode ir a partir daqui, e com que palavra no botão. */
const PROXIMOS: Partial<Record<PorterPedido["status"], Array<{ para: PorterPedido["status"]; texto: string }>>> = {
  // `pago` não aparece como destino em lugar nenhum: esse status é do webhook
  // da Stripe. Um admin marcando pago na mão esconderia uma cobrança que nunca
  // entrou, e a conciliação do mês deixaria de fechar.
  interessado: [{ para: "cancelado", texto: "Cancelar" }],
  pago: [
    { para: "em_andamento", texto: "Assumir" },
    { para: "cancelado", texto: "Cancelar" },
  ],
  em_andamento: [
    { para: "implantado", texto: "Marcar implantado" },
    { para: "cancelado", texto: "Cancelar" },
  ],
  implantado: [{ para: "em_andamento", texto: "Reabrir" }],
};

const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Há quanto tempo, em português de gente. */
function esperando(desde: string | null): string | null {
  if (!desde) return null;
  const dias = Math.floor((Date.now() - new Date(desde).getTime()) / 86_400_000);
  if (dias <= 0) return "hoje";
  if (dias === 1) return "há 1 dia";
  return `há ${dias} dias`;
}

export default function AdminPortaria() {
  const [fila, setFila] = useState<PorterPedido[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarregando, setRecarregando] = useState(false);
  const [mexendo, setMexendo] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setRecarregando(true);
    try {
      setFila(await api.admin.portariaFila());
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não consegui carregar a fila");
    } finally {
      setRecarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const mover = async (p: PorterPedido, para: PorterPedido["status"]) => {
    if (para === "cancelado" && !confirm(`Cancelar a implantação de ${p.property_name}?`)) return;
    setMexendo(p.id);
    try {
      await api.admin.portariaAvanca(p.id, para);
      await carregar();
      toast.success(ROTULO[para]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui mover");
    } finally {
      setMexendo(null);
    }
  };

  if (erro) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
        <p className="font-semibold text-destructive">Sem acesso</p>
        <p className="mt-1.5 text-sm text-muted-foreground">{erro}</p>
      </div>
    );
  }

  if (!fila) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const esperandoEquipe = fila.filter((p) => p.status === "pago");
  const recebido = fila
    .filter((p) => p.paid_at)
    .reduce((s, p) => s + p.amount_cents, 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Portaria</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {esperandoEquipe.length === 0
              ? "Ninguém esperando a equipe agora."
              : `${esperandoEquipe.length} pagou e ainda não foi atendido.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={carregar} disabled={recarregando}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", recarregando && "animate-spin")} />
          Atualizar
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { v: String(esperandoEquipe.length), l: "Esperando a equipe" },
          { v: String(fila.filter((p) => p.status === "implantado").length), l: "Implantadas" },
          { v: brl(recebido), l: "Recebido" },
        ].map((c) => (
          <div key={c.l} className="glass-card rounded-xl p-4">
            <p className="text-xl font-extrabold tabular-nums">{c.v}</p>
            <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{c.l}</p>
          </div>
        ))}
      </div>

      {fila.length === 0 && (
        <div className="glass-card rounded-xl p-8 text-center">
          <DoorOpen className="mx-auto h-8 w-8 text-muted-foreground/40" aria-hidden />
          <p className="mt-3 text-sm font-medium">Nenhum pedido ainda</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Assim que alguém comprar a implantação, o pedido aparece aqui com o telefone
            para você ligar.
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {fila.map((p) => {
          const espera = esperando(p.paid_at ?? p.created_at);
          const urgente = p.status === "pago";
          return (
            <li
              key={p.id}
              className={cn(
                "rounded-xl p-4",
                urgente
                  ? "border border-warning/30 bg-warning/[0.06]"
                  : "glass-card",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{p.property_name}</p>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {p.owner_name ?? "Sem nome"}
                  </p>
                </div>
                <Badge variant={urgente ? "default" : "secondary"} className="shrink-0">
                  {ROTULO[p.status]}
                </Badge>
              </div>

              {/* Os contatos ficam clicáveis: o trabalho desta tela termina numa
                  ligação, e obrigar a copiar número na mão é onde a fila para. */}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                {p.owner_phone && (
                  <a
                    href={`https://wa.me/${p.owner_phone.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[32px] items-center gap-1.5 text-primary hover:underline"
                  >
                    <Phone className="h-3.5 w-3.5" aria-hidden />
                    {p.owner_phone}
                  </a>
                )}
                {p.owner_email && (
                  <a
                    href={`mailto:${p.owner_email}`}
                    className="inline-flex min-h-[32px] items-center gap-1.5 text-primary hover:underline"
                  >
                    <Mail className="h-3.5 w-3.5" aria-hidden />
                    {p.owner_email}
                  </a>
                )}
                {p.condo_name && (
                  <span className="inline-flex min-h-[32px] items-center gap-1.5 text-muted-foreground">
                    <Building2 className="h-3.5 w-3.5" aria-hidden />
                    {p.condo_name}
                    {p.condo_system && ` · ${p.condo_system}`}
                  </span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  {p.paid_at ? `Pagou ${espera}` : `Clicou ${espera}`}
                  {p.paid_at && ` · ${brl(p.amount_cents)}`}
                  {p.implanted_at && (
                    <>
                      {" · "}
                      <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                      entregue
                    </>
                  )}
                </p>

                <div className="flex flex-wrap gap-2">
                  {(PROXIMOS[p.status] ?? []).map((a) => (
                    <Button
                      key={a.para}
                      size="sm"
                      variant={a.para === "cancelado" ? "ghost" : "outline"}
                      disabled={mexendo === p.id}
                      onClick={() => mover(p, a.para)}
                      className={cn(
                        "min-h-[36px]",
                        a.para === "cancelado" && "text-muted-foreground",
                      )}
                    >
                      {mexendo === p.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      {a.texto}
                    </Button>
                  ))}
                </div>
              </div>

              {p.notes && (
                <p className="mt-2 rounded-lg bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
                  {p.notes}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
