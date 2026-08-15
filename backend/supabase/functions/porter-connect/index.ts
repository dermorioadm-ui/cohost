import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, appToday, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Conecta o imóvel à portaria digital (Kiper/Porter).
 *
 * O backend já sabia cadastrar hóspede na portaria desde a 0009 — `guest-register`
 * enfileira e `job-porter-sync` chama a API. O que não existia era como o dono
 * informar as credenciais do prédio dele: `porter_accounts` nasceu sem tela.
 * Sem uma linha ali, `guest-register` não enfileira nada e a integração inteira
 * fica muda. Esta function é essa porta de entrada.
 *
 * Três decisões que valem explicar:
 *
 * 1. **O teste é aqui, não no navegador.** No app antigo o formulário chamava
 *    a Kiper direto do browser: o token trafegava pela máquina do cliente e
 *    dependia do CORS de um terceiro. Aqui o segredo sai do formulário e vai
 *    direto para o servidor.
 *
 * 2. **Salvar exige um teste que passou.** Credencial de portaria é capturada
 *    à mão, header por header; errar um dígito é o caso comum, e sem o teste o
 *    erro só apareceria dias depois, com o hóspede parado na guarita.
 *
 * 3. **Conectar preenche o passado.** Quem cadastrou hóspede antes de conectar
 *    a portaria não tem linha em `porter_registrations` — enfileiramos aqui as
 *    estadias que ainda não terminaram, senão a integração só valeria para
 *    quem se cadastrar depois.
 *
 * Em nenhuma resposta a credencial volta. A tabela não tem policy de SELECT
 * nem para o dono, e esta function respeita isso: devolve estado, não segredo.
 */

interface Body {
  action?: "status" | "test" | "save" | "disconnect";
  property_id?: string;
  /** Só quando o dono insiste em salvar com a Kiper fora do ar. */
  skip_test?: boolean;
  porter_token?: string;
  porter_application_key?: string;
  porter_account_local_id?: string;
  porter_user_context_id?: string;
  porter_user_partner_context_id?: string;
  porter_condo_person_context_id?: string;
  porter_condominium_gmt?: string;
  porter_profile_id?: number;
}

/** Os seis headers que o app da Kiper manda em toda chamada autenticada. */
const CREDENTIAL_FIELDS = [
  "porter_token",
  "porter_application_key",
  "porter_account_local_id",
  "porter_user_context_id",
  "porter_user_partner_context_id",
  "porter_condo_person_context_id",
] as const;

type CredentialField = typeof CREDENTIAL_FIELDS[number];
type Credentials = Record<CredentialField, string>;

const LABEL: Record<CredentialField, string> = {
  porter_token: "Token de autenticação",
  porter_application_key: "Chave da aplicação",
  porter_account_local_id: "ID da conta local",
  porter_user_context_id: "ID do usuário",
  porter_user_partner_context_id: "ID do parceiro",
  porter_condo_person_context_id: "ID do condomínio",
};

function readCredentials(body: Body): Credentials {
  const out = {} as Credentials;
  const missing: string[] = [];

  for (const field of CREDENTIAL_FIELDS) {
    const value = (body[field] ?? "").toString().trim();
    if (!value) missing.push(LABEL[field]);
    out[field] = value;
  }

  if (missing.length > 0) {
    throw errors.invalid(
      missing.length === 1
        ? `Falta preencher: ${missing[0]}`
        : `Faltam preencher: ${missing.join(", ")}`,
    );
  }
  return out;
}

/** Headers da Kiper, montados a partir das credenciais do imóvel. */
function porterHeaders(c: Credentials, gmt: string): HeadersInit {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-br",
    token: c.porter_token,
    "x-auth-token": c.porter_token,
    applicationkey: c.porter_application_key,
    condominiumpersoncontextid: c.porter_condo_person_context_id,
    userpartnercontextid: c.porter_user_partner_context_id,
    usercontextid: c.porter_user_context_id,
    accountlocalid: c.porter_account_local_id,
    accessid: c.porter_account_local_id,
    condominiumgmt: gmt,
    timezone: env.timezone(),
    datetime: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
}

