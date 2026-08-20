import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, appToday } from "../_shared/lib/db.ts";
import { enviarTermoPorEmail, registrarTermo } from "../_shared/lib/termo.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Cadastro da estadia pelo hóspede. Endpoint público (o hóspede não tem conta),
 * mas NÃO anônimo no sentido de "sem controle":
 *
 *   - só aceita o slug público do imóvel, nunca um UUID interno;
 *   - o imóvel precisa ter dono com assinatura viva;
 *   - limite por IP para não virar porta de spam;
 *   - devolve um TOKEN DE SESSÃO opaco — é ele, e não o id do imóvel, que
 *     autoriza o chat e o cadastro na portaria.
 *
 * No backend antigo esta etapa alimentava um endpoint totalmente aberto que
 * cadastrava morador na portaria digital a partir de um propertyId avulso.
 */

interface GuestInput {
  full_name?: string;
  email?: string;
  phone?: string;
  document_type?: string;
  document_number?: string;
}

interface Body {
  property_slug?: string;
  checkin_date?: string;
  checkout_date?: string;
  guests?: GuestInput[];
  term_accepted?: boolean;
  /** PNG do canvas: data:image/png;base64,... */
  assinatura?: string;
  locale?: string;
}

const MAX_GUESTS = 16;
const RATE_LIMIT_PER_HOUR = 20;

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : null;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const body = await readJson<Body>(req);
  const db = admin();
  const ip = clientIp(req);

  // ---- validação de entrada ------------------------------------------------
  const slug = (body.property_slug ?? "").trim().toLowerCase();
  if (!slug) throw errors.invalid("property_slug é obrigatório");

  if (!body.checkin_date || !isDate(body.checkin_date)) {
    throw errors.invalid("Informe a data de check-in (AAAA-MM-DD)");
  }
  if (!body.checkout_date || !isDate(body.checkout_date)) {
    throw errors.invalid("Informe a data de check-out (AAAA-MM-DD)");
  }
  if (body.checkout_date <= body.checkin_date) {
    throw errors.invalid("A data de check-out precisa ser depois do check-in");
  }
  if (body.checkout_date < appToday()) {
    throw errors.invalid("Essa estadia já terminou");
  }
  if (body.term_accepted !== true) {
    throw errors.invalid("É necessário aceitar o termo de responsabilidade");
  }
  // A assinatura NÃO é exigida aqui, e isso é sequenciamento e não descuido.
  //
  // O backend sobe antes do frontend: entre um e outro existe uma janela em
  // que o hóspede está na porta do prédio com a versão antiga da página, que
  // não desenha o quadro de assinar. Exigir a assinatura nessa janela
  // deixaria essa pessoa sem check-in por causa do nosso deploy.
  //
  // Quem manda a assinatura ganha o termo em PDF; quem não manda faz o
  // cadastro como antes. Quando o frontend novo estiver no ar em todo lugar,
  // trocar isto por um `throw` é uma linha.

  const guests = (body.guests ?? []).filter(Boolean);
  if (guests.length === 0) throw errors.invalid("Cadastre ao menos um hóspede");
  if (guests.length > MAX_GUESTS) {
    throw errors.invalid(`Máximo de ${MAX_GUESTS} hóspedes por cadastro`);
  }

  guests.forEach((g, i) => {
    const name = (g.full_name ?? "").trim();
    if (name.length < 3 || !name.includes(" ")) {
      throw errors.invalid(`Hóspede ${i + 1}: informe o nome completo`);
    }
    const email = (g.email ?? "").trim();
    if (!email || !isEmail(email)) {
      throw errors.invalid(`Hóspede ${i + 1}: informe um e-mail válido`);
    }
    const digits = (g.phone ?? "").replace(/\D/g, "");
    if (digits.length < 10) {
      throw errors.invalid(`Hóspede ${i + 1}: informe um telefone válido com DDD`);
    }
  });

  // ---- rate limit ----------------------------------------------------------
  if (ip) {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await db
      .from("guest_sessions")
      .select("id", { count: "exact", head: true })
      .eq("created_ip", ip)
      .gte("created_at", since);
    if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) throw errors.rateLimited();
  }

  // ---- imóvel + assinatura -------------------------------------------------
  const { data: property } = await db
    .from("properties")
    .select("id, name, owner_id, checkin_time, checkout_time, archived_at")
    .eq("public_slug", slug)
    .maybeSingle();

  if (!property || property.archived_at) {
    throw errors.notFound("Link inválido. Confirme o endereço com o anfitrião.");
  }

  const { data: subActive } = await db.rpc("subscription_is_active", {
    _user_id: property.owner_id,
  });
  if (!subActive) {
    throw errors.forbidden(
      "Este cadastro está temporariamente indisponível. Fale com o anfitrião.",
    );
  }

  // ---- termo ---------------------------------------------------------------
  const locale = ["pt", "en", "es"].includes(body.locale ?? "")
    ? body.locale!
    : env.defaultLocale();

  // O filtro por `kind` não é enfeite: esta consulta nasceu quando existia um
  // termo só no sistema, e a 0025 acrescentou o do Hermes. A partir dali havia
  // DOIS termos ativos em `pt`, `maybeSingle()` passou a devolver nulo (mais de
  // uma linha), e todo cadastro de hóspede morria em "Termo de responsabilidade
  // indisponível". Publicar um terceiro assunto sem este filtro quebraria de novo.
  const { data: term } = await db
    .from("term_versions")
    .select("id, version")
    .eq("kind", "cadastro_hospede")
    .eq("locale", locale)
    .eq("active", true)
    .maybeSingle();

  if (!term) throw errors.upstream("Termo de responsabilidade indisponível");

  // ---- grava ---------------------------------------------------------------
  // Casa o cadastro com a reserva do calendário quando as datas batem, para o
  // dono ver "reserva X = estas pessoas" em vez de dois registros soltos.
  const { data: reservation } = await db
    .from("reservations")
    .select("id")
    .eq("property_id", property.id)
    .eq("status", "confirmed")
    .lte("checkin_date", body.checkout_date)
    .gte("checkout_date", body.checkin_date)
    .order("checkin_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: registration, error: regError } = await db
    .from("guest_registrations")
    .insert({
      property_id: property.id,
      reservation_id: reservation?.id ?? null,
      checkin_date: body.checkin_date,
      checkout_date: body.checkout_date,
      term_version_id: term.id,
      term_accepted_ip: ip,
      term_user_agent: req.headers.get("user-agent"),
      locale,
    })
    .select("id")
    .single();

  if (regError || !registration) {
    console.error("Falha ao gravar cadastro:", regError?.message);
    throw errors.upstream("Não foi possível concluir o cadastro. Tente novamente.");
  }

  // A coluna se chama `phone_e164` e por muito tempo guardou o que a pessoa
  // digitou — "21988978322", "(21) 98897-8322", "+55 21…". Quem consome isso
  // depois (a portaria) confiava no nome da coluna, montava "+21988978322" e
  // a Kiper recusava por DDI inexistente. Normalizar aqui é o conserto na
  // origem: `normalize_phone` é a mesma função que o convite da diarista usa.
  const normalizedPhones = await Promise.all(
    guests.map(async (g) => {
      const { data } = await db.rpc("normalize_phone", { _phone: g.phone ?? null });
      return (data as unknown as string | null) ?? (g.phone ?? null);
    }),
  );

  const people = guests.map((g, i) => ({
    registration_id: registration.id,
    full_name: g.full_name!.trim(),
    email: g.email!.trim().toLowerCase(),
    phone_e164: normalizedPhones[i],
    document_type: g.document_type ?? null,
    document_number: g.document_number ?? null,
    is_primary: i === 0,
  }));

  const { data: insertedPeople, error: peopleError } = await db
    .from("guest_people")
    .insert(people)
    .select("id, full_name, email, phone_e164, is_primary");

  if (peopleError) {
    console.error("Falha ao gravar hóspedes:", peopleError.message);
    throw errors.upstream("Não foi possível concluir o cadastro. Tente novamente.");
  }

  // ---- sessão de chat ------------------------------------------------------
  const { data: tokenRow } = await db.rpc("generate_token", { _bytes: 32 });
  const token = tokenRow as unknown as string;
  const { data: hashRow } = await db.rpc("hash_token", { _token: token });

  const ttlHours = Number(
    (await db.from("app_settings").select("value").eq("key", "guest_session_ttl_hours")
      .maybeSingle()).data?.value ?? 720,
  );

  const primary = insertedPeople!.find((p) => p.is_primary)!;

  const { data: session, error: sessionError } = await db
    .from("guest_sessions")
    .insert({
      property_id: property.id,
      registration_id: registration.id,
      token_hash: hashRow as unknown as string,
      guest_name: primary.full_name,
      guest_phone_e164: primary.phone_e164,
      locale,
      expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
      created_ip: ip,
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    console.error("Falha ao criar sessão:", sessionError?.message);
    throw errors.upstream("Cadastro gravado, mas o chat falhou. Recarregue a página.");
  }

  // ---- portaria (assíncrono, não bloqueia o hóspede) -----------------------
  const { data: porter } = await db
    .from("porter_accounts")
    .select("id")
    .eq("property_id", property.id)
    .eq("active", true)
    .maybeSingle();

  if (porter && env.porterEnabled()) {
    const rows = insertedPeople!.map((p) => ({
      property_id: property.id,
      registration_id: registration.id,
      person_id: p.id,
      status: "pending",
      access_from: `${body.checkin_date}T${property.checkin_time ?? "15:00:00"}-03:00`,
      access_until: `${body.checkout_date}T${property.checkout_time ?? "11:00:00"}-03:00`,
    }));
    await db.from("porter_registrations").insert(rows);
  }

  // ---- termo assinado ------------------------------------------------------
  // Depois de gravar as pessoas, porque o documento lista quem foi cadastrado:
  // é justamente por essa lista que o hóspede está assumindo responsabilidade.
  //
  // Uma falha aqui NÃO derruba o cadastro. O hóspede já preencheu tudo e está
  // na porta do prédio; devolver erro agora o deixaria de fora por um problema
  // que é nosso. O termo fica sem PDF e o log registra — é o único caminho em
  // que alguém perde algo recuperável em vez de perder a entrada.
  let termoId: string | null = null;
  let termoPdf: string | null = null;

  if (body.assinatura) {
    try {
      const assinado = await registrarTermo(db, {
        kind: "cadastro_hospede",
        propertyId: property.id,
        registrationId: registration.id,
        signerName: primary.full_name,
        signerDoc: guests[0]?.document_number?.trim() || null,
        assinaturaDataUrl: body.assinatura!,
        locale,
        ip,
        userAgent: req.headers.get("user-agent"),
        detalhes: [
          ["Imóvel", property.name],
          ["Check-in", body.checkin_date!],
          ["Check-out", body.checkout_date!],
          ["Pessoas cadastradas", String(insertedPeople!.length)],
          ...insertedPeople!.map(
            (pe, i) => [`Hóspede ${i + 1}`, pe.full_name] as [string, string],
          ),
        ],
      });
      termoId = assinado.id;
      termoPdf = assinado.pdfPath;
    } catch (e) {
      console.error("Termo assinado falhou:", e instanceof Error ? e.message : e);
    }
  }

  // ---- e-mails -------------------------------------------------------------
  // Ao dono: quem se cadastrou.
  const { data: ownerProfile } = await db
    .from("profiles")
    .select("email, locale")
    .eq("user_id", property.owner_id)
    .maybeSingle();

  if (ownerProfile?.email) {
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "guest-registered",
      _payload: {
        property_name: property.name,
        guest_count: insertedPeople!.length,
        primary_guest: primary.full_name,
        checkin_date: body.checkin_date,
        checkout_date: body.checkout_date,
      },
      _to_email: ownerProfile.email,
      _to_user_id: property.owner_id,
      _idempotency_key: `guest-reg:${registration.id}`,
      _locale: ownerProfile.locale ?? "pt",
      _entity: "guest_registrations",
      _entity_id: registration.id,
    });

    // O termo vai num e-mail separado, com o PDF anexado. Junto do aviso de
    // cadastro ele viraria "mais um anexo" de uma mensagem de rotina; sozinho,
    // é o documento que o dono arquiva.
    if (termoId && termoPdf) {
      await enviarTermoPorEmail(db, {
        assinaturaId: termoId,
        pdfPath: termoPdf,
        para: ownerProfile.email,
        assunto: `Termo assinado — ${primary.full_name} em ${property.name}`,
        titulo: "Termo de responsabilidade assinado",
        linhas: [
          ["Imóvel", property.name],
          ["Hóspede responsável", primary.full_name],
          ["Check-in", body.checkin_date!],
          ["Check-out", body.checkout_date!],
          ["Pessoas cadastradas", String(insertedPeople!.length)],
          [
            "Assinado em",
            new Date().toLocaleString("pt-BR", {
              timeZone: env.timezone(),
              dateStyle: "short",
              timeStyle: "short",
            }),
          ],
        ],
        fecho:
          "Nele o hóspede assume a responsabilidade pelo imóvel, pelas demais pessoas que " +
          "cadastrou, e se compromete a não receber quem não está no check-in sem sua autorização.",
        nomeArquivo: "termo-de-responsabilidade.pdf",
      });
    }
  }

  // A cada hóspede: instruções de acesso + cópia do termo aceito.
  // Sem isto, quem fecha a aba perde Wi-Fi e código da fechadura — e liga
  // para o dono, que foi exatamente o que ele pagou para não acontecer.
  for (const person of insertedPeople!) {
    await db.rpc("enqueue_notification", {
      _channel: "email",
      _template: "guest-welcome",
      _payload: {
        guest_name: person.full_name,
        property_name: property.name,
        chat_url: `${env.appBaseUrl()}/c/${slug}?t=${token}`,
        checkin_date: body.checkin_date,
        checkout_date: body.checkout_date,
        checkin_time: property.checkin_time,
        checkout_time: property.checkout_time,
        term_version: term.version,
        // Este e-mail é o comprovante do aceite, então leva a data em que ele
        // aconteceu — sem isso o hóspede tem um recibo sem quando.
        term_accepted_at: new Date().toLocaleString("pt-BR", {
          timeZone: env.timezone(),
          dateStyle: "short",
          timeStyle: "short",
        }),
        guest_count: insertedPeople!.length,
        has_porter: Boolean(porter),
      },
      _to_email: person.email,
      _idempotency_key: `guest-welcome:${person.id}`,
      _locale: locale,
      _entity: "guest_people",
      _entity_id: person.id,
    });
  }

  return json({
    ok: true,
    session_token: token,
    registration_id: registration.id,
    property: { name: property.name, checkin_time: property.checkin_time, checkout_time: property.checkout_time },
    guests_registered: insertedPeople!.length,
    porter_pending: Boolean(porter),
  });
});
