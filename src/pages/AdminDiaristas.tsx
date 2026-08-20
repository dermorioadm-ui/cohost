import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

/**
 * Todas as diaristas da plataforma.
 *
 * Ordenadas por limpezas nos últimos 30 dias, e não por nome: quem trabalha
 * mais é quem mais sente qualquer coisa que quebre no app, e é de quem vale a
 * pena ouvir. Ordem alfabética faria a lista parecer um cadastro.
 *
 * A tabela vira cartões no celular. Tabela com scroll horizontal em tela de
 * 375px é conteúdo escondido atrás de um gesto que ninguém descobre.
 */

const data = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "—";

export default function AdminDiaristas() {
  const [busca, setBusca] = useState("");
  const [lista, setLista] = useState<Awaited<ReturnType<typeof api.admin.diaristas>> | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    // Espera a digitação parar: uma consulta por tecla castiga o banco e faz a
    // lista piscar enquanto a pessoa ainda está escrevendo o nome.
    const t = setTimeout(() => {
      api.admin
        .diaristas(busca.trim() || undefined)
        .then(setLista)
        .catch((e) => setErro(e instanceof Error ? e.message : "Não consegui carregar"));
    }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  const ativas = useMemo(() => (lista ?? []).filter((c) => c.limpezas_30d > 0).length, [lista]);

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
        <h1 className="text-2xl font-extrabold">Diaristas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {lista
            ? `${lista.length} na plataforma · ${ativas} com limpeza nos últimos 30 dias`
            : "Carregando…"}
        </p>
      </header>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome, e-mail ou telefone"
          className="pl-9"
          aria-label="Buscar diarista"
        />
      </div>

      {!lista ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : lista.length === 0 ? (
        <div className="glass-card rounded-xl p-8 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-semibold">
            {busca ? "Ninguém com esse nome" : "Nenhuma diarista ainda"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {busca
              ? "Tente parte do nome, ou o telefone."
              : "Elas aparecem aqui quando um host manda o primeiro convite."}
          </p>
        </div>
      ) : (
        <>
          {/* Celular: cartões */}
          <div className="space-y-2 md:hidden">
            {lista.map((c) => (
              <div key={c.cleaner_id} className="glass-card space-y-2 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{c.full_name ?? "Sem nome"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.phone_e164 ?? c.email ?? "—"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-primary">
                    {c.limpezas_30d} limpezas
                  </span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>{c.hosts} host(s)</span>
                  <span>{c.imoveis} imóvel(is)</span>
                  <span>última {data(c.ultima_limpeza)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: tabela */}
          <div className="glass-card hidden overflow-hidden rounded-xl md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-3 font-medium">Diarista</th>
                  <th scope="col" className="px-4 py-3 font-medium">Contato</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Hosts</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Imóveis</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Limpezas 30d</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Última</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((c) => (
                  <tr
                    key={c.cleaner_id}
                    className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3 font-medium">{c.full_name ?? "Sem nome"}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.phone_e164 ?? c.email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.hosts}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.imoveis}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">
                      {c.limpezas_30d}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {data(c.ultima_limpeza)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
