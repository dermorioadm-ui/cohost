import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  BadgeCheck, Check, Loader2, MapPin, ShoppingBasket, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { brl } from "@/lib/fees";
import { cn } from "@/lib/utils";

/**
 * Aprovações da diarista.
 *
 * Até aqui o combinado existia só na conversa: o dono digitava o valor da
 * limpeza no app e ela descobria quanto ia receber quando o dinheiro caía — ou
 * quando não caía. Esta tela transforma o combinado em um ato: ela lê o número
 * e responde.
 *
 * O aceite é por IMÓVEL, não por pessoa, porque é o imóvel que carrega o preço.
 * E ele volta a ficar pendente quando o dono mexe em qualquer um dos valores —
 * o que ela aceitou foi aquele número, não o campo.
 *
 * Recusar não desliga nada sozinho: continua sendo uma conversa entre os dois,
 * e o app não vai cancelar a limpeza de amanhã por causa de um clique. O que a
 * recusa faz é ficar VISÍVEL para o dono, com o motivo, em vez de virar um
 * mal-entendido que só aparece no fim do mês.
 */

interface Agreement {
  id: string;
  property_id: string;
  turnover_price: number;
  supplies_enabled: boolean;
  supplies_monthly_price: number;
  status: "pending" | "accepted" | "declined";
  decided_at: string | null;
  decline_note: string | null;
}

interface Property {
  id: string;
  name: string;
  neighborhood: string | null;
  city: string | null;
  address: string | null;
  street_number: string | null;
  apt_number: string | null;
  supplies_items: string[] | null;
}

const enderecoDe = (p: Property | undefined) => {
  if (!p) return "";
  const rua = [p.address, p.street_number].filter(Boolean).join(", ");
  const complemento = p.apt_number ? `apto ${p.apt_number}` : "";
  return [rua, complemento, p.neighborhood, p.city].filter(Boolean).join(" · ");
};

