import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle, Bot, Check, Copy, Eye, EyeOff, KeyRound, Loader2, Power, ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type HermesCredential, type HermesStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Atendimento Automático 24h de UM imóvel.
 *
 * A tela tem um trabalho que não é técnico: fazer o dono entender o que está
 * entregando. Pedir senha do Airbnb dentro de um formulário comum, entre o CEP
 * e o horário de check-out, seria esconder a decisão mais séria do produto no
 * meio da mais banal. Por isso o bloco é vermelho antes de ser ativado, o
 * termo abre inteiro na tela (não atrás de um link que ninguém clica) e a
 * caixa de aceite fica desmarcada.
 *
 * A senha entra e não volta: depois de salva, nem esta tela nem o backend a
 * exibem de novo. Trocar significa digitar outra.
 */

const ESTADO: Record<
  HermesCredential["status"],
  { texto: string; classe: string }
> = {
  pendente: {
    texto: "Aguardando a primeira conversa",
    classe: "bg-warning/10 text-warning",
  },
  ativo: { texto: "Atendendo", classe: "bg-success/10 text-success" },
  falhou: { texto: "Parou — precisa de atenção", classe: "bg-destructive/10 text-destructive" },
  revogado: { texto: "Desligado", classe: "bg-muted text-muted-foreground" },
};

