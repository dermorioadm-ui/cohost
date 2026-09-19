import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const migration = await readFile(
  new URL(
    "../supabase/migrations/0062_assistencia_juridica.sql",
    import.meta.url,
  ),
  "utf8",
);
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const admin = "33333333-3333-4333-8333-333333333333";
const requestKey = "44444444-4444-4444-8444-444444444444";
// Local Postgres WASM engine, actual migration/functions/RLS; auth.uid and
// pre-existing identity tables are fixtures, not a running Supabase Auth.
async function setup() {
  const db = new PGlite();
  await db.exec(`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 GRANT USAGE ON SCHEMA auth TO authenticated,service_role;
 CREATE TABLE public.user_roles(user_id uuid,role text);
 CREATE TABLE public.profiles(user_id uuid,email text,full_name text,subscription_status text);
 GRANT ALL ON public.profiles TO service_role;
 CREATE TABLE public.audit_log(actor_id uuid,actor_role text,action text,entity text,entity_id text,metadata jsonb);
 CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='admin') $$;
 CREATE FUNCTION public.assert_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF auth.uid() IS NULL OR NOT is_admin() THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF; END $$;
 INSERT INTO auth.users VALUES('${owner}'),('${other}'),('${admin}');
 INSERT INTO public.user_roles VALUES('${owner}','owner'),('${other}','owner'),('${admin}','admin');
 INSERT INTO public.profiles VALUES('${owner}','owner@example.test','Owner','expired'),('${other}','other@example.test','Other','active');
 `);
  await db.exec(migration);
  return db;
}
async function user(db, id, role = "authenticated") {
  await db.exec(
    `RESET ROLE; SET ROLE ${role}; SET request.jwt.claim.sub='${id ?? ""}';`,
  );
}
async function configure(db) {
  await db.exec(
    `RESET ROLE; UPDATE legal_offers SET enabled=true,operations_ready=true,annual_price_cents=116400,stripe_price_id='price_testLegal',scope_text='Escopo de teste, não oferta comercial',property_scope_text='Escopo de imóveis de teste',service_terms='Condições exclusivamente de teste',payment_terms='Pagamento integral anual',terms_url='https://example.test/terms',coordinator_user_id='${admin}';`,
  );
}
async function reserve(db) {
  await user(db, null, "service_role");
  return (
    await db.query(
      `SELECT legal_reserve_order($1,'legal-annual',2,$2) AS result`,
      [owner, requestKey],
    )
  ).rows[0].result;
}
async function paid(db, o, key = "evt_paid") {
  await user(db, null, "service_role");
  await db.query(
    `UPDATE legal_orders SET stripe_session_id='cs_test_legal' WHERE id=$1`,
    [o.id],
  );
  return (
    await db.query(
      `SELECT legal_apply_payment($1,'cs_test_legal','pi_legal',$2,'paid',now()-interval '1 minute') AS result`,
      [o.id, key],
    )
  ).rows[0].result;
}

test("offer starts closed, requires complete operational configuration, reservation deduplicates", async () => {
  const db = await setup();
  try {
    assert.deepEqual(
      (await db.query("SELECT legal_offer() AS result")).rows[0].result,
      { available: false, offer: null },
    );
    await user(db, null, "service_role");
    await assert.rejects(reserve(db), /legal_offer_unavailable/);
    await configure(db);
    const a = await reserve(db);
    const b = await reserve(db);
    assert.equal(a.id, b.id);
    await user(db, null, "service_role");
    const c = (
      await db.query(
        `SELECT legal_reserve_order($1,'legal-annual',2,$2) AS result`,
        [owner, crypto.randomUUID()],
      )
    ).rows[0].result;
    assert.equal(c.id, a.id);
    await user(db, owner);
    await assert.rejects(
      db.query(`SELECT legal_reserve_order($1,'legal-annual',2,$2)`, [
        other,
        requestKey,
      ]),
      /permission denied/,
    );
    await assert.rejects(
      db.query(
        `INSERT INTO legal_entitlements(user_id,order_id,starts_at,ends_at,offer_snapshot) VALUES($1,$2,now(),now()+interval '1 year','{}')`,
        [owner, a.id],
      ),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});

test("payment transaction is idempotent, validates session, ignores stale failures, independent of SaaS", async () => {
  const db = await setup();
  try {
    await configure(db);
    const o = await reserve(db);
    const first = await paid(db, o);
    const second = await paid(db, o);
    assert.equal(first.state, "active");
    assert.equal(first.entitlement.id, second.entitlement.id);
    assert.equal(first.entitlement.ends_at, second.entitlement.ends_at);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM legal_entitlements"))
        .rows[0].n,
      1,
    );
    await db.query(
      `SELECT legal_apply_payment($1,'cs_test_legal',null,'evt_old_failure','failed',null)`,
      [o.id],
    );
    assert.equal(
      (await db.query("SELECT status FROM legal_orders")).rows[0].status,
      "paid",
    );
    await assert.rejects(
      db.query(
        `SELECT legal_apply_payment($1,'cs_test_wrong','pi_wrong','evt_wrong','paid',now())`,
        [o.id],
      ),
      /legal_session_mismatch/,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM legal_payment_events WHERE event_key='evt_wrong'",
        )
      ).rows[0].n,
      0,
    );
    await user(db, owner);
    const overview = (await db.query("SELECT legal_overview() AS result"))
      .rows[0].result;
    assert.equal(overview.has_access, true);
    await user(db, null, "service_role");
    await assert.rejects(reserve(db), /legal_already_active/);
    await db.exec("UPDATE profiles SET subscription_status='canceled'");
    await user(db, owner);
    assert.equal(
      (await db.query("SELECT legal_overview() AS result")).rows[0].result
        .has_access,
      true,
    );
    await user(db, null, "service_role");
    await db.exec("UPDATE legal_entitlements SET status='revoked'");
    assert.equal(
      (
        await db.query(
          `SELECT subscription_status FROM profiles WHERE user_id='${owner}'`,
        )
      ).rows[0].subscription_status,
      "canceled",
    );
  } finally {
    await db.close();
  }
});

