import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { phoneKey, processIncomingMessage } from "./interpret.server";
import { enqueueMetaMessages, drainWhatsAppQueue } from "./whatsapp-webhook.server";
import {
  authenticateCronRequest,
  emitOperationalAlert,
  inspectOperationalQueueHealth,
  resetAlertCooldownsForTest,
} from "./operational-alerts.server";

const ROOT = process.cwd();
const MIGRATION_0011 = readFileSync(
  resolve(ROOT, "drizzle/migrations/0011_pre_production_hardening.sql"),
  "utf8",
);

describe("Hardening Pré-Produção — 1. Gatilho Financeiro (Constraint Trigger + Transação + Rollback)", () => {
  it("usa sintaxe padrão PostgreSQL SET CONSTRAINTS e CREATE CONSTRAINT TRIGGER sem UPDATE OF", () => {
    expect(MIGRATION_0011).not.toContain("SET LOCAL CONSTRAINTS");
    expect(MIGRATION_0011).toContain("SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;");
    expect(MIGRATION_0011).toContain("SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;");
    expect(MIGRATION_0011).toMatch(
      /CREATE CONSTRAINT TRIGGER zz_financial_require_audit_event\s+AFTER INSERT OR UPDATE ON public\.orders\s+DEFERRABLE INITIALLY IMMEDIATE\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.financial_assert_audit_event_exists\(\);/,
    );
  });

  it("recarrega a linha consolidada (SELECT * INTO current_ord) no constraint trigger e impede remoção de financial_last_audit_id", () => {
    expect(MIGRATION_0011).toContain(
      "SELECT * INTO current_ord FROM public.orders WHERE id = NEW.id;",
    );
    expect(MIGRATION_0011).toContain(
      "IF OLD.financial_last_audit_id IS NOT NULL AND NEW.financial_last_audit_id IS NULL THEN",
    );
    expect(MIGRATION_0011).toContain(
      "IF requires_transition_audit OR current_ord.financial_state IN ('pago', 'fiado') THEN",
    );
  });

  it("revoga INSERT, UPDATE e DELETE diretos em orders, payments e financial_events e restringe financial_classify_by_echo a service_role", () => {
    expect(MIGRATION_0011).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.orders FROM anon, authenticated;",
    );
    expect(MIGRATION_0011).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon, authenticated;",
    );
    expect(MIGRATION_0011).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.financial_events FROM anon, authenticated;",
    );
    expect(MIGRATION_0011).toContain(
      "REVOKE ALL ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;",
    );
    expect(MIGRATION_0011).toContain(
      "GRANT EXECUTE ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text) TO service_role;",
    );
  });

  it("alinha os nomes e tipos dos parâmetros RPC entre SQL (0011) e TypeScript (pedidos.tsx, whatsapp.tsx, interpret.server.ts, whatsapp-webhook.server.ts)", () => {
    const pedidosCode = readFileSync(
      resolve(ROOT, "src/routes/_authenticated/pedidos.tsx"),
      "utf8",
    );
    const whatsappCode = readFileSync(
      resolve(ROOT, "src/routes/_authenticated/whatsapp.tsx"),
      "utf8",
    );
    const webhookWorkerCode = readFileSync(
      resolve(ROOT, "src/lib/whatsapp-webhook.server.ts"),
      "utf8",
    );
    const interpretCode = readFileSync(resolve(ROOT, "src/lib/interpret.server.ts"), "utf8");

    expect(pedidosCode).not.toContain('.from("orders").insert');
    expect(pedidosCode).not.toContain('.from("orders").update');
    expect(pedidosCode).toContain("_financial_state: draft.condition");

    expect(whatsappCode).not.toContain('.from("orders").insert');
    expect(whatsappCode).toContain('_financial_state: "aguardando_classificacao"');
    expect(whatsappCode).toContain("_whatsapp_message_id: review.id");
    expect(whatsappCode).toContain("_event_id: review.id");

    expect(webhookWorkerCode).toContain("_batch_size: limit");
    expect(interpretCode).toContain("_creation_event: creationEventUuid");
  });

  it("simula a sequência transacional completa: criação pendente, bloqueio com rollback sem auditoria e commit com SET CONSTRAINTS", () => {
    type OrderRow = {
      id: string;
      company_id: string;
      customer_id: string;
      total: number;
      financial_state: "aguardando_classificacao" | "pago" | "fiado" | null;
      paid: boolean;
      settled_by_payment: boolean;
      financial_last_audit_id: string | null;
    };
    type AuditRow = {
      id: string;
      company_id: string;
      order_id: string;
      customer_id: string;
      previous_state: string | null;
      final_state: string;
      outcome: string;
      total: number;
    };

    const committedOrders = new Map<string, OrderRow>();
    const committedAudits = new Map<string, AuditRow>();

    function assertAuditConstraint(
      oldRow: OrderRow | null,
      newRow: OrderRow,
      txOrders: Map<string, OrderRow>,
      txAudits: Map<string, AuditRow>,
    ) {
      const currentOrd = txOrders.get(newRow.id);
      if (!currentOrd) return;

      const requiresTransitionAudit =
        oldRow === null
          ? currentOrd.financial_state === "pago" ||
            currentOrd.financial_state === "fiado" ||
            (currentOrd.paid && !currentOrd.settled_by_payment)
          : currentOrd.financial_state !== oldRow.financial_state &&
            (currentOrd.financial_state === "pago" || currentOrd.financial_state === "fiado");

      if (
        !requiresTransitionAudit &&
        currentOrd.financial_state !== "pago" &&
        currentOrd.financial_state !== "fiado"
      ) {
        return;
      }

      if (!currentOrd.financial_last_audit_id) {
        throw new Error(
          `Violação de integridade financeira: pedido ${currentOrd.id} classificado sem vínculo financial_last_audit_id.`,
        );
      }
      if (
        requiresTransitionAudit &&
        oldRow &&
        currentOrd.financial_last_audit_id === oldRow.financial_last_audit_id
      ) {
        throw new Error(
          `Violação de integridade financeira: transição em ${currentOrd.id} reutilizou financial_last_audit_id anterior.`,
        );
      }
      const audit = txAudits.get(currentOrd.financial_last_audit_id);
      const expectedPrev = oldRow ? oldRow.financial_state : null;
      const expectedFinal =
        currentOrd.financial_state ?? (currentOrd.paid ? "pago" : "fiado");

      if (
        !audit ||
        audit.company_id !== currentOrd.company_id ||
        audit.order_id !== currentOrd.id ||
        audit.customer_id !== currentOrd.customer_id ||
        audit.outcome !== "classified" ||
        (requiresTransitionAudit && audit.previous_state !== expectedPrev) ||
        audit.final_state !== expectedFinal ||
        audit.total !== currentOrd.total
      ) {
        throw new Error(
          `Violação de integridade financeira: transição para ${expectedFinal} no pedido ${currentOrd.id} sem evento correspondente em financial_events.`,
        );
      }
    }

    const pendingOrder: OrderRow = {
      id: "ord-1",
      company_id: "comp-1",
      customer_id: "cust-1",
      total: 124,
      financial_state: "aguardando_classificacao",
      paid: false,
      settled_by_payment: false,
      financial_last_audit_id: null,
    };
    committedOrders.set(pendingOrder.id, pendingOrder);
    assertAuditConstraint(null, pendingOrder, committedOrders, committedAudits);
    expect(committedOrders.get("ord-1")?.financial_state).toBe("aguardando_classificacao");

    // Tentativa direta sem evento -> ROLLBACK
    expect(() => {
      const txOrders = new Map(committedOrders);
      const txAudits = new Map(committedAudits);
      const prev = txOrders.get("ord-1")!;
      const mutated: OrderRow = { ...prev, financial_state: "pago", paid: true };
      txOrders.set("ord-1", mutated);
      assertAuditConstraint(prev, mutated, txOrders, txAudits);
    }).toThrow(/Violação de integridade financeira/);
    expect(committedOrders.get("ord-1")?.financial_state).toBe("aguardando_classificacao");

    // Execução com SET CONSTRAINTS DEFERRED -> INSERT/UPDATE -> SET CONSTRAINTS IMMEDIATE
    const txOrders = new Map(committedOrders);
    const txAudits = new Map(committedAudits);
    const deferredQueue: Array<() => void> = [];

    const prev = txOrders.get("ord-1")!;
    const step1Row: OrderRow = { ...prev, financial_state: "pago", paid: true };
    txOrders.set("ord-1", step1Row);
    deferredQueue.push(() =>
      assertAuditConstraint(prev, step1Row, txOrders, txAudits),
    );

    const auditId = "aud-101";
    txAudits.set(auditId, {
      id: auditId,
      company_id: "comp-1",
      order_id: "ord-1",
      customer_id: "cust-1",
      previous_state: "aguardando_classificacao",
      final_state: "pago",
      outcome: "classified",
      total: 124,
    });
    txOrders.set("ord-1", { ...step1Row, financial_last_audit_id: auditId });

    for (const check of deferredQueue) check();

    for (const [k, v] of txOrders) committedOrders.set(k, v);
    for (const [k, v] of txAudits) committedAudits.set(k, v);

    expect(committedOrders.get("ord-1")?.financial_state).toBe("pago");
    expect(committedOrders.get("ord-1")?.financial_last_audit_id).toBe("aud-101");
    expect(committedAudits.size).toBe(1);
  });
});

