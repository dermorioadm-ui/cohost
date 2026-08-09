import { errors, handler, json, readJson } from "../_shared/lib/http.ts";
import { admin, requireRole } from "../_shared/lib/db.ts";

/**
 * Gestão de usuários pelo admin.
 *
 * Toda ação grava em audit_log com o id do admin que executou. Isso não é
 * burocracia: quando alguém com acesso total mexe na conta de um cliente
 * pagante, precisa existir registro de quem foi e quando.
 *
 * Ações destrutivas (apagar usuário) exigem confirmação explícita no corpo.
 */

interface Body {
  action?: "set_role" | "set_plan" | "grant_days" | "add_note" | "delete";
  user_id?: string;
  role?: "owner" | "cleaner" | "admin";
  plan?: "essencial" | "pro" | "ilimitado";
  days?: number;
  note?: string;
  confirm?: string;
}

export default handler(async (req) => {
  if (req.method !== "POST") throw errors.invalid("Use POST");

  const actor = await requireRole(req, "admin");
  const body = await readJson<Body>(req);
  const db = admin();

  if (!body.user_id) throw errors.invalid("user_id é obrigatório");

  const { data: target } = await db
    .from("profiles")
    .select("user_id, email, full_name, plan, subscription_status, trial_ends_at")
    .eq("user_id", body.user_id)
    .maybeSingle();

  if (!target) throw errors.notFound("Usuário não encontrado");

  const audit = async (action: string, metadata: Record<string, unknown>) => {
    await db.from("audit_log").insert({
      actor_id: actor.id,
      actor_role: "admin",
      action,
      entity: "profiles",
      entity_id: body.user_id!,
      metadata: { target_email: target.email, ...metadata },
    });
  };

  switch (body.action) {
    case "set_role": {
      if (!body.role) throw errors.invalid("Informe o papel");

      // Promover a admin dá acesso a todos os dados de todos os clientes.
      // Exige confirmação digitada, para não acontecer por clique errado.
      if (body.role === "admin" && body.confirm !== target.email) {
        throw errors.invalid(
          "Para promover a admin, envie confirm com o e-mail exato do usuário.",
        );
      }

      const { error } = await db
        .from("user_roles")
        .upsert({ user_id: body.user_id, role: body.role }, { onConflict: "user_id,role" });
      if (error) throw errors.upstream(error.message);

      await audit("admin.role_granted", { role: body.role });
      return json({ ok: true, action: "set_role", role: body.role });
    }

    case "set_plan": {
      if (!body.plan) throw errors.invalid("Informe o plano");
      const { error } = await db
        .from("profiles")
        .update({ plan: body.plan })
        .eq("user_id", body.user_id);
      if (error) throw errors.upstream(error.message);

      await audit("admin.plan_changed", { from: target.plan, to: body.plan });
      return json({ ok: true, action: "set_plan", plan: body.plan });
    }

    case "grant_days": {
      const days = Number(body.days ?? 0);
      if (!Number.isFinite(days) || days <= 0 || days > 365) {
        throw errors.invalid("days deve estar entre 1 e 365");
      }

      // Estende a partir do maior entre agora e o fim atual, para conceder
      // dias não encurtar um trial que ainda está correndo.
      const base = target.trial_ends_at && new Date(target.trial_ends_at) > new Date()
        ? new Date(target.trial_ends_at)
        : new Date();
      const newEnd = new Date(base.getTime() + days * 86400_000).toISOString();

      const { error } = await db
        .from("profiles")
        .update({ subscription_status: "trialing", trial_ends_at: newEnd })
        .eq("user_id", body.user_id);
      if (error) throw errors.upstream(error.message);

      await audit("admin.days_granted", { days, new_trial_end: newEnd });
      return json({ ok: true, action: "grant_days", days, trial_ends_at: newEnd });
    }

    case "add_note": {
      const note = (body.note ?? "").trim();
      if (!note) throw errors.invalid("Nota vazia");
      const stamped = `[${new Date().toISOString().slice(0, 10)}] ${note}`;
      const { error } = await db
        .from("profiles")
        .update({ notes: stamped })
        .eq("user_id", body.user_id);
      if (error) throw errors.upstream(error.message);

      await audit("admin.note_added", { note: stamped });
      return json({ ok: true, action: "add_note" });
    }

    case "delete": {
      if (body.confirm !== target.email) {
        throw errors.invalid(
          "Para apagar, envie confirm com o e-mail exato do usuário. " +
            "Isto remove imóveis, reservas, limpezas e conversas em cascata.",
        );
      }
      if (body.user_id === actor.id) {
        throw errors.invalid("Você não pode apagar a própria conta por aqui.");
      }

      // Auditoria ANTES de apagar — depois o e-mail não existe mais.
      await audit("admin.user_deleted", {
        plan: target.plan,
        status: target.subscription_status,
      });

      const { error } = await db.auth.admin.deleteUser(body.user_id);
      if (error) throw errors.upstream(`Falha ao apagar usuário: ${error.message}`);

      return json({ ok: true, action: "delete" });
    }

    default:
      throw errors.invalid(
        "action inválida. Use: set_role | set_plan | grant_days | add_note | delete",
      );
  }
});
