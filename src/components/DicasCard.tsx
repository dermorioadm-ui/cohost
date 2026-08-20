import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Lightbulb, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "Dá para melhorar": o próximo passo, um de cada vez.
 *
 * Duas escolhas que definem esta peça:
 *
 * UMA DICA POR VEZ. O backend devolve a lista inteira em ordem de dependência,
 * e a tela mostra só a primeira. Cinco sugestões de melhoria empilhadas viram
 * uma lista de tarefas — e lista de tarefas dentro de um produto que prometeu
 * tirar trabalho da frente da pessoa é uma contradição que ela sente na hora.
 *
 * NÃO É POPUP. Um modal interrompe o que a pessoa veio fazer e cobra um clique
 * só para sumir; o preço disso é ela aprender a fechar sem ler. Aqui o card
 * fica no fluxo da página, some quando não há o que sugerir, e o "agora não"
 * vale por uma semana — tempo suficiente para não virar praga, curto o
 * bastante para a oportunidade voltar.
 */

const ADIADO = "hospedepay.dica-adiada";
const UMA_SEMANA = 7 * 24 * 60 * 60 * 1000;

export function DicasCard({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [dados, setDados] = useState<Awaited<ReturnType<typeof api.dicas>> | null>(null);
  const [adiadas, setAdiadas] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(ADIADO) ?? "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    // Falha aqui não vira erro na tela: uma sugestão que não carregou não pode
    // atrapalhar quem veio olhar o calendário.
    api.dicas().then(setDados).catch(() => setDados(null));
  }, []);

  if (!dados || dados.total === 0) return null;

  const agora = Date.now();
  const dica = dados.dicas
    .slice()
    .sort((a, b) => a.peso - b.peso)
    .find((d) => !adiadas[d.chave] || agora - adiadas[d.chave] > UMA_SEMANA);

  if (!dica) return null;

  const adiar = () => {
    const novo = { ...adiadas, [dica.chave]: agora };
    setAdiadas(novo);
    localStorage.setItem(ADIADO, JSON.stringify(novo));
  };

  return (
    <section
      className={cn(
        "rounded-xl border p-4",
        // A oferta paga tem cor própria: misturá-la com as dicas gratuitas
        // faria a pessoa clicar esperando um botão e encontrar um preço.
        dica.oferta
          ? "border-primary/30 bg-primary/[0.06]"
          : "border-white/[0.08] bg-white/[0.03]",
        className,
      )}
      aria-label="Sugestão de melhoria"
    >
      <div className="flex items-start gap-3">
        <Lightbulb
          className={cn("mt-0.5 h-4 w-4 shrink-0", dica.oferta ? "text-primary" : "text-warning")}
          aria-hidden
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">{dica.titulo}</p>
            <button
              onClick={adiar}
              aria-label="Agora não"
              // 44px de área de toque num ícone de 16px: hitSlop feito com
              // padding negativo no visual, e não com um X gigante.
              className="-m-2 shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* O porquê vem antes do botão. Tarefa sem motivo a pessoa adia. */}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{dica.porque}</p>

          <button
            onClick={() => navigate(dica.destino)}
            className={cn(
              "mt-3 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors",
              dica.oferta
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-white/[0.06] hover:bg-white/[0.1]",
            )}
          >
            {dica.oferta ? "Ver como funciona" : "Configurar agora"}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
}
