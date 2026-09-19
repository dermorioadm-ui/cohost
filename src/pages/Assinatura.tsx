import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LegalUpsell } from "@/components/LegalUpsell";
import { Marca } from "@/components/Marca";
import { api, ApiError, supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import {
  brl, esquecerPlano, guardarPlano, NOME_TIER, planoDaQuery, planoGuardado,
  type Ciclo, type PlanoEscolhido, type Tier,
} from "@/lib/planoEscolhido";
import { cn } from "@/lib/utils";

/**
 * A tela entre o pagamento e o produto.
 *
 * O caminho principal começa NA PÁGINA DE VENDAS: o botão do plano abre a
 * Stripe direto, sem conta. A Stripe pede nome, e-mail e telefone; ao voltar,
 * a pessoa cai aqui em `/assinatura?status=ok&session=cs_...` sem estar
 * logada. O servidor confirma o pagamento e solicita autenticação por e-mail.
 * Nenhum id de checkout concede uma sessão. O acesso depende de confirmação
 * do servidor; demora ou erro de rede nunca é tratado como pagamento ativo.
 *
 * Os outros momentos que passam por aqui:
 *
 *   /assinatura                  — logado, sem assinatura ativa (veio do
 *                                  aviso do painel ou do "Meu plano"):
 *                                  escolhe e paga pelo checkout amarrado à
 *                                  conta (`billing-checkout`).
 *   /assinatura?status=ok        — logado, voltou do checkout: espera o
 *                                  webhook ativar antes de soltar no painel.
 *   /assinatura?status=cancelado — desistiu no checkout logado.
 *
 * O preço nunca vem daqui: o backend lê `plans` e só aceita tier e ciclo.
 */

interface Plan {
  tier: Tier;
  name: string;
  monthly_cents: number;
  annual_cents: number;
  max_properties: number | null;
}

type Estado =
  | "carregando"
  | "escolher"
  | "abrindo"
  | "esperando"
  | "pendente"
  | "inativo"
  | "ativo"
  | "cancelado"
  | "entrar";

export default function Assinatura() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const status = params.get("status");
  const sessaoCheckout = params.get("session");

  const inicial = useMemo<PlanoEscolhido>(
    () => planoDaQuery(params) ?? planoGuardado() ?? { tier: "essencial", cycle: "annual" },
    [params],
  );
  const [tier, setTier] = useState<Tier>(inicial.tier);
  const [cycle, setCycle] = useState<Ciclo>(inicial.cycle);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [estado, setEstado] = useState<Estado>("carregando");
  const [erro, setErro] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (loading) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;
    setErro(null);
    setEstado("carregando");

    async function check() {
      try {
        if (status === "ok" && sessaoCheckout) {
          const result = await api.billingPublico.complete(sessaoCheckout);
          if (stopped) return;
          if (!result.ok || result.estado === "pendente") { wait(); return; }
          if (result.requires_login || !user) {
            setEmail(result.email ?? "");
            setEstado("entrar");
            return;
          }
          if (result.estado === "inativo") { setEstado("inativo"); return; }
        }
        if (!user) { navigate("/entrar", { replace: true }); return; }
        const profile = await supabase.from("profiles").select("subscription_status").eq("user_id", user.id).maybeSingle();
        if (stopped) return;
        if (profile.error) throw profile.error;
        if (profile.data?.subscription_status === "active") {
          esquecerPlano(); setEstado("ativo"); return;
        }
        if (status === "ok") { wait(); return; }
        const response = await supabase.from("plans").select("tier, name, monthly_cents, annual_cents, max_properties").eq("active", true).order("sort_order");
        if (stopped) return;
        if (response.error) throw response.error;
        setPlans((response.data ?? []) as Plan[]);
        setEstado(status === "cancelado" ? "cancelado" : "escolher");
      } catch (err) {
        if (stopped) return;
        setErro(err instanceof ApiError ? err.message : "Não consegui consultar o pagamento agora. Tente novamente.");
        setEstado("pendente");
      }
    }
    function wait() {
      if (++tries >= 20) { setEstado("pendente"); return; }
      setEstado("esperando");
      timer = setTimeout(check, 3000);
    }
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [loading, user?.id, status, sessaoCheckout, navigate, attempt]);

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

        {/* ------------------------------------------ pagamento confirmado */}
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
                ? "Agora você pode ligar seu calendário e configurar seu imóvel."
                : "Seu acesso será liberado após a confirmação do pagamento. Aguarde um instante."}
            </p>
            {estado === "ativo" && (
              <Button size="lg" className="mt-7 w-full" onClick={() => navigate("/comecar", { replace: true })}>
                Configurar meu imóvel
              </Button>
            )}
            {estado === "ativo" && status === "ok" && <LegalUpsell />}
          </div>
        )}

        {estado === "pendente" && (
          <div aria-live="polite">
            <p className="rotulo text-primary">Confirmação pendente</p>
            <h1 className="mt-3 text-3xl tracking-titulo">Ainda não foi possível confirmar.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{erro || "O pagamento pode continuar em processamento. Seu acesso será liberado após a confirmação. Não é necessário pagar novamente enquanto aguarda."}</p>
            <Button size="lg" className="mt-6 w-full" onClick={() => setAttempt((n) => n + 1)}>Verificar novamente</Button>
            {user && <Button asChild variant="outline" className="mt-3 w-full"><Link to="/plano">Consultar meu plano</Link></Button>}
          </div>
        )}
        {estado === "inativo" && <div><h1 className="text-3xl tracking-titulo">Esta assinatura não está ativa.</h1><p className="mt-3 text-muted-foreground">Este retorno corresponde a uma compra anterior. Consulte a situação atual do seu plano.</p><Button asChild className="mt-6"><Link to="/plano">Consultar meu plano</Link></Button></div>}

        {/* ------------------------------- link já usado: entra pelo e-mail */}
        {estado === "entrar" && (
          <div className="animate-rise-in">
            <p className="rotulo text-primary">Pagamento confirmado</p>
            <h1 className="mt-2 text-[30px] font-normal leading-[1.05] tracking-titulo">
              Confirme seu acesso.
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              {erro ??
                `Entre com ${email || "o e-mail do pagamento"}. Para criar sua senha, solicite o link enviado ao seu e-mail.`}
            </p>
            <Button asChild size="lg" className="mt-7 w-full">
              <Link to={`/entrar?retorno=${encodeURIComponent("/assinatura?status=ok")}`}>Entrar na minha conta</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="mt-3 w-full"><Link to="/entrar?modo=recuperar&retorno=%2Fassinatura%3Fstatus%3Dok">Criar ou recuperar minha senha</Link></Button>
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

        {/* ---------------------------------------- logado: escolher e pagar */}
        {(estado === "escolher" || estado === "abrindo") && (
          <div className="animate-rise-in">
            <p className="rotulo text-primary">Assinatura</p>
            <h1 className="mt-2 text-[30px] font-normal leading-[1.05] tracking-titulo">
              Confirme o plano e pague.
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              Os três planos são iguais. Só muda quantos imóveis rodam.
            </p>

            <div className="paper-frame mt-7 space-y-4 !rounded-panel p-5">
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
                    {c === "annual" ? "Anual" : "Mensal"}
                  </button>
                ))}
              </div>

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
                {estado === "abrindo" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {plano ? `Pagar ${brl(preco)}${cycle === "annual" ? " por ano" : " por mês"}` : "Carregando planos…"}
              </Button>
              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                Pagamento pela Stripe. Confira as condições no checkout. A garantia da ferramenta não se aplica à assistência jurídica, contratada separadamente.
              </p>
            </div>

            <button
              type="button"
              onClick={seguirSemAssinar}
              className="mt-6 w-full text-center text-sm text-muted-foreground underline decoration-1 underline-offset-[3px] hover:text-foreground"
            >
              Entrar sem assinar por enquanto
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