test("request authorization, client isolation, admin replies and expiry/history", async () => {
  const db = await setup();
  try {
    await configure(db);
    const o = await reserve(db);
    await paid(db, o);
    await user(db, other);
    await assert.rejects(
      db.query(
        `SELECT legal_create_request('Consulta teste','Descrição longa o suficiente para a consulta',$1)`,
        [requestKey],
      ),
      /legal_access_required/,
    );
    await user(db, owner);
    const r = (
      await db.query(
        `SELECT legal_create_request('Consulta teste','Descrição longa o suficiente para a consulta',$1) AS result`,
        [requestKey],
      )
    ).rows[0].result;
    const duplicate = (
      await db.query(
        `SELECT legal_create_request('Consulta teste','Descrição longa o suficiente para a consulta',$1) AS result`,
        [requestKey],
      )
    ).rows[0].result;
    assert.equal(r.id, duplicate.id);
    await user(db, other);
    assert.equal(
      (await db.query("SELECT * FROM legal_requests")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT legal_overview() AS result")).rows[0].result
        .requests.length,
      0,
    );
    await assert.rejects(
      db.query("SELECT admin_legal_requests()"),
      /admin_required/,
    );
    await assert.rejects(
      db.query(`SELECT legal_reply_request($1,'Mensagem invasora',$2)`, [
        r.id,
        crypto.randomUUID(),
      ]),
      /not_found/,
    );
    await user(db, admin);
    assert.equal(
      (await db.query("SELECT admin_legal_requests() AS result")).rows[0].result
        .length,
      1,
    );
    await db.query(
      `SELECT admin_legal_update_request($1,'waiting_customer','Por favor, descreva o ocorrido.')`,
      [r.id],
    );
    await user(db, owner);
    const replyKey = crypto.randomUUID();
    await db.query(
      `SELECT legal_reply_request($1,'Complemento da situação solicitada.',$2)`,
      [r.id, replyKey],
    );
    await db.query(
      `SELECT legal_reply_request($1,'Complemento da situação solicitada.',$2)`,
      [r.id, replyKey],
    );
    let overview = (await db.query("SELECT legal_overview() AS result")).rows[0]
      .result;
    assert.equal(overview.requests[0].messages.length, 2);
    assert.equal(overview.requests[0].status, "received");
    await user(db, null, "service_role");
    await db.exec(
      "UPDATE legal_entitlements SET starts_at=now()-interval '2 years',ends_at=now()-interval '1 day'",
    );
    await user(db, owner);
    overview = (await db.query("SELECT legal_overview() AS result")).rows[0]
      .result;
    assert.equal(overview.has_access, false);
    assert.equal(overview.requests.length, 1);
    await assert.rejects(
      db.query(
        `SELECT legal_create_request('Outra consulta','Descrição longa o suficiente para a consulta',$1)`,
        [crypto.randomUUID()],
      ),
      /legal_access_required/,
    );
    await user(db, null, "anon");
    await assert.rejects(
      db.query("SELECT legal_overview()"),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});

test("cancelled SaaS blocks operational writes in SQL but leaves legal service usable", async () => {
  const db = await setup();
  try {
    await db.exec(`CREATE FUNCTION public.has_role(_user uuid,_role text) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=_user AND role=_role) $$;
 CREATE FUNCTION public.subscription_is_active(_user uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM profiles WHERE user_id=_user AND subscription_status IN ('active','past_due')) $$;`);
    for (const table of [
      "properties",
      "property_ical_sources",
      "cleaner_invites",
      "connections",
      "cleaning_tasks",
      "porter_accounts",
    ])
      await db.exec(
        `CREATE TABLE ${table}(id uuid PRIMARY KEY DEFAULT gen_random_uuid()); GRANT ALL ON ${table} TO authenticated;`,
      );
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/0063_bloqueia_operacoes_sem_software.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await configure(db);
    const o = await reserve(db);
    await paid(db, o);
    await user(db, owner);
    await assert.rejects(
      db.exec("INSERT INTO properties DEFAULT VALUES"),
      /software_subscription_required/,
    );
    assert.equal(
      (await db.query("SELECT legal_overview() AS result")).rows[0].result
        .has_access,
      true,
    );
    await db.query(
      `SELECT legal_create_request('Consulta após cancelamento','Descrição jurídica após sair da ferramenta',$1)`,
      [requestKey],
    );
    await user(db, other);
    await db.exec("INSERT INTO properties DEFAULT VALUES");
  } finally {
    await db.close();
  }
});

test("refund review received before delayed paid event cannot create new access", async () => {
  const db = await setup();
  try {
    await configure(db);
    const o = await reserve(db);
    await db.query(
      `UPDATE legal_orders SET stripe_session_id='cs_test_legal' WHERE id=$1`,
      [o.id],
    );
    await db.query(
      `SELECT legal_apply_payment($1,'cs_test_legal','pi_legal','evt_refund','payment_review',null)`,
      [o.id],
    );
    const result = await paid(db, o, "evt_old_paid");
    assert.equal(result.state, "failed");
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM legal_entitlements"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("SELECT status FROM legal_orders")).rows[0].status,
      "payment_review",
    );
  } finally {
    await db.close();
  }
});
