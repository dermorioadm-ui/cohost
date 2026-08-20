import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, appToday } from "../_shared/lib/db.ts";
import {
  enviarTermoPorEmail, imagemDoDataUrl, registrarTermo,
} from "../_shared/lib/termo.ts";
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
  phone_ddi?: string;
  document_type?: string;
  document_number?: string;
  nationality?: string;
  /** data:image/...;base64,... da foto do documento. */
  document_photo?: string;
}

interface Body {
  property_slug?: string;
  checkin_date?: string;
  checkout_date?: string;
  guests?: GuestInput[];
  term_accepted?: boolean;
  /** PNG do canvas: data:image/png;base64,... */
  assinatura?: string;
  /**
   * Rosto de quem assinou, tirado logo depois da assinatura.
   *
   * Aceito como opcional pelo mesmo motivo que o documento e a assinatura
   * foram opcionais no seu tempo: o backend sobe antes do frontend, e nessa
   * janela existe hóspede na porta do prédio com a página anterior, que não
   * pede o rosto. Recusar ali o deixaria sem check-in por causa do nosso
   * deploy. Depois que a página nova estiver publicada, este campo vira
   * obrigatório — como os outros dois viraram.
   */
  selfie?: string;
  locale?: string;
}

const MAX_GUESTS = 16;
const RATE_LIMIT_PER_HOUR = 20;

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * CPF: dígitos verificadores.
 *
 * A checagem se repete aqui, e não só no formulário, porque validação de
 * cliente é conveniência e não regra. Quem chama o endpoint direto passaria
 * "00000000000" e o termo assinado sairia apontando para ninguém — que é
 * exatamente o que o documento existe para evitar.
 */
