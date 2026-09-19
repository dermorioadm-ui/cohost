import { test, expect } from "@playwright/test";

const USER = "11111111-1111-4111-8111-111111111111";
const offer = { id: "legal-annual", version: 1, title: "Assistência jurídica anual", annual_price_cents: 116400, currency: "brl", term_months: 12, scope_text: "Orientação sobre conflitos na locação e análise documental conforme contrato de teste.", property_scope_text: "Um imóvel de teste", service_terms: "Atendimento pela área jurídica, conforme os termos de teste.", payment_terms: "Pagamento integral por 12 meses, sem renovação automática.", terms_url: "https://terms.example.test/juridico" };
const entitlement = { id: "entitlement-test", status: "active", starts_at: "2026-01-01T12:00:00Z", ends_at: "2099-01-01T12:00:00Z", offer_snapshot: offer };
const initialRequest = { id: "request-test", subject: "Conflito na locação de teste", description: "Preciso de orientação sobre a devolução de um imóvel de temporada de teste.", status: "received", public_reply: "", created_at: "2026-09-19T12:00:00Z", updated_at: "2026-09-19T12:00:00Z", user_id: USER, email: "host@example.test", messages: [] };

async function setup(page, options = {}) {
  const state = { role: null, available: true, hasAccess: false, software: "canceled", requests: [], payment: "pending", publicPayment: "pending", overviewError: false, ...options };
  const calls = [];
  await page.context().addInitScript(({ role, userId }) => {
    // Acelera somente a espera de reconciliação; respostas continuam assíncronas.
    const original = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => original(fn, delay === 3000 ? 15 : delay, ...args);
    if (!role) return;
    const user = { id: userId, email: "host@example.test", aud: "authenticated", role: "authenticated", app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
    const token = `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${btoa(JSON.stringify({ sub: userId, exp: 4102444800, role: "authenticated" }))}.local-test`;
    localStorage.setItem("sb-127-auth-token", JSON.stringify({ access_token: token, refresh_token: "local-test", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user }));
    localStorage.setItem("hospedepay.papel-ativo", role);
  }, { role: state.role, userId: USER });
  await page.context().route("**/*", async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.hostname === "127.0.0.1" && url.port === "5173") return route.continue();
    // Nenhuma chamada destes testes sai para Supabase/Stripe de produção.
    if (url.hostname === "checkout.stripe.com") return route.fulfill({ contentType: "text/html", body: "<h1>Checkout simulado</h1>" });
    if (url.hostname !== "127.0.0.1" || url.port !== "54321") return route.fulfill({ status: 204 });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    let body; try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ path: url.pathname, body });
    let data = null; let status = 200;
    const method = url.pathname.split("/").pop();
    switch (method) {
      case "user_roles": data = state.role ? [{ role: state.role }] : []; break;
      case "profiles": data = [{ subscription_status: state.software }]; break;
      case "plans": data = [{ tier: "essencial", name: "Essencial", monthly_cents: 9700, annual_cents: 97000, max_properties: 1, active: true }]; break;
      case "landing_config": data = {}; break;
      case "legal_offer": data = { available: state.available, offer: state.available ? offer : null }; break;
      case "legal_overview":
        if (state.overviewError) { status = 500; data = { message: "test failure" }; break; }
        data = { has_access: state.hasAccess, entitlements: state.hasAccess ? [entitlement] : state.expired ? [{ ...entitlement, ends_at: "2020-01-01T12:00:00Z" }] : [], requests: state.requests, orders: [] }; break;
      case "legal-checkout": data = { ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_local", session_id: "cs_test_local" }; break;
      case "legal-checkout-status":
        if (state.payment === "active") state.hasAccess = true;
        data = { ok: true, state: state.payment }; break;
      case "billing-checkout-complete": data = state.publicPayment === "active" ? { ok: true, estado: "ativo", requires_login: true, email: "host@example.test" } : { ok: false, estado: "pendente" }; break;
      case "legal_create_request": {
        const existing = state.requests.find((r) => r.key === body._request_key);
        if (!existing) state.requests.push({ ...initialRequest, id: crypto.randomUUID(), subject: body._subject, description: body._description, key: body._request_key });
        data = existing ?? state.requests.at(-1); break;
      }
      case "legal_reply_request": {
        const item = state.requests.find((r) => r.id === body._id);
        item.messages.push({ id: crypto.randomUUID(), author_role: "owner", message: body._message, created_at: "2026-09-19T13:00:00Z" }); item.status = "received"; data = item; break;
      }
      case "admin_legal_requests": data = state.requests; break;
      case "admin_legal_payment_reviews": data = []; break;
      case "admin_legal_update_request": {
        const item = state.requests.find((r) => r.id === body._id);
        item.status = body._status; item.public_reply = body._public_reply;
        if (body._public_reply) item.messages.push({ id: crypto.randomUUID(), author_role: "admin", message: body._public_reply, created_at: "2026-09-19T13:00:00Z" }); data = item; break;
      }
      case "user": data = { id: USER, email: "host@example.test" }; break;
      default: throw new Error(`Unexpected local API call: ${method}`);
    }
    return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(data) });
  });
  return { state, calls };
}

