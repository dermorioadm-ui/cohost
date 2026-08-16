import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarCheck, Loader2, Sparkles } from "lucide-react";
import { api, supabase } from "@/lib/api";

/**
 * A diarista toca no link do convite e cai aqui.
 *
 * Sem senha e sem cadastro: ela confirma o próprio telefone e entra. O link
 * sozinho não serve de credencial — ele viaja por WhatsApp, é encaminhado e
 * fica no histórico de quem já leu a conversa. O telefone que o dono cadastrou
 * é o que prende o acesso a ela, e é a única coisa que ela digita.
 *
 * O aceite devolve a sessão pronta, que gravamos direto no Supabase client.
 */
export default function CleanerAccept() {
  const { token = "" } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [preview, setPreview] = useState<{
    cleaner_name: string;
    owner_name: string;
    properties: number;
    needs_phone: boolean;
    already_accepted: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await api.cleaner.preview(token);
        setPreview(res);
        setState("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Convite inválido");
        setState("error");
      }
    })();
  }, [token]);

  const accept = async () => {
    setPhoneError("");

    if (preview?.needs_phone && phone.replace(/\D/g, "").length < 10) {
      return setPhoneError("Digite seu número com DDD.");
    }

    setBusy(true);
    try {
      const res = await api.cleaner.accept(token, phone);
      await supabase.auth.setSession({
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
      });
      navigate("/agenda");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Não consegui liberar seu acesso";
      // Telefone errado ela corrige na hora; convite inválido não tem correção
      // possível nesta tela e vira a tela de erro.
      if (msg.toLowerCase().includes("telefone")) setPhoneError(msg);
      else {
        setError(msg);
        setState("error");
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center">
        <div className="max-w-xs">
          <p className="font-semibold">{error}</p>
          <p className="text-sm text-muted-foreground mt-2">
            Peça um link novo para quem te convidou.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-muted/30">
      <div className="w-full max-w-xs text-center">
        <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
          <CalendarCheck className="h-7 w-7 text-primary" />
        </div>

        <h1 className="mt-5 text-xl font-bold leading-tight">
          {preview!.already_accepted ? "Bem-vinda de volta" : "Oi"},{" "}
          {preview!.cleaner_name.split(" ")[0]}!
        </h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          {preview!.already_accepted ? (
            <>
              Sua agenda de limpeza
              {preview!.properties > 0 &&
                ` de ${preview!.properties} ${preview!.properties === 1 ? "apartamento" : "apartamentos"}`}{" "}
              está aqui. Este é o seu link fixo — salve na tela inicial do celular.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{preview!.owner_name}</span> quer te dar
              acesso à agenda de limpeza
              {preview!.properties > 0 &&
                ` de ${preview!.properties} ${preview!.properties === 1 ? "apartamento" : "apartamentos"}`}
              .
            </>
          )}
        </p>

        <div className="mt-5 rounded-2xl border bg-background p-4 text-left space-y-2.5">
          {[
            "Você vê os horários de saída no celular",
            "Não precisa ser avisada toda vez",
            "Marca a limpeza como feita em um toque",
          ].map((line) => (
            <p key={line} className="flex gap-2.5 text-sm">
              <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <span className="text-muted-foreground">{line}</span>
            </p>
          ))}
        </div>

        {preview!.needs_phone && (
          <div className="mt-5 space-y-1.5 text-left">
            <Label htmlFor="tel">Confirme seu telefone</Label>
            <Input
              id="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(21) 99999-8888"
              inputMode="tel"
              autoComplete="tel"
              className="h-12"
            />
            {phoneError && <p className="text-xs text-destructive">{phoneError}</p>}
          </div>
        )}

        <Button onClick={accept} disabled={busy} className="w-full h-12 mt-4">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Entrar
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Não precisa criar senha nem cadastro.
        </p>
      </div>
    </div>
  );
}