export default function CleanerAprovacoes() {
  const { user } = useAuth();
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [properties, setProperties] = useState<Record<string, Property>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Recusa pede motivo: um "não" sem explicação vira ligação telefônica.
  const [declining, setDeclining] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [agr, props] = await Promise.all([
        supabase
          .from("cleaner_agreements")
          .select(
            "id, property_id, turnover_price, supplies_enabled, supplies_monthly_price, status, decided_at, decline_note",
          )
          .order("created_at"),
        supabase.rpc("my_cleaning_properties"),
      ]);

      setAgreements((agr.data ?? []) as Agreement[]);
      setProperties(
        Object.fromEntries(((props.data ?? []) as Property[]).map((p) => [p.id, p])),
      );
      setLoading(false);
    })();
  }, [user]);

  const responder = async (
    a: Agreement,
    status: "accepted" | "declined",
    decline_note?: string,
  ) => {
    setSaving(a.id);
    // O gatilho no banco carimba decided_at e devolve os valores como vieram —
    // daqui só saem status e o motivo. Nem se a tela quisesse ela mudaria o preço.
    const { error } = await supabase
      .from("cleaner_agreements")
      .update({ status, decline_note: decline_note?.trim() || null })
      .eq("id", a.id);

    if (error) {
      toast.error("Não consegui salvar. Tente de novo.");
    } else {
      setAgreements((list) =>
        list.map((x) =>
          x.id === a.id
            ? { ...x, status, decline_note: decline_note?.trim() || null, decided_at: new Date().toISOString() }
            : x,
        ),
      );
      toast.success(status === "accepted" ? "Combinado aceito!" : "Recusa enviada ao cliente.");
      setDeclining(null);
      setNote("");
    }
    setSaving(null);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const pendentes = agreements.filter((a) => a.status === "pending");
  const respondidos = agreements.filter((a) => a.status !== "pending");

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-bold">Aprovações</h1>
        <p className="text-sm text-muted-foreground">
          O que o cliente propôs e você precisa confirmar.
        </p>
      </header>

      {agreements.length === 0 && (
        <div className="rounded-2xl glass-card p-8 text-center">
          <BadgeCheck className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 font-semibold">Nada para aprovar</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Quando um cliente te vincular a um apartamento, o combinado aparece aqui.
          </p>
        </div>
      )}

      {pendentes.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-warning">
            {pendentes.length === 1
              ? "1 combinado esperando você"
              : `${pendentes.length} combinados esperando você`}
          </h2>

          {pendentes.map((a) => {
            const p = properties[a.property_id];
            const emRecusa = declining === a.id;

            return (
              <article key={a.id} className="rounded-2xl glass-card p-5">
                <p className="font-bold leading-tight">{p?.name ?? "Apartamento"}</p>
                {p && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{enderecoDe(p)}</span>
                  </p>
                )}

                <div className="mt-4 space-y-2">
                  <div className="flex items-baseline justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3">
                    <span className="text-sm">Por limpeza</span>
                    <span className="text-lg font-extrabold tabular-nums">
                      {brl(a.turnover_price)}
                    </span>
                  </div>

                  {a.supplies_enabled && (
                    <div className="rounded-xl bg-muted/60 px-4 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-sm">
                          <ShoppingBasket className="h-4 w-4 shrink-0 text-muted-foreground" />
                          Reposição por mês
                        </span>
                        <span className="text-lg font-extrabold tabular-nums">
                          {brl(a.supplies_monthly_price)}
                        </span>
                      </div>

                      {(p?.supplies_items ?? []).length > 0 && (
                        <>
                          <p className="mt-2 text-xs text-muted-foreground">
                            Valor fixo do mês para você repor:
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {(p?.supplies_items ?? []).map((item) => (
                              <span
                                key={item}
                                className="rounded-full bg-background/60 px-2.5 py-1 text-xs"
                              >
                                {item}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {emRecusa ? (
                  <div className="mt-4 space-y-2">
                    <Textarea
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Ex.: o apartamento é grande, consigo por R$ 150."
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        className="h-12 flex-1"
                        disabled={saving === a.id}
                        onClick={() => responder(a, "declined", note)}
                      >
                        {saving === a.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Enviar recusa
                      </Button>
                      <Button
                        variant="outline"
                        className="h-12 flex-1"
                        disabled={saving === a.id}
                        onClick={() => {
                          setDeclining(null);
                          setNote("");
                        }}
                      >
                        Voltar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 space-y-2">
                    <Button
                      className="h-14 w-full text-base font-bold"
                      disabled={saving === a.id}
                      onClick={() => responder(a, "accepted")}
                    >
                      {saving === a.id ? (
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      ) : (
                        <Check className="mr-2 h-5 w-5" />
                      )}
                      Aceitar o combinado
                    </Button>
                    <button
                      type="button"
                      onClick={() => setDeclining(a.id)}
                      className="w-full py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Não concordo com o valor
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {respondidos.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-muted-foreground">Já respondidos</h2>

          {respondidos.map((a) => {
            const p = properties[a.property_id];
            const aceito = a.status === "accepted";

            return (
              <article key={a.id} className="rounded-2xl glass-card px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{p?.name ?? "Apartamento"}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {brl(a.turnover_price)} por limpeza
                      {a.supplies_enabled &&
                        ` · ${brl(a.supplies_monthly_price)}/mês de reposição`}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-xs font-semibold",
                      aceito ? "text-success" : "text-destructive",
                    )}
                  >
                    {aceito ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                    {aceito ? "Aceito" : "Recusado"}
                  </span>
                </div>

                {!aceito && a.decline_note && (
                  <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
                    Você respondeu: “{a.decline_note}”
                  </p>
                )}

                {aceito && (
                  <button
                    type="button"
                    onClick={() => {
                      setDeclining(a.id);
                      setNote("");
                    }}
                    className="mt-2 text-xs text-muted-foreground hover:underline"
                  >
                    Mudei de ideia
                  </button>
                )}

                {declining === a.id && aceito && (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Conte ao cliente o que mudou."
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="flex-1"
                        disabled={saving === a.id}
                        onClick={() => responder(a, "declined", note)}
                      >
                        Enviar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => setDeclining(null)}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Recusar não cancela nenhuma limpeza — o cliente vê o seu motivo e fala com você.
        Enquanto vocês não acertarem, o valor que vale é o que está aqui.
      </p>
    </div>
  );
}
