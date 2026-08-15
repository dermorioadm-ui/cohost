import { useEffect, useState } from "react";
import {
  AlertCircle, Check, ChevronDown, DoorOpen, Loader2, Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, type PorterCredentials, type PorterState } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Conectar o imóvel à portaria digital (Kiper/Porter).
 *
 * O que esta tela liga: o hóspede preenche o cadastro em `/c/:slug`, e a
 * pessoa aparece liberada na portaria do prédio sozinha — sem ninguém digitar
 * nome, e-mail e período no app do condomínio. O backend já fazia tudo isso;
 * faltava alguém informar as credenciais do prédio.
 *
 * Duas diferenças em relação ao formulário do app antigo:
 *
 * **Os campos vêm vazios, sempre.** No app antigo o formulário lia as
 * credenciais de volta do banco e as mostrava mascaradas — ou seja, qualquer
 * um com a sessão do dono extraía o token do prédio. Aqui a tabela não tem
 * policy de SELECT: não há o que carregar. Trocar uma credencial é recolar as
 * seis; é uma vez por token vencido, não uma vez por dia.
 *
 * **O teste roda no servidor.** O antigo chamava a Kiper direto do navegador,
 * o que fazia o token trafegar na máquina do cliente e dependia do CORS de um
 * terceiro para a checagem funcionar.
 */

const FIELDS: Array<{
  key: keyof PorterCredentials;
  label: string;
  hint: string;
  placeholder: string;
}> = [
  {
    key: "porter_token",
    label: "Token de autenticação",
    hint: "header token (ou x-auth-token)",
    placeholder: "cloud-xxxxxxxxxxxxxxxxxxxx",
  },
  {
    key: "porter_application_key",
    label: "Chave da aplicação",
    hint: "header applicationkey",
    placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    key: "porter_condo_person_context_id",
    label: "ID do condomínio",
    hint: "header condominiumpersoncontextid",
    placeholder: "1118161",
  },
  {
    key: "porter_user_partner_context_id",
    label: "ID do parceiro",
    hint: "header userpartnercontextid",
    placeholder: "5508",
  },
  {
    key: "porter_user_context_id",
    label: "ID do usuário",
    hint: "header usercontextid",
    placeholder: "1324627",
  },
  {
    key: "porter_account_local_id",
    label: "ID da conta local",
    hint: "header accountlocalid",
    placeholder: "1037399",
  },
];

