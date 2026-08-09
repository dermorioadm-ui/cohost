import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/api";

/**
 * Entrada do dono. Cadastro e login na mesma tela — o modo alterna sem
 * navegar, porque quem erra a senha não deveria ter que descobrir onde fica
 * o outro botão.
 */
export default function Auth() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">(
    params.get("modo") === "cadastro" ? "signup" : "signin",
  );
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);

    try {
      if (mode === "signup") {
        if (form.name.trim().length < 3) throw new Error("Informe seu nome completo");
        if (form.password.length < 8) throw new Error("A senha precisa de ao menos 8 caracteres");

        const { data, error } = await supabase.auth.signUp({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          options: {
            data: { full_name: form.name.trim(), whatsapp: form.phone },
          },
        });
        if (error) throw error;

        // O papel do usuário é gravado pelo gatilho on_auth_user_created, no
        // banco. Aqui não dá: com confirmação de e-mail ligada, o cadastro não
        // devolve sessão, então qualquer escrita daqui sairia sem autenticação
        // e a RLS recusaria — sem erro visível, deixando a conta sem papel.

        // Sem sessão, o cadastro só termina depois que o e-mail é confirmado.
        if (!data.session) {
          toast.success("Conta criada! Confirme o e-mail que enviamos para entrar.");
          setMode("signin");
          return;
        }

        toast.success("Conta criada! Vamos configurar seu primeiro imóvel.");
        navigate("/comecar");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: form.email.trim().toLowerCase(),
          password: form.password,
        });
        if (error) throw new Error("E-mail ou senha incorretos");
        navigate("/painel");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não consegui continuar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-muted/30">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <p className="text-xs font-bold tracking-widest uppercase text-primary">HospedePay</p>
          <h1 className="mt-2 text-2xl font-extrabold leading-tight">
            {mode === "signup" ? "Criar sua conta" : "Entrar"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {mode === "signup"
              ? "Em poucos minutos seu checkout roda sozinho."
              : "Bem-vindo de volta."}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 bg-background rounded-2xl border p-5 shadow-sm">
          {mode === "signup" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="name">Seu nome</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="João da Silva"
                  autoComplete="name"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone">WhatsApp</Label>
                <Input
                  id="phone"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="(21) 99999-8888"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="email"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Senha</Label>
            <Input
              id="password"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
            />
          </div>

          <Button type="submit" className="w-full h-11" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "signup" ? "Criar conta" : "Entrar"}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          className="mt-5 w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {mode === "signup" ? "Já tenho conta — entrar" : "Não tenho conta — criar agora"}
        </button>
      </div>
    </div>
  );
}
