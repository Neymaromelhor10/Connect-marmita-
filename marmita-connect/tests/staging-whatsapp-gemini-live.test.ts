import { createHmac, randomUUID } from "node:crypto";
import assert from "node:assert";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Route as MetaWebhookRoute } from "@/routes/api/public/whatsapp/meta-webhook";
import { Route as DrainQueueRoute } from "@/routes/api/internal/whatsapp/drain-queue";
import { classifyWithPersistence, type FinancialCommit } from "@/lib/financial-persistence";
import type { FinancialContext } from "@/lib/financial-command";
import { assertIsolatedNonProductionCleanupAllowed } from "@/lib/operational-alerts.server";

export { assertIsolatedNonProductionCleanupAllowed };

/**
 * Suíte de Integração Real WhatsApp + Gemini 2.5 Flash (Executada via Vitest no Passo 7 da Homologação):
 *   - Aciona apenas quando RUN_LIVE_HOMOLOGATION="1" (para não rodar durante os testes unitários offline).
 *   - Quando RUN_LIVE_HOMOLOGATION="1", FALHA IMEDIATAMENTE (exit code != 0) se qualquer segredo
 *     obrigatório (STAGING_DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY,
 *     WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, CRON_SECRET) estiver ausente ou inválido.
 *   - Exercita os handlers HTTP reais da aplicação:
 *       1. POST /api/public/whatsapp/meta-webhook (assinado com HMAC-SHA256)
 *       2. Persistência durável (status = 'aguardando') ANTES/no retorno do HTTP 200
 *       3. POST /api/internal/whatsapp/drain-queue (autenticado com Bearer CRON_SECRET)
 *       4. Chamada real à API Gemini 2.5 Flash via callGeminiExtractOrder
 *       5. Criação de pedido pelo fluxo real da aplicação com cálculo exclusivo no PostgreSQL
 *       6. Comando OK pelo avaliador e RPC real (classifyWithPersistence + financial_classify_order)
 *       7. Comando OKK via webhook assinado smb_message_echoes (processVerifiedBusinessEcho)
 *       8. Reenvio de mensagem duplicada sem criar segundo pedido
 *       9. Mensagem sem quantidade encaminhada para revisão ('revisar') pela IA + worker
 *      10. Isolamento estrito entre Empresa A e Empresa B
 */

const runLive = process.env["RUN_LIVE_HOMOLOGATION"] === "1";

