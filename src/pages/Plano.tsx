import { useEffect, useMemo, useState } from "react";
import { Check, CreditCard, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError, supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Meu plano.
 *
 * Os planos, os limites e a cobrança existem no backend desde a 0011 — o que
 * não existia era onde o dono visse em qual deles está. Sem esta tela, "quantos
 * imóveis ainda posso cadastrar" só aparecia como erro no meio do cadastro, e
 * trocar de plano exigia falar com o suporte.
 *
 * A tela responde três perguntas, nessa ordem: em que plano estou, quanto do
 * limite já usei, e o que ganho subindo. O botão de upgrade leva ao checkout do
 * Stripe; quem já paga vai para o portal, onde troca cartão e cancela sozinho.
 */

interface Plan {
  tier: "essencial" | "pro" | "ilimitado";
  name: string;
  monthly_cents: number;
  annual_cents: number;
  max_properties: number | null;
  sort_order: number;
}

interface Profile {
  plan: Plan["tier"];
  subscription_status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  trial_ends_at: string | null;
}

const brl = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const STATUS_LABEL: Record<Profile["subscription_status"], string> = {
  trialing: "Em teste",
  active: "Assinatura ativa",
  past_due: "Pagamento atrasado",
  canceled: "Assinatura cancelada",
  incomplete: "Pagamento pendente",
};

/** Dias inteiros que faltam — arredonda para cima: "meio dia" ainda é 1 dia. */
const daysLeft = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000));

export default function Plano() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [propertyCount, setPropertyCount] = useState(0);
  const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    (async () => {
      const [pl, pr, count] = await Promise.all([
        supabase
          .from("plans")
          .select("tier, name, monthly_cents, annual_cents, max_properties, sort_order")
          .eq("active", true)
          .order("sort_order"),
        supabase
          .from("profiles")
          .select("plan, subscription_status, trial_ends_at")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("properties")
          .select("id", { count: "exact", head: true })
          .is("archived_at", null),
      ]);

      setPlans((pl.data ?? []) as Plan[]);
      setProfile((pr.data ?? null) as Profile | null);
      setPropertyCount(count.count ?? 0);
      setLoading(false);
    })();
  }, [user]);

  const current = useMemo(
    () => plans.find((p) => p.tier === profile?.plan) ?? null,
    [plans, profile],
  );

  const limit = current?.max_properties ?? null;
  const noLimite = limit !== null && propertyCount >= limit;

  const assinar = async (tier: Plan["tier"]) => {
    setBusy(tier);
    try {
      const { url } = await api.billing.checkout({ tier, cycle });
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não consegui abrir o checkout");
      setBusy(null);
    }
  };

  const gerenciar = async () => {
    setBusy("portal");
    try {
      const { url } = await api.billing.portal();
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não consegui abrir o portal");
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const pagando = profile?.subscription_status === "active";
  const comProblema =
    profile?.subscription_status === "past_due" ||
    profile?.subscription_status === "incomplete";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-bold">Meu plano</h1>
        <p className="text-sm text-muted-foreground">
          Onde você está hoje e o que muda se subir.
        </p>
      </header>

      {/* ------------------------------------------------------ plano atual */}
      <section className="glass-accent space-y-4 rounded-2xl px-5 py-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Plano atual
            </p>
            <p className="text-2xl font-bold">{current?.name ?? "—"}</p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
              pagando
                ? "bg-success/10 text-success"
                : comProblema
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {profile ? STATUS_LABEL[profile.subscription_status] : "—"}
          </span>
        </div>

        {current && (
          <p className="text-sm text-muted-foreground">
            {brl(current.monthly_cents)} por mês
            {current.annual_cents > 0 && (
              <> · {brl(current.annual_cents)} no anual</>
            )}
          </p>
        )}

        {comProblema && (
          <div className="flex gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              O último pagamento não passou. Atualize o cartão para não perder o
              acesso.
            </span>
          </div>
        )}

        {/* Uso do limite — é o número que faz o dono entender por que subir */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Imóveis cadastrados</span>
            <span className="font-medium">
              {propertyCount}
              {limit !== null ? ` de ${limit}` : " (sem limite)"}
            </span>
          </div>
          {limit !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  noLimite ? "bg-destructive" : "bg-primary",
                )}
                style={{ width: `${Math.min(100, (propertyCount / limit) * 100)}%` }}
              />
            </div>
          )}
          {noLimite && (
            <p className="text-xs text-destructive">
              Você atingiu o limite. Para cadastrar outro imóvel, suba de plano.
            </p>
          )}
        </div>

        {(pagando || comProblema) && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={gerenciar}
            disabled={busy !== null}
          >
            {busy === "portal" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CreditCard className="mr-2 h-4 w-4" />
            )}
            Gerenciar assinatura, cartão e notas
          </Button>
        )}
      </section>

      {/* --------------------------------------------------------- upgrades */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Planos</h2>

          {/* Anual primeiro no olho, mensal como padrão: quem quer economizar
              procura; quem só quer assinar não deve ser empurrado ao anual. */}
          <div className="flex rounded-lg bg-muted p-0.5 text-xs">
            {(["monthly", "annual"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCycle(c)}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  cycle === c ? "bg-background shadow-sm" : "text-muted-foreground",
                )}
              >
                {c === "monthly" ? "Mensal" : "Anual"}
              </button>
            ))}
          </div>
        </div>

        {plans.map((p) => {
          const atual = p.tier === profile?.plan;
          const preco = cycle === "annual" ? p.annual_cents : p.monthly_cents;
          const porImovel =
            p.max_properties && p.max_properties > 0
              ? Math.round(p.monthly_cents / p.max_properties)
              : null;

          return (
            <article
              key={p.tier}
              className={cn(
                "rounded-xl p-5",
                atual ? "glass-accent border border-primary/30" : "glass-card",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {p.max_properties === null
                      ? "Imóveis ilimitados"
                      : `Até ${p.max_properties} imóvel${p.max_properties > 1 ? "eis" : ""}`}
                  </p>
                </div>
                {atual && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                    Seu plano
                  </span>
                )}
              </div>

              <p className="mt-3 text-xl font-bold">
                {brl(preco)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  /{cycle === "annual" ? "ano" : "mês"}
                </span>
              </p>

              {porImovel && cycle === "monthly" && (
                <p className="text-xs text-muted-foreground">
                  {brl(porImovel)} por imóvel
                </p>
              )}

              {!atual && (
                <Button
                  size="sm"
                  className="mt-4 w-full"
                  onClick={() => assinar(p.tier)}
                  disabled={busy !== null}
                >
                  {busy === p.tier ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-2 h-4 w-4" />
                  )}
                  {current && p.sort_order < current.sort_order
                    ? "Mudar para este"
                    : "Assinar este plano"}
                </Button>
              )}
            </article>
          );
        })}

        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          A troca é imediata e o valor é ajustado proporcionalmente pelo Stripe —
          você não paga dobrado pelo mês em curso.
        </p>
      </section>
    </div>
  );
}