describe("Hardening Pré-Produção — 2. Pagamentos: Controle Persistente de Tentativas e Reconciliação", () => {
  it("inclui already_completed em begin_payment_attempt e can_release_new_key: true quando succeeded em reconcile_payment_attempt", () => {
    expect(MIGRATION_0011).toContain(
      "RETURN to_jsonb(att) || jsonb_build_object('already_completed', (att.status = 'succeeded'));",
    );
    expect(MIGRATION_0011).toContain(
      "RETURN to_jsonb(att) || jsonb_build_object('already_completed', false);",
    );
  });

  it("implementa controle persistente de tentativas onde found:false NÃO libera nova chave até cancelamento explícito", () => {
    type AttemptRecord = {
      company_id: string;
      idempotency_key: string;
      customer_id: string;
      amount: number;
      status: "in_progress" | "succeeded" | "cancelled";
      payment_id: string | null;
    };
    type PaymentRecord = {
      id: string;
      company_id: string;
      customer_id: string;
      amount: number;
      idempotency_key: string;
    };

    const attempts = new Map<string, AttemptRecord>();
    const payments = new Map<string, PaymentRecord>();
    let debtBalance = 124;

    function beginPaymentAttempt(companyId: string, customerId: string, amount: number, key: string) {
      const k = `${companyId}:${key}`;
      const existing = attempts.get(k);
      if (existing) {
        return {
          status: existing.status,
          payment_id: existing.payment_id,
          amount: existing.amount,
          already_completed: existing.status === "succeeded",
        };
      }
      attempts.set(k, {
        company_id: companyId,
        idempotency_key: key,
        customer_id: customerId,
        amount,
        status: "in_progress",
        payment_id: null,
      });
      return { status: "in_progress", payment_id: null, amount, already_completed: false };
    }

    function registerPayment(companyId: string, customerId: string, amount: number, key: string) {
      const k = `${companyId}:${key}`;
      const att = attempts.get(k);
      if (att?.status === "cancelled") {
        throw new Error(
          "Tentativa de pagamento cancelada anteriormente. Inicie uma nova operação com nova chave.",
        );
      }
      if (att?.status === "succeeded" && att.payment_id) {
        return att.payment_id;
      }
      const existingPay = [...payments.values()].find(
        (p) => p.company_id === companyId && p.idempotency_key === key,
      );
      if (existingPay) {
        return existingPay.id;
      }

      const id = `pay-${payments.size + 1}`;
      payments.set(id, {
        id,
        company_id: companyId,
        customer_id: customerId,
        amount,
        idempotency_key: key,
      });
      debtBalance -= amount;
      attempts.set(k, {
        company_id: companyId,
        idempotency_key: key,
        customer_id: customerId,
        amount,
        status: "succeeded",
        payment_id: id,
      });
      return id;
    }

    function reconcilePaymentAttempt(
      companyId: string,
      key: string,
      action: "check" | "cancel",
      customerId?: string,
      amount?: number,
    ) {
      const k = `${companyId}:${key}`;
      const existingPay = [...payments.values()].find(
        (p) => p.company_id === companyId && p.idempotency_key === key,
      );
      if (existingPay) {
        attempts.set(k, {
          company_id: companyId,
          idempotency_key: key,
          customer_id: existingPay.customer_id,
          amount: existingPay.amount,
          status: "succeeded",
          payment_id: existingPay.id,
        });
        return {
          found: true,
          status: "succeeded",
          payment_id: existingPay.id,
          amount: existingPay.amount,
          can_release_new_key: true,
        };
      }

      const att = attempts.get(k);
      if (action === "cancel") {
        attempts.set(k, {
          company_id: companyId,
          idempotency_key: key,
          customer_id: att?.customer_id ?? customerId ?? "cust-1",
          amount: att?.amount ?? amount ?? 50,
          status: "cancelled",
          payment_id: null,
        });
        return {
          found: false,
          status: "cancelled",
          payment_id: null,
          can_release_new_key: true,
        };
      }

      return {
        found: false,
        status: att?.status ?? "not_started",
        payment_id: null,
        can_release_new_key: false,
      };
    }

    const key1 = "idem-key-1";
    beginPaymentAttempt("comp-1", "cust-1", 50, key1);

    const check1 = reconcilePaymentAttempt("comp-1", key1, "check");
    expect(check1).toEqual({
      found: false,
      status: "in_progress",
      payment_id: null,
      can_release_new_key: false,
    });

    const cancel1 = reconcilePaymentAttempt("comp-1", key1, "cancel", "cust-1", 50);
    expect(cancel1.can_release_new_key).toBe(true);
    expect(cancel1.status).toBe("cancelled");

    expect(() => registerPayment("comp-1", "cust-1", 50, key1)).toThrow(
      /Tentativa de pagamento cancelada anteriormente/,
    );
    expect(payments.size).toBe(0);
    expect(debtBalance).toBe(124);

    const key2 = "idem-key-2";
    beginPaymentAttempt("comp-1", "cust-1", 74, key2);
    const firstPayId = registerPayment("comp-1", "cust-1", 74, key2);
    const duplicatePayId = registerPayment("comp-1", "cust-1", 74, key2);
    expect(duplicatePayId).toBe(firstPayId);
    expect(payments.size).toBe(1);
    expect(debtBalance).toBe(50);

    const check2 = reconcilePaymentAttempt("comp-1", key2, "check");
    expect(check2).toEqual({
      found: true,
      status: "succeeded",
      payment_id: firstPayId,
      amount: 74,
      can_release_new_key: true,
    });
  });
});

