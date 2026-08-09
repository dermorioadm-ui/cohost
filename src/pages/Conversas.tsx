import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Loader2, MessageSquare } from "lucide-react";
import { supabase } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Conversas dos hóspedes com a assistente.
 *
 * O dono delega a resposta para a IA e não tem como saber o que ela respondeu.
 * Isso é ruim de duas formas: ele não descobre o que a assistente errou, e não
 * descobre o que os hóspedes perguntam sempre — que é justamente o que deveria
 * estar escrito no cadastro do imóvel para ela nunca mais chutar.
 *
 * A tela é só leitura. Responder por aqui exigiria entregar a mensagem ao
 * hóspede por outro canal (o chat não tem push), e um botão que finge enviar é
 * pior que não ter botão.
 */

interface Session {
  id: string;
  property_id: string;
  guest_name: string;
  guest_phone_e164: string | null;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
}

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400_000);
  if (days === 0) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "ontem";
  if (days < 7) return `${days} dias`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
};

export default function Conversas() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);

  useEffect(() => {
    if (!user) return;

    (async () => {
      const [props, sess] = await Promise.all([
        supabase.from("properties").select("id, name").is("archived_at", null),
        supabase
          .from("guest_sessions")
          .select(
            "id, property_id, guest_name, guest_phone_e164, message_count, last_message_at, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      setProperties(
        Object.fromEntries(
          ((props.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
        ),
      );
      setSessions((sess.data ?? []) as Session[]);
      setLoading(false);
    })();
  }, [user]);

  useEffect(() => {
    if (!open) return;
    setLoadingThread(true);
    setMessages([]);

    (async () => {
      const { data } = await supabase
        .from("guest_messages")
        .select("id, role, content, created_at")
        .eq("session_id", open.id)
        .order("created_at");

      // O system prompt não é conversa — é configuração do imóvel vazando.
      setMessages(((data ?? []) as Message[]).filter((m) => m.role !== "system"));
      setLoadingThread(false);
    })();
  }, [open]);

  // Quem falou por último primeiro; sessão sem mensagem cai para o fim do bloco.
  const ordered = useMemo(
    () =>
      [...sessions].sort((a, b) =>
        (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
      ),
    [sessions],
  );

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (open) {
    return (
      <div className="space-y-4">
        <header className="flex items-center gap-3">
          <button
            onClick={() => setOpen(null)}
            aria-label="Voltar"
            className="-ml-2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{open.guest_name}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {properties[open.property_id] ?? "Imóvel"}
              {open.guest_phone_e164 && ` · ${open.guest_phone_e164}`}
            </p>
          </div>
        </header>

        {loadingThread ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="rounded-xl glass-card px-4 py-8 text-center text-sm text-muted-foreground">
            Este hóspede abriu o chat mas não perguntou nada.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "glass-card",
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  <p
                    className={cn(
                      "mt-1 text-[10px]",
                      m.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {fmtWhen(m.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="pt-2 text-center text-xs text-muted-foreground">
          Só leitura — quem responde o hóspede é a assistente.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-bold">Conversas</h1>
        <p className="text-sm text-muted-foreground">
          O que os hóspedes perguntaram e o que a assistente respondeu.
        </p>
      </header>

      {ordered.length === 0 ? (
        <div className="rounded-xl glass-card px-4 py-10 text-center">
          <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">Nenhuma conversa ainda</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Elas aparecem aqui quando um hóspede abre o link do chat.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {ordered.map((s) => (
            <button
              key={s.id}
              onClick={() => setOpen(s)}
              className="w-full rounded-xl glass-card p-4 text-left"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.guest_name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {properties[s.property_id] ?? "Imóvel"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted-foreground">
                    {fmtWhen(s.last_message_at ?? s.created_at)}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {s.message_count === 0
                      ? "sem mensagens"
                      : `${s.message_count} ${s.message_count === 1 ? "mensagem" : "mensagens"}`}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
