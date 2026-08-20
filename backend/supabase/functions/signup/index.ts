import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Criação de conta com confirmação de e-mail entregue por nós.
 *
 * O `supabase.auth.signUp` do cliente já faz isto sozinho — e foi assim que
 * quebrou. O e-mail de confirmação dele é montado pelo GoTrue e o link aponta
 * para o **Site URL** do projeto. Com esse campo no padrão de fábrica, todo
 * cadastro novo recebia um link para `http://localhost:3000`, que não abre no
 * celular de ninguém. O cadastro era aceito, o e-mail chegava, e a conta ficava
 * presa em "confirme seu e-mail" para sempre — sem erro em lugar nenhum.
 *
 * Como não existe teste grátis, esse é o primeiro passo de todo cliente
 * pagante. Depender de um campo de dashboard aqui é depender de alguém não
 * esquecer.
 *
 * `generateLink({ type: "signup" })` cria o usuário NÃO confirmado e devolve o
 * `hashed_token`. O destino é escolhido aqui, o e-mail sai pela nossa fila com
 * o nosso template e o nosso remetente, e a tela troca o token por sessão com
 * `verifyOtp`. Mesmo desenho da recuperação de senha.
 *
 * A resposta é a MESMA exista a conta ou não. Um endpoint público que responde
 * "e-mail já cadastrado" é uma ferramenta de descoberta de clientes: dá para
 * varrer uma lista e saber quem usa o produto. Quem já tem conta recebe um
 * e-mail dizendo isso, no lugar do link — o dono da caixa fica sabendo, quem
 * está sondando não.
 */

interface Body {
  email?: string;
  password?: string;
  full_name?: string;
  phone?: string;
}

const RATE_LIMIT_PER_HOUR = 5;
const MIN_PASSWORD = 8;

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

/** Resposta única, para não entregar quem já tem conta e quem não tem. */
const sameAnswer = () =>
  json({
    ok: true,
    message: "Enviamos um e-mail para confirmar seu endereço. Abra e clique no link.",
  });

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const body = await readJson<Body>(req);
  const address = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const fullName = (body.full_name ?? "").trim();

  if (!address || !isEmail(address)) throw errors.invalid("Informe um e-mail válido");
  if (password.length < MIN_PASSWORD) {
    throw errors.invalid(`A senha precisa de ao menos ${MIN_PASSWORD} caracteres`);
  }
  if (fullName.length < 3 || !fullName.includes(" ")) {
    throw errors.invalid("Informe seu nome completo");
  }

  const db = admin();

  // Limite por DESTINATÁRIO. Quem sofre com o abuso é o dono da caixa, e ele
  // continua o mesmo se o pedido vier de mil IPs. Estourar devolve a resposta
  // neutra: dizer "muitas tentativas" já confirmaria que o endereço interessa.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .in("template", ["confirm-email", "signup-existing"])
    .eq("to_email", address)
    .gte("created_at", since);

  if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) return sameAnswer();

  const { data: link, error } = await db.auth.admin.generateLink({
    type: "signup",
    email: address,
    password,
    options: { data: { full_name: fullName, whatsapp: body.phone ?? null } },
  });

  if (error || !link.properties?.hashed_token) {
    const message = error?.message ?? "";

    // E-mail já cadastrado. Não dá para dizer isso na resposta sem transformar
    // o endpoint em consulta de base, então quem recebe a informação é o dono
    // do endereço — que é justamente quem precisa dela para lembrar que já tem
    // conta e ir para o "esqueci minha senha".
    if (/already|registered|exists/i.test(message)) {
      await db.rpc("enqueue_notification", {
        _channel: "email",
        _template: "signup-existing",
        _payload: { email: address, login_url: `${env.appBaseUrl()}/entrar` },
        _to_email: address,
        _idempotency_key: `signup-existing:${address}:${Math.floor(Date.now() / 3600_000)}`,
        _locale: env.defaultLocale(),
      });
      return sameAnswer();
    }

    console.error("Falha ao criar conta:", message);
    throw errors.upstream("Não consegui criar a conta agora. Tente de novo em instantes.");
  }

  await db.rpc("enqueue_notification", {
    _channel: "email",
    _template: "confirm-email",
    _payload: {
      full_name: fullName,
      email: address,
      confirm_url:
        `${env.appBaseUrl()}/confirmar` +
        `?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=signup`,
    },
    _to_email: address,
    _to_user_id: link.user?.id ?? null,
    _idempotency_key: `confirm-email:${address}:${Math.floor(Date.now() / 60_000)}`,
    _locale: env.defaultLocale(),
  });

  return sameAnswer();
});