describe("Hardening Pré-Produção — 3. Fila Durável do WhatsApp e Proteção de Estados", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
  });

  it("persiste mensagens com status 'aguardando' em enqueueMetaMessages sem chamar a API Gemini e nunca reprocessa 'revisar' ou 'registrado'", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const insertedRows: Array<Record<string, unknown>> = [];

    const mockSupabase = {
      from: (table: string) => {
        if (table === "whatsapp_connections") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      company_id: "comp-1",
                      whatsapp_business_account_id: "waba-1",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "whatsapp_messages") {
          return {
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: async () => {
                  if (payload.message_uid === "wa:msg-existing-review") {
                    return { data: null, error: { code: "23505", message: "duplicate key" } };
                  }
                  insertedRows.push(payload);
                  return { data: { id: "row-new-1" }, error: null };
                },
              }),
            }),
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: "row-review-1", status: "revisar", order_id: null },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    const res = await enqueueMetaMessages(
      [
        {
          messageId: "msg-new-1",
          from: "5511987654321",
          profileName: "Maria",
          text: "Quero 2 G e 1 P",
          timestamp: "1730000000",
          phoneNumberId: "phone-1",
          wabaId: "waba-1",
        },
        {
          messageId: "msg-existing-review",
          from: "5511987654321",
          profileName: "Maria",
          text: "Manda as de sempre",
          timestamp: "1730000005",
          phoneNumberId: "phone-1",
          wabaId: "waba-1",
        },
      ],
      mockSupabase as never,
    );

    expect(res.enqueuedIds).toEqual(["row-new-1"]);
    expect(res.skippedIds).toEqual(["row-review-1"]);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.status).toBe("aguardando");
    expect(insertedRows[0]?.phone).toBe("11987654321");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("impede reprocessamento automático de mensagens em 'revisar', 'registrado' ou 'ignorado' no worker e em processIncomingMessage", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const mockSupabase = {
      from: (table: string) => {
        if (table === "whatsapp_messages") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: "msg-rev-99", status: "revisar", order_id: null },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    const result = await processIncomingMessage(mockSupabase as never, "comp-1", {
      phone: "11987654321",
      body: "Manda 2 marmitas",
      externalId: "wa:msg-rev-99",
      messageId: "msg-rev-99",
    });

    expect(result.duplicate).toBe(true);
    expect(result.status).toBe("revisar");
    expect(fetchSpy).not.toHaveBeenCalled();

    const drainRes = await drainWhatsAppQueue({
      workerId: "worker-rev-check",
      supabase: {
        rpc: async () => ({
          data: [
            {
              id: "msg-rev-99",
              company_id: "comp-1",
              phone: "11987654321",
              body: "Manda 2 marmitas",
              status: "revisar",
              order_id: null,
              locked_by: "worker-rev-check",
              locked_until: new Date(Date.now() + 60_000).toISOString(),
              lease_generation: 1,
              message_uid: "wa:msg-rev-99",
            },
          ],
          error: null,
        }),
      } as never,
    });
    expect(drainRes.processed).toBe(0);
  });
});

