import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Assinatura a dedo.
 *
 * Escrita à mão em vez de uma biblioteca porque o que faz uma assinatura na
 * tela parecer assinatura são três detalhes que as bibliotecas genéricas
 * erram com frequência:
 *
 * 1. `touch-action: none` no canvas. Sem isso o navegador entende o traço
 *    como rolagem e a página desliza enquanto a pessoa tenta assinar — o
 *    sintoma clássico de "não consigo assinar no celular".
 *
 * 2. Escala pelo devicePixelRatio. Um canvas de 300px lógicos num aparelho 3x
 *    desenha em 300 pixels reais e sai borrado; o traço fica com cara de
 *    imagem esticada, e uma assinatura borrada não convence ninguém.
 *
 * 3. Ponto médio entre amostras (curva quadrática). Ligar os pontos com retas
 *    produz um zigue-zague anguloso que não se parece com escrita à mão.
 */

export interface AssinaturaHandle {
  vazia: boolean;
}

export function Assinatura({
  onChange,
  className,
  rotulo = "Assine no quadro abaixo",
}: {
  /** Recebe o PNG (data URL) a cada traço, ou null quando limpa. */
  onChange: (dataUrl: string | null) => void;
  className?: string;
  rotulo?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const desenhando = useRef(false);
  const ultimo = useRef<{ x: number; y: number } | null>(null);
  const [temTraco, setTemTraco] = useState(false);

  /** Redimensiona preservando o que já foi desenhado. */
  const ajustar = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const anterior =
      canvas.width > 0 ? canvas.toDataURL("image/png") : null;

    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";

    if (anterior && temTraco) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = anterior;
    }
  }, [temTraco]);

  useEffect(() => {
    ajustar();
    window.addEventListener("resize", ajustar);
    return () => window.removeEventListener("resize", ajustar);
  }, [ajustar]);

  const ponto = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const ctxDe = () => ref.current?.getContext("2d") ?? null;

  const comecar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    desenhando.current = true;
    ultimo.current = ponto(e);
  };

  const mover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!desenhando.current) return;
    const ctx = ctxDe();
    const de = ultimo.current;
    if (!ctx || !de) return;

    const para = ponto(e);
    // O traço passa pelo ponto médio como curva: ligar amostra a amostra em
    // linha reta produz um zigue-zague que não parece letra de gente.
    const meio = { x: (de.x + para.x) / 2, y: (de.y + para.y) / 2 };

    ctx.beginPath();
    ctx.moveTo(de.x, de.y);
    ctx.quadraticCurveTo(de.x, de.y, meio.x, meio.y);
    ctx.stroke();

    ultimo.current = para;
    if (!temTraco) setTemTraco(true);
  };

  const terminar = () => {
    if (!desenhando.current) return;
    desenhando.current = false;
    ultimo.current = null;
    const canvas = ref.current;
    if (canvas && temTraco) onChange(canvas.toDataURL("image/png"));
  };

  const limpar = () => {
    const canvas = ref.current;
    const ctx = ctxDe();
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setTemTraco(false);
    onChange(null);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{rotulo}</p>
        {temTraco && (
          <button
            type="button"
            onClick={limpar}
            className="inline-flex min-h-[32px] items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Eraser className="h-3.5 w-3.5" aria-hidden />
            Apagar e refazer
          </button>
        )}
      </div>

      <div className="relative overflow-hidden rounded-xl border border-white/[0.12] bg-white">
        <canvas
          ref={ref}
          onPointerDown={comecar}
          onPointerMove={mover}
          onPointerUp={terminar}
          onPointerLeave={terminar}
          onPointerCancel={terminar}
          // `touch-action: none` é o que impede a página de rolar enquanto o
          // dedo desenha. Sem ele, no celular, a tela desliza e o traço não sai.
          className="block h-40 w-full cursor-crosshair touch-none"
          aria-label="Área de assinatura"
        />
        {!temTraco && (
          <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-6">
            <div className="w-3/4 border-t border-dashed border-gray-300 pt-2 text-center">
              <span className="text-xs text-gray-400">Assine aqui com o dedo</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
