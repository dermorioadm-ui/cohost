import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";
import { env } from "../_shared/lib/env.ts";

/**
 * Entrada única para criar/atualizar um imóvel.
 *
 * Existe para o funil de configuração conversacional: o bot do WhatsApp
 * coleta os dados aos poucos e chama este endpoint a cada passo, com um
 * `property_id` para continuar de onde parou. Enquanto o funil não existir,
 * o mesmo endpoint atende o formulário do app e a operação manual em lote.
 *
 * Toda escrita é validada contra o limite do plano (gatilho no banco) e
 * devolve o estado de ativação — o que ainda falta preencher.
 */

interface AiConfig {
  address?: string;
  access?: string;
  lock?: string;
  wifi?: string;
  appliances?: string;
  rules?: string;
  parking?: string;
  amenities?: string;
  checkout?: string;
  emergency?: string;
  extra?: string;
}

interface Body {
  property_id?: string;
  name?: string;
  property_type?: string;
  address?: string;
  street_number?: string;
  apt_number?: string;
  block?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  condo_name?: string;
  condo_email?: string;
  condo_notify?: boolean;
  checkin_time?: string;
  checkout_time?: string;
  turnover_price?: number;
  self_clean?: boolean;
  cleaner_id?: string | null;
  ai_config?: AiConfig;
  ai_enabled?: boolean;
  auto_message_confirmed?: boolean;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const user = await requireRole(req, "owner");
  const body = await readJson<Body>(req);
  const db = admin();

  if (body.checkin_time && !TIME_RE.test(body.checkin_time)) {
    throw errors.invalid("Horário de check-in inválido (use HH:MM)");
  }
  if (body.checkout_time && !TIME_RE.test(body.checkout_time)) {
    throw errors.invalid("Horário de check-out inválido (use HH:MM)");
  }
  if (body.turnover_price !== undefined && body.turnover_price < 0) {
    throw errors.invalid("O valor da diária não pode ser negativo");
  }
  if (body.condo_email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.condo_email)) {
    throw errors.invalid("E-mail da portaria inválido");
  }

  // Só a diarista já vinculada a este dono pode ser atribuída.
  if (body.cleaner_id) {
    const { data: conn } = await db
      .from("connections")
      .select("id")
      .eq("owner_id", user.id)
      .eq("cleaner_id", body.cleaner_id)
      .eq("active", true)
      .maybeSingle();
    if (!conn) throw errors.invalid("Essa diarista ainda não aceitou seu convite");
  }

  const patch: Record<string, unknown> = {};
  const assign = (key: string, value: unknown) => {
    if (value !== undefined) patch[key] = value;
  };

  assign("name", body.name?.trim());
  assign("property_type", body.property_type);
  assign("address", body.address?.trim());
  assign("street_number", body.street_number);
  assign("apt_number", body.apt_number);
  assign("block", body.block);
  assign("neighborhood", body.neighborhood);
  assign("city", body.city);
  assign("state", body.state);
  assign("zip_code", body.zip_code);
  assign("condo_name", body.condo_name);
  assign("condo_email", body.condo_email);
  assign("condo_notify", body.condo_notify);
  assign("checkin_time", body.checkin_time);
  assign("checkout_time", body.checkout_time);
  assign("turnover_price", body.turnover_price);
  assign("self_clean", body.self_clean);
  assign("cleaner_id", body.cleaner_id);
  assign("ai_enabled", body.ai_enabled);

  if (body.auto_message_confirmed !== undefined) {
    patch.auto_message_confirmed_at = body.auto_message_confirmed
      ? new Date().toISOString()
      : null;
  }

  let propertyId = body.property_id;

  if (propertyId) {
    const { data: owned } = await db
      .from("properties")
      .select("id, ai_config")
      .eq("id", propertyId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (!owned) throw errors.notFound("Imóvel não encontrado");

    // ai_config é preenchido aos poucos pelo funil — mescla, não substitui.
    if (body.ai_config) {
      patch.ai_config = { ...(owned.ai_config as object ?? {}), ...body.ai_config };
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await db.from("properties").update(patch).eq("id", propertyId);
      if (error) throw errors.upstream(`Falha ao atualizar: ${error.message}`);
    }
  } else {
    if (!patch.name) throw errors.invalid("Informe o nome do imóvel");
    if (body.ai_config) patch.ai_config = body.ai_config;
    patch.owner_id = user.id;

    const { data: created, error } = await db
      .from("properties")
      .insert(patch)
      .select("id")
      .single();

    if (error) {
      if (error.message.includes("limite_do_plano_atingido")) {
        throw errors.forbidden(
          "Você atingiu o limite de imóveis do seu plano. Faça upgrade para adicionar mais.",
        );
      }
      throw errors.upstream(`Falha ao criar imóvel: ${error.message}`);
    }
    propertyId = created.id;
  }

  const { data: property } = await db
    .from("properties")
    .select("id, name, public_slug")
    .eq("id", propertyId!)
    .single();

  // my_activation() se apoia em auth.uid(), que é nulo no cliente service_role.
  // Aqui lemos a view direto, filtrando pelo imóvel que acabou de ser gravado.
  const { data: state } = await db
    .from("property_activation")
    .select("*")
    .eq("property_id", propertyId!)
    .maybeSingle();

  return json({
    ok: true,
    property: {
      id: property!.id,
      name: property!.name,
      chat_url: `${env.appBaseUrl()}/c/${property!.public_slug}`,
    },
    activation: state,
    next_step: state?.blocked_at ?? "ativo",
  });
});