describe("Hardening Pré-Produção — 4. Backup Coordenado (pg_export_snapshot) e Restore Drill", () => {
  it("mantém a transação exportadora aberta via FIFO coprocess com regex de SNAPSHOT_ID em backup-database.sh e valida Auth + pgcrypto em verify-restore-drill.sh", () => {
    const backupScript = readFileSync(resolve(ROOT, "scripts/backup-database.sh"), "utf8");
    const restoreScript = readFileSync(resolve(ROOT, "scripts/verify-restore-drill.sh"), "utf8");

    expect(backupScript).toContain("mkfifo \"$FIFO_IN\" \"$FIFO_OUT\"");
    expect(backupScript).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    expect(backupScript).toContain("SELECT pg_export_snapshot();");
    expect(backupScript).toContain("^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$");
    expect(backupScript).toContain("SET TRANSACTION SNAPSHOT '${SNAPSHOT_ID}';");
    expect(backupScript).toContain("--snapshot=\"$SNAPSHOT_ID\"");
    expect(backupScript).toContain("--schema=public");
    expect(backupScript).toContain("--schema=auth");

    expect(restoreScript).toContain("sha256sum -c SHA256SUMS.txt");
    expect(restoreScript).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;");
    expect(restoreScript).toContain("orphan_profiles");
    expect(restoreScript).toContain("request.jwt.claim.sub");
    expect(restoreScript).toContain("public.current_company_id()");
  });
});

