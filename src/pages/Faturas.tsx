import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock, Check, ChevronDown, FileText, Loader2, Paperclip, RefreshCw, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * O acerto do mês entre o anfitrião e a diarista.
 *
 * A mesma tela serve aos dois lados, e isso é decisão, não economia: uma fatura
 * discutida a partir de duas telas diferentes vira duas versões da conta. Aqui
 * os dois leem exatamente as mesmas linhas — só quem pode marcar como paga
 * muda.
 *
 * O que o anfitrião faz a mais: anexar o comprovante. É o motivo de a tela
 * existir. Antes o Pix era enviado por WhatsApp e sumia na conversa; no mês
 * seguinte ninguém achava, e "eu te paguei" contra "não recebi" não tinha onde
 * ser resolvido.
 */

type Status = "fechada" | "paga" | "cancelada";

interface Fatura {
  id: string;
  owner_id: string;
  cleaner_id: string;
  periodo_inicio: string;
  periodo_fim: string;
  status: Status;
  total: number;
  fechada_em: string;
  paga_em: string | null;
  comprovante_path: string | null;
}

interface Item {
  id: string;
  invoice_id: string;
  kind: "limpeza" | "insumos" | "extra";
  descricao: string;
  data: string | null;
  valor: number;
}

const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const dia = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
  });

const ROTULO_KIND: Record<Item["kind"], string> = {
  limpeza: "Limpeza",
  insumos: "Insumos",
  extra: "Extra",
};

export default function Faturas() {
  const { role, user } = useAuth();
  const dono = role === "owner" || role === "admin";

  const [faturas, setFaturas] = useState<Fatura[] | null>(null);
  const [itens, setItens] = useState<Record<string, Item[]>>({});
  const [aberta, setAberta] = useState<string | null>(null);
  const [ocupada, setOcupada] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const { data, error } = await supabase
      .from("cleaner_invoices")
      .select(
        "id, owner_id, cleaner_id, periodo_inicio, periodo_fim, status, total, fechada_em, paga_em, comprovante_path",
      )
      .order("fechada_em", { ascending: false });

    if (error) return setErro(error.message);
    setErro(null);
    setFaturas((data ?? []) as Fatura[]);
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  /**
   * Os itens são buscados quando a fatura é aberta, e não junto da lista.
   *
   * Uma diarista com um ano de histórico tem centenas de linhas, e nenhuma
   * delas é olhada até alguém tocar na fatura. Trazer tudo de uma vez só
   * atrasaria a única coisa que a pessoa veio ver: quanto deu o mês.
   */
  const abrir = async (id: string) => {
    if (aberta === id) return setAberta(null);
    setAberta(id);
    if (itens[id]) return;

    const { data, error } = await supabase
      .from("cleaner_invoice_items")
      .select("id, invoice_id, kind, descricao, data, valor")
      .eq("invoice_id", id)
      .order("data", { ascending: true });

    if (error) return toast.error("Não consegui abrir os itens");
    setItens((m) => ({ ...m, [id]: (data ?? []) as Item[] }));
  };

  const emAberto = useMemo(
    () => (faturas ?? []).filter((f) => f.status === "fechada"),
    [faturas],
  );
  const totalEmAberto = emAberto.reduce((s, f) => s + Number(f.total), 0);

  if (!faturas && !erro) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            {dono ? "Faturas da limpeza" : "Minhas faturas"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {dono
              ? "Fecham sozinhas no dia combinado com cada diarista."
              : "O que foi fechado, e o comprovante de quando foi pago."}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={carregar} aria-label="Atualizar">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      {erro && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {erro}
        </p>
      )}

      {/* O número que responde a pergunta com que a pessoa abre a tela. */}
      {emAberto.length > 0 && (
        <section className="glass-accent rounded-2xl p-4">
          <p className="text-xs font-medium uppercase tracking-wide opacity-90">
            {dono ? "A pagar" : "A receber"}
          </p>
          <p className="mt-1 text-3xl font-extrabold tabular-nums">{brl(totalEmAberto)}</p>
          <p className="mt-0.5 text-xs opacity-90">
            {emAberto.length === 1 ? "1 fatura em aberto" : `${emAberto.length} faturas em aberto`}
          </p>
        </section>
      )}

      {faturas?.length === 0 && (
        <section className="glass-card rounded-2xl p-6 text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground opacity-40" aria-hidden />
          <p className="mt-3 text-sm font-medium">Nenhuma fatura ainda</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
            {dono
              ? "A primeira fecha no dia que você escolheu no cadastro da diarista, com as limpezas feitas até lá."
              : "A primeira fecha no dia combinado com o anfitrião, com as limpezas que você já concluiu."}
          </p>
        </section>
      )}

      {faturas?.map((f) => (
        <CartaoFatura
          key={f.id}
          fatura={f}
          itens={itens[f.id]}
          aberta={aberta === f.id}
          ocupada={ocupada === f.id}
          podePagar={dono && f.owner_id === user?.id}
          onAbrir={() => abrir(f.id)}
          onOcupada={(v) => setOcupada(v ? f.id : null)}
          onMudou={carregar}
        />
      ))}
    </div>
  );
}

