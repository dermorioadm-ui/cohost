import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Home, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

/**
 * Lista de imóveis.
 *
 * Faltava a porta de entrada da edição: o app só tinha o trilho de cadastro,
 * que sempre começa um imóvel novo. Quem quisesse trocar o preço da diária ou
 * atribuir a diarista de um imóvel já existente não tinha por onde — o único
 * caminho visível era criar outro, duplicando o imóvel.
 */

interface Property {
  id: string;
  name: string;
  neighborhood: string | null;
  city: string | null;
  turnover_price: number;
  cleaner_id: string | null;
  self_clean: boolean;
}

export default function Imoveis() {
  const { user } = useAuth();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("properties")
        .select("id, name, neighborhood, city, turnover_price, cleaner_id, self_clean")
        .is("archived_at", null)
        .order("created_at");

      setProperties((data ?? []) as Property[]);
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
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center">
          <Home className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">Nenhum imóvel ainda</p>
          <Button asChild size="sm" className="mt-4">
            <Link to="/comecar">Cadastrar o primeiro</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {properties.map((p) => (
            <Link
              key={p.id}
              to={`/imoveis/${p.id}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[p.neighborhood, p.city].filter(Boolean).join(" · ") || "Endereço não preenchido"}
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
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