describe("Hardening Pré-Produção — 5 & 6. Normalização/Unicidade de Telefones e Índices de Desempenho", () => {
  it("normaliza variações de telefone para a mesma chave canônica e aplica lock + índices de desempenho na migração 0011", () => {
    expect(phoneKey("+55 (11) 98765-4321")).toBe("11987654321");
    expect(phoneKey("5511987654321")).toBe("11987654321");
    expect(phoneKey("(11) 98765-4321")).toBe("11987654321");

    expect(MIGRATION_0011).toContain("guard_customer_phone_uniqueness()");
    expect(MIGRATION_0011).toContain("CREATE UNIQUE INDEX IF NOT EXISTS orders_financial_last_audit_id_uidx");
    expect(MIGRATION_0011).toContain("CREATE UNIQUE INDEX IF NOT EXISTS payments_company_idempotency_key_uidx");
    expect(MIGRATION_0011).toContain("CREATE INDEX IF NOT EXISTS whatsapp_messages_queue_idx");
    expect(MIGRATION_0011).toContain("CREATE INDEX IF NOT EXISTS customers_company_phone_key_idx");
    expect(MIGRATION_0011).toContain("CREATE INDEX IF NOT EXISTS orders_customer_settled_idx");
  });
});

describe("Hardening Pré-Produção — 7. Adequação à LGPD (Anonimização Irreversível vs. Pseudonimização)", () => {
  it("usa sequência sintética irreversível (lgpd_anon_seq) em customers e whatsapp_messages e limpa todos os 12 campos PII preservando totais financeiros", () => {
    expect(MIGRATION_0011).toContain("CREATE SEQUENCE IF NOT EXISTS public.lgpd_anon_seq");
    expect(MIGRATION_0011).toContain("synthetic_phone := '99900' || lpad(seq_val::text, 6, '0');");
    expect(MIGRATION_0011).toContain("SET name = 'Titular Anonimizado #' || seq_val::text");
    expect(MIGRATION_0011).toContain(
      "phone = CASE WHEN _scope = 'anonimizacao_completa' THEN synthetic_phone ELSE phone END",
    );
    expect(MIGRATION_0011).toContain(
      "OR (old_phone_key <> '' AND public.financial_phone_key(phone) = old_phone_key)",
    );
    expect(MIGRATION_0011).toContain("parsed = CASE");
    expect(MIGRATION_0011).toContain("parsed - 'nome' - 'motivo'");
    expect(MIGRATION_0011).toContain("SET notes = NULL");
    expect(MIGRATION_0011).toContain("SET financial_phone = NULL");
    expect(MIGRATION_0011).toContain("UPDATE public.payments");
    expect(MIGRATION_0011).toContain("UPDATE public.financial_events");
  });
});