interface TestResult {
  ok: boolean;
  status: number | null;
  message: string;
}

/**
 * Toca a Kiper num endpoint de leitura. `Profiles` é o mais barato que exige
 * as mesmas credenciais do cadastro — se ele responde, `InsertDwellerFromMobile`
 * responde. Nada é criado no prédio por causa de um teste.
 */
async function testCredentials(c: Credentials, gmt: string): Promise<TestResult> {
  const url = `${env.porterBaseUrl()}/Mobile/Profiles?token=${encodeURIComponent(c.porter_token)}`;

  try {
    const res = await fetch(url, { method: "GET", headers: porterHeaders(c, gmt) });
    const text = await res.text();

    if (res.ok) {
      return { ok: true, status: res.status, message: "Portaria respondeu. Credenciais válidas." };
    }

    // 401/403 é quase sempre token vencido — o caso que mais aparece, porque a
    // captura é manual e o token da Kiper expira sozinho.
    const message =
      res.status === 401 || res.status === 403
        ? "A portaria recusou essas credenciais. O token costuma vencer — capture de novo pelo app do prédio."
        : `A portaria respondeu com erro ${res.status}. ${text.slice(0, 200)}`.trim();

    return { ok: false, status: res.status, message };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: null,
      message: `Não consegui falar com a portaria: ${detail}`,
    };
  }
}

/** Estado que o dono pode ver — nunca as credenciais. */
async function statusOf(db: ReturnType<typeof admin>, propertyId: string) {
  const { data } = await db
    .from("porter_accounts")
    .select("active, last_ok_at, last_error, updated_at")
    .eq("property_id", propertyId)
    .maybeSingle();

  if (!data) return { connected: false };

  return {
    connected: true,
    active: data.active,
    last_ok_at: data.last_ok_at,
    last_error: data.last_error,
    updated_at: data.updated_at,
  };
}

/**
 * Enfileira quem já está cadastrado e ainda não saiu.
 *
 * A janela de acesso sai do horário do imóvel, igual ao `guest-register`, com
 * o offset de Brasília explícito: a Kiper interpreta data sem fuso como UTC e
 * o hóspede perderia as três primeiras horas da estadia.
 */
