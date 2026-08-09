import { errors, handler, json } from "../_shared/lib/http.ts";
import { asUser, requireRole } from "../_shared/lib/db.ts";

/**
 * Painel administrativo — tudo que o dashboard precisa.
 *
 * GET ?view=overview             KPIs + funil de ativação + saúde do sistema
 * GET ?view=subscribers&...      lista de assinantes (busca, filtro, paginação)
 * GET ?view=subscriber&id=...    ficha completa de um assinante
 * GET ?view=timeseries&days=30   série diária para os gráficos
 *
 * Autorização em duas camadas: requireRole('admin') aqui, e assert_admin()
 * dentro de cada função SQL. A segunda é a que importa — sem ela, um
 * SECURITY DEFINER furaria a RLS para qualquer usuário logado.
 *
 * Por isso as chamadas usam o JWT do admin (asUser), não a service_role.
 */

export default handler(async (req) => {
  await requireRole(req, "admin");

  const authHeader = req.headers.get("Authorization")!;
  const db = asUser(authHeader);

  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "overview";

  switch (view) {
    case "overview": {
      const [kpis, funnel, health] = await Promise.all([
        db.rpc("admin_kpis"),
        db.rpc("admin_activation_funnel"),
        db.rpc("admin_system_health"),
      ]);

      for (const r of [kpis, funnel, health]) {
        if (r.error) throw errors.upstream(r.error.message);
      }

      return json({
        ok: true,
        kpis: kpis.data,
        activation_funnel: funnel.data,
        system_health: health.data,
        generated_at: new Date().toISOString(),
      });
    }

    case "subscribers": {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

      const { data, error } = await db.rpc("admin_subscribers", {
        _search: url.searchParams.get("q"),
        _status: url.searchParams.get("status"),
        _plan: url.searchParams.get("plan"),
        _stuck_only: url.searchParams.get("stuck") === "true",
        _order_by: url.searchParams.get("order") ?? "created_at",
        _limit: limit,
        _offset: offset,
      });

      if (error) throw errors.upstream(error.message);

      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

      return json({
        ok: true,
        subscribers: rows.map(({ total_count: _t, ...rest }) => rest),
        pagination: { total, limit, offset, has_more: offset + rows.length < total },
      });
    }

    case "subscriber": {
      const id = url.searchParams.get("id");
      if (!id) throw errors.invalid("Informe ?id=<owner_id>");

      const { data, error } = await db.rpc("admin_subscriber_detail", { _owner_id: id });
      if (error) throw errors.upstream(error.message);
      if (!data) throw errors.notFound("Assinante não encontrado");

      return json({ ok: true, subscriber: data });
    }

    case "timeseries": {
      const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 365);
      const { data, error } = await db.rpc("admin_timeseries", { _days: days });
      if (error) throw errors.upstream(error.message);
      return json({ ok: true, days, series: data });
    }

    default:
      throw errors.invalid(
        "view inválida. Use: overview | subscribers | subscriber | timeseries",
      );
  }
});
