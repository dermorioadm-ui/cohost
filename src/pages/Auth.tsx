import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, supabase } from "@/lib/api";

/**
 * Entrada do dono. Cadastro, login e recuperação na mesma tela — o modo
 * alterna sem navegar, porque quem erra a senha não deveria ter que descobrir
 * onde fica o outro botão.
 */
export default function Auth() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">(
    params.get("modo") === "cadastro" ? "signup" : "signin",
  );
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);

    try {
      if (mode === "reset") {
        // A resposta do servidor é a mesma exista a conta ou não, e a tela
        // repete essa neutralidade: dizer "não achei esse e-mail" transformaria
        // o formulário em ferramenta de descoberta de quem é cliente.
        const res = await api.auth.resetPassword(form.email.trim().toLowerCase());
        setResetSent(true);
        toast.success(res.message);
        return;
      }

      if (mode === "signup") {
        if (form.name.trim().length < 3) throw new Error("Informe seu nome completo");
        if (form.password.length < 8) throw new Error("A senha precisa de ao menos 8 caracteres");

        // Quem cria a conta é o backend, não o `supabase.auth.signUp`.
        //
        // O signUp dispara a confirmação pelo e-mail padrão do Supabase, e o
        // link dele aponta para o Site URL do projeto. Com esse campo no padrão
        // de fábrica, todo cadastro recebia um link para `http://localhost:3000`
        // e a conta ficava presa em "confirme seu e-mail" para sempre — sem
        // erro em tela nenhuma. A function `signup` monta o link no nosso
        // domínio e manda pela nossa fila, com o mesmo template dos outros.
        //
        // O papel do usuário continua sendo gravado pelo gatilho
        // on_auth_user_created, no banco: aqui não haveria sessão para escrever.
        const res = await api.auth.signup({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          full_name: form.name.trim(),
          phone: form.phone,
        });

        toast.success(res.message);
        setMode("signin");
        return;
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
            {mode === "signup"
              ? "Criar sua conta"
              : mode === "reset"
                ? "Recuperar senha"
                : "Entrar"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {mode === "signup"
              ? "Em poucos minutos seu checkout roda sozinho."
              : mode === "reset"
                ? "Enviamos um link para você criar uma senha nova."
                : "Bem-vindo de volta."}
          </p>
        </div>

        {mode === "reset" && resetSent ? (
          <div className="space-y-4 rounded-2xl border bg-background p-5 shadow-sm">
            <p className="text-sm leading-relaxed">
              Se existir uma conta com <strong>{form.email.trim().toLowerCase()}</strong>, o link
              de recuperação chega em instantes. Ele vale por 1 hora e só funciona uma vez.
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Não chegou? Confira a caixa de spam. O e-mail sai de uma caixa que não é lida —
              responder a ele não chega em ninguém.
            </p>
            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => {
                setMode("signin");
                setResetSent(false);
              }}
            >
              Voltar para o login
            </Button>
          </div>
        ) : (
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

          {mode !== "reset" && (
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
              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => setMode("reset")}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Esqueci minha senha
                </button>
              )}
            </div>
          )}

          <Button type="submit" className="w-full h-11" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "signup"
              ? "Criar conta"
              : mode === "reset"
                ? "Enviar link de recuperação"
                : "Entrar"}
          </Button>
        </form>
        )}

        <button
          type="button"
          onClick={() => {
            setResetSent(false);
            setMode(mode === "signup" ? "signin" : mode === "reset" ? "signin" : "signup");
          }}
          className="mt-5 w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {mode === "signup"
            ? "Já tenho conta — entrar"
            : mode === "reset"
              ? "Lembrei a senha — voltar ao login"
              : "Não tenho conta — criar agora"}
        </button>
      </div>
    </div>
  );
}