async function backfillQueue(
  db: ReturnType<typeof admin>,
  property: { id: string; checkin_time: string | null; checkout_time: string | null },
): Promise<number> {
  const { data: registrations } = await db
    .from("guest_registrations")
    .select("id, checkin_date, checkout_date, guest_people(id)")
    .eq("property_id", property.id)
    .gte("checkout_date", appToday());

  if (!registrations || registrations.length === 0) return 0;

  const peopleIds = registrations.flatMap(
    (r) => ((r.guest_people ?? []) as Array<{ id: string }>).map((p) => p.id),
  );
  if (peopleIds.length === 0) return 0;

  // Quem já tem linha na fila (de qualquer status) fica de fora: reenfileirar
  // um `registered` cadastraria a mesma pessoa duas vezes no prédio.
  const { data: existing } = await db
    .from("porter_registrations")
    .select("person_id")
    .in("person_id", peopleIds);

  const already = new Set((existing ?? []).map((r) => r.person_id as string));

  const rows = registrations.flatMap((r) =>
    ((r.guest_people ?? []) as Array<{ id: string }>)
      .filter((p) => !already.has(p.id))
      .map((p) => ({
        property_id: property.id,
        registration_id: r.id as string,
        person_id: p.id,
        status: "pending",
        access_from: `${r.checkin_date}T${property.checkin_time ?? "15:00:00"}-03:00`,
        access_until: `${r.checkout_date}T${property.checkout_time ?? "11:00:00"}-03:00`,
      })),
  );

  if (rows.length === 0) return 0;

  const { error } = await db.from("porter_registrations").insert(rows);
  if (error) {
    // A conexão em si deu certo; falhar aqui só significa que ninguém do
    // passado entrou na fila. Não vale derrubar o save por isso.
    console.warn(`Backfill da portaria falhou (${property.id}): ${error.message}`);
    return 0;
  }
  return rows.length;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const body = await readJson<Body>(req);
  const action = body.action ?? "status";

  if (!body.property_id) throw errors.invalid("Informe o imóvel");

  const db = admin();

  // O imóvel tem de ser do requisitante. Admin passa pelo requireRole, então a
  // checagem de dono só se aplica a quem é dono — caso contrário um admin não
  // conseguiria configurar a portaria de um cliente no suporte.
  const propertyQuery = db
    .from("properties")
    .select("id, name, checkin_time, checkout_time, owner_id")
    .eq("id", body.property_id);

  if (user.role !== "admin") propertyQuery.eq("owner_id", user.id);

  const { data: property } = await propertyQuery.maybeSingle();
  if (!property) throw errors.notFound("Imóvel não encontrado");

  if (!env.porterEnabled()) {
    return json({
      ok: false,
      reason: "disabled",
      message: "A portaria digital está desligada nesta instalação.",
      ...(await statusOf(db, property.id)),
    });
  }

  // ---- status --------------------------------------------------------------
  if (action === "status") {
    return json({ ok: true, ...(await statusOf(db, property.id)) });
  }

  // ---- desconectar ---------------------------------------------------------
  if (action === "disconnect") {
    // Apaga em vez de desativar: credencial guardada que ninguém usa é só
    // superfície de vazamento. Reconectar é recolar os seis campos.
    const { error } = await db
      .from("porter_accounts")
      .delete()
      .eq("property_id", property.id);

    if (error) throw errors.upstream(`Não consegui desconectar: ${error.message}`);

    return json({
      ok: true,
      connected: false,
      message: `Portaria desconectada de ${property.name}. Novos hóspedes deixam de ser cadastrados no prédio.`,
    });
  }

  // ---- testar / salvar -----------------------------------------------------
  const credentials = readCredentials(body);
  const gmt = (body.porter_condominium_gmt ?? "-3").toString().trim() || "-3";

  if (action === "test") {
    const result = await testCredentials(credentials, gmt);
    return json({ ok: result.ok, status: result.status, message: result.message });
  }

  if (action !== "save") throw errors.invalid(`Ação desconhecida: ${action}`);

  let tested: TestResult | null = null;
  if (!body.skip_test) {
    tested = await testCredentials(credentials, gmt);
    if (!tested.ok) {
      return json({
        ok: false,
        saved: false,
        reason: "test_failed",
        status: tested.status,
        message: tested.message,
      });
    }
  }

  const { error } = await db.from("porter_accounts").upsert(
    {
      property_id: property.id,
      owner_id: property.owner_id,
      ...credentials,
      porter_condominium_gmt: gmt,
      porter_profile_id: body.porter_profile_id ?? 16,
      active: true,
      last_error: null,
      last_ok_at: tested?.ok ? new Date().toISOString() : null,
    },
    { onConflict: "property_id" },
  );

  if (error) throw errors.upstream(`Não consegui salvar as credenciais: ${error.message}`);

  const queued = await backfillQueue(db, property);

  return json({
    ok: true,
    saved: true,
    connected: true,
    queued,
    message:
      queued === 0
        ? `Portaria conectada. A partir de agora, quem se cadastrar em ${property.name} é liberado no prédio sozinho.`
        : `Portaria conectada. ${queued} hóspede${queued === 1 ? "" : "s"} que já ${queued === 1 ? "estava" : "estavam"} cadastrado${queued === 1 ? "" : "s"} ${queued === 1 ? "entrou" : "entraram"} na fila de liberação.`,
  });
});
