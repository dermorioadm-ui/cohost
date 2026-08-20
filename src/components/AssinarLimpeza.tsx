import { useState } from "react";
import { FileSignature, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Assinatura } from "@/components/Assinatura";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

/**
 * A declaração de limpeza, assinada pela diarista.
 *
 * A data e a hora são preenchidas por ELA, e vêm pré-carregadas com o agora
 * só como ponto de partida. Ela costuma assinar no fim do dia a limpeza que
 * fez de manhã, e carimbar o relógio do servidor transformaria a declaração
 * dela numa declaração nossa.
 *
 * Assinar já conclui a limpeza. Pedir os dois toques — "marcar concluída" e
 * depois "assinar" — seria pedir que ela confirme duas vezes o mesmo fato, e
 * o segundo toque é o que fica sem fazer.
 */

/** `datetime-local` quer o horário LOCAL sem fuso, não o ISO em UTC. */
function agoraLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function AssinarLimpeza({
  taskId,
  imovel,
  onPronto,
}: {
  taskId: string;
  imovel: string;
  onPronto: () => void;
}) {
  const { user } = useAuth();
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState(
    (user?.user_metadata?.full_name as string | undefined) ?? "",
  );
  const [doc, setDoc] = useState("");
  const [quando, setQuando] = useState(agoraLocal);
  const [assinatura, setAssinatura] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const enviar = async () => {
    if (nome.trim().length < 3) return toast.error("Escreva seu nome completo");
    if (!assinatura) return toast.error("Assine no quadro antes de enviar");

    setSalvando(true);
    try {
      await api.assinarLimpeza({
        cleaning_task_id: taskId,
        // O input dá "2026-08-20T11:00" sem fuso. `new Date` interpreta como
        // horário local do aparelho, que é o que ela quis dizer.
        declarado_em: new Date(quando).toISOString(),
        signer_name: nome.trim(),
        signer_doc: doc.trim() || undefined,
        assinatura,
      });
      toast.success("Declaração assinada. O cliente recebeu o PDF por e-mail.");
      setAberto(false);
      onPronto();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui enviar");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <Button
        onClick={() => setAberto(true)}
        className="mt-4 h-14 w-full text-base font-bold"
      >
        <FileSignature className="mr-2 h-5 w-5" aria-hidden />
        Assinar e concluir
      </Button>

      <Dialog open={aberto} onOpenChange={(v) => !v && !salvando && setAberto(false)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Declaração de limpeza</DialogTitle>
            <DialogDescription>
              {imovel} — você declara que fez a limpeza na data e hora abaixo.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="assin-quando">Fiz a limpeza em</Label>
              <Input
                id="assin-quando"
                type="datetime-local"
                value={quando}
                onChange={(e) => setQuando(e.target.value)}
                className="min-h-[48px]"
              />
              {/* Dito porque o campo vem preenchido e parece só decoração. */}
              <p className="text-xs text-muted-foreground">
                Já vem com agora. Se você limpou mais cedo, corrija — é esta hora que vai no
                documento.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="assin-nome">Seu nome completo</Label>
              <Input
                id="assin-nome"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Como está no seu documento"
                autoComplete="name"
                className="min-h-[48px]"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="assin-doc">CPF ou RG (opcional)</Label>
              <Input
                id="assin-doc"
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                className="min-h-[48px]"
              />
            </div>

            <Assinatura onChange={setAssinatura} rotulo="Assine com o dedo" />

            <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Ao assinar, você declara que a limpeza foi feita, que o imóvel ficou pronto para o
              próximo hóspede, e que avisou o cliente sobre qualquer dano que encontrou. A
              limpeza é marcada como concluída e o cliente recebe o documento por e-mail.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setAberto(false)} disabled={salvando}>
              Cancelar
            </Button>
            <Button
              onClick={enviar}
              disabled={salvando || !assinatura}
              className="min-h-[48px]"
            >
              {salvando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Assinar e concluir
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
