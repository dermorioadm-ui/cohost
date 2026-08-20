import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, CalendarCheck, Check, DoorOpen, Eye, Loader2,
  Mail, MessageSquarePlus, Phone, RefreshCw, Sparkles, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api, type ContaAdmin, type ContaImovel } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RegistrarContato } from "@/components/RegistrarContato";

/**
 * O painel de uma conta, visto pelo admin.
 *
 * Existe para a ligação de suporte. Quando o cliente diz "não aparece nada
 * aqui", quem atende precisa ver o que ele vê — não um resumo em outra
 * linguagem, que obriga os dois a traduzirem a mesma tela um para o outro.
 *
 * É leitura, e nunca sessão emprestada. O admin não vira o cliente: se virasse,
 * toda alteração cairia no log como se o próprio cliente tivesse feito, e no
 * dia em que alguém precisasse auditar não haveria como separar. Por isso as
 * policies de escrita continuam recusando — o banco garante o somente-leitura,
 * não a boa intenção da tela.
 */

const fmtData = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";

const fmtDia = (iso: string) => {
  const hoje = new Date().toISOString().slice(0, 10);
  if (iso === hoje) return "Hoje";
  const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (iso === amanha) return "Amanhã";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
};

const brl = (v: number) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Uma bandeira do imóvel: ligada, desligada, ou quebrada. */
function Flag({ ok, quebrado, texto }: { ok: boolean; quebrado?: boolean; texto: string }) {
  const Icone = quebrado ? AlertTriangle : ok ? Check : X;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        quebrado ? "text-warning" : ok ? "text-primary" : "text-muted-foreground",
      )}
    >
      <Icone className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {texto}
    </span>
  );
}