const EMPTY: PorterCredentials = {
  porter_token: "",
  porter_application_key: "",
  porter_account_local_id: "",
  porter_user_context_id: "",
  porter_user_partner_context_id: "",
  porter_condo_person_context_id: "",
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function PorterConnect({ propertyId }: { propertyId: string }) {
  const [state, setState] = useState<PorterState | null>(null);
  const [form, setForm] = useState<PorterCredentials>(EMPTY);
  const [open, setOpen] = useState(false);
  const [howTo, setHowTo] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "disconnect" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    let alive = true;
    api.porter
      .status(propertyId)
      .then((s) => alive && setState(s))
      .catch(() => alive && setState({ ok: false, connected: false }));
    return () => {
      alive = false;
    };
  }, [propertyId]);

  const set = (key: keyof PorterCredentials, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const filled = FIELDS.every((f) => form[f.key].trim());

  const test = async () => {
    setBusy("test");
    setFailed(null);
    try {
      const res = await api.porter.test({ property_id: propertyId, ...form });
      if (res.ok) toast.success(res.message);
      else {
        setFailed(res.message);
        toast.error(res.message);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não consegui testar agora");
    } finally {
      setBusy(null);
    }
  };

  const save = async (skipTest = false) => {
    setBusy("save");
    try {
      const res = await api.porter.save({ property_id: propertyId, ...form, skip_test: skipTest });

      if (!res.ok) {
        // Não salvou porque a portaria recusou. O motivo fica na tela junto do
        // "salvar mesmo assim" — quem está com a Kiper fora do ar precisa da
        // saída, mas ela não pode ser a rota óbvia.
        setFailed(res.message);
        toast.error(res.message);
        return;
      }

      toast.success(res.message);
      setForm(EMPTY);
      setFailed(null);
      setOpen(false);
      setState(await api.porter.status(propertyId));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não consegui salvar agora");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      const res = await api.porter.disconnect(propertyId);
      toast.success(res.message);
      setConfirmOff(false);
      setState({ ok: true, connected: false });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não consegui desconectar");
    } finally {
      setBusy(null);
    }
  };

  if (!state) {
    return (
      <section className="flex justify-center rounded-xl glass-card p-5">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </section>
    );
  }

  const connected = state.connected && state.active !== false;

  return (
    <section className="space-y-4 rounded-xl glass-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <DoorOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Portaria digital</h2>
        </div>

        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
            connected
              ? state.last_error
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          {connected ? (state.last_error ? "Com erro" : "Conectada") : "Não configurada"}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        Com a portaria conectada, quem preenche o cadastro do hóspede já entra
        liberado no prédio — nome, período e permissão de acesso vão sozinhos
        para o sistema do condomínio. Sem ela, o cadastro continua funcionando;
        a liberação é que fica com você.
      </p>

      {connected && state.last_ok_at && (
        <p className="text-xs text-muted-foreground">
          Último cadastro aceito pela portaria em {fmtWhen(state.last_ok_at)}.
        </p>
      )}

      {connected && state.last_error && (
        <div className="flex gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="break-words">{state.last_error}</p>
            <p className="text-muted-foreground">
              O token do prédio vence sozinho. Capture de novo e recoloque abaixo.
            </p>
          </div>
        </div>
      )}

      {state.reason === "disabled" && (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          {state.message}
        </p>
      )}

      {/* -------------------------------------------------------- formulário */}
      {!open ? (
        <Button
          type="button"
          variant={connected ? "outline" : "default"}
          size="sm"
          className="w-full"
          onClick={() => setOpen(true)}
        >
          {connected ? "Trocar as credenciais" : "Conectar a portaria"}
        </Button>
      ) : (
        <div className="space-y-4">
          {connected && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Os campos vêm vazios de propósito: as credenciais salvas não podem
              ser lidas de volta, nem por você. Preencher aqui substitui as que
              estão guardadas.
            </p>
          )}

          {FIELDS.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={field.key}>{field.label}</Label>
              <Input
                id={field.key}
                value={form[field.key]}
                onChange={(e) => set(field.key, e.target.value)}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="font-mono text-[11px] text-muted-foreground">{field.hint}</p>
            </div>
          ))}

          {failed && (
            <div className="space-y-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <p className="break-words">{failed}</p>
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => save(true)}
                disabled={busy !== null}
              >
                Salvar mesmo assim
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={test}
              disabled={!filled || busy !== null}
            >
              {busy === "test" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Wifi className="mr-2 h-4 w-4" />
              )}
              Testar
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              onClick={() => save()}
              disabled={!filled || busy !== null}
            >
              {busy === "save" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Salvar
            </Button>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              setOpen(false);
              setForm(EMPTY);
              setFailed(null);
            }}
            disabled={busy !== null}
          >
            Cancelar
          </Button>
        </div>
      )}

      {/* ------------------------------------------------------ como capturar */}
      <div>
        <button
          type="button"
          className="flex w-full items-center justify-between text-xs font-medium text-primary"
          onClick={() => setHowTo((v) => !v)}
        >
          Onde encontro esses dados
          <ChevronDown className={cn("h-4 w-4 transition-transform", howTo && "rotate-180")} />
        </button>

        {howTo && (
          <div className="mt-3 space-y-3 text-xs leading-relaxed text-muted-foreground">
            <p>
              Eles não aparecem em nenhuma tela do app do prédio: são os
              cabeçalhos que o aplicativo manda para a Kiper. Para lê-los, o
              celular passa a navegar por um proxy no seu computador.
            </p>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                No PC, instale o{" "}
                <a
                  href="https://mitmproxy.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  mitmproxy
                </a>{" "}
                e rode <code className="rounded bg-muted px-1">mitmweb --listen-port 8080</code>.
                Descubra o IP do PC com <code className="rounded bg-muted px-1">ipconfig</code>{" "}
                (Windows) ou <code className="rounded bg-muted px-1">ifconfig</code> (Mac).
              </li>
              <li>
                No celular, na mesma rede Wi-Fi: Proxy HTTP manual, servidor =
                IP do PC, porta 8080.
              </li>
              <li>
                Ainda no celular, abra <code className="rounded bg-muted px-1">http://mitm.it</code>{" "}
                e instale o certificado. No iPhone use o Safari e depois ative em
                Ajustes → Geral → Sobre → Certificados Confiáveis.
              </li>
              <li>
                Abra o app da portaria e entre na tela de moradores. No mitmweb,
                procure a chamada para{" "}
                <code className="rounded bg-muted px-1">api.cloud.kiper.com.br</code> e copie os
                seis cabeçalhos indicados abaixo de cada campo.
              </li>
              <li>
                Desfaça o proxy no celular quando terminar.
              </li>
            </ol>
            <p>
              O token vence de tempos em tempos. Quando os cadastros pararem,
              refaça a captura — o resto continua igual.
            </p>
          </div>
        )}
      </div>

      {/* -------------------------------------------------------- desconectar */}
      {connected && (
        <div className="border-t border-border/50 pt-3">
          {confirmOff ? (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="flex-1"
                onClick={disconnect}
                disabled={busy !== null}
              >
                {busy === "disconnect" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirmar
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setConfirmOff(false)}
                disabled={busy !== null}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setConfirmOff(true)}
            >
              Desconectar a portaria deste imóvel
            </button>
          )}
        </div>
      )}
    </section>
  );
}
