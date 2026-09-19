import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LEGAL_STATUS, legalApi, legalDate, legalError, type LegalRequest, type LegalRequestStatus } from "@/lib/legal";

function RequestEditor({ item, refresh }: { item: LegalRequest; refresh: () => Promise<unknown> }) {
  const [status, setStatus] = useState<LegalRequestStatus>(item.status);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { await legalApi.updateRequest(item.id, status, reply.trim()); setReply(""); await refresh(); setNotice("Atualizado. A resposta fica disponível na área do cliente."); }
    catch (err) { setError(legalError(err)); }
    finally { setBusy(false); }
  }
  return <article className="rounded-3xl border border-border p-5 sm:p-7">
    <p className="text-xs text-muted-foreground break-all">{item.email || item.user_id} · {legalDate(item.created_at)}</p>
    <h2 className="mt-2 break-words text-2xl tracking-titulo">{item.subject}</h2>
    <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.description}</p>
    {(item.messages ?? []).map((m) => <div key={m.id} className="mt-4 border-l-2 border-border pl-4">
      <p className="text-xs text-muted-foreground">{m.author_role === "owner" ? "Cliente" : "Atendimento"} · {legalDate(m.created_at)}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.message}</p>
    </div>)}
    {!item.messages?.length && item.public_reply && <p className="mt-4 whitespace-pre-wrap text-sm">Última resposta: {item.public_reply}</p>}
    <form onSubmit={save} className="mt-6 space-y-4">
      <div className="space-y-2"><Label htmlFor={`status-${item.id}`}>Situação do atendimento</Label><select id={`status-${item.id}`} className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value as LegalRequestStatus)} disabled={busy}>{Object.entries(LEGAL_STATUS).map(([value, name]) => <option key={value} value={value}>{value === "waiting_customer" ? "Aguardando cliente" : name}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor={`answer-${item.id}`}>Nova resposta ao cliente</Label><Textarea id={`answer-${item.id}`} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={6000} rows={4} disabled={busy} /><p className="text-xs text-muted-foreground">Fica visível no histórico do atendimento. Não envia e-mail ou WhatsApp.</p></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-success">{notice}</p>}
      <Button type="submit" disabled={busy}>{busy ? "Salvando…" : "Salvar atendimento"}</Button>
    </form>
  </article>;
}

export default function AdminJuridico() {
  const query = useQuery({ queryKey: ["admin-legal-requests"], queryFn: legalApi.adminRequests, retry: false });
  const reviews = useQuery({ queryKey: ["admin-legal-payment-reviews"], queryFn: legalApi.paymentReviews, retry: false });
  const [filter, setFilter] = useState("open");
  const requests = (query.data ?? []).filter((item) => filter === "all" || (filter === "open" ? item.status !== "completed" : item.status === filter));
  return <div className="mx-auto max-w-3xl space-y-7">
    <header><p className="rotulo text-primary">Operação · Jurídico</p><h1 className="mt-3 text-4xl tracking-titulo">Fila de atendimento</h1><p className="mt-3 text-muted-foreground">Pedidos, respostas e acompanhamento da assistência jurídica.</p></header>
    {reviews.isError && <div role="alert"><p className="text-sm">Não foi possível consultar as pendências de pagamento.</p><Button className="mt-2" variant="outline" onClick={() => void reviews.refetch()}>Consultar pendências</Button></div>}
    {!!reviews.data?.length && <section className="rounded-3xl border border-primary/40 p-5"><h2 className="text-xl">Pagamentos para revisão</h2><p className="mt-2 text-sm text-muted-foreground">Confira os eventos e a condição contratada antes de alterar a vigência. A fila não executa estornos nem repasses.</p><ul className="mt-4 space-y-3">{reviews.data.map((item) => <li key={item.id} className="break-all text-sm"><span className="font-medium">{item.email || item.user_id}</span><p>{item.status} · {legalDate(item.updated_at)}</p><p className="text-xs text-muted-foreground">Pedido: {item.id}{item.stripe_session_id ? ` · ${item.stripe_session_id}` : ""}</p></li>)}</ul></section>}
    <div className="flex flex-wrap items-center justify-between gap-3"><label className="text-sm">Mostrar <select className="ml-2 rounded-xl border border-input bg-background px-3 py-2" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="open">Em aberto</option><option value="all">Todos</option><option value="received">Recebidos</option><option value="waiting_customer">Aguardando cliente</option><option value="completed">Concluídos</option></select></label><Button variant="outline" onClick={() => { void query.refetch(); void reviews.refetch(); }}>Atualizar fila</Button></div>
    {query.isPending && <p role="status">Carregando atendimentos…</p>}
    {query.isError && <p role="alert">Não foi possível carregar a fila. Use “Atualizar fila” para tentar novamente.</p>}
    {query.data && requests.length === 0 && <p className="text-muted-foreground">Nenhum atendimento neste filtro.</p>}
    {requests.map((item) => <RequestEditor key={item.id} item={item} refresh={() => query.refetch()} />)}
  </div>;
}