function cpfValido(valor: string): boolean {
  const d = (valor ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;

  const digito = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

const passaporteValido = (v: string) => /^[A-Z0-9]{5,12}$/.test((v ?? "").trim().toUpperCase());

/** ISO 3166-1 alfa-2. Não valida o país, valida o formato. */
const isoValido = (v: string) => /^[A-Z]{2}$/.test((v ?? "").trim().toUpperCase());

/** "CPF 123.456.789-09" ou "Passaporte AB123456 (PT)", para o PDF. */
function rotuloDoc(g: GuestInput | undefined): string {
  if (!g) return "";
  const tipo = (g.document_type ?? "").trim().toLowerCase();
  const numero = (g.document_number ?? "").trim();
  if (!numero) return "";

  if (tipo === "cpf") {
    const d = numero.replace(/\D/g, "");
    const formatado =
      d.length === 11
        ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
        : d;
    return `CPF ${formatado}`;
  }

  const pais = (g.nationality ?? "").trim().toUpperCase();
  return `Passaporte ${numero.toUpperCase()}${pais ? ` (${pais})` : ""}`;
}

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
  // A assinatura era opcional enquanto o frontend antigo ainda estava no ar —
  // não se deixa hóspede na porta do prédio por causa do nosso deploy. Com o
  // formulário novo publicado, essa janela fechou: um cadastro sem assinatura
  // agora só vem de chamada direta ao endpoint.
  if (!body.assinatura) {
    throw errors.invalid("Assine o termo antes de concluir o cadastro");
  }

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

    // O documento é o que dá validade ao termo assinado. Um cadastro sem ele
    // produz uma assinatura que identifica um nome, e nome não identifica
    // ninguém — há dois "João Silva" em qualquer prédio.
    const tipo = (g.document_type ?? "").trim().toLowerCase();
    const numero = (g.document_number ?? "").trim();

    if (tipo === "passaporte") {
      if (!passaporteValido(numero)) {
        throw errors.invalid(`Hóspede ${i + 1}: número de passaporte inválido`);
      }
      if (!isoValido(g.nationality ?? "")) {
        throw errors.invalid(`Hóspede ${i + 1}: informe a nacionalidade`);
      }
    } else if (tipo === "cpf") {
      if (!cpfValido(numero)) throw errors.invalid(`Hóspede ${i + 1}: CPF inválido`);
    } else {
      // A janela de transição fechou: o formulário com CPF está no ar, então
      // um cadastro sem documento não é mais "frontend antigo" — é chamada
      // direta ao endpoint, contornando a única coisa que dá validade ao
      // termo assinado.
      throw errors.invalid(
        `Hóspede ${i + 1}: informe o CPF, ou marque estrangeiro e informe o passaporte`,
      );
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

  // ---- as datas precisam bater com uma reserva -----------------------------
  // O link circula por mensagem de plataforma e vaza — print, encaminhamento,
  // hóspede antigo que guardou. Sem esta checagem, qualquer pessoa com o link
  // escolhia datas, se cadastrava e entrava na fila da portaria com acesso ao
  // prédio. Documento e rosto registram QUEM entrou; isto aqui é o que impede
  // entrar quem não tem reserva.
  //
  // A regra falha ABERTA de propósito: só exige o casamento quando o imóvel
  // tem reserva futura no calendário. Imóvel sem iCal conectado (ou com a
  // sincronia quebrada) não tem reservas no banco, e exigir ali trancaria
  // hóspede legítimo para fora por um problema que é nosso.
  if (!reservation) {
    const { count: futuras } = await db
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("property_id", property.id)
      .eq("status", "confirmed")
      .gte("checkout_date", appToday());

    if ((futuras ?? 0) > 0) {
      throw errors.invalid(
        "Não encontrei uma reserva nessas datas. Confira as datas na sua reserva " +
          "do Airbnb ou da Booking — precisam ser as mesmas.",
      );
    }
  }

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
    phone_ddi: (g.phone_ddi ?? "").replace(/\D/g, "") || null,
    document_type: (g.document_type ?? "").trim().toLowerCase() || null,
    // CPF guardado só com dígitos e passaporte em maiúsculas: a mesma pessoa
    // digitando "123.456.789-09" e "12345678909" precisa virar a mesma linha.
    document_number:
      (g.document_type ?? "").trim().toLowerCase() === "cpf"
        ? (g.document_number ?? "").replace(/\D/g, "") || null
        : (g.document_number ?? "").trim().toUpperCase() || null,
    nationality: (g.nationality ?? "").trim().toUpperCase() || null,
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

  // ---- foto do documento ---------------------------------------------------
  // Depois de gravar as pessoas, porque o arquivo é nomeado pelo id de cada
  // uma. E fora de qualquer caminho que possa derrubar o cadastro: a foto é
  // um reforço para a portaria, e o hóspede não pode ficar sem check-in
  // porque a imagem dele falhou no upload.

  // O documento do RESPONSÁVEL entra no PDF do termo, logo abaixo. Ele é
  // sempre o primeiro da lista — `is_primary: i === 0`, alguns passos acima —,
  // então sai daqui direto, sem depender de o laço de upload ter terminado.
  // `imagemDoDataUrl` devolve null para PDF: o pdf-lib não rasteriza páginas,
  // e um PDF de documento simplesmente não aparece no termo.
  const documentoDoResponsavel = imagemDoDataUrl(guests[0]?.document_photo);

  await Promise.all(
    insertedPeople!.map(async (pessoa, i) => {
      const foto = guests[i]?.document_photo;
      if (!foto) return;

      const m = /^data:(image\/(?:jpeg|png|webp|heic)|application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/
        .exec(foto);
      if (!m) {
        console.warn(`Foto do documento ignorada (formato) — pessoa ${pessoa.id}`);
        return;
      }

      try {
        const bin = atob(m[2].replace(/\s/g, ""));
        if (bin.length > 8 * 1024 * 1024) throw new Error("arquivo grande demais");

        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const ext = m[1] === "application/pdf" ? "pdf" : m[1].split("/")[1];
        // O primeiro segmento é o property_id: é por ele que a policy do
        // storage decide quem pode ler.
        const caminho = `${property.id}/${registration.id}/${pessoa.id}.${ext}`;

        const { error: upErro } = await db.storage
          .from("documentos")
          .upload(caminho, bytes, { contentType: m[1], upsert: true });
        if (upErro) throw new Error(upErro.message);

        await db
          .from("guest_people")
          .update({ document_photo_path: caminho })
          .eq("id", pessoa.id);
      } catch (e) {
        console.error(
          `Foto do documento falhou (pessoa ${pessoa.id}):`,
          e instanceof Error ? e.message : e,
        );
      }
    }),
  );

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

  try {
    const assinado = await registrarTermo(db, {
      kind: "cadastro_hospede",
      propertyId: property.id,
      registrationId: registration.id,
      signerName: primary.full_name,
      // O documento do responsável no rodapé da assinatura: é ele que
      // transforma o traço numa identificação.
      signerDoc: rotuloDoc(guests[0]),
      assinaturaDataUrl: body.assinatura!,
      rostoDataUrl: body.selfie ?? null,
      documento: documentoDoResponsavel,
      locale,
      ip,
      userAgent: req.headers.get("user-agent"),
      detalhes: [
        ["Imóvel", property.name],
        ["Check-in", body.checkin_date!],
        ["Check-out", body.checkout_date!],
        ["Pessoas cadastradas", String(insertedPeople!.length)],
        // Cada hóspede com o documento ao lado do nome. O termo diz
        // "cadastrei todas as pessoas, com nome e documento de cada uma" —
        // um PDF que lista só os nomes não sustenta a própria cláusula.
        ...insertedPeople!.map(
          (pe, i) =>
            [
              `Hóspede ${i + 1}`,
              [pe.full_name, rotuloDoc(guests[i])].filter(Boolean).join(" — "),
            ] as [string, string],
        ),
      ],
    });
    termoId = assinado.id;
    termoPdf = assinado.pdfPath;
  } catch (e) {
    console.error("Termo assinado falhou:", e instanceof Error ? e.message : e);
  }

  // ---- link do termo para o próprio hóspede --------------------------------
  // O bucket `termos` é privado, e a policy de leitura autoriza pelo dono do
  // imóvel — o hóspede não tem conta, então nunca passaria por ela. A URL
  // assinada é gerada aqui, com o service_role, para um arquivo só.
  //
  // Seis horas: tempo de sobra para baixar na tela de conclusão, e curto o
  // bastante para não virar um link permanente de um documento com foto de
  // documento e rosto dentro. O e-mail com o PDF anexado continua sendo a
  // cópia que dura.
  let termoUrl: string | null = null;

  if (termoPdf) {
    const { data: assinado, error: erroUrl } = await db.storage
      .from("termos")
      .createSignedUrl(termoPdf, 6 * 3600, {
        download: "termo-de-responsabilidade.pdf",
      });
    if (erroUrl) console.error("Link do termo falhou:", erroUrl.message);
    termoUrl = assinado?.signedUrl ?? null;
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
    termo_url: termoUrl,
  });
});
