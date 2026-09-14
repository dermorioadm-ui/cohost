import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
 * logada. A tela troca o id da sessão de checkout por conta + sessão no
 * backend (`billing-checkout-complete`), pede uma senha para as próximas
 * entradas e manda para o onboarding. Duas telas depois do cartão, nenhuma
 * antes.
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
  | "senha"
  | "ativo"
  | "cancelado"
  | "entrar";

const MIN_SENHA = 8;

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
  const [senha, setSenha] = useState("");
  const [salvandoSenha, setSalvandoSenha] = useState(false);
  // A troca do checkout por sessão acontece uma vez, mesmo que o React rode
  // o efeito duas vezes ou a sessão chegue no meio.
  const trocando = useRef(false);

  // ---- 1. Volta do checkout da página: sem sessão, com o id da Stripe -----
  useEffect(() => {
    if (loading || user || status !== "ok" || !sessaoCheckout || trocando.current) return;
    trocando.current = true;

    (async () => {
      try {
        const r = await api.billingPublico.complete(sessaoCheckout);
        if (!r.ok) {
          // Pagamento ainda processando (boleto, 3DS pendente): dá o benefício
          // da dúvida por alguns segundos e tenta de novo.
          setEstado("esperando");
          setTimeout(() => {
            trocando.current = false;
          }, 4000);
          return;
        }
        if (r.email) setEmail(r.email);
        if (r.session) {
          await supabase.auth.setSession(r.session);
          // A URL com o id de checkout não deve ficar no histórico: ele já
          // foi usado, e um refresh acusaria "já entrou".
          window.history.replaceState(null, "", "/assinatura?status=ok");
          esquecerPlano();
          setEstado(r.conta_nova ? "senha" : "ativo");
          return;
        }
        // Já entrou antes por este link: a sessão não é reemitida.
        setEstado("entrar");
      } catch (e) {
        setErro(e instanceof ApiError ? e.message : "Não consegui confirmar o pagamento. Entre com seu e-mail.");
        setEstado("entrar");
      }
    })();
  }, [loading, user, status, sessaoCheckout, estado]);

  // ---- 2. Logado: planos e estado da assinatura ---------------------------
  useEffect(() => {
    if (loading || !user) return;
    // A sessão acabou de ser criada pela troca acima: o estado já está certo.
    if (estado === "senha" || estado === "ativo" || estado === "entrar") return;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, status]);

  // ---- 3. Sem sessão e sem checkout: não há o que fazer aqui ---------------
  useEffect(() => {
    if (loading || user) return;
    if (status === "ok" && sessaoCheckout) return;
    navigate("/entrar", { replace: true });
  }, [loading, user, status, sessaoCheckout, navigate]);

  // ---- 4. Logado, voltou do checkout: espera o webhook ---------------------
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

  const salvarSenha = async (e: React.FormEvent) => {
    e.preventDefault();
    if (senha.length < MIN_SENHA) {
      setErro(`A senha precisa de ao menos ${MIN_SENHA} caracteres.`);
      return;
    }
    setErro(null);
    setSalvandoSenha(true);
    const { error } = await supabase.auth.updateUser({ password: senha });
    setSalvandoSenha(false);
    if (error) {
      setErro("Não consegui salvar a senha. Você pode definir depois em \"esqueci minha senha\".");
      return;
    }
    navigate("/comecar", { replace: true });
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

        {/* ---------------------------------- conta nova: só falta a senha */}
        {estado === "senha" && (
          <form onSubmit={salvarSenha} className="animate-rise-in">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-7 w-7 text-success" aria-hidden />
            </span>
            <p className="rotulo mt-5 text-primary">Pagamento confirmado</p>
            <h1 className="mt-2 text-[30px] font-normal leading-[1.05] tracking-titulo">
              Sua conta está criada.
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              Você já está dentro. Escolha uma senha para entrar das próximas vezes
              {email ? <> com <span className="text-foreground">{email}</span></> : null}.
            </p>

            <div className="paper-frame mt-7 space-y-4 !rounded-panel p-6">
              <div className="space-y-1.5">
                <Label htmlFor="senha">Senha</Label>
                <Input
                  id="senha"
                  type="password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  minLength={MIN_SENHA}
                  required
                />
                <p className="text-xs text-muted-foreground">Ao menos {MIN_SENHA} caracteres.</p>
              </div>
              {erro && (
                <p role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {erro}
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={salvandoSenha}>
                {salvandoSenha && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Salvar e configurar meu imóvel
              </Button>
            </div>

            <button
              type="button"
              onClick={() => navigate("/comecar", { replace: true })}
              className="mt-6 w-full text-center text-sm text-muted-foreground underline decoration-1 underline-offset-[3px] hover:text-foreground"
            >
              Definir a senha depois
            </button>
          </form>
        )}

        {/* ------------------------------- link já usado: entra pelo e-mail */}
        {estado === "entrar" && (
          <div className="animate-rise-in">
            <p className="rotulo text-primary">Pagamento confirmado</p>
            <h1 className="mt-2 text-[30px] font-normal leading-[1.05] tracking-titulo">
              Sua conta já existe.
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
              {erro ??
                `Entre com ${email || "o e-mail do pagamento"}. Se ainda não tem senha, use "esqueci minha senha" na tela de entrada.`}
            </p>
            <Button asChild size="lg" className="mt-7 w-full">
              <Link to="/entrar">Entrar</Link>
            </Button>
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
                    {c === "annual" ? "Anual · 2 meses grátis" : "Mensal"}
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
          </div>
        )}
      </div>
    </div>
  );
}
