import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Scale } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { Marca } from "@/components/Marca";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LEGAL_STATUS, legalApi, legalCheckoutUrl, legalDate, legalError, legalPrice, useLegalOffer, type LegalRequest } from "@/lib/legal";

const panel = "rounded-3xl border border-border p-5 sm:p-7";

function RequestHistory({ item, canReply, onRefresh }: { item: LegalRequest; canReply: boolean; onRefresh: () => Promise<unknown> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  async function reply(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      await legalApi.replyRequest(item.id, message.trim(), key.current);
      setMessage(""); key.current = crypto.randomUUID(); await onRefresh();
    } catch (err) { setError(legalError(err)); }
    finally { setBusy(false); }
  }
  return <article className={panel}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-lg font-medium break-words">{item.subject}</h3>
      <span className="rounded-full bg-secondary px-3 py-1 text-xs">{LEGAL_STATUS[item.status]}</span>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Enviado em {legalDate(item.created_at)}</p>
    <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.description}</p>
    {(item.messages ?? []).map((m) => <div key={m.id} className="mt-4 border-l-2 border-primary/40 pl-4">
      <p className="text-xs text-muted-foreground">{m.author_role === "owner" ? "Você" : "Atendimento"} · {legalDate(m.created_at)}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{m.message}</p>
    </div>)}
    {!item.messages?.length && item.public_reply && <div className="mt-4 border-l-2 border-primary pl-4">
      <p className="text-xs text-muted-foreground">Resposta do atendimento</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.public_reply}</p>
    </div>}
    {canReply && item.status !== "completed" && <form onSubmit={reply} className="mt-5 space-y-3">
      <Label htmlFor={`reply-${item.id}`}>Complementar este atendimento</Label>
      <Textarea id={`reply-${item.id}`} value={message} onChange={(e) => setMessage(e.target.value)} required minLength={2} maxLength={6000} disabled={busy} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" variant="outline" disabled={busy || message.trim().length < 2}>{busy ? "Enviando…" : "Enviar mensagem"}</Button>
    </form>}
  </article>;
}