function CartaoImovel({ im }: { im: ContaImovel }) {
  const quebrado = im.calendario_quebrado > 0;
  return (
    <div
      className={cn(
        "rounded-xl p-4",
        quebrado ? "border border-warning/30 bg-warning/[0.06]" : "glass-card",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{im.nome}</p>
          {im.cidade && <p className="text-xs text-muted-foreground">{im.cidade}</p>}
        </div>
        <Badge variant="secondary" className="shrink-0">
          {im.reservas_futuras} reserva{im.reservas_futuras === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        <Flag
          ok={im.calendarios > 0}
          quebrado={quebrado}
          texto={
            quebrado
              ? `${im.calendario_quebrado} calendário fora do ar`
              : im.calendarios > 0
                ? `${im.calendarios} calendário${im.calendarios === 1 ? "" : "s"}`
                : "Sem calendário"
          }
        />
        <Flag
          ok={Boolean(im.diarista) || im.self_clean}
          texto={im.diarista ?? (im.self_clean ? "Limpa sozinho" : "Sem diarista")}
        />
        <Flag ok={im.mensagem_automatica} texto="Mensagem automática" />
        <Flag
          ok={im.portaria}
          texto={
            im.portaria
              ? "Portaria ligada"
              : im.portaria_pedido
                ? `Portaria: ${im.portaria_pedido}`
                : "Sem portaria"
          }
        />
      </div>

      {im.ultima_sincronia && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Última sincronia em {fmtData(im.ultima_sincronia)}
        </p>
      )}
    </div>
  );
}

export default function AdminConta() {
  const { userId } = useParams<{ userId: string }>();
  const [conta, setConta] = useState<ContaAdmin | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recarregando, setRecarregando] = useState(false);
  const [registrando, setRegistrando] = useState(false);

  const carregar = useCallback(async () => {
    if (!userId) return;
    setRecarregando(true);
    try {
      setConta(await api.admin.conta(userId));
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não consegui abrir a conta");
    } finally {
      setRecarregando(false);
    }
  }, [userId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (erro) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/admin/assinantes">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
          </Link>
        </Button>
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-5">
          <p className="font-semibold text-destructive">Não abriu</p>
          <p className="mt-1.5 text-sm text-muted-foreground">{erro}</p>
        </div>
      </div>
    );
  }

  if (!conta) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ehDono = conta.papeis.includes("owner");
  const ehDiarista = conta.papeis.includes("cleaner");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to={ehDono ? "/admin/assinantes" : "/admin/diaristas"}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={carregar} disabled={recarregando}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", recarregando && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {/* O aviso não some. Quem esquece que está dentro da conta de outra
          pessoa é justamente quem ficou tempo demais ali — um toast de três
          segundos serve a quem já sabia. */}
      <div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Você está vendo a conta de{" "}
          <strong className="text-foreground">{conta.nome ?? conta.email}</strong>. É somente
          leitura — o banco recusa qualquer alteração feita a partir daqui, e esta visita ficou
          registrada.
        </p>
      </div>

      <header className="glass-card rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold">{conta.nome ?? "Sem nome"}</h1>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              {conta.email && (
                <a
                  href={`mailto:${conta.email}`}
                  className="inline-flex min-h-[32px] items-center gap-1.5 text-primary hover:underline"
                >
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                  {conta.email}
                </a>
              )}
              {conta.telefone && (
                <a
                  href={`https://wa.me/${conta.telefone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[32px] items-center gap-1.5 text-primary hover:underline"
                >
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {conta.telefone}
                </a>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            {conta.papeis.map((p) => (
              <Badge key={p} variant="secondary">
                {p === "owner" ? "Host" : p === "cleaner" ? "Diarista" : "Admin"}
              </Badge>
            ))}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-4 sm:grid-cols-4">
          {[
            // Plano e assinatura só existem para quem é dono. A tabela de
            // perfis carrega valores padrão para todo mundo, e uma diarista
            // aparecia como "essencial / expired" — cobrança que ela nunca
            // teve, e que faria alguém da equipe ligar para vender renovação.
            ...(ehDono
              ? [
                  { t: "Plano", v: conta.plano ?? "—" },
                  { t: "Assinatura", v: conta.assinatura ?? "—" },
                ]
              : []),
            { t: ehDono ? "Cliente desde" : "Entrou em", v: fmtData(conta.assinou_em) },
            { t: "Último acesso", v: fmtData(conta.ultimo_acesso) },
          ].map((c) => (
            <div key={c.t}>
              <dt className="text-[11px] text-muted-foreground">{c.t}</dt>
              <dd className="mt-0.5 text-sm font-semibold">{c.v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex justify-end border-t border-white/[0.06] pt-4">
          <Button size="sm" onClick={() => setRegistrando(true)} className="min-h-[40px]">
            <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden />
            Registrar contato
          </Button>
        </div>
      </header>

      {/* ---------- lado dono ---------- */}
      {ehDono && conta.ativacao && !conta.ativacao.ativado && (
        <section className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4">
          <p className="text-sm font-semibold text-warning">
            Travado em: {conta.ativacao.travado_em ?? "início"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-warning/90">
            {conta.ativacao.imoveis} imóvel(is) · {conta.ativacao.com_calendario} com calendário ·{" "}
            {conta.ativacao.sincronizando} sincronizando · {conta.ativacao.com_diarista} com
            diarista · {conta.ativacao.com_mensagem} com mensagem automática
            {conta.ativacao.convites_pendentes > 0 &&
              ` · ${conta.ativacao.convites_pendentes} convite(s) de diarista sem resposta`}
          </p>
        </section>
      )}

      {ehDono && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Imóveis ({conta.imoveis?.length ?? 0})
          </h2>
          {(conta.imoveis?.length ?? 0) === 0 ? (
            <div className="glass-card rounded-xl p-6 text-center">
              <p className="text-sm font-medium">Nenhum imóvel cadastrado</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Pagou e não usou nada — é o perfil que cancela no primeiro mês.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {conta.imoveis?.map((im) => (
                <CartaoImovel key={im.id} im={im} />
              ))}
            </div>
          )}
        </section>
      )}

      {ehDono && (conta.saidas?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Próximas saídas</h2>
          <ul className="glass-card divide-y divide-white/[0.04] overflow-hidden rounded-xl">
            {conta.saidas?.map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.imovel}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDia(s.data)} · saída {s.hora?.slice(0, 5) ?? "--:--"}
                    {s.diarista && ` · ${s.diarista}`}
                  </p>
                </div>
                <Badge variant={s.status === "completed" ? "default" : "secondary"}>
                  {s.status === "completed" ? "Feita" : "Pendente"}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------- lado diarista ---------- */}
      {ehDiarista && conta.diarista && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Como diarista</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { v: String(conta.diarista.hosts), l: "Hosts" },
              { v: String(conta.diarista.imoveis), l: "Imóveis" },
              { v: String(conta.diarista.limpezas_30d), l: "Limpezas em 30d" },
              { v: brl(conta.diarista.a_receber_mes), l: "A receber no mês" },
            ].map((c) => (
              <div key={c.l} className="glass-card rounded-xl p-4">
                <p className="text-lg font-extrabold tabular-nums">{c.v}</p>
                <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{c.l}</p>
              </div>
            ))}
          </div>

          {conta.diarista.acordos_pendentes > 0 && (
            <p className="rounded-lg bg-warning/[0.08] p-3 text-xs leading-relaxed text-warning">
              {conta.diarista.acordos_pendentes} acordo(s) esperando resposta dela. Enquanto não
              aceitar, o host acha que a limpeza está combinada e ela não vê a agenda.
            </p>
          )}
        </section>
      )}

      {ehDiarista && (conta.tarefas?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Próximas limpezas dela</h2>
          <ul className="glass-card divide-y divide-white/[0.04] overflow-hidden rounded-xl">
            {conta.tarefas?.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.imovel}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDia(t.data)} · saída {t.hora?.slice(0, 5) ?? "--:--"}
                    {t.host && ` · ${t.host}`}
                  </p>
                </div>
                <Badge variant={t.status === "completed" ? "default" : "secondary"}>
                  {t.status === "completed" ? "Feita" : "Pendente"}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ehDiarista && (conta.tarefas?.length ?? 0) === 0 && (
        <div className="glass-card rounded-xl p-6 text-center">
          <Sparkles className="mx-auto h-7 w-7 text-muted-foreground/40" aria-hidden />
          <p className="mt-2 text-sm font-medium">Agenda vazia</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sem limpeza marcada. Normalmente é o calendário do host que não está sincronizando.
          </p>
        </div>
      )}

      {/* ---------- histórico ---------- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Histórico de contato ({conta.contatos.length})
        </h2>
        {conta.contatos.length === 0 ? (
          <div className="glass-card rounded-xl p-6 text-center">
            <p className="text-sm font-medium">Ninguém falou com essa pessoa ainda</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {conta.contatos.map((c, i) => (
              <li key={i} className="glass-card rounded-xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">
                    {c.canal} · {c.resultado.replace(/_/g, " ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtData(c.quando)}
                    {c.autor && ` · ${c.autor}`}
                  </p>
                </div>
                {c.notas && (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{c.notas}</p>
                )}
                {c.proximo_passo && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-primary">
                    <CalendarCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      {c.proximo_passo}
                      {c.proximo_passo_em && ` — ${fmtData(c.proximo_passo_em)}`}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ehDono && (conta.imoveis?.length ?? 0) > 0 &&
        !conta.imoveis?.some((i) => i.portaria || i.portaria_pedido) && (
          <section className="flex gap-3 rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
            <DoorOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Nenhum imóvel dele tem portaria conectada. Se o prédio tiver sistema, a implantação
              de R$ 197 é a oferta natural — e resolve o cadastro de hóspede que ele ainda faz na
              mão.
            </p>
          </section>
        )}

      {registrando && (
        <RegistrarContato
          userId={conta.user_id}
          nome={conta.nome ?? conta.email ?? "este cliente"}
          onFechar={() => setRegistrando(false)}
          onSalvo={() => {
            setRegistrando(false);
            carregar();
          }}
        />
      )}
    </div>
  );
}
