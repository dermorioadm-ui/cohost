import { useCallback, useEffect, useState } from "react";
import { Download, FileSignature, Loader2, Mail } from "lucide-react";
import { api, type TermoAssinado } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Os termos assinados, com o PDF para baixar.
 *
 * O documento chegava só como anexo de e-mail. Anexo de e-mail é a cópia que
 * some: a pessoa apaga a mensagem, troca de caixa, ou simplesmente não acha
 * seis meses depois — que é exatamente quando um termo é procurado.
 *
 * Aqui ele fica onde o dono já está. E o botão baixa o arquivo em vez de abrir
 * numa aba: quem clica em "termo assinado" quer o documento na mão, não uma
 * pré-visualização que ele vai ter que salvar depois.
 */

const dataHora = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function BotaoBaixarTermo({
  termo,
  className,
  compacto = false,
}: {
  termo: TermoAssinado;
  className?: string;
  compacto?: boolean;
}) {
  const [indo, setIndo] = useState(false);

  const baixar = async () => {
    if (!termo.pdf_path) {
      toast.error("Este termo ficou sem PDF. Fale com o suporte.");
      return;
    }
    setIndo(true);
    try {
      const url = await api.termos.link(termo.pdf_path);
      // `window.open` num handler assíncrono é bloqueado como popup em boa
      // parte dos navegadores de celular. O link temporário resolve isso:
      // navegar direto entrega o arquivo sem abrir aba.
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui abrir o documento");
    } finally {
      setIndo(false);
    }
  };

  return (
    <button
      type="button"
      onClick={baixar}
      disabled={indo}
      className={cn(
        "inline-flex items-center gap-1.5 font-medium text-primary hover:underline disabled:opacity-60",
        compacto ? "min-h-[32px] text-xs" : "min-h-[40px] text-sm",
        className,
      )}
    >
      {indo ? (
        <Loader2 className={cn("animate-spin", compacto ? "h-3.5 w-3.5" : "h-4 w-4")} />
      ) : (
        <Download className={compacto ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden />
      )}
      Baixar termo
    </button>
  );
}

/** Lista de termos de um imóvel. */
export function TermosAssinados({ propertyId }: { propertyId: string }) {
  const [lista, setLista] = useState<TermoAssinado[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setLista(await api.termos.listar({ propertyId }));
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não consegui carregar");
    }
  }, [propertyId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (erro) {
    return (
      <section className="glass-card rounded-xl p-5">
        <p className="text-sm text-muted-foreground">{erro}</p>
      </section>
    );
  }

  if (!lista) {
    return (
      <section className="glass-card flex justify-center rounded-xl p-5">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </section>
    );
  }

  return (
    <section className="glass-card space-y-3 rounded-xl p-5">
      <div className="flex items-center gap-2">
        <FileSignature className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="font-semibold">Termos assinados</h2>
      </div>

      {lista.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Nada assinado ainda. Assim que um hóspede fizer o cadastro ou a diarista concluir uma
          limpeza, o documento aparece aqui para você baixar.
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.05]">
          {lista.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {t.kind === "limpeza_concluida" ? "Limpeza" : "Hóspede"} · {t.signer_name}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {/* A data DECLARADA vem primeiro quando existe: é o fato.
                      A da assinatura é quando a pessoa registrou o fato. */}
                  {t.declarado_em
                    ? `Declarado para ${dataHora(t.declarado_em)} · assinado ${dataHora(t.assinado_em)}`
                    : `Assinado em ${dataHora(t.assinado_em)}`}
                </p>
                {t.pdf_enviado_em && (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Mail className="h-3 w-3" aria-hidden />
                    enviado para o seu e-mail
                  </p>
                )}
              </div>
              <BotaoBaixarTermo termo={t} compacto />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
