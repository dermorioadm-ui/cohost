import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Registrar o que aconteceu na ligação.
 *
 * Três campos e não dez. Formulário longo depois de uma ligação não é
 * preenchido — quem acabou de desligar já está discando o próximo. O que a
 * equipe precisa guardar é o mínimo que evita a ligação repetida: o que
 * aconteceu, o que ficou combinado, e para quando.
 *
 * A data do retorno é o campo que faz o pipeline funcionar: é ela que puxa o
 * cliente de volta para o topo da fila no dia certo. Sem ela, "ele pediu para
 * ligar semana que vem" morre na memória de quem atendeu.
 */

const CANAIS = [
  { v: "whatsapp", t: "WhatsApp" },
  { v: "ligacao", t: "Ligação" },
  { v: "email", t: "E-mail" },
  { v: "presencial", t: "Presencial" },
] as const;

const RESULTADOS = [
  { v: "falou", t: "Falei com ele" },
  { v: "nao_atendeu", t: "Não atendeu" },
  { v: "agendou", t: "Agendou retorno" },
  { v: "resolvido", t: "Resolvido" },
  { v: "recusou", t: "Recusou" },
] as const;

export function RegistrarContato({
  userId,
  nome,
  onFechar,
  onSalvo,
}: {
  userId: string;
  nome: string;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [canal, setCanal] = useState<string>("whatsapp");
  const [resultado, setResultado] = useState<string>("falou");
  const [notas, setNotas] = useState("");
  const [passo, setPasso] = useState("");
  const [passoEm, setPassoEm] = useState("");
  const [salvando, setSalvando] = useState(false);

  const salvar = async () => {
    setSalvando(true);
    try {
      await api.admin.registrarContato({
        target_user_id: userId,
        canal,
        resultado,
        notas,
        proximo_passo: passo,
        proximo_passo_em: passoEm || null,
      });
      toast.success("Contato registrado");
      onSalvo();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui registrar");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && onFechar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar contato</DialogTitle>
          <DialogDescription>
            Com {nome}. Fica só para a equipe — o cliente não vê.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Por onde</Label>
            <div className="flex flex-wrap gap-2">
              {CANAIS.map((c) => (
                <button
                  key={c.v}
                  type="button"
                  onClick={() => setCanal(c.v)}
                  className={cn(
                    "min-h-[40px] rounded-lg border px-3 text-sm transition-colors",
                    canal === c.v
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-white/[0.08] text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {c.t}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>O que aconteceu</Label>
            <div className="flex flex-wrap gap-2">
              {RESULTADOS.map((r) => (
                <button
                  key={r.v}
                  type="button"
                  onClick={() => setResultado(r.v)}
                  className={cn(
                    "min-h-[40px] rounded-lg border px-3 text-sm transition-colors",
                    resultado === r.v
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-white/[0.08] text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {r.t}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notas">Anotação</Label>
            <Textarea
              id="notas"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              rows={3}
              placeholder="O que ele falou, o que travou, o que prometeu."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="passo">Ficou combinado</Label>
            <Input
              id="passo"
              value={passo}
              onChange={(e) => setPasso(e.target.value)}
              placeholder="Ligar de novo depois que ele achar o link"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="passo-em">Voltar em</Label>
            <Input
              id="passo-em"
              type="date"
              value={passoEm}
              onChange={(e) => setPassoEm(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
            />
            {/* Dito na tela porque é o campo que as pessoas pulam, e é o único
                que muda o comportamento do pipeline no dia seguinte. */}
            <p className="text-xs text-muted-foreground">
              Com data, ele volta para o topo da fila nesse dia. Sem data, some no meio da lista.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onFechar} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={salvando} className="min-h-[44px]">
            {salvando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