function CartaoFatura({
  fatura,
  itens,
  aberta,
  ocupada,
  podePagar,
  onAbrir,
  onOcupada,
  onMudou,
}: {
  fatura: Fatura;
  itens?: Item[];
  aberta: boolean;
  ocupada: boolean;
  podePagar: boolean;
  onAbrir: () => void;
  onOcupada: (v: boolean) => void;
  onMudou: () => void;
}) {
  const arquivo = useRef<HTMLInputElement>(null);
  const paga = fatura.status === "paga";

  /**
   * Anexa o comprovante e marca a fatura como paga, nesta ordem.
   *
   * O arquivo sobe ANTES de a fatura mudar de estado porque o inverso deixa o
   * pior resultado possível: uma fatura marcada como paga cujo comprovante
   * falhou no envio — que é exatamente a situação que esta tela existe para
   * acabar. Falhando o upload, nada muda e a pessoa tenta de novo.
   */
  const pagar = async (comprovante: File | null) => {
    onOcupada(true);
    try {
      let caminho: string | null = null;

      if (comprovante) {
        const ext = comprovante.name.split(".").pop()?.toLowerCase() || "jpg";
        // O primeiro segmento é o id da fatura: é por ele que a policy do
        // storage decide quem envia e quem lê.
        caminho = `${fatura.id}/comprovante.${ext}`;
        const { error } = await supabase.storage
          .from("comprovantes")
          .upload(caminho, comprovante, { upsert: true, contentType: comprovante.type });
        if (error) throw new Error(error.message);
      }

      const { error } = await supabase.rpc("marcar_fatura_paga", {
        _fatura: fatura.id,
        _comprovante_path: caminho,
      });
      if (error) throw new Error(error.message);

      toast.success("Fatura marcada como paga");
      onMudou();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui marcar como paga");
    } finally {
      onOcupada(false);
    }
  };

  const verComprovante = async () => {
    if (!fatura.comprovante_path) return;
    const { data, error } = await supabase.storage
      .from("comprovantes")
      .createSignedUrl(fatura.comprovante_path, 120);
    if (error || !data) return toast.error("Não consegui abrir o comprovante");
    // `location.href` e não `window.open`: o bloqueador de pop-up do celular
    // mata a segunda forma dentro de um handler assíncrono, sem avisar.
    window.location.href = data.signedUrl;
  };

  return (
    <section className="glass-card overflow-hidden rounded-2xl">
      <button
        type="button"
        onClick={onAbrir}
        aria-expanded={aberta}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            paga ? "bg-success/15" : "bg-primary/10",
          )}
        >
          {paga ? (
            <Check className="h-4 w-4 text-success" aria-hidden />
          ) : (
            <Wallet className="h-4 w-4 text-primary" aria-hidden />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tabular-nums">{brl(Number(fatura.total))}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3 w-3 shrink-0" aria-hidden />
            {dia(fatura.periodo_inicio)} – {dia(fatura.periodo_fim)}
          </p>
        </div>

        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
            paga ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
          )}
        >
          {paga ? "Paga" : "Em aberto"}
        </span>

        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            aberta && "rotate-180",
          )}
        />
      </button>

      {aberta && (
        <div className="border-t border-white/[0.06] px-4 pb-4">
          {!itens ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {itens.map((i) => (
                <li key={i.id} className="flex items-start gap-3 py-2.5">
                  <span className="mt-0.5 shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {ROTULO_KIND[i.kind]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs leading-snug">{i.descricao}</p>
                    {i.data && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{dia(i.data)}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-medium tabular-nums">
                    {brl(Number(i.valor))}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {paga && (
            <div className="mt-3 space-y-2 rounded-xl border border-success/25 bg-success/[0.06] p-3">
              <p className="text-xs text-success">
                Paga em{" "}
                {fatura.paga_em
                  ? new Date(fatura.paga_em).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })
                  : "—"}
              </p>
              {fatura.comprovante_path ? (
                <Button variant="outline" size="sm" className="w-full" onClick={verComprovante}>
                  <Paperclip className="mr-2 h-4 w-4" aria-hidden />
                  Ver comprovante
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Sem comprovante anexado.</p>
              )}
            </div>
          )}

          {!paga && podePagar && (
            <div className="mt-3 space-y-2">
              <input
                ref={arquivo}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  if (f) pagar(f);
                }}
              />

              <Button
                className="min-h-[44px] w-full"
                disabled={ocupada}
                onClick={() => arquivo.current?.click()}
              >
                {ocupada ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Paperclip className="mr-2 h-4 w-4" aria-hidden />
                )}
                Anexar comprovante e marcar como paga
              </Button>

              {/* A saída sem anexo existe para quem pagou em dinheiro, e fica
                  discreta de propósito: o caminho bom é o que deixa prova. */}
              <button
                type="button"
                disabled={ocupada}
                onClick={() => pagar(null)}
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Marcar como paga sem anexar
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