export default function Juridico() {
  const { user, role, loading } = useAuth();
  const [params, setParams] = useSearchParams();
  const session = params.get("session");
  const cancelled = params.get("checkout") === "cancelado";
  const queryClient = useQueryClient();
  const offerQuery = useLegalOffer();
  const overview = useQuery({ queryKey: ["legal-overview", user?.id], queryFn: legalApi.overview, enabled: !!user, retry: false });
  const software = useQuery({ queryKey: ["software-status", user?.id], enabled: !!user && (!!session || params.get("origem") === "pos-compra"), queryFn: async () => {
    const { data, error } = await supabase.from("profiles").select("subscription_status").eq("user_id", user!.id).maybeSingle();
    if (error) throw error;
    return data?.subscription_status === "active";
  } });
  const offer = offerQuery.data?.available ? offerQuery.data.offer : null;
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [payment, setPayment] = useState<"idle" | "pending" | "active" | "failed" | "unconfirmed">("idle");
  const [attempt, setAttempt] = useState(0);
  const checkoutKey = useRef(crypto.randomUUID());
  const requestKey = useRef(crypto.randomUUID());
  const canBuy = !!user && (role === "owner" || role === "admin");
  useEffect(() => { setAccepted(false); checkoutKey.current = crypto.randomUUID(); }, [offer?.id, offer?.version]);

  useEffect(() => {
    if (!user || !session) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>; let tries = 0;
    setPayment("pending");
    async function check() {
      try {
        const result = await legalApi.checkoutStatus(session!);
        if (stopped) return;
        if (result.state === "active") {
          setPayment("active");
          await queryClient.invalidateQueries({ queryKey: ["legal-overview", user!.id] });
          return;
        }
        if (result.state === "failed") { setPayment("failed"); return; }
        if (++tries >= 20) { setPayment("unconfirmed"); return; }
        timer = setTimeout(check, 3000);
      } catch { if (!stopped) setPayment("unconfirmed"); }
    }
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, user?.id, attempt, queryClient]);

  async function buy(e: FormEvent) {
    e.preventDefault(); if (!offer || !accepted || !canBuy) return;
    setBusy(true); setError("");
    try { const result = await legalApi.checkout(offer, checkoutKey.current); window.location.assign(legalCheckoutUrl(result.url)); }
    catch (err) { setError(legalError(err)); setAccepted(false); checkoutKey.current = crypto.randomUUID(); void offerQuery.refetch(); void overview.refetch(); }
    finally { setBusy(false); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await legalApi.createRequest(subject.trim(), description.trim(), requestKey.current);
      setSubject(""); setDescription(""); requestKey.current = crypto.randomUUID();
      setNotice("Atendimento recebido. Acompanhe as respostas nesta página."); await overview.refetch();
    } catch (err) { setError(legalError(err)); }
    finally { setBusy(false); }
  }
  const activeEntitlement = overview.data?.entitlements.find((e) => e.status === "active");
  const returnPath = `/juridico${session ? `?session=${encodeURIComponent(session)}` : ""}`;
  const content = <div className="mx-auto w-full max-w-3xl space-y-8">
    <header>
      <p className="rotulo text-primary">Hospedepay · Jurídico</p>
      <h1 className="mt-3 text-4xl leading-tight tracking-titulo sm:text-5xl">Seu atendimento.<br />Um acesso próprio.</h1>
      <p className="mt-4 max-w-xl text-muted-foreground leading-relaxed">A assistência jurídica tem contratação e vigência separadas da ferramenta. Seus atendimentos ficam reunidos aqui.</p>
    </header>
    {params.get("origem") === "pos-compra" && software.data && <Button asChild variant="outline"><Link to="/comecar">Voltar à configuração do imóvel</Link></Button>}
    {cancelled && <p role="status" className={panel}>Você voltou sem concluir a contratação. Seu acesso à ferramenta continua separado.</p>}
    {session && !user && !loading && <p className={panel}>Entre na conta usada na contratação para consultar a confirmação do pagamento.</p>}
    {payment !== "idle" && user && <section className={panel} aria-live="polite">
      <h2 className="text-lg font-medium">{payment === "active" ? "Pagamento confirmado" : payment === "failed" ? "Pagamento não concluído" : payment === "pending" ? "Conferindo seu pagamento…" : "A confirmação ainda não chegou"}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{payment === "active" ? "A vigência e o acesso atual estão na sua área abaixo." : payment === "failed" ? "Consulte o meio de pagamento antes de tentar novamente." : "Seu acesso será liberado após a confirmação. Não é necessário fazer outro pagamento enquanto aguarda."}</p>
      {payment === "unconfirmed" && <Button className="mt-4" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Verificar novamente</Button>}
      {payment === "active" && software.data && <Button asChild className="mt-4"><Link to="/comecar">Configurar meu imóvel</Link></Button>}
      {(payment === "active" || payment === "failed") && <Button variant="ghost" className="mt-3" onClick={() => { setParams({}); setPayment("idle"); }}>Fechar confirmação</Button>}
    </section>}
    {loading || (user && overview.isPending) ? <p role="status" className="flex gap-2"><Loader2 className="h-5 w-5 animate-spin" />Carregando seu acesso…</p> : null}
    {user && overview.isError && <div role="alert" className={panel}><p>Não foi possível consultar seu acesso.</p><Button variant="outline" className="mt-3" onClick={() => void overview.refetch()}>Tentar novamente</Button></div>}
    {overview.data?.has_access && activeEntitlement && <section className={`${panel} border-primary/40`}>
      <p className="rotulo text-primary">Assistência vigente</p>
      <h2 className="mt-2 text-2xl">Acesso até {legalDate(activeEntitlement.ends_at)}</h2>
      <p className="mt-3 text-sm leading-relaxed">Cancelar a ferramenta não encerra esta vigência jurídica.</p>
      <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{activeEntitlement.offer_snapshot.scope_text}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{activeEntitlement.offer_snapshot.property_scope_text}</p>
      <details className="mt-4 text-sm"><summary className="cursor-pointer">Condições da sua contratação</summary><div className="mt-3 space-y-3 whitespace-pre-wrap text-muted-foreground"><p>{activeEntitlement.offer_snapshot.service_terms}</p><p>{activeEntitlement.offer_snapshot.payment_terms}</p></div></details>
    </section>}
    {user && overview.data && !overview.data.has_access && overview.data.entitlements.length > 0 && <section className={panel}>
      <h2 className="text-xl">Sem assistência vigente</h2><p className="mt-2 text-sm text-muted-foreground">O histórico dos seus atendimentos continua disponível abaixo.</p>
      {overview.data.entitlements.map((e) => <p key={e.id} className="mt-2 text-sm">{legalDate(e.starts_at)} a {legalDate(e.ends_at)}{e.status === "revoked" ? " · acesso encerrado" : ""}</p>)}
    </section>}
    {!overview.data?.has_access && <section className={panel}>
      <Scale className="h-6 w-6 text-primary" aria-hidden />
      <h2 className="mt-4 text-2xl">Assistência jurídica anual</h2>
      {offerQuery.isPending ? <p className="mt-3" role="status">Consultando condições…</p> : offerQuery.isError ? <div className="mt-3"><p>As condições não puderam ser carregadas agora.</p><Button variant="outline" className="mt-3" onClick={() => void offerQuery.refetch()}>Recarregar condições</Button></div> : !offer ? <p className="mt-3 leading-relaxed text-muted-foreground">Estamos preparando a contratação deste adicional. Ela ainda não está disponível.</p> : <>
        <p className="mt-4 text-4xl tracking-titulo">{legalPrice(offer.annual_price_cents)}<span className="text-lg text-muted-foreground"> / ano</span></p>
        <p className="mt-2 text-sm text-muted-foreground">Equivalente a {legalPrice(offer.annual_price_cents / 12)} por mês. Contratação de 12 meses.</p>
        <dl className="mt-6 space-y-5 text-sm leading-relaxed">
          <div><dt className="font-medium">O que está incluído</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{offer.scope_text}</dd></div>
          <div><dt className="font-medium">Imóveis atendidos</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{offer.property_scope_text}</dd></div>
          <div><dt className="font-medium">Atendimento e condições</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{offer.service_terms}</dd></div>
          <div><dt className="font-medium">Pagamento</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{offer.payment_terms}</dd></div>
        </dl>
        <p className="mt-5 text-sm">A ferramenta é contratada separadamente. Encerrar a ferramenta preserva o jurídico durante a vigência paga.</p>
        {!user && <Button asChild className="mt-6"><Link to={`/entrar?retorno=${encodeURIComponent(returnPath)}`}>Entrar para contratar</Link></Button>}
        {canBuy && overview.data && !session && <form onSubmit={buy} className="mt-6 space-y-5">
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#ff385c]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required disabled={busy} /><span>Li as condições e aceito a contratação anual por {legalPrice(offer.annual_price_cents)}. <a className="underline underline-offset-4" href={offer.terms_url.startsWith("https://") ? offer.terms_url : undefined} target="_blank" rel="noopener noreferrer">Ler os termos completos</a>.</span></label>
          <Button type="submit" size="lg" disabled={!accepted || busy}>{busy ? "Abrindo pagamento…" : "Contratar assistência anual"}</Button>
        </form>}
        {user && !canBuy && <p className="mt-5 text-sm">Entre com seu perfil de anfitrião para contratar.</p>}
      </>}
    </section>}
    {!user && !loading && <p className="text-sm">Já contratou? <Link className="text-primary underline underline-offset-4" to={`/entrar?retorno=${encodeURIComponent(returnPath)}`}>Entre para acessar seus atendimentos</Link>.</p>}
    {overview.data?.has_access && <form onSubmit={create} className={`${panel} space-y-4`}>
      <h2 className="text-2xl">Abrir atendimento</h2><p className="text-sm text-muted-foreground">Conte o que aconteceu. O atendimento segue o escopo e as condições da sua contratação.</p>
      <div className="space-y-2"><Label htmlFor="legal-subject">Assunto</Label><Input id="legal-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={5} maxLength={160} disabled={busy} /></div>
      <div className="space-y-2"><Label htmlFor="legal-description">O que você precisa resolver?</Label><Textarea id="legal-description" value={description} onChange={(e) => setDescription(e.target.value)} required minLength={20} maxLength={6000} rows={5} disabled={busy} /><p className="text-xs text-muted-foreground">De 20 a 6.000 caracteres.</p></div>
      <Button type="submit" disabled={busy || subject.trim().length < 5 || description.trim().length < 20}>{busy ? "Enviando…" : "Enviar atendimento"}</Button>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    {overview.data && <section className="space-y-4"><h2 className="text-2xl">Seus atendimentos</h2>{overview.data.requests.length === 0 ? <p className="text-sm text-muted-foreground">Você ainda não abriu um atendimento.</p> : overview.data.requests.map((item) => <RequestHistory key={item.id} item={item} canReply={overview.data.has_access} onRefresh={() => overview.refetch()} />)}</section>}
  </div>;
  if (user && role) return <AppShell>{content}</AppShell>;
  return <div className="min-h-screen bg-background"><nav className="mx-auto flex max-w-3xl items-center justify-between px-5 py-6"><Link to="/"><Marca size={30} /></Link><Link to="/pagina" className="flex items-center gap-2 text-sm"><ArrowLeft className="h-4 w-4" />Ver a ferramenta</Link></nav><main className="px-5 pb-16 pt-8">{content}</main></div>;
}
