import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/api";
import { toast } from "sonner";

/**
 * O dia em que a conta da diarista fecha.
 *
 * Vive no cadastro dela, dentro do imóvel, porque é ali que o anfitrião pensa
 * nela — mas o combinado é do PAR, não do apartamento. Quem tem três imóveis
 * com a mesma pessoa paga uma pessoa, e uma fatura por imóvel devolveria a
 * soma de cabeça que esta tela existe para acabar. Por isso o aviso embaixo
 * do campo: mudar aqui muda para todos.
 *
 * Até 28 porque fevereiro não tem 30. Um fechamento marcado para 31 nunca
 * chegaria em quatro meses do ano, e o sintoma seria "a fatura não fechou",
 * sem nada que explicasse.
 */

const DIAS = Array.from({ length: 28 }, (_, i) => i + 1);

export function FechamentoFatura({
  ownerId,
  cleanerId,
  cleanerName,
}: {
  ownerId: string;
  cleanerId: string;
  cleanerName: string;
}) {
  const [dia, setDia] = useState<number | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [fechando, setFechando] = useState(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data } = await supabase
        .from("cleaner_billing")
        .select("closing_day")
        .eq("owner_id", ownerId)
        .eq("cleaner_id", cleanerId)
        .maybeSingle();

      // Sem linha ainda: 5 é o padrão do banco, e mostrar o mesmo número que
      // será gravado evita a tela dizer uma coisa e o fechamento fazer outra.
      if (vivo) setDia((data?.closing_day as number | undefined) ?? 5);
    })();
    return () => {
      vivo = false;
    };
  }, [ownerId, cleanerId]);

  const salvar = async (novo: number) => {
    setDia(novo);
    setSalvando(true);
    const { error } = await supabase
      .from("cleaner_billing")
      .upsert(
        { owner_id: ownerId, cleaner_id: cleanerId, closing_day: novo, updated_at: new Date().toISOString() },
        { onConflict: "owner_id,cleaner_id" },
      );
    setSalvando(false);
    if (error) toast.error("Não consegui salvar o dia do fechamento");
  };

  const fecharAgora = async () => {
    setFechando(true);
    const { data, error } = await supabase.rpc("fechar_fatura_agora", {
      _cleaner_id: cleanerId,
    });
    setFechando(false);

    if (error) return toast.error(error.message);
    // Nulo quer dizer "não havia nada a cobrar". Dizer isso é melhor que um
    // "pronto!" seguido de uma lista vazia, que a pessoa lê como falha.
    if (!data) return toast.info("Nada a cobrar desde a última fatura.");
    toast.success("Fatura fechada. Ela já aparece em Faturas.");
  };

  if (dia === null) return null;

  return (
    <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Fatura mensal</p>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        No dia escolhido, a conta de {cleanerName} fecha sozinha com as limpezas concluídas, os
        reembolsos aprovados e a reposição de insumos. Você anexa o comprovante ao pagar, e ela vê o
        comprovante no painel dela.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="dia-fechamento" className="text-xs">
          Fecha todo dia
        </Label>
        <div className="flex items-center gap-2">
          <select
            id="dia-fechamento"
            value={dia}
            onChange={(e) => salvar(Number(e.target.value))}
            className="min-h-[44px] flex-1 rounded-lg border border-input bg-background px-3 text-sm"
          >
            {DIAS.map((d) => (
              <option key={d} value={d}>
                Dia {d}
              </option>
            ))}
          </select>
          {salvando && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Vale para todos os seus imóveis com {cleanerName} — é uma fatura por pessoa, não por
          apartamento.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={fecharAgora}
          disabled={fechando}
          className="flex-1"
        >
          {fechando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Fechar agora
        </Button>
        <Button asChild size="sm" variant="ghost" className="flex-1">
          <Link to="/faturas">
            Ver faturas
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
