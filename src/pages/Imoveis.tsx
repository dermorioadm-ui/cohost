import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Home, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { automationsOf, type Automation } from "@/lib/automations";
import { cn } from "@/lib/utils";

/**
 * Lista de imóveis.
 *
 * Faltava a porta de entrada da edição: o app só tinha o trilho de cadastro,
 * que sempre começa um imóvel novo. Quem quisesse trocar o preço da diária ou
 * atribuir a diarista de um imóvel já existente não tinha por onde — o único
 * caminho visível era criar outro, duplicando o imóvel.
 *
 * A lista também é o único lugar que compara imóveis lado a lado, e por isso é
 * onde as automatizações precisam aparecer: é aqui que se vê que um apartamento
 * está rodando sozinho e o outro não.
 */

interface Property {
  id: string;
  name: string;
  neighborhood: string | null;
  city: string | null;
  turnover_price: number;
  cleaner_id: string | null;
  self_clean: boolean;
  supplies_enabled: boolean;
  auto_message_confirmed_at: string | null;
  ai_enabled: boolean;
}

/** Bolinha + nome. Quatro cabem numa linha de 375px porque o rótulo é curto. */
function AutomationPill({ a }: { a: Automation }) {
  return (
    <span
      title={a.hint}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium",
        a.active ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          a.active ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      {a.label}
    </span>
  );
}

export default function Imoveis() {
  const { user } = useAuth();
  const [properties, setProperties] = useState<Property[]>([]);
  // Portaria mora noutra tabela (uma credencial por imóvel) — e só existe
  // linha para o imóvel que foi conectado, então ausência já significa "não".
  const [porterOn, setPorterOn] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [props, porter] = await Promise.all([
        supabase
          .from("properties")
          .select(
            "id, name, neighborhood, city, turnover_price, cleaner_id, self_clean, supplies_enabled, auto_message_confirmed_at, ai_enabled",
          )
          .is("archived_at", null)
          .order("created_at"),
        supabase.from("porter_status").select("property_id, active"),
      ]);

      setProperties((props.data ?? []) as Property[]);
      setPorterOn(
        new Set(
          ((porter.data ?? []) as { property_id: string; active: boolean }[])
            .filter((r) => r.active)
            .map((r) => r.property_id),
        ),
      );
      setLoading(false);
    })();
  }, [user]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Imóveis</h1>
          <p className="text-sm text-muted-foreground">Toque para editar.</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/comecar">
            <Plus className="mr-1 h-4 w-4" /> Novo
          </Link>
        </Button>
      </header>

      {properties.length === 0 ? (
        <div className="rounded-xl glass-card px-4 py-10 text-center">
          <Home className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">Nenhum imóvel ainda</p>
          <Button asChild size="sm" className="mt-4">
            <Link to="/comecar">Cadastrar o primeiro</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {properties.map((p) => {
            const automations = automationsOf({
              self_clean: p.self_clean,
              cleaner_id: p.cleaner_id,
              supplies_enabled: p.supplies_enabled,
              auto_message_confirmed_at: p.auto_message_confirmed_at,
              ai_enabled: p.ai_enabled,
              porter_active: porterOn.has(p.id),
            });
            const ligadas = automations.filter((a) => a.active).length;

            return (
              <Link
                key={p.id}
                to={`/imoveis/${p.id}`}
                className="flex items-center justify-between gap-3 rounded-xl glass-card p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[p.neighborhood, p.city].filter(Boolean).join(" · ") ||
                      "Endereço não preenchido"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    R$ {Number(p.turnover_price).toFixed(2).replace(".", ",")} por limpeza ·{" "}
                    {p.self_clean ? (
                      "você mesmo limpa"
                    ) : p.cleaner_id ? (
                      "diarista vinculada"
                    ) : (
                      <span className="text-warning">sem diarista</span>
                    )}
                  </p>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {automations.map((a) => (
                      <AutomationPill key={a.key} a={a} />
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {ligadas === 4
                      ? "As 4 automatizações ligadas."
                      : `${ligadas} de 4 automatizações ligadas.`}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
