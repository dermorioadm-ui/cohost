import { handler, json } from "../_shared/lib/http.ts";
import { admin, requireCron } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Cadastra na portaria digital (Kiper) os hóspedes com status `pending`.
 *
 * Diferença central para o backend antigo: aquele endpoint era público e
 * aceitava `propertyId` avulso — qualquer um com o link do chat cadastrava
 * morador com permissão de abrir porta. Aqui as linhas de `porter_registrations`
 * só nascem de um `guest_registration` criado com sessão válida, e este job
 * apenas consome a fila. Nenhuma entrada externa chega até a API da portaria.
 *
 * As credenciais ficam em `porter_accounts`, sem policy de SELECT — nem o dono
 * do imóvel lê de volta. Só este job, com service_role.
 */

const BATCH = 20;
const MAX_ATTEMPTS = 4;

interface PendingRow {
  id: string;
  property_id: string;
  person_id: string;
  attempts: number;
  access_from: string;
  access_until: string;
}

/** Permissões do morador temporário. Espelha o payload aceito pela Kiper. */
function permissions() {
  return [
    { fieldName: "manageContactMean", profilePermissionId: 163, allowsEdit: true, name: "Gerenciar meio de contato", label: null, applicationFeatureId: 44, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: null, ableToWrite: false },
    { fieldName: "locker", profilePermissionId: 89, allowsEdit: true, name: "Encomendas", label: "Encomendas", applicationFeatureId: 28, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: false, ableToWrite: false },
    { fieldName: "virtualOpenDoor", profilePermissionId: 113, allowsEdit: true, name: "Abertura de acessos via internet", label: "Abertura de acessos via internet", applicationFeatureId: 29, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: true, ableToWrite: false },
    { fieldName: "mural", profilePermissionId: 3, allowsEdit: true, name: "Mural", label: "Mural", applicationFeatureId: 3, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: false, ableToWrite: false },
    { fieldName: "cameras", profilePermissionId: 5, allowsEdit: true, name: "Câmeras", label: "Câmeras", applicationFeatureId: 5, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: false, ableToWrite: false },
    { fieldName: "accessTimeline", profilePermissionId: 4, allowsEdit: true, name: "Push e Timeline de acesso", label: "Timeline de Acesso", applicationFeatureId: 4, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: false, ableToWrite: false },
    { fieldName: "invitations", profilePermissionId: 2, allowsEdit: true, name: "Convites", label: "Convites", applicationFeatureId: 2, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: null, ableToWrite: false },
    { fieldName: "users", profilePermissionId: 1, allowsEdit: true, name: "Usuários", label: "Usuários", applicationFeatureId: 1, ableToReadIsUpdated: true, ableToWriteIsUpdated: true, ableToRead: false, ableToWrite: false },
  ];
}

/**
 * Identidade do app que a Kiper passou a conferir junto com o token. São
 * valores globais do aplicativo (não variam por imóvel); o único campo por
 * conta é o `appdeviceid`, que fica em porter_accounts.
 *
 * Capturados da versão iOS 6.17.5. Se um dia a Kiper travar por versão, é aqui
 * que se atualiza — sem tocar em banco.
 */
const PORTER_APP = {
  appname: "porter",
  appos: "ios",
  appversion: "6.17.5",
  apposversion: "26.5",
  userAgent: "Porter/1372 CFNetwork/3860.600.12 Darwin/25.5.0",
} as const;

/** E.164 -> "+55 21 99999 8888", formato que a Kiper espera exibir. */
function formatPhone(e164: string | null): string {
  if (!e164) return "";
  const digits = e164.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) {
    const local = digits.slice(2);
    return `+55 ${local.slice(0, 2)} ${local.slice(2, 7)} ${local.slice(7)}`;
  }
  // DDI de 1 a 3 dígitos: sem tabela, devolvemos com o + e o resto junto.
  return `+${digits}`;
}

