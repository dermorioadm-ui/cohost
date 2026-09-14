import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Marca } from "@/components/Marca";
import { api, ApiError, supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import {
  brl, esquecerPlano, guardarPlano, NOME_TIER, planoDaQuery, planoGuardado,
  type Ciclo, type PlanoEscolhido, type Tier,
} from "@/lib/planoEscolhido";
import { cn } from "@/lib/utils";

/**
 * A tela entre a conta e o pagamento.
 *
 * Três momentos passam por aqui, e a URL diz qual:
 *
 *   /assinatura                  — conta criada, plano escolhido na página de
 *                                  vendas: confirma o valor e manda para o
 *                                  checkout da Stripe.
 *   /assinatura?status=ok        — voltou do checkout. O webhook da Stripe é
 *                                  quem ativa a assinatura, e ele chega segundos
 *                                  depois; a tela espera por ele antes de soltar
 *                                  a pessoa no onboarding.
 *   /assinatura?status=cancelado — desistiu no checkout. Oferece tentar de novo
 *                                  ou entrar sem assinar.
 *
 * O preço nunca vem daqui: o backend lê `plans` e só aceita tier e ciclo. O
 * que esta tela mostra é lido da mesma tabela, para nunca prometer um valor e
 * cobrar outro.
 */

interface Plan {
  tier: Tier;
  name: string;
  monthly_cents: number;
  annual_cents: number;
  max_properties: number | null;
}

type Estado = "carregando" | "escolher" | "abrindo" | "esperando" | "ativo" | "cancelado";

export default function Assinatura() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const status = params.get("status");

  const inicial = useMemo<PlanoEscolhido>(
    () => planoDaQuery(params) ?? planoGuardado() ?? { tier: "essencial", cycle: "annual" },
    [params],
  );
  const [tier, setTier] = useState<Tier>(inicial.tier);
  const [cycle, setCycle] = useState<Ciclo>(inicial.cycle);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [estado, setEstado] = useState<Estado>("carregando");
  const [erro, setErro] = useState<string | null>(null);

  // Carrega os planos e o estado da assinatura. Quem já paga não precisa
  // passar por aqui: vai direto para o painel.
  useEffect(() => {
    if (!user) return;
    (async () => {
      const [pl, pr] = await Promise.all([
        supabase
          .from("plans")
          .select("tier, name, monthly_cents, annual_cents, max_properties")
          .eq("active", true)
          .order("sort_order"),
        supabase.from("profiles").select("subscription_status").eq("user_id", user.id).maybeSingle(),
      ]);
      setPlans((pl.data ?? []) as Plan[]);
      const ativo = pr.data?.subscription_status === "active";
      if (ativo) {
        esquecerPlano();
        setEstado("ativo");
        return;
      }
      if (status === "ok") setEstado("esperando");
      else if (status === "cancelado") setEstado("cancelado");
      else setEstado("escolher");
    })();
  }, [user, status]);

  // Voltou do checkout: o webhook ativa a assinatura em segundos. Espera até
  // 40s consultando o perfil; passado isso, segue mesmo assim — o acesso abre
  // sozinho quando o webhook chegar, e ninguém fica preso numa tela de espera.
  useEffect(() => {
    if (estado !== "esperando" || !user) return;
    let vivo = true;
    let tentativas = 0;
    const id = setInterval(async () => {
      tentativas++;
      const { data } = await supabase
        .from("profiles")
        .select("subscription_status")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!vivo) return;
      if (data?.subscription_status === "active" || tentativas >= 20) {
        clearInterval(id);
        esquecerPlano();
        setEstado("ativo");
      }
    }, 2000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [estado, user]);

  const pagar = async () => {
    setErro(null);
    setEstado("abrindo");
    guardarPlano({ tier, cycle });
    try {
      const { url } = await api.billing.checkout({ tier, cycle });
      window.location.href = url;
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : "Não consegui abrir o pagamento. Tente de novo.");
      setEstado("escolher");
    }
  };

  const seguirSemAssinar = () => {
    esquecerPlano();
    navigate("/comecar", { replace: true });
  };

  const plano = plans.find((p) => p.tier === tier);
  const preco = plano ? (cycle === "annual" ? plano.annual_cents : plano.monthly_cents) : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed inset-x-3 top-3 z-30 flex justify-center">
        <div className="flex w-full max-w-[720px] items-center justify-between gap-3 rounded-[52px] bg-white py-2 pl-4 pr-2 shadow-pill">
          <Marca size={32} />
          <span className="flex h-10 items-center gap-2 whitespace-nowrap rounded-full border border-[#f0f0f0] px-3.5 text-[13px] tracking-corpo text-black">
            <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
            Pagamento seguro
          </span>
        </div>
      </header>

      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 pb-12 pt-24">
        {estado === "carregando" && (
          <div className="flex justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* ------------------------------------------------ pagamento ok */}
        {(estado === "esperando" || estado === "ativo") && (
          <div className="animate-rise-in text-center">
            <span className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/15">
              {estado === "ativo" ? (
                <CheckCircle2 className="h-8 w-8 text-success" aria-hidden />
              ) : (
                <Loader2 className="h-7 w-7 animate-spin text-success" aria-hidden />
              )}
            </span>
            <h1 className="mt-5 text-[30px] font-normal leading-[1.05] tracking-titulo">
              {estado === "ativo" ? "Assinatura ativa." : "Confirmando o pagamento…"}
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              {estado === "ativo"
                ? "Agora é ligar o seu calendário. Leva menos de cinco minutos."
                : "A Stripe avisa a gente em alguns segundos. Não feche esta tela."}
            </p>
            {estado === "ativo" && (
              <Button size="lg" className="mt-7 w-full" onClick={() => navigate("/comecar", { replace: true })}>
                Configurar meu imóvel
              </Button>
            )}
          </div>
        )}

        {/* ------------------------------------------------- cancelado */}
        {estado === "cancelado" && (
          <div className="animate-rise-in">
            <p className="rotulo text-primary">Pagamento</p>
            <h1 className="mt-2 text-[30px] font-normal leading-[1.05] tracking-titulo">
              Você saiu antes de pagar.
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              Sem problema. O plano fica guardado; quando quiser, é um toque.
            </p>
            <div className="mt-7 space-y-3">
              <Button size="lg" className="w-full" onClick={() => setEstado("escolher")}>
                Tentar de novo
              </Button>
              <Button variant="outline" size="lg" className="w-full" onClick={seguirSemAssinar}>
                Entrar sem assinar por enquanto
              </Button>
            </div>
          </div>
        )}

        {/* -------------------------------------------------- escolher */}
        {(estado === "escolher" || estado === "abrindo") && (
          <div className="animate-rise-in">
            <p className="rotulo text-primary">Último passo</p>
            <h1 className="mt-2 text-[30px] font-normal leading-[1.05] tracking-titulo">
              Confirme o plano e pague.
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              Os três planos são iguais. Só muda quantos imóveis rodam.
            </p>

            <div className="paper-frame mt-7 space-y-4 !rounded-panel p-5">
              {/* Ciclo */}
              <div className="flex rounded-full bg-secondary p-1 text-[13px]">
                {(["annual", "monthly"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCycle(c)}
                    aria-pressed={cycle === c}
                    className={cn(
                      "h-9 flex-1 rounded-full tracking-corpo transition-colors",
                      cycle === c ? "bg-ink text-ink-foreground" : "text-muted-foreground",
                    )}
                  >
                    {c === "annual" ? "Anual · 2 meses grátis" : "Mensal"}
                  </button>
                ))}
              </div>

              {/* Planos */}
              <div className="space-y-2">
                {plans.map((p) => {
                  const sel = p.tier === tier;
                  const v = cycle === "annual" ? p.annual_cents : p.monthly_cents;
                  return (
                    <button
                      key={p.tier}
                      type="button"
                      onClick={() => setTier(p.tier)}
                      aria-pressed={sel}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                        sel ? "border-white bg-white/10" : "border-border hover:border-line-strong",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block text-[17px] tracking-titulo">
                          {NOME_TIER[p.tier] ?? p.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {p.max_properties === null
                            ? "Imóveis ilimitados"
                            : p.max_properties === 1
                              ? "1 imóvel"
                              : `Até ${p.max_properties} imóveis`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="numero-grande text-[22px]">{brl(v)}</span>
                        <span className="text-xs text-muted-foreground">/{cycle === "annual" ? "ano" : "mês"}</span>
                        {sel && <Check className="h-4 w-4 text-success" aria-hidden />}
                      </span>
                    </button>
                  );
                })}
              </div>

              {erro && (
                <p role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {erro}
                </p>
              )}

              <Button size="lg" className="w-full" onClick={pagar} disabled={estado === "abrindo" || !plano}>
                {estado === "abrindo" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {plano ? `Pagar ${brl(preco)}${cycle === "annual" ? " por ano" : " por mês"}` : "Carregando planos…"}
              </Button>
              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                Cartão de crédito, pela Stripe. Garantia incondicional de 30 dias.
                {cycle === "annual" && " No anual, em até 10x sem juros no cartão."}
              </p>
            </div>

            <button
              type="button"
              onClick={seguirSemAssinar}
              className="mt-6 w-full text-center text-sm text-muted-foreground underline decoration-1 underline-offset-[3px] hover:text-foreground"
            >
              Entrar sem assinar por enquanto
            </button>

            <p className="mt-8 text-center text-xs text-muted-foreground">
              Já assinou por outra conta?{" "}
              <Link to="/entrar" className="underline decoration-1 underline-offset-[3px] hover:text-foreground">
                Entrar com ela
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
