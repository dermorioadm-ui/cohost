import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * "Esqueci minha senha".
 *
 * O Supabase Auth já sabe enviar este e-mail sozinho — e é justamente por isso
 * que esta function existe. O e-mail dele sai pelo SMTP da plataforma, com o
 * layout padrão do Supabase e outro remetente. O cliente receberia a
 * recuperação de senha com uma cara que não é a do produto, logo depois de ter
 * recebido três e-mails com a cara certa. Aqui o link é gerado pelo Auth
 * (`generateLink`), mas quem entrega é a nossa fila, com o nosso template e o
 * nosso remetente.
 *
 * Duas escolhas de segurança:
 *
 *   1. A resposta é SEMPRE a mesma, exista a conta ou não. Um endpoint que
 *      responde "e-mail não encontrado" vira ferramenta de descoberta de
 *      cadastro: dá para varrer uma lista e saber quem é cliente.
 *   2. Limite por IP. Sem ele, o mesmo endereço pode ser inundado de e-mails
 *      de recuperação por qualquer um — e o dono da conta é quem sofre.
 */

interface Body {
  email?: string;
}

const RATE_LIMIT_PER_HOUR = 5;
const LINK_TTL_MINUTES = 60;

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

/** Resposta única, para não entregar quem tem conta e quem não tem. */
const sameAnswer = () =>
  json({
    ok: true,
    message:
      "Se existir uma conta com esse e-mail, o link de recuperação chega em instantes.",
  });

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const { email } = await readJson<Body>(req);
  const address = (email ?? "").trim().toLowerCase();
  if (!address || !isEmail(address)) throw errors.invalid("Informe um e-mail válido");

  const db = admin();

  // Limite por DESTINATÁRIO, não por IP: quem sofre com o abuso é o dono da
  // caixa, e ele continua sendo o mesmo se o pedido vier de mil IPs. Passar do
  // teto devolve a resposta neutra de sempre — dizer "muitas tentativas" já
  // confirmaria que a conta existe.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("template", "password-reset")
    .eq("to_email", address)
    .gte("created_at", since);

  if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) return sameAnswer();

  const { data: profile } = await db
    .from("profiles")
    .select("user_id, email, full_name, locale")
    .eq("email", address)
    .maybeSingle();

  // Sem conta: encerra aqui, com a MESMA resposta de quem tem.
  if (!profile) return sameAnswer();

  // O link é montado por nós, e não é o `action_link` que o GoTrue devolve.
  //
  // O caminho óbvio seria passar `redirectTo` e mandar o `action_link`: o
  // GoTrue verifica o token e redireciona para a nossa tela. Só que ele valida
  // esse destino contra a allow-list de Redirect URLs do projeto e, quando não
  // encontra, NÃO devolve erro — troca em silêncio pelo Site URL. Com o Site
  // URL no padrão de fábrica, todo pedido de recuperação saía apontando para
  // `http://localhost:3000`, que não abre no celular de ninguém. Uma tela de
  // configuração esquecida quebrava a recuperação de senha sem um único log.
  //
  // Com `hashed_token` o destino é escolhido aqui e a tela troca o token por
  // sessão com `verifyOtp`. O link nasce no nosso domínio, e não existe campo
  // de dashboard capaz de desviá-lo.
  const { data: link, error } = await db.auth.admin.generateLink({
    type: "recovery",
    email: address,
  });

  if (error || !link.properties?.hashed_token) {
    console.error("Falha ao gerar link de recuperação:", error?.message);
    // Continua devolvendo a resposta neutra: o motivo da falha é nosso, não
    // dele, e detalhá-lo aqui só ajudaria quem está sondando.
    return sameAnswer();
  }

  await db.rpc("enqueue_notification", {
    _channel: "email",
    _template: "password-reset",
    _payload: {
      email: address,
      reset_url:
        `${env.appBaseUrl()}/nova-senha` +
        `?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=recovery`,
      expires_minutes: LINK_TTL_MINUTES,
    },
    _to_email: address,
    _to_user_id: profile.user_id,
    // Janela de um minuto na chave: dois toques seguidos no botão não geram
    // dois e-mails, mas pedir de novo depois de dez minutos gera.
    _idempotency_key: `pwd-reset:${profile.user_id}:${Math.floor(Date.now() / 60_000)}`,
    _locale: profile.locale ?? "pt",
    _entity: "profiles",
    _entity_id: profile.user_id,
  });

  return sameAnswer();
});
