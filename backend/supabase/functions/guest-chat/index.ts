import { corsHeaders, errors, handler, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { chatProvider, toSSE, type ChatTurn } from "../_shared/lib/ai.ts";

/**
 * Assistente do hóspede — 24h, em português, inglês ou espanhol.
 *
 * Autorização: header `x-guest-token`, devolvido pelo guest-register.
 * O token é resolvido por resolve_guest_session() (SECURITY DEFINER); o
 * hóspede nunca fala direto com o banco. É isso que fecha o vazamento do
 * backend antigo, onde qualquer um com a chave pública lia todas as conversas
 * de todos os imóveis — incluindo senha de fechadura e Wi-Fi.
 */

const HISTORY_LIMIT = 30;
const MAX_MESSAGE_CHARS = 2000;
const MAX_MESSAGES_PER_SESSION = 200;

const RULES: Record<string, string> = {
  pt: `Regras:
- Responda em português do Brasil, de forma simpática, curta e direta.
- Use APENAS as informações do imóvel listadas acima. Nunca invente dado algum.
- Se a resposta não estiver acima, diga que vai confirmar com o responsável e ofereça o WhatsApp de urgência, se houver.
- Nada de listas longas nem textão: o hóspede está no celular.
- Se a pergunta for uma emergência (vazamento, incêndio, alguém ferido, não consegue entrar), oriente a acionar o responsável imediatamente e mostre o contato.`,
  en: `Rules:
- Reply in English, friendly, short and direct.
- Use ONLY the property information listed above. Never invent anything.
- If the answer is not above, say you'll confirm with the host and offer the emergency WhatsApp if there is one.
- No long lists or walls of text: the guest is on a phone.
- If it's an emergency (leak, fire, injury, can't get in), tell them to contact the host right away and show the contact.`,
  es: `Reglas:
- Responde en español, de forma simpática, corta y directa.
- Usa SOLO la información del inmueble listada arriba. Nunca inventes nada.
- Si la respuesta no está arriba, di que lo confirmarás con el responsable y ofrece el WhatsApp de urgencia, si existe.
- Nada de listas largas ni textos enormes: el huésped está en el móvil.
- Si es una emergencia (fuga, incendio, herido, no puede entrar), indícale contactar al responsable de inmediato y muestra el contacto.`,
};

const ROLE: Record<string, (name: string) => string> = {
  pt: (n) => `Você é o assistente virtual do imóvel "${n}". Ajuda o hóspede com dúvidas sobre o imóvel, acesso, regras e funcionamento.`,
  en: (n) => `You are the virtual assistant for the property "${n}". You help the guest with questions about the property, access, rules and how things work.`,
  es: (n) => `Eres el asistente virtual del inmueble "${n}". Ayudas al huésped con dudas sobre el inmueble, acceso, reglas y funcionamiento.`,
};

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const token = req.headers.get("x-guest-token")?.trim();
  if (!token) throw errors.unauthorized("Sessão do hóspede ausente");

  const { message } = await readJson<{ message?: string }>(req);
  const text = (message ?? "").trim();
  if (!text) throw errors.invalid("Mensagem vazia");
  if (text.length > MAX_MESSAGE_CHARS) {
    throw errors.invalid(`Mensagem muito longa (máx. ${MAX_MESSAGE_CHARS} caracteres)`);
  }

  const db = admin();

  const { data: resolved } = await db.rpc("resolve_guest_session", { _token: token });
  const session = Array.isArray(resolved) ? resolved[0] : resolved;
  if (!session) throw errors.unauthorized("Sessão expirada. Faça o cadastro novamente.");

  const { data: property } = await db
    .from("properties")
    .select("name, ai_prompt, ai_enabled, owner_id, checkin_time, checkout_time, condo_name, block, apt_number")
    .eq("id", session.property_id)
    .maybeSingle();

  if (!property) throw errors.notFound("Imóvel não encontrado");
  if (!property.ai_enabled) {
    throw errors.forbidden("O atendimento automático está desativado para este imóvel.");
  }

  const { data: subActive } = await db.rpc("subscription_is_active", {
    _user_id: property.owner_id,
  });
  if (!subActive) {
    throw errors.forbidden("Atendimento temporariamente indisponível. Fale com o anfitrião.");
  }

  const { data: sessionRow } = await db
    .from("guest_sessions")
    .select("message_count")
    .eq("id", session.session_id)
    .maybeSingle();

  if ((sessionRow?.message_count ?? 0) >= MAX_MESSAGES_PER_SESSION) {
    throw errors.rateLimited("Limite de mensagens desta estadia atingido.");
  }

  // ---- monta o prompt ------------------------------------------------------
  const locale = ["pt", "en", "es"].includes(session.locale) ? session.locale : "pt";

  const unitLine = [property.condo_name, property.block && `Bloco ${property.block}`,
    property.apt_number && `Apto ${property.apt_number}`].filter(Boolean).join(" · ");

  const system = [
    ROLE[locale](property.name),
    "",
    `Hóspede: ${session.guest_name}`,
    unitLine && `Unidade: ${unitLine}`,
    `Check-in: ${property.checkin_time ?? "—"} | Check-out: ${property.checkout_time ?? "—"}`,
    "",
    property.ai_prompt
      ? `Informações do imóvel (fornecidas pelo proprietário):\n${property.ai_prompt}`
      : "O proprietário ainda não preencheu as informações do imóvel.",
    "",
    RULES[locale],
  ].filter(Boolean).join("\n");

  const { data: history } = await db
    .from("guest_messages")
    .select("role, content")
    .eq("session_id", session.session_id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const turns: ChatTurn[] = (history ?? [])
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Grava a pergunta antes de chamar o modelo: se a geração falhar no meio,
  // a conversa continua coerente na próxima tentativa.
  await db.from("guest_messages").insert({
    session_id: session.session_id,
    role: "user",
    content: text,
  });

  // ---- gera --------------------------------------------------------------
  const provider = chatProvider();
  const { stream, collected } = toSSE(provider.stream({ system, history: turns, message: text }));

  // Persiste a resposta quando o stream termina, sem segurar a conexão.
  collected.then(async (full) => {
    if (!full.trim()) return;
    await db.from("guest_messages").insert({
      session_id: session.session_id,
      role: "assistant",
      content: full,
      token_usage: { provider: provider.name, model: provider.model },
    });
    await db
      .from("guest_sessions")
      .update({
        message_count: (sessionRow?.message_count ?? 0) + 1,
        last_message_at: new Date().toISOString(),
      })
      .eq("id", session.session_id);
  }).catch((e) => console.error("Falha ao gravar resposta do assistente:", e));

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
});