test("página: oferta indisponível sem preço ou cobrança; legível no celular", async ({ page }, testInfo) => {
  await setup(page, { available: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pagina");
  const section = page.locator("#assistencia-juridica");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("Contratação ainda não disponível.");
  await expect(section).not.toContainText("R$");
  await expect(section.getByRole("link")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await section.screenshot({ path: testInfo.outputPath("juridico-mobile.png") });
  expect(await page.locator("video").evaluateAll((videos) => videos.every((v) => v.paused))).toBe(true);
});

test("página: anual real após garantia e antes do contato", async ({ page }, testInfo) => {
  await setup(page); await page.goto("/pagina");
  const section = page.locator("#assistencia-juridica");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("1.164");
  await expect(section).toContainText("A contratação é anual.");
  expect(await page.evaluate(() => !!(document.querySelector("#garantia").compareDocumentPosition(document.querySelector("#assistencia-juridica")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await section.screenshot({ path: testInfo.outputPath("juridico-desktop.png") });
  await section.getByRole("link", { name: "Ver condições e contratar" }).click();
  await expect(page.getByRole("link", { name: "Entrar para contratar" })).toBeVisible();
});

test("pagamento exige termos e usa oferta/version do servidor", async ({ page }) => {
  const { calls } = await setup(page, { role: "owner" }); await page.goto("/juridico");
  const buy = page.getByRole("button", { name: "Contratar assistência anual" });
  await expect(buy).toBeDisabled(); await page.getByRole("checkbox").check(); await buy.click();
  await expect(page.getByRole("heading", { name: "Checkout simulado" })).toBeVisible();
  const call = calls.find((r) => r.path.endsWith("/legal-checkout"));
  expect(call.body).toMatchObject({ offer_id: offer.id, offer_version: offer.version, accepted_terms: true });
  expect(call.body).not.toHaveProperty("amount");
});

test("SaaS cancelado mantém atendimento jurídico, resposta e histórico ao recarregar", async ({ page }, testInfo) => {
  const { state } = await setup(page, { role: "owner", hasAccess: true, software: "canceled" }); await page.goto("/juridico");
  await expect(page.getByText("Assistência vigente", { exact: true })).toBeVisible();
  await page.getByLabel("Assunto", { exact: true }).fill("Contrato da reserva de teste");
  await page.getByLabel("O que você precisa resolver?").fill("Quero orientação sobre uma divergência no contrato da reserva de teste.");
  await page.getByRole("button", { name: "Enviar atendimento", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Contrato da reserva de teste" })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  await page.getByLabel("Complementar este atendimento").fill("O hóspede enviou uma informação adicional.");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await page.reload();
  await expect(page.getByText("O hóspede enviou uma informação adicional.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("area-juridica.png"), fullPage: true });
});

test("jurídico vencido preserva histórico e não permite novo pedido", async ({ page }) => {
  await setup(page, { role: "owner", expired: true, requests: [{ ...initialRequest, messages: [] }] }); await page.goto("/juridico");
  await expect(page.getByRole("heading", { name: "Sem assistência vigente" })).toBeVisible();
  await expect(page.getByRole("heading", { name: initialRequest.subject })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar atendimento" })).toHaveCount(0);
});

test("retorno jurídico pendente não libera acesso por timeout; pode reconsultar", async ({ page }) => {
  const { state, calls } = await setup(page, { role: "owner", payment: "pending", software: "active" }); await page.goto("/juridico?session=cs_test_local");
  await expect(page.getByRole("heading", { name: "A confirmação ainda não chegou" })).toBeVisible();
  expect(calls.filter((c) => c.path.endsWith("legal-checkout-status"))).toHaveLength(20);
  await expect(page.getByRole("heading", { name: "Abrir atendimento" })).toHaveCount(0);
  state.payment = "active"; await page.getByRole("button", { name: "Verificar novamente" }).click();
  await expect(page.getByRole("heading", { name: "Pagamento confirmado" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Configurar meu imóvel" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Abrir atendimento" })).toBeVisible();
});

test("retorno público pago pede autenticação e pendente nunca vira ativo", async ({ page }) => {
  const { state } = await setup(page); await page.goto("/assinatura?status=ok&session=cs_test_local");
  await expect(page.getByRole("heading", { name: "Ainda não foi possível confirmar." })).toBeVisible();
  await expect(page.getByText("Assinatura ativa.", { exact: true })).toHaveCount(0);
  state.publicPayment = "active"; await page.getByRole("button", { name: "Verificar novamente" }).click();
  await expect(page.getByRole("heading", { name: "Confirme seu acesso." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configurar meu imóvel" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Criar ou recuperar minha senha" })).toBeVisible();
});

test("upsell confirmado é dispensável e não interrompe configuração", async ({ page }) => {
  await setup(page, { role: "owner", software: "active" }); await page.goto("/assinatura?status=ok");
  await expect(page.getByRole("button", { name: "Configurar meu imóvel" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Assistência jurídica opcional" })).toBeVisible();
  await page.getByRole("button", { name: "Agora não", exact: true }).click();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Configurar meu imóvel" })).toBeVisible();
});

test("admin responde no pedido e atualização permanece no histórico", async ({ page }) => {
  const { state } = await setup(page, { role: "admin", requests: [{ ...initialRequest, messages: [] }] }); await page.goto("/admin/juridico");
  await page.getByLabel("Situação do atendimento").selectOption("waiting_customer");
  await page.getByLabel("Nova resposta ao cliente").fill("Envie a informação complementar para analisarmos o contrato.");
  await page.getByRole("button", { name: "Salvar atendimento" }).click();
  await expect(page.getByText("Atualizado. A resposta fica disponível na área do cliente.")).toBeVisible();
  expect(state.requests[0].status).toBe("waiting_customer");
  await page.reload();
  await expect(page.getByText("Envie a informação complementar para analisarmos o contrato.", { exact: true })).toBeVisible();
});

test("falha na consulta do acesso não oferece outra cobrança", async ({ page }) => {
  await setup(page, { role: "owner", overviewError: true }); await page.goto("/juridico");
  await expect(page.getByText("Não foi possível consultar seu acesso.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Contratar assistência anual" })).toHaveCount(0);
});