(runLive ? describe : describe.skip)("Integração Real WhatsApp Webhook + Worker + Gemini 2.5 Flash + Classificação OK/OKK", () => {
  const stagingDbUrl = process.env["STAGING_DATABASE_URL"]?.trim() ?? "";
  const supabaseUrl = (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"] || "").trim();
  const serviceRoleKey = (process.env["SUPABASE_SERVICE_ROLE_KEY"] || "").trim();
  const geminiKey = (process.env["GEMINI_API_KEY"] || "").trim();
  const appSecret = (process.env["WHATSAPP_APP_SECRET"] || "").trim();
  const verifyToken = (process.env["WHATSAPP_VERIFY_TOKEN"] || "").trim();
  const cronSecret = (process.env["CRON_SECRET"] || "").trim();

  let sql: any;
  const compA = randomUUID();
  const compB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const custA = randomUUID();
  const custB = randomUUID();
  const phoneIdA = "999000111222";
  const wabaIdA = "888000111222";
  const msgUid1 = `wamid.homolog.${randomUUID()}`;
  const msgUid2 = `wamid.homolog.${randomUUID()}`;
  const msgUidAmbig = `wamid.homolog.${randomUUID()}`;
  const echoUidOkk = `wamid.echo.${randomUUID()}`;

  function signPayload(raw: string, secret: string) {
    return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  }

  async function asAuthenticated<T>(uid: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return sql.begin(async (tx: any) => {
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claim.sub', ${uid}, true)`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    // Verifica que todas as credenciais obrigatórias de homologação estão presentes (nunca pula silenciosamente)
    const missing: string[] = [];
    if (!stagingDbUrl) missing.push("STAGING_DATABASE_URL");
    if (!supabaseUrl || supabaseUrl.includes("placeholder")) missing.push("SUPABASE_URL (real de homologação)");
    if (!serviceRoleKey || serviceRoleKey === "staging-service-role-key") missing.push("SUPABASE_SERVICE_ROLE_KEY (real de homologação)");
    if (!geminiKey || geminiKey.includes("placeholder")) missing.push("GEMINI_API_KEY (real de homologação)");
    if (!appSecret) missing.push("WHATSAPP_APP_SECRET");
    if (!verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
    if (!cronSecret) missing.push("CRON_SECRET");

    if (missing.length > 0) {
      throw new Error(
        `[FALHA HOMOLOGAÇÃO] Credenciais obrigatórias ausentes para o teste integrado WhatsApp/Gemini: ${missing.join(", ")}`,
      );
    }

    assertIsolatedNonProductionCleanupAllowed(stagingDbUrl, process.env);

    const pgMod = await import("postgres");
    const postgres = pgMod.default;
    sql = postgres(stagingDbUrl, { max: 4, onnotice: () => {} });

    await sql`
      INSERT INTO auth.users(id, email, encrypted_password)
      VALUES
        (${userA}, ${`wa.a.${userA}@homolog.local`}, 'hash'),
        (${userB}, ${`wa.b.${userB}@homolog.local`}, 'hash')
    `;
    await sql`
      INSERT INTO public.companies(id, name, price_g, price_m, price_p, whatsapp_connected)
      VALUES
        (${compA}, 'Marmitaria Homologação WA-A', 20.00, 18.00, 16.00, true),
        (${compB}, 'Marmitaria Homologação WA-B', 25.00, 22.00, 19.00, false)
    `;
    await sql`
      INSERT INTO public.profiles(id, company_id, full_name, email)
      VALUES
        (${userA}, ${compA}, 'Operador WA-A', ${`wa.a.${userA}@homolog.local`}),
        (${userB}, ${compB}, 'Operador WA-B', ${`wa.b.${userB}@homolog.local`})
    `;
    await sql`INSERT INTO public.user_roles(user_id, role) VALUES (${userA}, 'admin'), (${userB}, 'admin')`;
    await sql`INSERT INTO public.financial_permissions(company_id, user_id, can_classify) VALUES (${compA}, ${userA}, true), (${compB}, ${userB}, true)`;
    await sql`
      INSERT INTO public.whatsapp_connections(company_id, whatsapp_business_account_id, phone_number_id, status)
      VALUES (${compA}, ${wabaIdA}, ${phoneIdA}, 'ativo')
    `;
    await sql`
      INSERT INTO public.customers(id, company_id, name, phone)
      VALUES
        (${custA}, ${compA}, 'Carlos Homologação', '11900000001'),
        (${custB}, ${compB}, 'Ana Homologação', '21900000002')
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    // CORREÇÃO AUD8-03: Garante que a autorização transacional de limpeza de auditoria
    // só é ativada após validar que o ambiente/banco não é de produção, mantendo ativo
    // o trigger whatsapp_manual_retry_audit_immutable_trg.
    assertIsolatedNonProductionCleanupAllowed(stagingDbUrl, process.env);

    await sql.begin(async (tx: any) => {
      await tx`ALTER TABLE public.orders DISABLE TRIGGER zz_financial_guard_order`;
      await tx`ALTER TABLE public.financial_events DISABLE TRIGGER financial_audit_immutable`;
      await tx`SELECT set_config('app.allow_audit_cleanup', 'on', true)`;
      await tx`DELETE FROM public.whatsapp_manual_retry_audit WHERE company_id IN (${compA}, ${compB})`;
      await tx`SELECT set_config('app.allow_audit_cleanup', 'off', true)`;
      await tx`UPDATE public.orders SET financial_last_audit_id = NULL WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.financial_events WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.whatsapp_messages WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.whatsapp_connections WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.orders WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.customers WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.financial_permissions WHERE company_id IN (${compA}, ${compB})`;
      await tx`DELETE FROM public.user_roles WHERE user_id IN (${userA}, ${userB})`;
      await tx`DELETE FROM public.profiles WHERE id IN (${userA}, ${userB})`;
      await tx`DELETE FROM public.companies WHERE id IN (${compA}, ${compB})`;
      await tx`DELETE FROM auth.users WHERE id IN (${userA}, ${userB})`;
      await tx`ALTER TABLE public.financial_events ENABLE TRIGGER financial_audit_immutable`;
      await tx`ALTER TABLE public.orders ENABLE TRIGGER zz_financial_guard_order`;
    });
    await sql.end();
  });

  it("1. Valida assinatura HMAC-SHA256 no handler HTTP real POST /api/public/whatsapp/meta-webhook", async () => {
    const postHandler = (MetaWebhookRoute as any).options.server.handlers.POST;
    const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const invalidReq = new Request("http://localhost/api/public/whatsapp/meta-webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=invalido" },
      body: rawBody,
    });
    const invalidRes = await postHandler({ request: invalidReq });
    expect(invalidRes.status).toBe(401);

    const validReq = new Request("http://localhost/api/public/whatsapp/meta-webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signPayload(rawBody, appSecret) },
      body: rawBody,
    });
    const validRes = await postHandler({ request: validReq });
    expect(validRes.status).toBe(200);
  });

  it("2, 3, 4 e 5. Persiste mensagem antes do HTTP 200, processa pelo worker real com Gemini 2.5 Flash e cria pedido de R$ 96,00 calculado pelo PostgreSQL", async () => {
    const postWebhook = (MetaWebhookRoute as any).options.server.handlers.POST;
    const postDrain = (DrainQueueRoute as any).options.server.handlers.POST;

    const webhookPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaIdA,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneIdA },
                contacts: [{ wa_id: "5511900000001", profile: { name: "Carlos Homologação" } }],
                messages: [
                  {
                    id: msgUid1,
                    from: "5511900000001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Oi, sou o Carlos, me vê 3 marmitas G e 2 M para hoje" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const webhookReq = new Request("http://localhost/api/public/whatsapp/meta-webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signPayload(webhookPayload, appSecret) },
      body: webhookPayload,
    });

    const webhookRes = await postWebhook({ request: webhookReq });
    expect(webhookRes.status).toBe(200);

    // Verifica que a mensagem já foi persistida no banco imediatamente no retorno do HTTP 200
    const [persistedMsg] = await sql`
      SELECT id, status FROM public.whatsapp_messages
      WHERE company_id = ${compA} AND message_uid = ${`wa:${msgUid1}`}
    `;
    assert.ok(persistedMsg, "A mensagem deve estar persistida no banco antes do retorno HTTP 200");

    // Aciona o endpoint real do worker (POST /api/internal/whatsapp/drain-queue) autenticado com CRON_SECRET
    const drainReq = new Request("http://localhost/api/internal/whatsapp/drain-queue?limit=15", {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    const drainRes = await postDrain({ request: drainReq });
    expect(drainRes.status).toBe(200);

    // Aguarda conclusão caso o disparo assíncrono do webhook já tivesse reclamado a mensagem
    for (let i = 0; i < 20; i++) {
      const [cur] = await sql`
        SELECT status, order_id, parsed FROM public.whatsapp_messages WHERE id = ${persistedMsg.id}
      `;
      if (cur.status === "registrado" && cur.order_id) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const [finalMsg] = await sql`
      SELECT status, order_id, qty_g, qty_m, qty_p, parsed FROM public.whatsapp_messages WHERE id = ${persistedMsg.id}
    `;
    expect(finalMsg.status).toBe("registrado");
    expect(finalMsg.qty_g).toBe(3);
    expect(finalMsg.qty_m).toBe(2);
    expect(Boolean(finalMsg.order_id)).toBe(true);

    const [createdOrder] = await sql`
      SELECT id, total, qty_g, qty_m, qty_p, financial_state, paid
      FROM public.orders WHERE id = ${finalMsg.order_id}
    `;
    expect(Number(createdOrder.total)).toBe(96.00);
    expect(createdOrder.financial_state).toBe("aguardando_classificacao");
    expect(createdOrder.paid).toBe(false);
  }, 30_000);

  it("6, 7 e 8. Classifica OK pelo fluxo real sem dívida, classifica OKK pelo webhook de eco comercial gerando Contas a Receber e bloqueia duplicata", async () => {
    const postWebhook = (MetaWebhookRoute as any).options.server.handlers.POST;
    const postDrain = (DrainQueueRoute as any).options.server.handlers.POST;

    const [msg1] = await sql`
      SELECT order_id FROM public.whatsapp_messages
      WHERE company_id = ${compA} AND message_uid = ${`wa:${msgUid1}`}
    `;
    const order1Id = msg1.order_id as string;
    const okEventId = randomUUID();
    const receivedAt = new Date().toISOString();

    // Executa o fluxo real de classificação do painel (classifyWithPersistence + financial_command_context + financial_classify_order)
    const okClassification = await classifyWithPersistence(
      {
        load: async () =>
          asAuthenticated(userA, async (tx) => {
            const [row] = await tx`
              SELECT public.financial_command_context(${order1Id}::uuid, ${okEventId}::uuid, 'OK', ${receivedAt}::timestamptz) AS data
            `;
            return row.data as FinancialContext;
          }),
        commit: async (_req, decision) =>
          asAuthenticated(userA, async (tx) => {
            const [row] = await tx`
              SELECT public.financial_classify_order(
                ${order1Id}::uuid,
                ${okEventId}::uuid,
                'OK',
                ${receivedAt}::timestamptz,
                ${decision.acao_financeira === "SOLICITAR_CLASSIFICACAO"},
                ${decision.motivo}
              ) AS data
            `;
            return row.data as FinancialCommit;
          }),
      },
      { orderId: order1Id, eventId: okEventId, command: "OK" },
    );

    expect(okClassification.result.outcome).toBe("classified");
    expect(okClassification.result.state).toBe("pago");

    // Reenvia o mesmo webhook (msgUid1) para provar que mensagem duplicada não cria pedido duplicado
    const dupPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaIdA,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneIdA },
                messages: [
                  {
                    id: msgUid1,
                    from: "5511900000001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Oi, sou o Carlos, me vê 3 marmitas G e 2 M para hoje" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const dupRes = await postWebhook({
      request: new Request("http://localhost/api/public/whatsapp/meta-webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signPayload(dupPayload, appSecret) },
        body: dupPayload,
      }),
    });
    expect(dupRes.status).toBe(200);
    const [orderCountAfterDup] = await sql`SELECT count(*)::int AS n FROM public.orders WHERE company_id = ${compA}`;
    expect(orderCountAfterDup.n).toBe(1);

    // Envia segundo pedido (5 marmitas G = R$ 100,00) e classifica como OKK via webhook smb_message_echoes
    const msg2Payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaIdA,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneIdA },
                messages: [
                  {
                    id: msgUid2,
                    from: "5511900000001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Quero 5 marmitas grandes para hoje" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await postWebhook({
      request: new Request("http://localhost/api/public/whatsapp/meta-webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signPayload(msg2Payload, appSecret) },
        body: msg2Payload,
      }),
    });
    await postDrain({
      request: new Request("http://localhost/api/internal/whatsapp/drain-queue?limit=15", {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      }),
    });

    for (let i = 0; i < 20; i++) {
      const [m2] = await sql`SELECT status, order_id FROM public.whatsapp_messages WHERE company_id = ${compA} AND message_uid = ${`wa:${msgUid2}`}`;
      if (m2?.status === "registrado" && m2.order_id) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Dispara comando OKK pelo fluxo de eco comercial do WhatsApp (smb_message_echoes)
    const echoPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaIdA,
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: phoneIdA },
                message_echoes: [
                  {
                    id: echoUidOkk,
                    from: "5511999999999",
                    to: "5511900000001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "OKK" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const echoRes = await postWebhook({
      request: new Request("http://localhost/api/public/whatsapp/meta-webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signPayload(echoPayload, appSecret) },
        body: echoPayload,
      }),
    });
    expect(echoRes.status).toBe(200);

    await postDrain({
      request: new Request("http://localhost/api/internal/whatsapp/drain-queue?limit=15", {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      }),
    });

    const [diagAfterOkk] = await asAuthenticated(userA, (tx) =>
      tx`SELECT public.lgpd_inspect_customer(${custA}::uuid) AS d`,
    );
    expect(Number(diagAfterOkk.d.open_debt_amount)).toBe(100.00);
  }, 30_000);

  it("9 e 10. Encaminha mensagem sem quantidade para 'revisar' e garante isolamento entre Empresa A e Empresa B", async () => {
    const postWebhook = (MetaWebhookRoute as any).options.server.handlers.POST;
    const postDrain = (DrainQueueRoute as any).options.server.handlers.POST;

    const ambigPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaIdA,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneIdA },
                messages: [
                  {
                    id: msgUidAmbig,
                    from: "5511900000001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Oi, manda umas marmitas aí como sempre por favor" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await postWebhook({
      request: new Request("http://localhost/api/public/whatsapp/meta-webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signPayload(ambigPayload, appSecret) },
        body: ambigPayload,
      }),
    });
    await postDrain({
      request: new Request("http://localhost/api/internal/whatsapp/drain-queue?limit=15", {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      }),
    });

    for (let i = 0; i < 20; i++) {
      const [mAmbig] = await sql`SELECT status FROM public.whatsapp_messages WHERE company_id = ${compA} AND message_uid = ${`wa:${msgUidAmbig}`}`;
      if (mAmbig && mAmbig.status !== "aguardando" && mAmbig.status !== "processando") break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const [ambigRow] = await sql`
      SELECT status, order_id FROM public.whatsapp_messages
      WHERE company_id = ${compA} AND message_uid = ${`wa:${msgUidAmbig}`}
    `;
    expect(ambigRow.status).toBe("revisar");
    expect(ambigRow.order_id).toBeNull();

    // Verifica que Empresa B enxerga 0 mensagens e 0 pedidos da Empresa A
    const visibleToB = await asAuthenticated(userB, (tx) =>
      tx`SELECT count(*)::int AS n FROM public.orders WHERE company_id = ${compA}`,
    );
    expect(visibleToB[0].n).toBe(0);
  }, 30_000);
});
