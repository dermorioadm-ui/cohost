import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, supabase } from "@/lib/api";
import { Marca } from "@/components/Marca";
import { Link } from "react-router-dom";

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

  const titulo =
    mode === "signup" ? "Criar sua conta" : mode === "reset" ? "Recuperar senha" : "Entrar";
  const apoio =
    mode === "signup"
      ? "Em poucos minutos seu check-in roda blindado."
      : mode === "reset"
        ? "Enviamos um link para você criar uma senha nova."
        : "Bem-vindo de volta.";

  // A mesma pílula branca da página de vendas no alto, sobre o mesmo preto do
  // herói, e o cartão de vidro embaixo: quem veio do "Assinar" reconhece o
  // lugar sem ler nada.
  return (
    <div className="min-h-screen bg-background">
      <header className="fixed inset-x-3 top-3 z-30 flex justify-center">
        <div className="flex w-full max-w-[720px] items-center justify-between gap-3 rounded-[52px] bg-white py-2 pl-4 pr-2 shadow-pill">
          <Link to="/" aria-label="Página inicial" className="rounded-full">
            <Marca size={32} />
          </Link>
          <Link
            to="/"
            className="flex h-10 items-center rounded-full border border-[#f0f0f0] px-4 text-[13px] tracking-corpo text-black transition-colors hover:border-black"
          >
            Ver a página
          </Link>
        </div>
      </header>

      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 pb-12 pt-24">
        <div className="animate-rise-in">
          <p className="rotulo text-primary">
            {mode === "signup" ? "Cadastro" : mode === "reset" ? "Senha" : "Acesso"}
          </p>
          <h1 className="mt-2 text-[34px] font-normal leading-[1.02] tracking-titulo">{titulo}</h1>
          <p className="mt-2 text-[15px] leading-snug text-muted-foreground">{apoio}</p>
        </div>

        {mode === "reset" && resetSent ? (
          <div className="paper-frame mt-7 space-y-4 !rounded-panel p-6 animate-rise-in [animation-delay:120ms]">
            <p className="text-[15px] leading-relaxed">
              Se existir uma conta com <span className="font-medium">{form.email.trim().toLowerCase()}</span>, o
              link de recuperação chega em instantes. Ele vale por 1 hora e só funciona uma vez.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Não chegou? Confira a caixa de spam. O e-mail sai de uma caixa que não é lida —
              responder a ele não chega em ninguém.
            </p>
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => {
                setMode("signin");
                setResetSent(false);
              }}
            >
              Voltar para o login
            </Button>
          </div>
        ) : (
        <form
          onSubmit={submit}
          className="paper-frame mt-7 space-y-4 !rounded-panel p-6 animate-rise-in [animation-delay:120ms]"
        >
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
                <Label htmlFor="phone">WhatsApp (com DDD)</Label>
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
                  className="text-sm text-muted-foreground underline decoration-1 underline-offset-[3px] transition-colors hover:text-foreground"
                >
                  Esqueci minha senha
                </button>
              )}
            </div>
          )}

          <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
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
          className="mt-6 w-full text-center text-sm text-muted-foreground underline decoration-1 underline-offset-[3px] transition-colors hover:text-foreground"
        >
          {mode === "signup"
            ? "Já tenho conta — entrar"
            : mode === "reset"
              ? "Lembrei a senha — voltar ao login"
              : "Não tenho conta — criar agora"}
        </button>

        <p className="mt-10 text-center text-xs leading-relaxed text-muted-foreground">
          Reserva confirmada, documento com foto, selfie e assinatura digital.
          <br />
          Contrato vem antes da chave.
        </p>
      </div>
    </div>
  );
}