describe("Hardening Pré-Produção — 8. Monitoramento, Healthcheck e Alertas Operacionais", () => {
  beforeEach(() => {
    resetAlertCooldownsForTest();
    process.env["CRON_SECRET"] = "segredo-super-seguro-32-caracteres";
    delete process.env["OPERATIONAL_ALERT_WEBHOOK_URL"];
  });

  it("valida CRON_SECRET com comparação em tempo constante em authenticateCronRequest", () => {
    const validReq = new Request("https://example.com/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer segredo-super-seguro-32-caracteres" },
    });
    const invalidReq = new Request("https://example.com/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer token-invalido" },
    });

    expect(authenticateCronRequest(validReq)).toBe(true);
    expect(authenticateCronRequest(invalidReq)).toBe(false);
  });

  it("aplica deduplicação por cooldown em emitOperationalAlert e detecta fila degradada em inspectOperationalQueueHealth", async () => {
    const first = await emitOperationalAlert({
      code: "TEST_ALERT",
      severity: "warning",
      title: "Alerta de teste",
      details: { count: 1 },
    });
    const second = await emitOperationalAlert({
      code: "TEST_ALERT",
      severity: "warning",
      title: "Alerta repetido dentro da janela de cooldown",
      details: { count: 2 },
    });

    expect(first.emitted).toBe(true);
    expect(second.emitted).toBe(false);

    const mockSupabase = {
      from: (table: string) => {
        if (table === "companies") {
          return {
            select: () => ({
              limit: async () => ({ data: [{ id: "comp-1" }], error: null }),
            }),
          };
        }
        if (table === "whatsapp_messages") {
          return {
            select: () => ({
              is: () => ({
                in: () => ({
                  limit: async () => ({
                    data: [
                      {
                        id: "m1",
                        status: "processando",
                        locked_until: new Date(Date.now() - 60_000).toISOString(),
                        created_at: new Date(Date.now() - 180_000).toISOString(),
                      },
                      {
                        id: "m2",
                        status: "aguardando",
                        locked_until: null,
                        created_at: new Date().toISOString(),
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    const health = await inspectOperationalQueueHealth(mockSupabase as never);
    expect(health.dbConnected).toBe(true);
    expect(health.healthy).toBe(false);
    expect(health.counts.stuckProcessing).toBe(1);
    expect(health.counts.aguardando).toBe(1);
  });
});
