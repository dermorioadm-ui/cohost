import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Foto do rosto de quem assinou.
 *
 * O que este componente é, dito sem eufemismo: uma CAPTURA facial. Ele coloca
 * o rosto de quem assinou dentro do mesmo documento em que está a assinatura e
 * a foto do documento de identidade, para que a comparação entre os três possa
 * ser feita por uma pessoa olhando. Ele não compara nada sozinho.
 *
 * A distinção importa porque "reconhecimento facial" costuma significar
 * conferência automática (1:1 contra o documento, ou 1:N contra uma base), e
 * isso é uma chamada a um provedor de biometria — outra conta, outro custo por
 * verificação e outra conversa de consentimento. Prometer na interface o que o
 * código não faz é o tipo de coisa que só aparece no dia em que alguém precisa
 * do documento para valer.
 *
 * A câmera é aberta ao vivo, e não por `input capture`, por um motivo prático:
 * com o vídeo na tela a pessoa se enquadra antes de disparar, e a foto sai
 * utilizável na primeira tentativa. O `input capture` continua existindo como
 * saída para quem negou a permissão ou está num navegador que não abre a
 * câmera — sem ele, a permissão negada viraria um cadastro que não conclui.
 */

/** Lado do quadrado gravado. Rosto é legível bem antes disso. */
const LADO = 720;
const QUALIDADE = 0.85;

type Fase = "parado" | "abrindo" | "ao_vivo" | "pronto" | "sem_camera";

export interface TextosFacial {
  titulo: string;
  ajuda: string;
  abrir: string;
  disparar: string;
  refazer: string;
  consentimento: string;
  negada: string;
  arquivo: string;
}

export function CapturaFacial({
  onChange,
  textos,
  obrigatorio = false,
}: {
  onChange: (dataUrl: string | null) => void;
  textos: TextosFacial;
  obrigatorio?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [fase, setFase] = useState<Fase>("parado");
  const [foto, setFoto] = useState<string | null>(null);

  /** Desliga a câmera. Chamada em todo caminho de saída, sem exceção. */
  const desligar = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // A luzinha da câmera acesa depois que a pessoa saiu da tela é a diferença
  // entre um cadastro e uma denúncia. Desligar no unmount não é zelo, é o
  // mínimo.
  useEffect(() => desligar, [desligar]);

  const abrir = async () => {
    setFase("abrindo");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `facingMode` e não `exact`: num notebook só existe a câmera da
        // frente, e `exact` faria a promessa falhar em vez de usar a que há.
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setFase("ao_vivo");
    } catch {
      // Permissão negada, navegador sem suporte, câmera ocupada por outro app:
      // os três terminam no mesmo lugar, e o que a pessoa precisa é da saída,
      // não do diagnóstico.
      desligar();
      setFase("sem_camera");
    }
  };

  const disparar = () => {
    const video = videoRef.current;
    if (!video) return;

    const canvas = document.createElement("canvas");
    canvas.width = LADO;
    canvas.height = LADO;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Recorte quadrado do centro. O vídeo do celular chega em retrato e o do
    // notebook em paisagem; cortar pelo menor lado dá o mesmo enquadramento
    // nos dois, em vez de um rosto achatado num deles.
    const lado = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - lado) / 2;
    const sy = (video.videoHeight - lado) / 2;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, LADO, LADO);

    // Espelhado, igual à pré-visualização.
    //
    // A primeira versão gravava sem espelho, pelo argumento de que a imagem
    // "correta" é a não invertida. Na prática o que acontece é pior: a pessoa
    // se enquadra olhando um espelho, dispara, e a foto que aparece é o lado
    // trocado — ela não reconhece o próprio rosto e refaz. Salvar o que estava
    // na tela é a única versão que ninguém precisa conferir duas vezes, e o
    // espelhamento não atrapalha a comparação com o documento: rosto humano
    // não é texto, e quem confere olha traços, não a mão em que está o anel.
    ctx.translate(LADO, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, lado, lado, 0, 0, LADO, LADO);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const dataUrl = canvas.toDataURL("image/jpeg", QUALIDADE);
    desligar();
    setFoto(dataUrl);
    setFase("pronto");
    onChange(dataUrl);
  };

  const refazer = () => {
    setFoto(null);
    onChange(null);
    abrir();
  };

  const doArquivo = (arquivo: File) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result);
      setFoto(dataUrl);
      setFase("pronto");
      onChange(dataUrl);
    };
    fr.readAsDataURL(arquivo);
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">
          {textos.titulo}
          {obrigatorio && <span aria-hidden className="ml-0.5 text-destructive">*</span>}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{textos.ajuda}</p>
      </div>

      <div className="relative mx-auto aspect-square w-full max-w-[260px] overflow-hidden rounded-2xl border border-white/[0.08] bg-black/40">
        {foto ? (
          <img src={foto} alt="" className="h-full w-full object-cover" />
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              // Espelho: é como a pessoa se enxerga, e sem ele ela move a
              // cabeça para o lado errado. A foto gravada usa o mesmo espelho,
              // para o resultado ser o que estava na tela.
              className={cn(
                "h-full w-full -scale-x-100 object-cover",
                fase === "ao_vivo" ? "opacity-100" : "opacity-0",
              )}
            />

            {fase !== "ao_vivo" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                {fase === "abrindo" ? (
                  <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
                ) : (
                  <UserRound className="h-10 w-10 opacity-40" aria-hidden />
                )}
              </div>
            )}

            {/* A guia oval existe para o enquadramento sair certo de primeira.
                Rosto pequeno no canto do quadro é a foto que não serve para
                comparar com nada. */}
            {fase === "ao_vivo" && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <div className="h-[78%] w-[62%] rounded-[50%] border-2 border-dashed border-white/50" />
              </div>
            )}
          </>
        )}
      </div>

      {fase === "pronto" ? (
        <Button
          type="button"
          variant="outline"
          onClick={refazer}
          className="min-h-[44px] w-full"
        >
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
          {textos.refazer}
        </Button>
      ) : fase === "ao_vivo" ? (
        <Button type="button" onClick={disparar} className="min-h-[48px] w-full font-semibold">
          <Camera className="mr-2 h-4 w-4" aria-hidden />
          {textos.disparar}
        </Button>
      ) : (
        <div className="space-y-2">
          <Button
            type="button"
            onClick={abrir}
            disabled={fase === "abrindo"}
            className="min-h-[48px] w-full font-semibold"
          >
            {fase === "abrindo" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Camera className="mr-2 h-4 w-4" aria-hidden />
            )}
            {textos.abrir}
          </Button>

          {fase === "sem_camera" && (
            <>
              <p role="alert" className="text-xs leading-relaxed text-destructive">
                {textos.negada}
              </p>
              <label className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-input text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground">
                <input
                  type="file"
                  accept="image/*"
                  capture="user"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) doArquivo(f);
                    e.target.value = "";
                  }}
                />
                <Camera className="h-4 w-4 shrink-0" aria-hidden />
                {textos.arquivo}
              </label>
            </>
          )}
        </div>
      )}

      {/* Imagem de rosto é dado pessoal sensível na LGPD (art. 5º, II). O
          consentimento para dado sensível precisa ser específico e destacado —
          diluído no termo geral, ele não é consentimento. Por isso a frase
          fica aqui, ao lado do botão que tira a foto, e não trinta linhas
          acima no meio de outro texto. */}
      <p className="flex items-start gap-2 rounded-xl bg-white/[0.04] p-3 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span>{textos.consentimento}</span>
      </p>
    </div>
  );
}
