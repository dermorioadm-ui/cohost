import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2 } from "lucide-react";
import { supabase } from "@/lib/api";

/**
 * Onde o link de confirmação de cadastro cai.
 *
 * O e-mail é emitido pela function `signup`, com `token_hash` na query. A troca
 * por sessão acontece aqui, e não no redirecionador do Supabase: o link dele
 * aponta para o Site URL do projeto, um campo de dashboard que — esquecido —
 * mandava todo cliente novo para `localhost` e deixava a conta presa em
 * "confirme seu e-mail" para sempre.
 *
 * Confirmar já loga a pessoa. Pedir a senha de novo aqui seria pedir duas
 * vezes a mesma coisa a alguém que acabou de digitá-la no cadastro.
 */
export default function Confirmar() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState<"checking" | "ok" | "invalid">("checking");

  const tokenHash = params.get("token_hash");

  useEffect(() => {
    if (!tokenHash) {
      setState("invalid");
      return;
    }

    let alive = true;

    supabase.auth
      .verifyOtp({ token_hash: tokenHash, type: "signup" })
      .then(({ data, error }) => {
        if (!alive) return;
        if (error || !data.session) {
          setState("invalid");
          return;
        }
        setState("ok");
        // O token vale uma vez. Limpar a barra de endereço evita que um refresh
        // tente reusá-lo e mostre "link inválido" para quem já confirmou.
        window.history.replaceState(null, "", "/confirmar");
        // Um instante na tela de sucesso antes do onboarding: sem isso o
        // clique no e-mail terminaria num formulário sem explicação.
        setTimeout(() => navigate("/comecar", { replace: true }), 1200);
      });

    return () => {
      alive = false;
    };
  }, [tokenHash, navigate]);

  if (state === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (state === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-6 text-center">
        <div className="max-w-xs">
          <p className="font-semibold">Este link não vale mais</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Links de confirmação só funcionam uma vez. Se você já confirmou, é só entrar. Se não,
            faça o cadastro de novo para receber outro.
          </p>
          <Button className="mt-5 h-11 w-full" onClick={() => navigate("/entrar")}>
            Ir para o login
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-6 text-center">
      <div className="max-w-xs">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <CheckCircle2 className="h-7 w-7 text-primary" />
        </div>
        <p className="mt-5 text-lg font-extrabold">E-mail confirmado</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Vamos configurar seu primeiro imóvel.
        </p>
      </div>
    </div>
  );
}