function quando(iso: string | null): string {
  if (!iso) return "nunca";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function HermesCard({ propertyId }: { propertyId: string }) {
  const [state, setState] = useState<HermesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [termoAberto, setTermoAberto] = useState(false);

  const [login, setLogin] = useState("");
  const [senha, setSenha] = useState("");
  const [totp, setTotp] = useState("");
  const [verSenha, setVerSenha] = useState(false);
  const [aceite, setAceite] = useState(false);

  const [novaChave, setNovaChave] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  async function load() {
    try {
      setState(await api.hermes.status());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const prop = state?.properties.find((p) => p.id === propertyId);
  const semAnuncio = prop && !prop.airbnb_listing_id;

  // A credencial é da conta. O que diz se ESTE imóvel está sendo atendido é
  // `hermes_enabled` — separar os dois é o que permite desligar um apartamento
  // de cinco sem apagar a senha usada pelos outros quatro.
  const contaConectada = state?.credentials.find((c) => c.platform === "airbnb");
  const cred = prop?.hermes_enabled ? contaConectada : undefined;
  const outrosLigados =
    (state?.properties.filter((p) => p.hermes_enabled && p.id !== propertyId).length) ?? 0;

  function limpar() {
    setLogin("");
    setSenha("");
    setTotp("");
    setAceite(false);
    setVerSenha(false);
    setForm(false);
  }

  async function salvar() {
    if (!aceite) {
      toast.error("É preciso aceitar o termo para ativar.");
      return;
    }
    setSaving(true);
    try {
      await api.hermes.save({
        property_id: propertyId,
        login: login.trim(),
        password: senha,
        totp_secret: totp.trim() || undefined,
        accept_term: true,
      });
      toast.success("Atendimento 24h ativado.");
      limpar();
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function ligarNesteImovel() {
    setSaving(true);
    try {
      await api.hermes.enable(propertyId);
      toast.success("Atendimento ligado neste imóvel.");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não foi possível ligar.");
    } finally {
      setSaving(false);
    }
  }

  async function desligar() {
    setSaving(true);
    try {
      const { credencial_apagada } = await api.hermes.revoke(propertyId, "imovel");
      // O aviso de trocar a senha só faz sentido quando a credencial saiu de
      // fato. Dá-lo ao desligar 1 de 5 imóveis assustaria à toa, e o dono
      // trocaria uma senha que os outros quatro ainda usam.
      toast.success(
        credencial_apagada
          ? "Desligado e credencial apagada. Troque a senha no Airbnb também."
          : "Este imóvel não é mais atendido. Os outros continuam.",
      );
      setConfirmOff(false);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não foi possível desligar.");
    } finally {
      setSaving(false);
    }
  }

  async function gerarChave() {
    try {
      const { key } = await api.hermes.createKey();
      setNovaChave(key);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Não foi possível gerar a chave.");
    }
  }

  if (loading) {
    return (
      <section className="flex items-center justify-center rounded-xl glass-card p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl glass-card p-5">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold">Atendimento automático 24h</h2>
      </div>

      {/* ---------------------------------------------------------- ativo */}
      {cred ? (
        <>
          <div
            className={cn(
              "rounded-xl p-3 text-xs leading-relaxed",
              ESTADO[cred.status].classe,
            )}
          >
            <div className="font-semibold">{ESTADO[cred.status].texto}</div>
            <div className="mt-1 opacity-90">
              Conta: {cred.login}
              <br />
              Último acesso do agente: {quando(cred.last_access_at)}
              {cred.access_count > 0 && ` · ${cred.access_count} acesso(s)`}
            </div>
            {cred.last_error && <div className="mt-2 font-medium">Erro: {cred.last_error}</div>}
          </div>

          {cred.status === "falhou" && (
            <p className="rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
              Normalmente é senha trocada ou verificação em duas etapas nova. Coloque os dados
              atualizados abaixo para voltar a atender.
            </p>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Termo aceito em {quando(cred.term_accepted_at)}.
          </p>

          {!form ? (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setForm(true)}
              >
                Atualizar dados
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmOff(true)}
              >
                <Power className="mr-2 h-4 w-4" />
                Desligar
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        /* ------------------------------------------------------ desligado */
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            O agente entra na sua conta do Airbnb e responde os hóspedes a qualquer hora, usando o
            que você cadastrou sobre este imóvel. Para isso ele precisa das suas credenciais.
          </p>

          {semAnuncio && (
            <p className="rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
              Conecte o calendário do Airbnb neste imóvel antes. É do link do iCal que sai o número
              do anúncio — sem ele o agente não sabe qual conversa é deste apartamento.
            </p>
          )}

          {/* Conta já conectada por outro imóvel: um clique, sem redigitar. */}
          {!form && contaConectada ? (
            <>
              <p className="rounded-xl bg-success/10 p-3 text-xs leading-relaxed text-success">
                Sua conta {contaConectada.login} já está conectada e atende{" "}
                {outrosLigados === 1 ? "outro imóvel" : `outros ${outrosLigados} imóveis`}. Não
                precisa digitar a senha de novo.
              </p>
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={semAnuncio || saving}
                onClick={ligarNesteImovel}
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Atender também este imóvel
              </Button>
            </>
          ) : null}

          {!form && !contaConectada && (
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={semAnuncio}
              onClick={() => setForm(true)}
            >
              Ativar atendimento 24h
            </Button>
          )}
        </>
      )}

      {/* --------------------------------------------------------- formulário */}
      {form && (
        <div className="space-y-4 rounded-xl border border-destructive/30 bg-destructive/[0.03] p-4">
          <div className="flex items-start gap-2 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs font-semibold leading-relaxed">
              Você vai entregar o acesso à sua conta do Airbnb. Leia o termo antes.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>E-mail ou telefone da conta do Airbnb</Label>
            <Input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="seu@email.com"
              autoComplete="off"
              inputMode="email"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Senha</Label>
            <div className="relative">
              <Input
                type={verSenha ? "text" : "password"}
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                autoComplete="new-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setVerSenha((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-label={verSenha ? "Esconder senha" : "Mostrar senha"}
              >
                {verSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Guardada cifrada em cofre. Nem você consegue vê-la depois — se esquecer, digite outra.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>
              Chave da verificação em duas etapas{" "}
              <span className="text-muted-foreground">(se tiver)</span>
            </Label>
            <Input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="JBSWY3DPEHPK3PXP"
              autoComplete="off"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Se sua conta pede código por SMS ou aplicativo, o agente não consegue entrar sozinho
              sem isto. É o código que o Airbnb mostra ao configurar o app autenticador.
            </p>
          </div>

          {/* O termo aparece inteiro, rolável. Link para outra página seria um
              aceite que ninguém leu — e é justamente o que precisa ser lido. */}
          {state?.term && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setTermoAberto(true)}
                className="text-xs font-semibold text-primary underline underline-offset-2"
              >
                Ler o termo completo
              </button>

              <div className="max-h-40 overflow-y-auto rounded-lg border border-white/[0.07] bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-line">
                {state.term.body}
              </div>

              <label className="flex cursor-pointer items-start gap-3 pt-1">
                <Checkbox
                  checked={aceite}
                  onCheckedChange={(v) => setAceite(Boolean(v))}
                  className="mt-0.5"
                />
                <span className="text-xs leading-relaxed">
                  Li e aceito o termo. Estou ciente de que a plataforma de hospedagem pode bloquear
                  ou suspender minha conta por causa do acesso automatizado, e que a HospedePay não
                  se responsabiliza por isso.
                </span>
              </label>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="flex-1"
              onClick={salvar}
              disabled={saving || !aceite || !login.trim() || senha.length < 6}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {cred ? "Atualizar" : "Ativar"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={limpar}
              disabled={saving}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ chave do agente */}
      {cred && (
        <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Chave da VPS</h3>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            É com ela que o agente instalado no servidor busca o contexto dos seus imóveis. Vale
            para todos eles — gere uma só e guarde no servidor.
          </p>

          {state?.keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-background/40 p-2.5 text-xs"
            >
              <div className="min-w-0">
                <div className="font-mono">{k.key_prefix}…</div>
                <div className="text-muted-foreground">Último uso: {quando(k.last_used_at)}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={async () => {
                  await api.hermes.revokeKey(k.id);
                  toast.success("Chave revogada.");
                  await load();
                }}
              >
                Revogar
              </Button>
            </div>
          ))}

          <Button type="button" variant="outline" size="sm" className="w-full" onClick={gerarChave}>
            Gerar chave nova
          </Button>
        </div>
      )}

      {/* ------------------------------------------------------------- diálogos */}
      <Dialog open={termoAberto} onOpenChange={setTermoAberto}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">{state?.term?.title}</DialogTitle>
          </DialogHeader>
          <div className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
            {state?.term?.body}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base">Desligar o atendimento 24h?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm leading-relaxed">
            {outrosLigados > 0 ? (
              <p>
                O agente para de responder os hóspedes deste imóvel imediatamente. Sua conta do
                Airbnb continua conectada, porque{" "}
                {outrosLigados === 1 ? "outro imóvel ainda é atendido" : `outros ${outrosLigados} imóveis ainda são atendidos`}.
              </p>
            ) : (
              <>
                <p>
                  Este é o último imóvel atendido, então suas credenciais também são apagadas do
                  cofre.
                </p>
                <p className="rounded-xl bg-warning/10 p-3 text-xs text-warning">
                  Troque também a senha no Airbnb e encerre as sessões ativas. É a única forma de
                  ter certeza de que nenhum acesso continua de pé.
                </p>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="flex-1"
              onClick={desligar}
              disabled={saving}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Desligar
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setConfirmOff(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* A chave inteira existe uma vez só. Fechar sem copiar significa gerar
          outra — dizer isso agora evita o suporte depois. */}
      <Dialog open={Boolean(novaChave)} onOpenChange={() => { setNovaChave(null); setCopiado(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-success" />
              Copie agora
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-relaxed">
            Esta chave não será mostrada de novo. Se perder, gere outra e troque no servidor.
          </p>
          <div className="break-all rounded-lg bg-background/60 p-3 font-mono text-xs">
            {novaChave}
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={async () => {
              await navigator.clipboard.writeText(novaChave ?? "");
              setCopiado(true);
              toast.success("Chave copiada.");
            }}
          >
            {copiado ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            {copiado ? "Copiada" : "Copiar chave"}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
