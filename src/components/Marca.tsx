import { cn } from "@/lib/utils";

/**
 * A marca, desenhada e não importada: quadrado coral de cantos redondos com o
 * pino branco (um ponto e um trapézio) e a palavra "hospedepay" em minúsculas.
 *
 * É o mesmo desenho, nas mesmas proporções, que abre a página de vendas. O
 * painel usa este componente para que o cliente reconheça, no primeiro
 * segundo depois de entrar, que continua no mesmo lugar.
 *
 * `tom="tinta"` inverte o pino para fundo preto (rodapé da página, painéis de
 * destaque); o quadrado continua coral.
 */
export function MarcaSimbolo({
  size = 32,
  tom = "papel",
  className,
}: {
  size?: number;
  tom?: "papel" | "tinta";
  className?: string;
}) {
  const pino = tom === "tinta" ? "#000000" : "#ffffff";
  const r = Math.round(size * 0.3125);
  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size, borderRadius: r, background: "#FF385C" }}
    >
      <span
        className="absolute left-1/2 -translate-x-1/2 rounded-full"
        style={{ top: size * 0.34, width: size * 0.25, height: size * 0.25, background: pino }}
      />
      <span
        className="absolute left-1/2 -translate-x-1/2"
        style={{
          top: size * 0.53,
          width: size * 0.16,
          height: size * 0.19,
          background: pino,
          clipPath: "polygon(28% 0, 72% 0, 100% 100%, 0 100%)",
        }}
      />
    </span>
  );
}

export function Marca({
  size = 32,
  tom = "papel",
  className,
  semNome = false,
}: {
  size?: number;
  tom?: "papel" | "tinta";
  className?: string;
  semNome?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <MarcaSimbolo size={size} tom={tom} />
      {!semNome && (
        <span
          className="font-medium leading-none tracking-titulo"
          style={{ fontSize: Math.round(size * 0.5625), color: tom === "tinta" ? "#ffffff" : "#000000" }}
        >
          hospedepay
        </span>
      )}
    </span>
  );
}