export default handler(async (req) => {
  await requireCron(req);

  if (!env.porterEnabled()) {
    return json({ ok: true, skipped: "PORTER_ENABLED=false" });
  }

  const db = admin();

  const { data: pending, error } = await db
    .from("porter_registrations")
    .select("id, property_id, person_id, attempts, access_from, access_until")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) throw new Error(`Falha ao listar fila da portaria: ${error.message}`);

  let registered = 0;
  let failed = 0;
  let noIntegration = 0;

  for (const row of (pending ?? []) as PendingRow[]) {
    const { data: account } = await db
      .from("porter_accounts")
      .select("*")
      .eq("property_id", row.property_id)
      .eq("active", true)
      .maybeSingle();

    if (!account) {
      await db
        .from("porter_registrations")
        .update({ status: "no_integration", response_body: "Portaria não configurada para este imóvel" })
        .eq("id", row.id);
      noIntegration++;
      continue;
    }

    const { data: person } = await db
      .from("guest_people")
      .select("full_name, email, phone_e164")
      .eq("id", row.person_id)
      .maybeSingle();

    if (!person) {
      await db
        .from("porter_registrations")
        .update({ status: "failed", response_body: "Hóspede não encontrado" })
        .eq("id", row.id);
      failed++;
      continue;
    }

    const phone = formatPhone(person.phone_e164);
    const baseBody = {
      name: person.full_name,
      email: person.email,
      accessibilityTime: 3,
      profileId: account.porter_profile_id ?? 16,
      bookingTime: { initDate: row.access_from, endDate: row.access_until },
      allowedAccesses: [],
      permissions: permissions(),
    };

    const url =
      `${env.porterBaseUrl()}/Mobile/InsertDwellerFromMobile` +
      `?token=${encodeURIComponent(account.porter_token)}`;

    // Sem a semente do TOTP não adianta chamar: desde ~ago/2026 a Kiper exige
    // o `otp` e devolve "token inválido" sem ele. Marca a conta com o motivo
    // exato — o que o dono lê é "falta reconectar", não um erro genérico.
    if (!account.porter_totp_secret) {
      await db
        .from("porter_registrations")
        .update({
          status: "no_integration",
          response_body:
            "Portaria conectada sem o código de acesso (TOTP). Reconecte o imóvel capturando o keyHash do login.",
        })
        .eq("id", row.id);
      await db
        .from("porter_accounts")
        .update({ last_error: "Falta o segredo do código de acesso (keyHash). Reconecte pela captura do login." })
        .eq("id", account.id);
      noIntegration++;
      continue;
    }

    // O código de 6 dígitos, gerado agora no banco a partir da semente. Fica no
    // Postgres de propósito: a semente nunca sai de porter_accounts, e a função
    // só é executável pelo service_role.
    const { data: otp, error: otpError } = await db.rpc("porter_totp", {
      _secret: account.porter_totp_secret,
    });
    if (otpError || !otp) {
      const attempts = row.attempts + 1;
      await db
        .from("porter_registrations")
        .update({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          response_body: `Falha ao gerar o código de acesso: ${otpError?.message ?? "sem retorno"}`,
        })
        .eq("id", row.id);
      failed++;
      continue;
    }

    const reqHeaders: HeadersInit = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "pt-br",
      token: account.porter_token,
      "x-auth-token": account.porter_token,
      applicationkey: account.porter_application_key,
      condominiumpersoncontextid: account.porter_condo_person_context_id,
      userpartnercontextid: account.porter_user_partner_context_id,
      usercontextid: account.porter_user_context_id,
      accountlocalid: account.porter_account_local_id,
      accessid: account.porter_account_local_id,
      condominiumgmt: account.porter_condominium_gmt ?? "-3",
      otp: otp as unknown as string,
      appname: PORTER_APP.appname,
      appos: PORTER_APP.appos,
      appversion: PORTER_APP.appversion,
      apposversion: PORTER_APP.apposversion,
      appdeviceid: account.porter_app_device_id ?? "",
      "user-agent": PORTER_APP.userAgent,
      "x-datadog-tracked-by": "react-native",
      timezone: env.timezone(),
      // UTC, igual ao que o app manda. A Kiper compara com o relógio dela;
      // hora local (−3h) faz cair em "verifique a hora do aparelho".
      datetime: new Date().toISOString().replace("T", " ").slice(0, 19),
    };

    // A Kiper exige telefone único no condomínio. Hóspede repetido, ou cujo
    // número já está em outro cadastro, é o caso comum — e o próprio painel
    // da portaria, nesse caso, cadastra só com nome e e-mail. Espelhamos isso:
    // manda com telefone; se ela recusar o número, refaz sem o campo.
    const post = (withPhone: boolean) =>
      fetch(url, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(withPhone && phone ? { ...baseBody, phone } : baseBody),
      });

    try {
      let res = await post(Boolean(phone));
      let text = await res.text();

      if (
        !res.ok &&
        phone &&
        /(telefone[^"]*(vinculado|cadastro)|"specificities"\s*:\s*"phone")/i.test(text)
      ) {
        res = await post(false);
        text = await res.text();
      }

      // "Esse usuário possui cadastro nessa unidade": a pessoa já tem acesso
      // (morador fixo ou hóspede que voltou). Não é falha — é liberado.
      const alreadyRegistered = res.status === 400 && /possui cadastro/i.test(text);

      if (res.ok || alreadyRegistered) {
        await db
          .from("porter_registrations")
          .update({
            status: "registered",
            attempts: row.attempts + 1,
            response_status: res.status,
            response_body: text.slice(0, 2000),
          })
          .eq("id", row.id);

        await db
          .from("porter_accounts")
          .update({ last_ok_at: new Date().toISOString(), last_error: null })
          .eq("id", account.id);

        registered++;
      } else {
        const attempts = row.attempts + 1;
        await db
          .from("porter_registrations")
          .update({
            status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
            attempts,
            response_status: res.status,
            response_body: text.slice(0, 2000),
          })
          .eq("id", row.id);

        await db
          .from("porter_accounts")
          .update({ last_error: `HTTP ${res.status}: ${text.slice(0, 300)}` })
          .eq("id", account.id);

        failed++;
        console.warn(`Portaria recusou ${row.person_id}: ${res.status} ${text.slice(0, 200)}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const attempts = row.attempts + 1;
      await db
        .from("porter_registrations")
        .update({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          response_body: message.slice(0, 2000),
        })
        .eq("id", row.id);
      failed++;
      console.error(`Falha de rede na portaria (${row.id}): ${message}`);
    }
  }

  const out = { scanned: pending?.length ?? 0, registered, failed, no_integration: noIntegration };
  if ((pending?.length ?? 0) > 0) console.log("porter-sync:", JSON.stringify(out));
  return json({ ok: true, ...out });
});
