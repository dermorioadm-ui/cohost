import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/api";

/**
 * Onde o link de recuperação cai.
 *
 * Dois formatos de link chegam aqui, e os dois precisam funcionar:
 *
 * 1. `?token_hash=...&type=recovery` — o formato que a function password-reset
 *    passou a emitir. A troca por sessão é feita aqui, com `verifyOtp`. O link
 *    aponta direto para o nosso domínio e não passa pelo redirecionador do
 *    GoTrue, que descartava o destino em silêncio quando ele não estava na
 *    allow-list do projeto e mandava todo mundo para o Site URL.
 *
 * 2. Token no fragmento da URL — formato antigo, do `action_link`. O cliente
 *    troca por sessão sozinho. Links já enviados continuam valendo.
 *
 * Em ambos, `getSession()` devolve nulo por um instante. Sem esperar, a tela
 * diria "link inválido" para um link perfeitamente bom, que é o pior erro
 * possível numa recuperação de senha: a pessoa pede outro, recebe outro, e
 * falha de novo. Por isso o estado começa em "conferindo".
 */
export default function NovaSenha() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const tokenHash = params.get("token_hash");

  useEffect(() => {
    let done = false;

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // PASSWORD_RECOVERY é o evento específico deste link; SIGNED_IN cobre o
      // caso de o cliente já ter processado o token antes de assinarmos.
      if (session && (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN")) {
        done = true;
        setState("ready");
      }
    });

    if (tokenHash) {
      // O token vale uma vez só. Consumir e apagar da barra de endereço evita
      // que um refresh — ou o histórico do navegador — tente usá-lo de novo e
      // pinte de "inválido" uma recuperação que deu certo.
      supabase.auth
        .verifyOtp({ token_hash: tokenHash, type: "recovery" })
        .then(({ data, error }) => {
          if (error || !data.session) return;
          done = true;
          setState("ready");
          window.history.replaceState(null, "", "/nova-senha");
        });
    } else {
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          done = true;
          setState("ready");
        }
      });
    }

    // Rede ruim é comum no celular; três segundos evitam veredito precipitado.
    const timer = setTimeout(() => {
      if (!done) setState("invalid");
    }, 3000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [tokenHash]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return toast.error("A senha precisa de ao menos 8 caracteres");
    if (password !== confirm) return toast.error("As duas senhas não são iguais");

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (error) {
      toast.error("Não consegui salvar. Peça um link novo e tente de novo.");
      return;
    }

    toast.success("Senha alterada. Você já está dentro.");
    navigate("/painel", { replace: true });
  };

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
            Links de recuperação valem por 1 hora e só funcionam uma vez. Peça outro na tela de
            login.
          </p>
          <Button className="mt-5 h-11 w-full" onClick={() => navigate("/entrar")}>
            Ir para o login
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <KeyRound className="h-7 w-7 text-primary" />
          </div>
          <h1 className="mt-5 text-2xl font-extrabold leading-tight">Criar uma senha nova</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Ao salvar, você já entra direto no painel.
          </p>
        </div>

        <form onSubmit={save} className="space-y-4 rounded-2xl border bg-background p-5 shadow-sm">
          <div className="space-y-1.5">
            <Label htmlFor="nova">Nova senha</Label>
            <Input
              id="nova"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            <p className="text-xs text-muted-foreground">Ao menos 8 caracteres.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirma">Repita a senha</Label>
            <Input
              id="confirma"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          <Button type="submit" className="h-11 w-full" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar e entrar
          </Button>
        </form>
      </div>
    </div>
  );
}
