import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Maximize2, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Assinatura a dedo.
 *
 * Escrita à mão em vez de uma biblioteca porque o que faz uma assinatura na
 * tela parecer assinatura são detalhes que as bibliotecas genéricas erram:
 *
 * 1. `touch-action: none` no canvas. Sem isso o navegador entende o traço
 *    como rolagem e a página desliza enquanto a pessoa tenta assinar — o
 *    sintoma clássico de "não consigo assinar no celular".
 *
 * 2. Escala pelo devicePixelRatio. Um canvas de 300px lógicos num aparelho 3x
 *    desenha em 300 pixels reais e sai borrado.
 *
 * 3. A curva pelo ponto médio, feita CERTO (ver `mover`). Feita errado, ela
 *    produz um traço tracejado — metade dos segmentos não é desenhada.
 *
 * 4. Espaço. Assinar num retângulo de 40mm de altura sai diferente da
 *    assinatura da pessoa. Daí o modo tela cheia, e o giro para quem está com
 *    a rotação travada no celular.
 */

interface Ponto {
  x: number;
  y: number;
}

const meioEntre = (a: Ponto, b: Ponto): Ponto => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function Assinatura({
  onChange,
  className,
  rotulo = "Assine no quadro abaixo",
  obrigatorio = false,
}: {
  onChange: (dataUrl: string | null) => void;
  className?: string;
  rotulo?: string;
  obrigatorio?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const desenhando = useRef(false);

  /** Último ponto lido do dedo, e último ponto médio desenhado. */
  const ultimo = useRef<Ponto | null>(null);
  const ultimoMeio = useRef<Ponto | null>(null);

  /**
   * Espelho do `temTraco` em ref.
   *
   * O estado existe para a interface (mostrar "apagar", esconder a linha
   * guia). O desenho lê a ref porque `setTemTraco` durante o primeiro
   * movimento re-executava o efeito de dimensionar o canvas, que zera
   * `canvas.width` — e zerar a largura LIMPA o canvas. O traço sumia no meio
   * e voltava de forma assíncrona, deixando buracos.
   */
  const temTracoRef = useRef(false);
  const [temTraco, setTemTraco] = useState(false);

  const [cheia, setCheia] = useState(false);
  const [girado, setGirado] = useState(false);

  const marcarTraco = () => {
    if (temTracoRef.current) return;
    temTracoRef.current = true;
    setTemTraco(true);
  };

  const estilo = (ctx: CanvasRenderingContext2D, dpr: number) => {
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  };

  /** Redimensiona preservando o que já foi desenhado. */
  const ajustar = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;

    // `offsetWidth/Height` é a CAIXA DE LAYOUT do elemento: não sofre com o
    // `transform` do modo girado, e não depende de ler a string do estilo.
    //
    // Ler o estilo era o bug do quadro pequeno. Lá a largura é "100%", e
    // `parseFloat("100%")` devolve 100 — então o canvas desenhava numa área de
    // 100px enquanto aparecia com uns 350px, e o traço saía deslocado e fora
    // de escala. Em tela cheia a largura é um `calc(...)`, que vira NaN e caía
    // no fallback certo; era por isso que só lá funcionava.
    const larguraCss = canvas.offsetWidth;
    const alturaCss = canvas.offsetHeight;
    if (larguraCss === 0 || alturaCss === 0) return;

    const igual =
      canvas.width === Math.round(larguraCss * dpr) &&
      canvas.height === Math.round(alturaCss * dpr);
    if (igual) return;

    const anterior = temTracoRef.current && canvas.width > 0 ? canvas.toDataURL("image/png") : null;

    canvas.width = Math.round(larguraCss * dpr);
    canvas.height = Math.round(alturaCss * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    estilo(ctx, dpr);

    if (anterior) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, larguraCss, alturaCss);
      img.src = anterior;
    }
  }, []);

  useEffect(() => {
    ajustar();
    window.addEventListener("resize", ajustar);
    window.addEventListener("orientationchange", ajustar);

    // O quadro vive dentro de um diálogo que abre com animação. No primeiro
    // render a caixa ainda pode ter largura zero, e `ajustar` sai sem fazer
    // nada — sem o observador, ela nunca mais seria chamada e o canvas ficaria
    // com o tamanho errado pelo resto da sessão.
    const observador =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => ajustar()) : null;
    if (observador && ref.current) observador.observe(ref.current);

    return () => {
      window.removeEventListener("resize", ajustar);
      window.removeEventListener("orientationchange", ajustar);
      observador?.disconnect();
    };
  }, [ajustar, cheia, girado]);

  /**
   * Converte a posição do dedo em coordenada do canvas.
   *
   * Quando o canvas está girado por CSS, `getBoundingClientRect()` devolve a
   * caixa já rotacionada — os eixos não batem mais com os do desenho. Aqui a
   * rotação é desfeita à mão, em torno do centro.
   */
  const ponto = (e: { clientX: number; clientY: number }): Ponto => {
    const canvas = ref.current!;
    const rect = canvas.getBoundingClientRect();
    const larguraCss = canvas.offsetWidth;
    const alturaCss = canvas.offsetHeight;

    if (!girado) {
      // Sem rotação o rect já é a própria caixa: subtrair o canto basta.
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;

    // Inverso de rotate(90deg): (x, y) -> (y, -x)
    return { x: dy + larguraCss / 2, y: -dx + alturaCss / 2 };
  };

  const ctxDe = () => ref.current?.getContext("2d") ?? null;

  const comecar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    desenhando.current = true;
    const p = ponto(e);
    ultimo.current = p;
    ultimoMeio.current = p;

    // Um toque sem arrastar também é traço: quem assina com pingo no "i"
    // esperaria vê-lo.
    const ctx = ctxDe();
    if (ctx) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = "#111827";
      ctx.fill();
    }
    marcarTraco();
  };

  const traçar = (para: Ponto) => {
    const ctx = ctxDe();
    const de = ultimo.current;
    const meioAnterior = ultimoMeio.current;
    if (!ctx || !de || !meioAnterior) return;

    const meio = meioEntre(de, para);

    // A curva vai de MEIO ANTERIOR a MEIO ATUAL, usando o ponto lido como
    // controle. Era aqui que estava o traço tracejado: desenhar de `de` até
    // `meio` e depois saltar o cursor para `para` deixa a metade entre `meio`
    // e `para` sem desenhar — um segmento sim, um não.
    ctx.beginPath();
    ctx.moveTo(meioAnterior.x, meioAnterior.y);
    ctx.quadraticCurveTo(de.x, de.y, meio.x, meio.y);
    ctx.stroke();

    ultimo.current = para;
    ultimoMeio.current = meio;
  };

  const mover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!desenhando.current) return;

    // O navegador junta vários movimentos num evento só quando o dedo é
    // rápido. Sem ler os coalescidos, um traço rápido vira uma reta entre dois
    // pontos distantes — e a assinatura fica angulosa.
    const nativo = e.nativeEvent as PointerEvent & {
      getCoalescedEvents?: () => PointerEvent[];
    };
    const amostras =
      typeof nativo.getCoalescedEvents === "function"
        ? nativo.getCoalescedEvents()
        : [];

    if (amostras.length > 0) {
      for (const a of amostras) traçar(ponto(a));
    } else {
      traçar(ponto(e));
    }
  };

  const terminar = () => {
    if (!desenhando.current) return;
    desenhando.current = false;

    // O último ponto lido não chegou a virar meio: sem esta reta, a ponta
    // final do traço fica faltando.
    const ctx = ctxDe();
    const de = ultimo.current;
    const meioAnterior = ultimoMeio.current;
    if (ctx && de && meioAnterior) {
      ctx.beginPath();
      ctx.moveTo(meioAnterior.x, meioAnterior.y);
      ctx.lineTo(de.x, de.y);
      ctx.stroke();
    }

    ultimo.current = null;
    ultimoMeio.current = null;

    const canvas = ref.current;
    if (canvas && temTracoRef.current) onChange(canvas.toDataURL("image/png"));
  };

  const limpar = () => {
    const canvas = ref.current;
    const ctx = ctxDe();
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    temTracoRef.current = false;
    setTemTraco(false);
    onChange(null);
  };

  /** Dimensões de desenho. Em tela cheia o canvas ocupa o espaço todo. */
  const medidas = (() => {
    if (!cheia) return { largura: "100%", altura: "160px" };
    if (girado) {
      // Girado, o lado longo do desenho é a ALTURA da tela e o lado curto é a
      // largura. Num aparelho de 390px, `46vw` deixava 200px de tela ociosos
      // ao lado do traço.
      return { largura: "calc(100vh - 150px)", altura: "min(78vw, 380px)" };
    }
    return { largura: "calc(100vw - 32px)", altura: "calc(100vh - 220px)" };
  })();

  const canvasEl = (
    <canvas
      ref={ref}
      onPointerDown={comecar}
      onPointerMove={mover}
      onPointerUp={terminar}
      onPointerLeave={terminar}
      onPointerCancel={terminar}
      style={{
        width: medidas.largura,
        height: medidas.altura,
        transform: girado ? "rotate(90deg)" : undefined,
      }}
      // `touch-action: none` é o que impede a página de rolar enquanto o dedo
      // desenha. Sem ele, no celular, a tela desliza e o traço não sai.
      className="block cursor-crosshair touch-none rounded-xl bg-white"
      aria-label="Área de assinatura"
    />
  );

  if (cheia) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-neutral-900">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <p className="text-sm font-medium text-white">
            {rotulo}
            {obrigatorio && <span aria-hidden className="ml-0.5 text-red-400">*</span>}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setGirado((g) => !g)}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-white/80 hover:bg-white/10"
            >
              <RotateCw className="h-4 w-4" aria-hidden />
              {girado ? "Desgirar" : "Girar"}
            </button>
            {temTraco && (
              <button
                type="button"
                onClick={limpar}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-white/80 hover:bg-white/10"
              >
                <Eraser className="h-4 w-4" aria-hidden />
                Apagar
              </button>
            )}
            <button
              type="button"
              onClick={() => setCheia(false)}
              aria-label="Fechar"
              className="rounded-lg p-2 text-white/80 hover:bg-white/10"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Sem `overflow-hidden` e sem caixa em volta: a caixa de layout do
            canvas girado continua na orientação original, e recortá-la cortaria
            justamente a parte que aparece na tela. */}
        <div className="flex flex-1 items-center justify-center">{canvasEl}</div>

        <div className="px-4 pb-6 pt-2">
          {/* Dito porque muita gente tem a rotação travada no aparelho e não
              percebe que deitar o celular não fez nada. */}
          <p className="mb-3 text-center text-xs text-white/60">
            {girado
              ? "Deite o celular para assinar."
              : "Deite o celular — ou toque em Girar, se a rotação estiver travada."}
          </p>
          <button
            type="button"
            onClick={() => setCheia(false)}
            className="min-h-[48px] w-full rounded-xl bg-white text-sm font-semibold text-neutral-900"
          >
            Pronto
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {rotulo}
          {obrigatorio && <span aria-hidden className="ml-0.5 text-destructive">*</span>}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCheia(true)}
            className="inline-flex min-h-[32px] items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            Assinar em tela cheia
          </button>
          {temTraco && (
            <button
              type="button"
              onClick={limpar}
              className="inline-flex min-h-[32px] items-center gap-1.5 pl-3 text-xs text-muted-foreground hover:text-foreground"
            >
              <Eraser className="h-3.5 w-3.5" aria-hidden />
              Apagar
            </button>
          )}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-white/[0.12] bg-white">
        {canvasEl}
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
