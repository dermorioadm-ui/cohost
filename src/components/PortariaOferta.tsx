import { useEffect, useState } from "react";
import { CheckCircle2, Clock, DoorOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * A oferta de implantação da portaria.
 *
 * O que ela precisa fazer, e quase nenhuma oferta faz: dizer o que o cliente
 * NÃO vai precisar fazer. "Conectar portaria digital" é a funcionalidade;
 * "você para de mandar nome e documento para o porteiro a cada chegada" é o
 * que a pessoa compra.
 *
 * O preço fica visível antes do clique. Botão que leva a um checkout com valor
 * surpresa queima a confiança que o resto do produto passou semanas montando.
 *
 * O card muda de forma conforme o estado — oferta, fila, pronto —, e some de
 * vez quando a portaria já funciona. Oferta que continua aparecendo depois da
 * compra é a lembrança diária de que ninguém está olhando.
 */

type Estado =
  | { fase: "carregando" }
  | { fase: "oferta" }
  | { fase: "fila"; status: string }
  | { fase: "pronto" };

const PRECO = "R$ 197";

export function PortariaOferta({ propertyId }: { propertyId: string }) {
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });
  const [indo, setIndo] = useState(false);

  useEffect(() => {
    (async () => {
      const [pedido, conta] = await Promise.all([
        supabase
          .from("porter_setup_requests")
          .select("status")
          .eq("property_id", propertyId)
          .neq("status", "cancelado")
          .maybeSingle(),
        supabase
          .from("porter_status")
          .select("active")
          .eq("property_id", propertyId)
          .maybeSingle(),
      ]);

      if (conta.data?.active) return setEstado({ fase: "pronto" });

      const st = pedido.data?.status;
      if (st === "implantado") return setEstado({ fase: "pronto" });
      if (st && st !== "interessado") return setEstado({ fase: "fila", status: st });

      setEstado({ fase: "oferta" });
    })();
  }, [propertyId]);

  if (estado.fase === "carregando") return null;

  if (estado.fase === "pronto") {
    return (
      <section className="rounded-xl border border-success/25 bg-success/[0.05] p-4">
        <div className="flex gap-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-success">Portaria conectada</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              O hóspede que preenche o cadastro já entra liberado no prédio. Você não precisa
              mandar nome e documento para o porteiro.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (estado.fase === "fila") {
    return (
      <section className="rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
        <div className="flex gap-3">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-primary">Implantação em andamento</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Recebemos seu pagamento. <strong className="text-foreground">Nossa equipe entra em
              contato em até 1 dia útil</strong> para pegar as credenciais do prédio com o síndico
              ou com a administradora. Você não precisa fazer nada agora — e pode continuar
              cadastrando o hóspede normalmente até a portaria entrar no ar.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const comprar = async () => {
    setIndo(true);
    try {
      const r = await api.porterSetup({ property_id: propertyId });
      if (r.checkout_url) {
        window.location.href = r.checkout_url;
        return;
      }
      toast.info(r.message ?? "Já recebemos seu pedido.");
      setEstado({ fase: "fila", status: r.status ?? "pago" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui abrir o pagamento");
    } finally {
      setIndo(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-primary/25 bg-primary/[0.05] p-5">
      <div className="flex items-start gap-3">
        <DoorOpen className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div>
          <h3 className="font-semibold">O hóspede se cadastra na portaria sozinho</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Com a portaria conectada, o cadastro que o hóspede já faz aqui vai direto para o
            sistema do prédio. Você para de mandar nome e documento para o porteiro a cada
            chegada, e ninguém fica parado na recepção esperando alguém achar você no WhatsApp.
          </p>
          {/* Dito antes do preço, e não depois: quem mora em prédio com
              porteiro de caderninho não tem o que comprar aqui, e descobrir
              isso depois de pagar é a pior forma de descobrir. */}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Vale para prédios que já têm <strong className="text-foreground">portaria digital ou
            sistema de controle de acesso</strong> (Kiper, Control iD, Intelbras e outros). Se o
            seu prédio ainda usa caderno na recepção, não há o que conectar — e a gente te avisa
            antes de cobrar.
          </p>
        </div>
      </div>

      <ul className="space-y-1.5 pl-8 text-sm">
        {[
          "Nossa equipe entra em contato em até 1 dia útil depois do pagamento",
          "Ela fala com o síndico ou a administradora e faz a integração inteira",
          "Você não precisa de senha, credencial nem nada técnico",
          "Depois de pronto, funciona sozinho — o cadastro vai direto para o prédio",
        ].map((t) => (
          <li key={t} className="flex gap-2 text-muted-foreground">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="leading-relaxed">{t}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
        <div>
          {/* O preço antes do clique. Checkout com valor surpresa queima a
              confiança que o resto do produto levou semanas para construir. */}
          <p className="text-lg font-extrabold tabular-nums">{PRECO}</p>
          <p className="text-xs text-muted-foreground">pagamento único, por imóvel</p>
        </div>
        <Button onClick={comprar} disabled={indo} className="min-h-[44px]">
          {indo && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Quero a portaria conectada
        </Button>
      </div>
    </section>
  );
}
