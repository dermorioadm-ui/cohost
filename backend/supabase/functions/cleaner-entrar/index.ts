import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin } from "../_shared/lib/db.ts";

/**
 * A diarista entra pelo site, sem link: WhatsApp + código de 6 dígitos.
 *
 * O link do convite continua valendo. Esta é a porta para quem o perdeu ou
 * chegou em hospedepay.org pela barra do navegador — antes, essa diarista só
 * encontrava e-mail e senha, e acabava se cadastrando como dona.
 *
 * O código vem do dono (ele vê ao gerar o link do painel dela) ou da primeira
 * entrada dela pelo link. A validação, a contagem de tentativas e a exigência
 * de vínculo ativo ficam no banco, em `cleaner_login`.
 */

interface Body {
  phone?: string;
  code?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const { phone, code } = await readJson<Body>(req);
  if (!phone || phone.replace(/\D/g, "").length < 10) {
    throw errors.invalid("Digite seu WhatsApp com DDD.");
  }
  if (!code || code.replace(/\D/g, "").length !== 6) {
    throw errors.invalid("O código tem 6 números.");
  }

  const db = admin();

  const { data: cleanerId, error } = await db.rpc("cleaner_login", {
    _phone: phone,
    _code: code,
  });

  if (error || !cleanerId) {
    if (error?.message.includes("muitas_tentativas")) {
      throw errors.rateLimited("Muitas tentativas. Espere 15 minutos e tente de novo.");
    }
    // Uma mensagem só para "não existe", "código errado" e "sem vínculo":
    // separar transformaria a tela em ferramenta de descoberta de telefones.
    throw errors.forbidden("WhatsApp ou código não conferem. Confira com quem te convidou.");
  }

  const { data: conta } = await db.auth.admin.getUserById(cleanerId as unknown as string);
  const email = conta?.user?.email;
  if (!email) throw errors.upstream("Não consegui abrir sua sessão. Tente de novo.");

  // Sessão sem senha: link mágico trocado por tokens de acesso.
  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link.properties?.hashed_token) {
    console.error("Falha ao gerar sessão:", linkError?.message);
    throw errors.upstream("Não consegui abrir sua sessão. Tente de novo.");
  }

  const { data: verified, error: verifyError } = await db.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (verifyError || !verified.session) {
    console.error("Falha ao validar sessão:", verifyError?.message);
    throw errors.upstream("Não consegui abrir sua sessão. Tente de novo.");
  }

  const nome = (conta.user.user_metadata?.full_name as string | undefined) ?? "";

  return json({
    ok: true,
    cleaner_name: nome,
    session: {
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
      expires_in: verified.session.expires_in,
    },
  });
});
