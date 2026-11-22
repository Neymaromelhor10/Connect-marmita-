import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acquireInProcessMessageLock,
  renewInProcessMessageLock,
  renewWhatsAppMessageLockSafe,
  hasActiveInProcessMessageLock,
  resetInProcessMessageLocksForTest,
  releaseInProcessMessageLock,
  releaseWhatsAppMessageLockSafe,
  computeEchoRetryBackoffMs,
  MAX_ECHO_ORDER_WAIT_ATTEMPTS,
  findCustomerByPhoneIndexed,
  enqueueMetaBusinessEchoes,
  drainWhatsAppQueue,
  handleMetaMessages,
} from "./whatsapp-webhook.server";
import {
  getOrCreateCustomerByPhoneAtomic,
  MAX_INBOUND_AUTO_ATTEMPTS,
  MAX_MANUAL_RETRIES,
  MANUAL_RETRY_COOLDOWN_SECONDS,
  computeInboundErrorBackoffMs,
  phoneKey,
} from "./interpret.server";
import {
  normalizePhone,
  isValidNormalizedPhone,
  formatPhone,
} from "./format";
import {
  isCommercialEchoReviewMessage,
  selectCandidateAwaitingOrdersForReview,
  evaluateEchoReconciliationOutcome,
} from "../routes/_authenticated/whatsapp";
import { evaluateManualRetryPreparationOutcome } from "./company.functions";
import {
  authorizeCompanyOperatorOperation,
  executeInterpretMessage,
} from "./company.server";
import {
  authorizeWhatsAppAdminOperation,
  executeLinkWhatsAppNumber,
  executeDisconnectWhatsAppNumber,
} from "./whatsapp.server";
import {
  verifyRemoteSupabaseSession,
} from "../integrations/supabase/auth-middleware";
import {
  authenticateCronRequest as cronAuthMiddleware,
} from "../integrations/supabase/cron-auth";
import {
  authenticateCronRequest,
} from "./operational-alerts.server";
import {
  handleHealthRequest,
  resetPublicHealthCacheForTest,
} from "../routes/api/public/health";
import {
  extractBusinessEchoes,
  extractTrustedClientIpKey,
} from "../routes/api/public/whatsapp/meta-webhook";
import {
  processVerifiedBusinessEcho,
  normalizeFencingGeneration,
  isValidFencingGeneration,
} from "./whatsapp-webhook.server";
import {
  fetchAll,
  MAX_CUSTOMER_IDS_CHUNK_SIZE,
  chunkCustomerIds,
  fetchCustomersByIdsChunked,
  buildOrdersKeysetOrFilter,
  buildPaymentsKeysetOrFilter,
  buildCustomersKeysetOrFilter,
  fetchOrdersCursorPage,
  fetchPaymentsCursorPage,
  fetchCustomersCursorPage,
  computeAuthoritativeBalancesFromLedger,
  reconcileDashboardSummaryWithBalances,
  computeDashboardSummary,
  filterOrderAfterCursor,
  filterPaymentAfterCursor,
  filterCustomerAfterCursor,
} from "./queries";
import {
  assertIsolatedNonProductionCleanupAllowed,
  maskPhoneForOperationalLog,
  sanitizeFreeTextForOperationalLog,
  sanitizeOperationalAlertDetails,
} from "./operational-alerts.server";

const ROOT = process.cwd();
const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "");
const MIGRATION_0012 = readFileSync(
  resolve(ROOT, "drizzle/migrations/0012_argon4_concurrency_scalability_and_rls_hardening.sql"),
  "utf8",
);
const MIGRATION_0013 = readFileSync(
  resolve(ROOT, "drizzle/migrations/0013_argon4_queue_dashboard_and_rls_hardening.sql"),
  "utf8",
);
const MIGRATION_0014 = readFileSync(
  resolve(
    ROOT,
    "drizzle/migrations/0014_argon4_round4_queue_advisory_and_review_hardening.sql",
  ),
  "utf8",
);
const MIGRATION_0015 = readFileSync(
  resolve(ROOT, "drizzle/migrations/0015_argon4_round5_audit5_hardening.sql"),
  "utf8",
);
const MIGRATION_0016 = readFileSync(
  resolve(
    ROOT,
    "drizzle/migrations/0016_argon4_round6_critical_security_and_queue_fixes.sql",
  ),
  "utf8",
);
const MIGRATION_0017 = readFileSync(
  resolve(
    ROOT,
    "drizzle/migrations/0017_argon4_round9_trigger_role_and_audit_hardening.sql",
  ),
  "utf8",
);
const MIGRATION_0014_NOCOMMENTS = MIGRATION_0014.replace(/--.*$/gm, "");
const MIGRATION_0015_NOCOMMENTS = MIGRATION_0015.replace(/--.*$/gm, "");
const MIGRATION_0016_NOCOMMENTS = MIGRATION_0016.replace(/--.*$/gm, "");
const MIGRATION_0017_NOCOMMENTS = MIGRATION_0017.replace(/--.*$/gm, "");
const MIGRATION_0018 = readFileSync(
  resolve(
    ROOT,
    "drizzle/migrations/0018_argon4_forensic_audit_hardening.sql",
  ),
  "utf8",
);
const MIGRATION_0018_NOCOMMENTS = MIGRATION_0018.replace(/--.*$/gm, "");
const MIGRATION_0019 = readFileSync(
  resolve(
    ROOT,
    "drizzle/migrations/0019_argon4_c09_queue_fencing_and_claim_hardening.sql",
  ),
  "utf8",
);
const MIGRATION_0019_NOCOMMENTS = MIGRATION_0019.replace(/--.*$/gm, "");

describe("Auditoria Argon 4 — Validação das Correções (0012 a 0017: ARGON4-01..07, AUD-01..10, AUD3-01..08, AUD5-01..05, AUD6-01..09 e AUD8-01..04)", () => {
  it("AUD6-01: exporta normalizePhone e isValidNormalizedPhone em src/lib/format.ts e unifica phoneKey", () => {
    expect(typeof normalizePhone).toBe("function");
    expect(typeof isValidNormalizedPhone).toBe("function");
    expect(typeof phoneKey).toBe("function");

    const masks = [
      "11988887777",
      "5511988887777",
      "+55 (11) 98888-7777",
      "(11) 98888-7777",
      "55 11 98888-7777",
    ];
    for (const mask of masks) {
      expect(normalizePhone(mask)).toBe("11988887777");
      expect(phoneKey(mask)).toBe("11988887777");
      expect(isValidNormalizedPhone(mask)).toBe(true);
    }

    expect(normalizePhone("551133334444")).toBe("1133334444");
    expect(isValidNormalizedPhone("551133334444")).toBe(true);
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("sem-telefone")).toBe("");
    expect(isValidNormalizedPhone("sem-telefone")).toBe(false);
    expect(isValidNormalizedPhone("1234567")).toBe(false);
    expect(formatPhone("11988887777")).toBe("(11) 98888-7777");
  });

  it("AUD-01 & ARGON4-01: protege posse do lease com fencing token (lease_generation) e impede que worker expirado sobrescreva worker ativo", async () => {
    const companyFns = readFileSync(resolve(ROOT, "src/lib/company.server.ts"), "utf8");
    expect(companyFns).toContain("drainWhatsAppQueue({");
    expect(MIGRATION_0012).toContain("ADD COLUMN IF NOT EXISTS locked_by text");
    expect(MIGRATION_0013).toContain("ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0");
    expect(MIGRATION_0013).toContain("AND locked_by = _worker_id");
    expect(MIGRATION_0013).toContain("LEASE_LOST: mensagem");

    const msgId = "00000000-0000-4000-8000-000000000999";
    releaseInProcessMessageLock(msgId);

    const w1 = acquireInProcessMessageLock(msgId, "worker-1", 60, 1000, 1);
    expect(w1.acquired).toBe(true);
    expect(w1.leaseGeneration).toBe(1);

    const w2Blocked = acquireInProcessMessageLock(msgId, "worker-2", 60, 1005, 1);
    expect(w2Blocked.acquired).toBe(false);

    // Após expirar o lock (t = 62.000ms), o worker-2 assume com lease_generation = 2 confirmada pelo banco
    const w2Acquired = acquireInProcessMessageLock(msgId, "worker-2", 60, 62_000, 2);
    expect(w2Acquired.acquired).toBe(true);
    expect(w2Acquired.leaseGeneration).toBe(2);

    // Worker-1 (atrasado, geração 1) tenta renovar ou liberar: ambos negados!
    expect(renewInProcessMessageLock(msgId, "worker-1", 60, 63_000, 1)).toBe(false);
    expect(releaseInProcessMessageLock(msgId, "worker-1", 1)).toBe(false);

    let dbRowStatus = "processando";
    const mockSupabase = {
      rpc: async () => ({ data: false, error: null }),
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: msgId, locked_by: "worker-2", lease_generation: 2, order_id: null },
              error: null,
            }),
          }),
        }),
        update: (patch: { status: string }) => ({
          eq: () => ({
            eq: async () => {
              dbRowStatus = patch.status;
              return { error: null };
            },
          }),
        }),
      }),
    } as never;

    const staleRelease = await releaseWhatsAppMessageLockSafe(
      mockSupabase,
      msgId,
      "worker-1",
      "erro",
      { leaseGeneration: 1 },
    );
    expect(staleRelease).toBe(false);
    expect(dbRowStatus).toBe("processando");

    expect(releaseInProcessMessageLock(msgId, "worker-2", 2)).toBe(true);
  });

  it("AUD3-01, AUD5-05, AUD6-06 & AUD6-08: claim_whatsapp_queue_batch limita fairness_slot, limpa next_retry_at=NULL, varre processando expirado para revisar e possui índices de suporte", () => {
    expect(MIGRATION_0014_NOCOMMENTS).toContain("WITH eligible AS MATERIALIZED (");
    expect(MIGRATION_0016_NOCOMMENTS).toContain(
      "m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))",
    );
    expect(MIGRATION_0016_NOCOMMENTS).toContain(
      "WHERE ranked.fairness_slot <= greatest(effective_limit * 2, 50)",
    );
    expect(MIGRATION_0016_NOCOMMENTS).toContain("next_retry_at = NULL");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("SET status = 'revisar'");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("LEASE_EXPIRADO_APOS_LIMITE_DE_TENTATIVAS");
    expect(MIGRATION_0016_NOCOMMENTS).toContain(
      "CREATE INDEX IF NOT EXISTS whatsapp_messages_fairness_partition_idx",
    );
    expect(MIGRATION_0016_NOCOMMENTS).toContain(
      "CREATE INDEX IF NOT EXISTS whatsapp_messages_order_id_idx",
    );
  });

  it("AUD-02: handleMetaMessages delega integralmente para enqueueMetaMessages + drainWhatsAppQueue sem inserir status='processando'", () => {
    const webhookServer = readFileSync(
      resolve(ROOT, "src/lib/whatsapp-webhook.server.ts"),
      "utf8",
    );
    const fnBody = webhookServer.slice(webhookServer.indexOf("export async function handleMetaMessages"));
    expect(fnBody).toContain("await enqueueMetaMessages(");
    expect(fnBody).toContain("await drainWhatsAppQueue(");
    expect(fnBody).not.toContain('status: "processando"');
    expect(typeof handleMetaMessages).toBe("function");
  });

  it("AUD-03, ARGON4-02 & AUD3-02: unifica namespace de advisory lock (:customer_phone:) e recupera de 23505 sem duplicar clientes", async () => {
    const interpretSrc = readFileSync(resolve(ROOT, "src/lib/interpret.server.ts"), "utf8");
    expect(interpretSrc).toContain("get_or_create_customer_by_phone");
    expect(interpretSrc).toContain("if (!customer && !rpcAuthoritative && key)");
    expect(MIGRATION_0014_NOCOMMENTS).toContain(
      "pg_advisory_xact_lock(hashtextextended(_company_id::text || ':customer_phone:' || norm_key, 0))",
    );
    expect(MIGRATION_0014_NOCOMMENTS).toContain("WHEN unique_violation THEN");

    const totalCustomers = 1500;
    const allCustomers = Array.from({ length: totalCustomers }, (_, idx) => ({
      id: `cust-${String(idx + 1).padStart(5, "0")}`,
      company_id: "comp-1",
      name: `Cliente ${idx + 1}`,
      phone: `119${String(10000000 + idx + 1).slice(-8)}`,
    }));

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              range: async (from: number, to: number) => ({
                data: allCustomers.slice(from, to + 1),
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as never;

    const targetCustomer = allCustomers[1349]!;
    const found = await findCustomerByPhoneIndexed(
      mockSupabase,
      "comp-1",
      `+55 (${targetCustomer.phone.slice(0, 2)}) ${targetCustomer.phone.slice(2, 7)}-${targetCustomer.phone.slice(7)}`,
    );
    expect(found?.id).toBe("cust-01350");

    const raceClient = {
      rpc: async (fn: string) => {
        if (fn === "get_or_create_customer_by_phone") {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        if (fn === "find_customer_by_phone") {
          return {
            data: [{ id: "cust-race-winner", company_id: "comp-1", name: "Cliente Concorrente", phone: "11944443333" }],
            error: null,
          };
        }
        return { data: null, error: null };
      },
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: "23505", message: "duplicate key value" },
            }),
          }),
        }),
      }),
    } as never;

    const recovered = await getOrCreateCustomerByPhoneAtomic(
      raceClient,
      "comp-1",
      "+55 (11) 94444-3333",
      "Cliente Concorrente",
      "11944443333",
    );
    expect(recovered?.id).toBe("cust-race-winner");
  });

  it("AUD3-03, AUD5-03, AUD6-04 & AUD6-07: valida assinatura real de selectCandidateAwaitingOrdersForReview (customerId + phone obrigatório) e evaluateEchoReconciliationOutcome (isDuplicate)", () => {
    expect(
      isCommercialEchoReviewMessage({
        direction: "outbound",
        source: "whatsapp_echo",
        body: "OK",
      }),
    ).toBe(true);
    expect(
      isCommercialEchoReviewMessage({
        direction: "outbound",
        source: "whatsapp_echo",
        body: "OKK",
      }),
    ).toBe(true);
    expect(
      isCommercialEchoReviewMessage({
        direction: "inbound",
        source: "whatsapp_cloud",
        body: "  okk ",
      }),
    ).toBe(true);
    expect(
      isCommercialEchoReviewMessage({
        direction: "inbound",
        source: "whatsapp_cloud",
        body: "Quero 2 G e 1 M",
      }),
    ).toBe(false);

    const orders = [
      {
        id: "ord-cust-A",
        customer_id: "cust-A",
        delivery_status: "pendente" as const,
        financial_state: "aguardando_classificacao" as const,
        customers: { name: "Cliente A", phone: "11999990001" },
      },
      {
        id: "ord-cust-B",
        customer_id: "cust-B",
        delivery_status: "pendente" as const,
        financial_state: "aguardando_classificacao" as const,
        customers: { name: "Cliente B", phone: "11999990002" },
      },
      {
        id: "ord-cust-no-phone",
        customer_id: "cust-no-phone",
        delivery_status: "pendente" as const,
        financial_state: "aguardando_classificacao" as const,
        customers: { name: "Cliente Sem Telefone", phone: "sem-telefone" },
      },
    ] as never;

    const candidatesForC = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: "cust-C",
      phone: "11999990003",
    });
    expect(candidatesForC).toEqual([]);

    const candidatesWithoutIdentity = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: null,
      phone: null,
    });
    expect(candidatesWithoutIdentity).toEqual([]);

    // AUD6-07.B: Mesmo se customerId coincidir, sem telefone válido em ambos os lados retorna []
    const candidatesWithoutValidPhone = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: "cust-A",
      phone: null,
    });
    expect(candidatesWithoutValidPhone).toEqual([]);

    const candidatesOrderWithoutPhone = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: "cust-no-phone",
      phone: "11999990009",
    });
    expect(candidatesOrderWithoutPhone).toEqual([]);

    const candidatesForA = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: "cust-A",
      phone: "+55 (11) 99999-0001",
    });
    expect(candidatesForA.map((o) => o.id)).toEqual(["ord-cust-A"]);

    const candidatesByPhoneOnly = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: null,
      phone: "(11) 99999-0001",
    });
    expect(candidatesByPhoneOnly.map((o) => o.id)).toEqual(["ord-cust-A"]);

    const candidatesDivergentPhone = selectCandidateAwaitingOrdersForReview(orders, {
      customerId: "cust-A",
      phone: "+55 (11) 99999-0002",
    });
    expect(candidatesDivergentPhone).toEqual([]);

    const blockedEval = evaluateEchoReconciliationOutcome(
      {
        outcome: "blocked",
        reason: "OUTSIDE_RECONCILIATION_WINDOW",
      },
      null,
    );
    expect(blockedEval.ok).toBe(false);
    expect(blockedEval.isDuplicate).toBe(false);
    if (!blockedEval.ok) {
      expect(blockedEval.errorMessage).toContain("fora da janela segura de 30 minutos");
    }

    const wrongDateEval = evaluateEchoReconciliationOutcome(
      {
        outcome: "blocked",
        reason: "COMANDO_FORA_DA_DATA_DO_PEDIDO",
      },
      null,
    );
    expect(wrongDateEval.ok).toBe(false);
    if (!wrongDateEval.ok) {
      expect(wrongDateEval.errorMessage).toContain("diverge da data do pedido");
    }

    const duplicateEval = evaluateEchoReconciliationOutcome(
      {
        outcome: "duplicate",
        order_id: "ord-cust-A",
      },
      null,
    );
    expect(duplicateEval.ok).toBe(true);
    expect(duplicateEval.isDuplicate).toBe(true);

    const confirmedEval = evaluateEchoReconciliationOutcome(
      {
        outcome: "classified",
        order_id: "ord-cust-A",
      },
      null,
    );
    expect(confirmedEval.ok).toBe(true);
    expect(confirmedEval.isDuplicate).toBe(false);

    const unexpectedEval = evaluateEchoReconciliationOutcome(
      {
        outcome: "unknown_state",
      },
      null,
    );
    expect(unexpectedEval.ok).toBe(false);

    expect(MIGRATION_0016_NOCOMMENTS).toContain("v_echo_ts := coalesce(msg.received_at, msg.created_at, clock_timestamp())");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("COMANDO_FORA_DA_DATA_DO_PEDIDO");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("OUTSIDE_RECONCILIATION_WINDOW");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("_received_at => v_echo_ts");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("CREATE OR REPLACE FUNCTION public.ignore_whatsapp_message");
  });

  it("AUD-04, AUD-05, AUD3-04, AUD5-02, AUD6-02, AUD6-05 & AUD6-09: retry manual persiste auditoria de bloqueio sem rollback, exige financial_require_operator e sanitiza objetos aninhados", () => {
    expect(MAX_INBOUND_AUTO_ATTEMPTS).toBe(5);
    expect(MAX_MANUAL_RETRIES).toBe(3);
    expect(MANUAL_RETRY_COOLDOWN_SECONDS).toBe(30);

    const bMin = computeInboundErrorBackoffMs(1, () => 0);
    const bMax = computeInboundErrorBackoffMs(1, () => 1);
    expect(bMin).toBe(15_000);
    expect(bMax).toBe(17_500);

    // AUD6-02: Verifica que prepare_manual_whatsapp_retry retorna jsonb sem RAISE EXCEPTION após INSERT de auditoria
    expect(MIGRATION_0016_NOCOMMENTS).toContain("RETURNS jsonb");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("comp := public.financial_require_operator();");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("'error_code', 'MANUAL_RETRY_COOLDOWN_ACTIVE'");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("'error_code', 'MANUAL_RETRY_LIMIT_EXCEEDED'");
    expect(MIGRATION_0016_NOCOMMENTS).toContain("CREATE TRIGGER whatsapp_manual_retry_audit_immutable_trg");

    const authOutcome = evaluateManualRetryPreparationOutcome(
      {
        authorized: true,
        updated_count: 1,
        outcome: "authorized",
        manual_retry_count: 1,
      },
      null,
    );
    expect(authOutcome.allowed).toBe(true);
    expect(authOutcome.updatedCount).toBe(1);

    const cooldownOutcome = evaluateManualRetryPreparationOutcome(
      {
        authorized: false,
        updated_count: 0,
        outcome: "blocked",
        reason: "COOLDOWN_30S_ACTIVE",
        error_code: "MANUAL_RETRY_COOLDOWN_ACTIVE",
        message: "Aguarde pelo menos 30 segundos entre reprocessamentos manuais da mesma mensagem (faltam 22s).",
      },
      null,
    );
    expect(cooldownOutcome.allowed).toBe(false);
    if (!cooldownOutcome.allowed) {
      expect(cooldownOutcome.errorCode).toBe("MANUAL_RETRY_COOLDOWN_ACTIVE");
      expect(cooldownOutcome.errorMessage).toContain("Aguarde pelo menos 30 segundos");
    }

    const limitOutcome = evaluateManualRetryPreparationOutcome(
      {
        authorized: false,
        updated_count: 0,
        outcome: "blocked",
        reason: "MANUAL_RETRY_LIMIT_REACHED",
        error_code: "MANUAL_RETRY_LIMIT_EXCEEDED",
        message: "Limite máximo de 3 reprocessamentos manuais atingido para esta mensagem. Classifique-a manualmente na fila de revisão.",
      },
      null,
    );
    expect(limitOutcome.allowed).toBe(false);
    if (!limitOutcome.allowed) {
      expect(limitOutcome.errorCode).toBe("MANUAL_RETRY_LIMIT_EXCEEDED");
      expect(limitOutcome.errorMessage).toContain("Limite máximo de 3 reprocessamentos manuais atingido");
    }

    expect(MAX_ECHO_ORDER_WAIT_ATTEMPTS).toBe(5);
    const d1 = computeEchoRetryBackoffMs(1, () => 0);
    const d2 = computeEchoRetryBackoffMs(2, () => 0);
    const d3 = computeEchoRetryBackoffMs(3, () => 0);
    const d4 = computeEchoRetryBackoffMs(4, () => 0);
    const d5 = computeEchoRetryBackoffMs(5, () => 0);
    expect([d1, d2, d3, d4, d5]).toEqual([2000, 4000, 8000, 16000, 20000]);
    expect(d1 + d2 + d3 + d4 + d5).toBeGreaterThanOrEqual(30_000);

    // AUD6-09: Sanitização recursiva de objetos aninhados, arrays, Error e texto livre
    expect(maskPhoneForOperationalLog("+55 (11) 98888-7766")).toBe("***7766");
    expect(
      sanitizeFreeTextForOperationalLog(
        "Falha ao enviar para +55 (11) 98888-7766 com Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      ),
    ).toBe("Falha ao enviar para ***7766 com Bearer [REDACTED]");

    const sanitized = sanitizeOperationalAlertDetails({
      phone: "11988887766",
      access_token: "secret-token-xyz",
      attempts: 5,
      nested: {
        customerPhone: "+55 21 97777-6655",
        apiKey: "AIzaSySecretKey123456",
        notes: ["Erro no número 11988887766", { whatsapp_access_token: "EAABsecret" }],
      },
      err: new Error("Timeout para +55 (11) 98888-7766 usando key=AIzaSySecret999"),
    });
    expect(sanitized["phone"]).toBe("***7766");
    expect(sanitized["access_token"]).toBe("[REDACTED]");
    expect(sanitized["attempts"]).toBe(5);

    const nestedObj = sanitized["nested"] as Record<string, unknown>;
    expect(nestedObj["customerPhone"]).toBe("***6655");
    expect(nestedObj["apiKey"]).toBe("[REDACTED]");
    const nestedNotes = nestedObj["notes"] as unknown[];
    expect(nestedNotes[0]).toBe("Erro no número ***7766");
    expect((nestedNotes[1] as Record<string, unknown>)["whatsapp_access_token"]).toBe("[REDACTED]");

    const sanitizedErr = sanitized["err"] as Record<string, unknown>;
    expect(sanitizedErr["message"]).toBe("Timeout para ***7766 usando key=[REDACTED]");
  });

  it("AUD-06, AUD-09, AUD3-05, AUD5-04 & AUD6-04: executa a função real fetchCustomersByIdsChunked({ companyId, customerIds, supabaseClient }) para 100, 300, 1.500, 5.000 e 10.000 devedores", async () => {
    expect(MAX_CUSTOMER_IDS_CHUNK_SIZE).toBe(100);

    for (const totalDebtors of [100, 300, 1500, 5000, 10000]) {
      const ids = Array.from(
        { length: totalDebtors },
        (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      );
      const chunks = chunkCustomerIds(ids, MAX_CUSTOMER_IDS_CHUNK_SIZE);
      expect(chunks.every((c) => c.length <= 100)).toBe(true);

      let maxChunkSizeObserved = 0;
      const mockClientForVolume = {
        from: () => ({
          select: () => ({
            eq: () => ({
              in: (_col: string, chunk: string[]) => {
                if (chunk.length > maxChunkSizeObserved) {
                  maxChunkSizeObserved = chunk.length;
                }
                const orderBuilder = {
                  order: () => orderBuilder,
                  range: async () => ({
                    data: chunk.map((id, idx) => ({
                      id,
                      company_id: "comp-1",
                      name: `Cliente ${String(idx + 1).padStart(5, "0")}`,
                      phone: "11988887777",
                    })),
                    error: null,
                  }),
                };
                return orderBuilder;
              },
            }),
          }),
        }),
      } as never;

      const result = await fetchCustomersByIdsChunked({
        companyId: "comp-1",
        customerIds: ids,
        supabaseClient: mockClientForVolume,
      });

      expect(maxChunkSizeObserved).toBeLessThanOrEqual(100);
      expect(result.maxChunkSizeUsed).toBeLessThanOrEqual(100);
      expect(result.chunksQueried).toBe(Math.ceil(totalDebtors / 100));
      expect(result.items.length).toBe(totalDebtors);
      expect(new Set(result.items.map((r) => r.id)).size).toBe(totalDebtors);
    }

    let callIdx = 0;
    const failingMockClient = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: (_col: string, chunk: string[]) => {
              callIdx++;
              const currentCall = callIdx;
              const orderBuilder = {
                order: () => orderBuilder,
                range: async () => {
                  if (currentCall === 2) {
                    return { data: null, error: new Error("Falha simulada no lote 2") };
                  }
                  return {
                    data: chunk.map((id) => ({
                      id,
                      company_id: "comp-1",
                      name: id,
                      phone: "11988887777",
                    })),
                    error: null,
                  };
                },
              };
              return orderBuilder;
            },
          }),
        }),
      }),
    } as never;

    await expect(
      fetchCustomersByIdsChunked({
        companyId: "comp-1",
        customerIds: Array.from({ length: 250 }, (_, i) => `id-${i}`),
        supabaseClient: failingMockClient,
      }),
    ).rejects.toThrow("Falha simulada no lote 2");

    const fiadoSrc = readFileSync(resolve(ROOT, "src/routes/_authenticated/fiado.tsx"), "utf8");
    expect(fiadoSrc).toContain("isLoading: loadingBalances");
    expect(fiadoSrc).toContain("enabled: Boolean(company?.id) && Boolean(authoritativeBalances)");
    expect(fiadoSrc).toContain("customerIds: balanceCustomerIds");
  });

  it("AUD-07 & AUD-08: executa paginação server-side e paginação por cursor real (RPC / PostgREST .or) sem perda nem duplicação", async () => {
    expect(MIGRATION_0013).toContain("CREATE OR REPLACE FUNCTION public.list_orders_cursor");
    expect(MIGRATION_0013).toContain("CREATE OR REPLACE FUNCTION public.list_payments_cursor");
    expect(MIGRATION_0013).toContain("CREATE OR REPLACE FUNCTION public.list_customers_cursor");

    const orderFilter = buildOrdersKeysetOrFilter({
      order_date: "2026-11-07",
      created_at: "2026-11-07T12:00:00Z",
      id: "00000000-0000-4000-8000-000000000050",
    });
    expect(orderFilter).toContain("order_date.lt.2026-11-07");
    expect(orderFilter).toContain("created_at.lt.2026-11-07T12:00:00Z");

    expect(
      buildPaymentsKeysetOrFilter({
        paid_at: "2026-11-07T12:00:00Z",
        id: "00000000-0000-4000-8000-000000000050",
      }),
    ).toContain("paid_at.lt.2026-11-07T12:00:00Z");

    expect(
      buildCustomersKeysetOrFilter({
        name: "Ana",
        id: "00000000-0000-4000-8000-000000000050",
      }),
    ).toContain('name.gt."Ana"');

    const count = 2500;
    const dataset = Array.from({ length: count }, (_, idx) => ({
      id: `id-${String(count - idx).padStart(6, "0")}`,
      order_date: "2026-11-07",
      created_at: `2026-11-07T12:00:00.${String(count - idx).padStart(6, "0")}Z`,
    }));

    const mockRpcClient = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        const curDate = args["_cursor_order_date"] as string | null;
        const curCreated = args["_cursor_created_at"] as string | null;
        const curId = args["_cursor_id"] as string | null;
        const pageSize = Number(args["_page_size"] ?? 500);
        const cur =
          curDate && curCreated && curId
            ? { order_date: curDate, created_at: curCreated, id: curId }
            : null;
        const page = filterOrderAfterCursor(dataset, cur, pageSize);
        return { data: page.items, error: null };
      },
    } as never;

    let cursor = null;
    const collected: string[] = [];
    for (let p = 0; p < 10; p++) {
      const pageRes = await fetchOrdersCursorPage({
        companyId: "comp-1",
        cursor,
        pageSize: 500,
        supabaseClient: mockRpcClient,
      });
      expect(pageRes.usedRpc).toBe(true);
      collected.push(...pageRes.items.map((i) => i.id));
      cursor = pageRes.nextCursor;
      if (!cursor) break;
    }
    expect(collected.length).toBe(count);
    expect(new Set(collected).size).toBe(count);

    const singlePage = await fetchAll(
      async (from, to) => ({ data: dataset.slice(from, to + 1), error: null }),
      { pageSize: 100, page: 0 },
    );
    expect(singlePage.length).toBe(100);
    expect(typeof fetchPaymentsCursorPage).toBe("function");
    expect(typeof fetchCustomersCursorPage).toBe("function");
    expect(typeof filterPaymentAfterCursor).toBe("function");
    expect(typeof filterCustomerAfterCursor).toBe("function");
  });

  it("AUD5-01, AUD6-03, AUD-10, ARGON4-07, AUD3-06, AUD3-07, AUD3-08 & AUD8-01..04: valida correção de 3 argumentos em staging-pg-concurrency-and-load.mjs, RLS de companies, types.ts, migration 0017, workflow de backup, cleanup Gemini e fronteira cliente/servidor", () => {
    const stagingScript = readFileSync(
      resolve(ROOT, "tests/staging-pg-concurrency-and-load.mjs"),
      "utf8",
    );
    expect(stagingScript).not.toContain("normalize_br_phone");
    expect(stagingScript).not.toContain("DO $$");
    expect(stagingScript).not.toContain("$4::text");
    expect(stagingScript).toContain("public.financial_phone_key(phone)");
    expect(stagingScript).toContain(
      "SELECT id AS cust_id FROM public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text)",
    );

    const runHomologSh = readFileSync(
      resolve(ROOT, "scripts/run-staging-homologation.sh"),
      "utf8",
    );
    expect(runHomologSh).toContain("drizzle/migrations/0014_*.sql");
    expect(runHomologSh).toContain("drizzle/migrations/0015_*.sql");
    expect(runHomologSh).toContain("drizzle/migrations/0016_*.sql");
    expect(runHomologSh).toContain("drizzle/migrations/0017_*.sql");

    const supaTypes = readFileSync(resolve(ROOT, "src/integrations/supabase/types.ts"), "utf8");
    expect(supaTypes).toContain("whatsapp_manual_retry_audit:");
    expect(supaTypes).toContain("manual_retry_count?: number");
    expect(supaTypes).toContain("ignore_whatsapp_message:");
    expect(supaTypes).toContain("_max_manual_retries?: number");
    expect(supaTypes).toContain("_cooldown_seconds?: number");

    // AUD8-01: Workflow diário de backup configurado com GoTrue e todas as variáveis exigidas por verify-restore-drill.sh
    const backupWorkflow = readFileSync(
      resolve(ROOT, ".github/workflows/database-backup.yml"),
      "utf8",
    );
    expect(backupWorkflow).toContain('RESTORE_DRILL_CONFIRM_MARKER: "RESTORE_DRILL_AUTORIZADO"');
    expect(backupWorkflow).toContain("RESTORE_TEST_DATABASE_URL:");
    expect(backupWorkflow).toContain("RESTORE_TEST_GOTRUE_URL:");
    expect(backupWorkflow).toContain("RESTORE_TEST_ANON_KEY:");
    expect(backupWorkflow).toContain("RESTORE_SMOKE_EMAIL:");
    expect(backupWorkflow).toContain("RESTORE_SMOKE_PASSWORD:");
    expect(backupWorkflow).toContain("supabase/gotrue:v2.158.1");

    // AUD8-02: Migration 0017 refatora triggers de guarda para SECURITY INVOKER + request_jwt_role() + session_user
    expect(MIGRATION_0017_NOCOMMENTS).toContain("CREATE OR REPLACE FUNCTION public.request_jwt_role()");
    expect(MIGRATION_0017_NOCOMMENTS).toContain(
      "GRANT EXECUTE ON FUNCTION public.financial_require_operator() TO authenticated, service_role;",
    );
    expect(MIGRATION_0017_NOCOMMENTS).toContain("CREATE OR REPLACE FUNCTION public.guard_whatsapp_messages_protected_fields()");
    expect(MIGRATION_0017_NOCOMMENTS).toContain("CREATE OR REPLACE FUNCTION public.guard_company_admin_update()");
    expect(MIGRATION_0017_NOCOMMENTS).toContain("SECURITY INVOKER");
    expect(MIGRATION_0017_NOCOMMENTS).not.toContain("SECURITY DEFINER");
    expect(MIGRATION_0017_NOCOMMENTS).toContain("session_user IN ('authenticated', 'anon')");

    // AUD8-03: Validação de assertIsolatedNonProductionCleanupAllowed em ambiente isolado vs. bloqueio em produção
    expect(() =>
      assertIsolatedNonProductionCleanupAllowed(
        "postgresql://postgres:drill_password@127.0.0.1:54332/marmita_staging",
        {
          NODE_ENV: "test",
          RUN_LIVE_HOMOLOGATION: "1",
          PRODUCTION_PROJECT_REF: "prodref123",
        },
      ),
    ).not.toThrow();

    expect(() =>
      assertIsolatedNonProductionCleanupAllowed(
        "postgresql://postgres:drill_password@127.0.0.1:54332/marmita_staging",
        {
          NODE_ENV: "production",
          RUN_LIVE_HOMOLOGATION: "1",
        },
      ),
    ).toThrow("proibida em ambiente de produção");

    expect(() =>
      assertIsolatedNonProductionCleanupAllowed(
        "postgresql://postgres:secret@db.ehsmkjuelryvoqyweiga.supabase.co:5432/postgres",
        {
          NODE_ENV: "test",
          RUN_LIVE_HOMOLOGATION: "1",
        },
      ),
    ).toThrow("PRODUÇÃO");

    // AUD8-04: Rota de clientes importa normalizePhone de @/lib/format sem depender de interpret.server
    const clientesSrc = readFileSync(
      resolve(ROOT, "src/routes/_authenticated/clientes.tsx"),
      "utf8",
    );
    expect(clientesSrc).not.toContain("interpret.server");
    expect(clientesSrc).toContain("normalizePhone");
  });

  it("FOR-01: valida autorização administrativa estrita em linkWhatsAppNumber e disconnectWhatsAppNumber (admin autorizado, operador sem privilégio, outra empresa, não autenticado, empresa inexistente e RPC indisponível)", async () => {
    // 1. Usuário não autenticado -> negado
    await expect(authorizeWhatsAppAdminOperation(null)).rejects.toThrow("autenticação obrigatória");
    await expect(
      authorizeWhatsAppAdminOperation({ supabase: null as never, userId: "" }),
    ).rejects.toThrow("autenticação obrigatória");

    // 2. Empresa inexistente (perfil sem company_id) -> negado
    const noCompanySupabase = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-no-comp", email: "a@b.com" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: true, error: null }),
    } as never;

    await expect(
      authorizeWhatsAppAdminOperation({ supabase: noCompanySupabase, userId: "user-no-comp" }),
    ).rejects.toThrow("Empresa não encontrada");

    // 3. Operador sem privilégio administrativo (is_company_admin = false) -> negado antes de tocar em supabaseAdmin
    let adminClientTouched = false;
    const nonAdminSupabase = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-op", email: "op@b.com" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { company_id: "comp-a" }, error: null }),
          }),
        }),
      }),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        expect(fn).toBe("is_company_admin");
        expect(args["_company_id"]).toBe("comp-a");
        return { data: false, error: null };
      },
    } as never;

    const spyAdmin = {
      from: () => {
        adminClientTouched = true;
        throw new Error("supabaseAdmin JAMAIS deveria ser chamado para não-admin");
      },
    } as never;

    await expect(
      executeLinkWhatsAppNumber(
        { supabase: nonAdminSupabase, userId: "user-op" },
        { phoneNumberId: "1234567890", wabaId: "9876543210" },
        { supabaseAdmin: spyAdmin, whatsappAccessToken: "fake-token" },
      ),
    ).rejects.toThrow("Permissão administrativa necessária");
    expect(adminClientTouched).toBe(false);

    await expect(
      executeDisconnectWhatsAppNumber(
        { supabase: nonAdminSupabase, userId: "user-op" },
        { supabaseAdmin: spyAdmin },
      ),
    ).rejects.toThrow("Permissão administrativa necessária");
    expect(adminClientTouched).toBe(false);

    // 4. RPC de autorização indisponível ou com erro -> negado por padrão (fail-closed)
    const rpcUnavailableSupabase = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-admin", email: "admin@b.com" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { company_id: "comp-a" }, error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Function not found" } }),
    } as never;

    await expect(
      authorizeWhatsAppAdminOperation({ supabase: rpcUnavailableSupabase, userId: "user-admin" }),
    ).rejects.toThrow("Permissão administrativa necessária");

    // 5. Usuário de outra empresa / número já vinculado a outra empresa -> bloqueia sequestro cross-tenant
    const adminCompBSupabase = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-admin-b", email: "adminb@b.com" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { company_id: "comp-b" }, error: null }),
          }),
        }),
      }),
      rpc: async (_fn: string, args: Record<string, unknown>) => ({
        data: args["_company_id"] === "comp-b",
        error: null,
      }),
    } as never;

    const mockAdminTakenByCompA = {
      from: (table: string) => {
        if (table === "whatsapp_connections") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { company_id: "comp-a" }, error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as never;

    await expect(
      executeLinkWhatsAppNumber(
        { supabase: adminCompBSupabase, userId: "user-admin-b" },
        { phoneNumberId: "1234567890", wabaId: "9876543210" },
        {
          supabaseAdmin: mockAdminTakenByCompA,
          whatsappAccessToken: "test-token",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ data: [{ id: "1234567890", display_phone_number: "+55 11 99999-0000" }] }),
              { status: 200 },
            ),
        },
      ),
    ).rejects.toThrow("já está vinculado a outra conta");

    // 6. Administrador autorizado da própria empresa -> vincula e desconecta com sucesso
    let companyConnectedState: boolean | null = null;
    const mockAdminSuccess = {
      from: (table: string) => {
        if (table === "whatsapp_connections") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { company_id: "comp-b" }, error: null }),
              }),
            }),
            upsert: (row: Record<string, unknown>) => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: "conn-b",
                    phone_number_id: row["phone_number_id"],
                    whatsapp_business_account_id: row["whatsapp_business_account_id"],
                    status: "ativo",
                  },
                  error: null,
                }),
              }),
            }),
            update: () => ({
              eq: async () => ({ data: null, error: null }),
            }),
          };
        }
        if (table === "companies") {
          return {
            update: (patch: { whatsapp_connected: boolean }) => ({
              eq: async () => {
                companyConnectedState = patch.whatsapp_connected;
                return { data: null, error: null };
              },
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as never;

    const linked = await executeLinkWhatsAppNumber(
      { supabase: adminCompBSupabase, userId: "user-admin-b" },
      { phoneNumberId: "1234567890", wabaId: "9876543210" },
      {
        supabaseAdmin: mockAdminSuccess,
        whatsappAccessToken: "test-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ data: [{ id: "1234567890", display_phone_number: "+55 11 99999-0000" }] }),
            { status: 200 },
          ),
      },
    );
    expect(linked.status).toBe("ativo");
    expect(companyConnectedState).toBe(true);

    const disconnected = await executeDisconnectWhatsAppNumber(
      { supabase: adminCompBSupabase, userId: "user-admin-b" },
      { supabaseAdmin: mockAdminSuccess },
    );
    expect(disconnected).toEqual({ companyId: "comp-b", status: "desconectado" });
    expect(companyConnectedState).toBe(false);
  });

  it("FOR-03: preserva body original ('OK' e 'OKK') e parsed.echo_meta em MULTIPLOS_PEDIDOS_ELEGIVEIS, sem duplicar eventos financeiros em retries", async () => {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const now = new Date(`${today}T14:00:00-03:00`);
    const tsSeconds = String(Math.floor(now.getTime() / 1000));

    type StoredMsg = Record<string, unknown>;
    const messageStore = new Map<string, StoredMsg>();
    const financialEvents: Record<string, unknown>[] = [];
    let ordersList: Record<string, unknown>[] = [];

    const mockSupabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "find_customer_by_phone") {
          return {
            data: [{ id: "cust-1", name: "Maria", phone: "11988887777" }],
            error: null,
          };
        }
        if (fn === "financial_echo_context") {
          return { data: null, error: { code: "PGRST202", message: "fallback" } };
        }
        if (fn === "has_inflight_customer_order_message") {
          return { data: false, error: null };
        }
        if (fn === "financial_classify_by_echo") {
          const evId = String(args["_event_id"]);
          const cmd = String(args["_command"]);
          const existingEv = financialEvents.find((e) => e["event_id"] === evId);
          if (existingEv) {
            return {
              data: {
                outcome: "duplicate",
                reason: existingEv["reason"],
                order_id: existingEv["order_id"],
                state: existingEv["final_state"],
                total: existingEv["total"],
                audit_id: existingEv["id"],
              },
              error: null,
            };
          }
          const eligible = ordersList.filter(
            (o) => o["financial_state"] === "aguardando_classificacao" && o["order_date"] === today,
          );
          const outcome = eligible.length === 1 ? "classified" : "blocked";
          const reason =
            eligible.length > 1
              ? "MULTIPLOS_PEDIDOS_ELEGIVEIS"
              : eligible.length === 1
                ? "CONFIRMACAO_VALIDADA"
                : "SEM_PEDIDO_ELEGIVEL";
          const targetOrd = eligible.length === 1 ? eligible[0] : null;
          const newState =
            outcome === "classified" ? (cmd === "OK" ? "pago" : "fiado") : null;
          if (targetOrd && newState) {
            targetOrd["financial_state"] = newState;
          }
          const evRecord = {
            id: `aud-${financialEvents.length + 1}`,
            event_id: evId,
            command: cmd,
            outcome,
            reason,
            order_id: targetOrd ? targetOrd["id"] : null,
            final_state: newState,
            total: targetOrd ? targetOrd["total"] : null,
          };
          financialEvents.push(evRecord);
          return {
            data: {
              outcome,
              reason,
              order_id: evRecord.order_id,
              state: evRecord.final_state,
              total: evRecord.total,
              audit_id: evRecord.id,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      from: (table: string) => {
        if (table === "orders") {
          const chain = {
            select: () => chain,
            eq: () => chain,
            then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
              Promise.resolve(resolve({ data: ordersList, error: null })),
          };
          return chain;
        }
        if (table === "financial_events") {
          let filterEvId = "";
          const chain = {
            select: () => chain,
            eq: (col: string, val: string) => {
              if (col === "event_id") filterEvId = val;
              return chain;
            },
            then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
              Promise.resolve(
                resolve({
                  data: financialEvents.filter((e) => !filterEvId || e["event_id"] === filterEvId),
                  error: null,
                }),
              ),
          };
          return chain;
        }
        if (table === "whatsapp_messages") {
          return {
            upsert: async (row: StoredMsg) => {
              const key = `${row["company_id"]}:${row["message_uid"]}`;
              messageStore.set(key, row);
              return { data: row, error: null };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as never;

    // 1. Uma mensagem OK com exatamente 1 pedido elegível -> classifica normalmente
    ordersList = [
      {
        id: "ord-single",
        company_id: "comp-1",
        customer_id: "cust-1",
        financial_phone: "11988887777",
        order_date: today,
        total: 25,
        financial_state: "aguardando_classificacao",
        delivery_status: "pendente",
        settled_by_payment: false,
      },
    ];
    const singleOk = await processVerifiedBusinessEcho(
      mockSupabase,
      "comp-1",
      {
        messageId: "wamid.single.ok",
        from: "5511900001111",
        to: "5511988887777",
        text: "OK",
        timestamp: tsSeconds,
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
      now,
    );
    expect(singleOk.result?.outcome).toBe("classified");
    expect(singleOk.result?.state).toBe("pago");

    // 2. Uma mensagem OK com múltiplos pedidos elegíveis -> preserva body === "OK" e parsed.echo_meta
    ordersList = [
      {
        id: "ord-m1",
        company_id: "comp-1",
        customer_id: "cust-1",
        financial_phone: "11988887777",
        order_date: today,
        total: 20,
        financial_state: "aguardando_classificacao",
        delivery_status: "pendente",
        settled_by_payment: false,
      },
      {
        id: "ord-m2",
        company_id: "comp-1",
        customer_id: "cust-1",
        financial_phone: "11988887777",
        order_date: today,
        total: 39,
        financial_state: "aguardando_classificacao",
        delivery_status: "pendente",
        settled_by_payment: false,
      },
    ];

    const multiOk = await processVerifiedBusinessEcho(
      mockSupabase,
      "comp-1",
      {
        messageId: "wamid.multi.ok",
        from: "5511900001111",
        to: "5511988887777",
        text: "OK",
        timestamp: tsSeconds,
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
      now,
    );
    expect(multiOk.result?.outcome).toBe("blocked");
    expect(multiOk.result?.reason).toBe("MULTIPLOS_PEDIDOS_ELEGIVEIS");

    const savedOkMsg = messageStore.get("comp-1:echo:wamid.multi.ok");
    expect(savedOkMsg).toBeDefined();
    expect(savedOkMsg?.["body"]).toBe("OK");
    expect(savedOkMsg?.["status"]).toBe("revisar");
    expect(String(savedOkMsg?.["last_error"])).toContain("múltiplos pedidos");
    const parsedOk = savedOkMsg?.["parsed"] as Record<string, unknown>;
    expect(parsedOk?.["motivo"]).toBe("MULTIPLOS_PEDIDOS_ELEGIVEIS");
    expect(parsedOk?.["comando"]).toBe("OK");
    expect((parsedOk?.["echo_meta"] as Record<string, unknown>)?.["messageId"]).toBe(
      "wamid.multi.ok",
    );
    expect((parsedOk?.["echo_meta"] as Record<string, unknown>)?.["text"]).toBe("OK");

    // 3. Uma mensagem OKK com múltiplos pedidos elegíveis -> preserva body === "OKK" e parsed.echo_meta
    const multiOkk = await processVerifiedBusinessEcho(
      mockSupabase,
      "comp-1",
      {
        messageId: "wamid.multi.okk",
        from: "5511900001111",
        to: "5511988887777",
        text: "OKK",
        timestamp: tsSeconds,
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
      now,
    );
    expect(multiOkk.result?.outcome).toBe("blocked");
    expect(multiOkk.result?.reason).toBe("MULTIPLOS_PEDIDOS_ELEGIVEIS");
    const savedOkkMsg = messageStore.get("comp-1:echo:wamid.multi.okk");
    expect(savedOkkMsg?.["body"]).toBe("OKK");
    expect(
      ((savedOkkMsg?.["parsed"] as Record<string, unknown>)?.["echo_meta"] as Record<string, unknown>)?.[
        "text"
      ],
    ).toBe("OKK");

    // 4 & 5. Retry / Reprocessamento da mesma mensagem -> não duplica eventos financeiros e preserva conteúdo
    const eventsCountBeforeRetry = financialEvents.length;
    const retryOk = await processVerifiedBusinessEcho(
      mockSupabase,
      "comp-1",
      {
        messageId: "wamid.multi.ok",
        from: "5511900001111",
        to: "5511988887777",
        text: "OK",
        timestamp: tsSeconds,
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
      now,
    );
    expect(retryOk.result?.outcome).toBe("duplicate");
    expect(financialEvents.length).toBe(eventsCountBeforeRetry);
    expect(messageStore.get("comp-1:echo:wamid.multi.ok")?.["body"]).toBe("OK");
  });

  it("FOR-05: unifica authenticateCronRequest com digest SHA-256 de tamanho fixo e suporte a CRON_SECRET_PREVIOUS (segredo correto, incorreto, antigo, ausente, vazio e formato inválido)", async () => {
    const env = {
      CRON_SECRET: "segredo-atual-super-forte-2026",
      CRON_SECRET_PREVIOUS: "segredo-anterior-rotacao-2025",
    };

    // 1. Segredo atual correto (Authorization: Bearer e x-cron-secret)
    const reqValidBearer = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer segredo-atual-super-forte-2026" },
    });
    expect(authenticateCronRequest(reqValidBearer, env)).toBe(true);
    expect(await cronAuthMiddleware(reqValidBearer, env)).toBeNull();

    const reqValidHeader = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { "x-cron-secret": "segredo-atual-super-forte-2026" },
    });
    expect(authenticateCronRequest(reqValidHeader, env)).toBe(true);

    // 2. Segredo antigo (CRON_SECRET_PREVIOUS) durante rotação -> aceito em ambas as funções
    const reqPrevious = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer segredo-anterior-rotacao-2025" },
    });
    expect(authenticateCronRequest(reqPrevious, env)).toBe(true);
    expect(await cronAuthMiddleware(reqPrevious, env)).toBeNull();

    // 3. Segredo incorreto (de mesmo tamanho ou tamanho diferente) -> rejeitado
    const reqWrong = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer segredo-invalido-curto" },
    });
    expect(authenticateCronRequest(reqWrong, env)).toBe(false);
    const resWrong = await cronAuthMiddleware(reqWrong, env);
    expect(resWrong?.status).toBe(401);

    // 4. Segredo ausente ou vazio no servidor -> rejeitado
    expect(authenticateCronRequest(reqValidBearer, { CRON_SECRET: "" })).toBe(false);
    expect(authenticateCronRequest(reqValidBearer, {})).toBe(false);
    const resNoSecret = await cronAuthMiddleware(reqValidBearer, { CRON_SECRET: "   " });
    expect(resNoSecret?.status).toBe(500);

    // 5. Header ausente, vazio ou formato inválido (múltiplos tokens, vírgula, Basic auth) -> rejeitado
    const reqNoHeader = new Request("http://localhost/api/internal/whatsapp/drain-queue");
    expect(authenticateCronRequest(reqNoHeader, env)).toBe(false);

    const reqEmptyBearer = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer    " },
    });
    expect(authenticateCronRequest(reqEmptyBearer, env)).toBe(false);

    const reqMalformedMulti = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Bearer segredo-atual-super-forte-2026, extra" },
    });
    expect(authenticateCronRequest(reqMalformedMulti, env)).toBe(false);

    const reqBasic = new Request("http://localhost/api/internal/whatsapp/drain-queue", {
      headers: { Authorization: "Basic segredo-atual-super-forte-2026" },
    });
    expect(authenticateCronRequest(reqBasic, env)).toBe(false);
  });

  it("FOR-08 & FOR-09: valida revogação remota de sessão (verifyRemoteSupabaseSession) e autorização operacional obrigatória em interpretMessage", async () => {
    // FOR-08: 1. Sessão válida -> aprovada
    const validAuthClient = {
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: "user-1",
              email: "op@marmita.com",
              user_metadata: { full_name: "Operador" },
              banned_until: null,
            },
          },
          error: null,
        }),
      },
    } as never;
    const verified = await verifyRemoteSupabaseSession(validAuthClient, "user-1", "jwt-token");
    expect(verified.userId).toBe("user-1");

    // FOR-08: 2. Sessão revogada / token inválido -> rejeitada
    const revokedAuthClient = {
      auth: {
        getUser: async () => ({
          data: { user: null },
          error: { message: "Session from session_id claim in JWT does not exist" },
        }),
      },
    } as never;
    await expect(
      verifyRemoteSupabaseSession(revokedAuthClient, "user-1", "jwt-token"),
    ).rejects.toThrow("sessão inválida, expirada ou revogada");

    // FOR-08: 3. Usuário banido (banned_until no futuro) -> rejeitado
    const bannedAuthClient = {
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: "user-1",
              email: "ban@marmita.com",
              banned_until: new Date(Date.now() + 3600_000).toISOString(),
            },
          },
          error: null,
        }),
      },
    } as never;
    await expect(
      verifyRemoteSupabaseSession(bannedAuthClient, "user-1", "jwt-token"),
    ).rejects.toThrow("suspensa ou revogada");

    // FOR-08: 4. Usuário excluído ou sub divergente -> rejeitado
    const deletedUserClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "other-user" } },
          error: null,
        }),
      },
    } as never;
    await expect(
      verifyRemoteSupabaseSession(deletedUserClient, "user-1", "jwt-token"),
    ).rejects.toThrow("sessão inválida, expirada ou revogada");

    // FOR-08: 5. Indisponibilidade do servidor Auth (exceção de rede) -> rejeita por padrão (fail-closed)
    const downAuthClient = {
      auth: {
        getUser: async () => {
          throw new Error("ECONNREFUSED auth server");
        },
      },
    } as never;
    await expect(
      verifyRemoteSupabaseSession(downAuthClient, "user-1", "jwt-token"),
    ).rejects.toThrow("não foi possível validar a sessão");

    // FOR-09: interpretMessage — usuário sem permissão (can_classify = false) -> bloqueado antes de chamar processIncomingMessage
    let processIncomingCalled = false;
    const restrictedOpClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-restricted" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { company_id: "comp-a" }, error: null }),
          }),
        }),
      }),
      rpc: async (fn: string) => {
        expect(fn).toBe("financial_require_operator");
        return { data: null, error: { code: "42501", message: "Permissão financeira necessária" } };
      },
    } as never;

    await expect(
      executeInterpretMessage(
        { supabase: restrictedOpClient, userId: "user-restricted" },
        { phone: "11988887777", body: "2 marmitas G" },
        {
          processIncomingMessageImpl: async () => {
            processIncomingCalled = true;
            return {} as never;
          },
        },
      ),
    ).rejects.toThrow("Permissão financeira/operacional necessária");
    expect(processIncomingCalled).toBe(false);

    // FOR-09: interpretMessage — usuário cuja RPC retorna outra empresa -> bloqueado
    const wrongCompanyRpcClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-cross" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { company_id: "comp-a" }, error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: "comp-b", error: null }),
    } as never;

    await expect(
      authorizeCompanyOperatorOperation({ supabase: wrongCompanyRpcClient, userId: "user-cross" }),
    ).rejects.toThrow("Permissão financeira/operacional necessária");

    // FOR-09: interpretMessage — operador/admin autorizado -> permitido
    const authorizedOpClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-op-ok" } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { company_id: "comp-a" }, error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: "comp-a", error: null }),
    } as never;

    const interpRes = await executeInterpretMessage(
      { supabase: authorizedOpClient, userId: "user-op-ok" },
      {
        phone: "11988887777",
        body: "2 marmitas G",
        externalId: "00000000-0000-4000-8000-000000000123",
      },
      {
        supabaseAdmin: {} as never,
        processIncomingMessageImpl: async (_supa, compId, payload) => {
          processIncomingCalled = true;
          expect(compId).toBe("comp-a");
          expect(payload.externalId).toBe("manual:00000000-0000-4000-8000-000000000123");
          return {
            duplicate: false,
            completedByRpc: true,
            leaseLost: false,
            status: "registrado",
            messageId: "msg-1",
            orderId: "ord-1",
            financialState: "aguardando_classificacao",
            customerName: "Cliente",
            parsed: null,
          };
        },
      },
    );
    expect(processIncomingCalled).toBe(true);
    expect(interpRes.orderId).toBe("ord-1");
  });

  it("FOR-10: resolve colisão em activeInProcessMessageLocks quando o PostgreSQL emite lease_generation superior após retry manual, bloqueando geração obsoleta (fencing token monotônico)", () => {
    const msgId = "00000000-0000-4000-8000-00000000f010";
    const t0 = 1_700_000_000_000;

    // 1. Worker A adquire geração 1 (válida por 90s)
    const lock1 = acquireInProcessMessageLock(msgId, "worker-A", 90, t0, 1);
    expect(lock1).toEqual({ acquired: true, leaseGeneration: 1 });

    // 2. Worker B tenta adquirir com a MESMA geração 1 (ou sem geração) enquanto o lease de A está ativo -> bloqueado
    const lockSameGen = acquireInProcessMessageLock(msgId, "worker-B", 90, t0 + 5_000, 1);
    expect(lockSameGen.acquired).toBe(false);
    expect(lockSameGen.leaseGeneration).toBe(1);

    const lockNoGen = acquireInProcessMessageLock(msgId, "worker-B", 90, t0 + 5_000);
    expect(lockNoGen.acquired).toBe(false);

    // 3. Operador aciona retry manual no banco -> PostgreSQL incrementa lease_generation = 2 e reclama para Worker B
    const lockGen2 = acquireInProcessMessageLock(msgId, "worker-B", 90, t0 + 10_000, 2);
    expect(lockGen2).toEqual({ acquired: true, leaseGeneration: 2 });

    // 4. Worker A antigo não consegue renovar nem substituir a geração 2 com geração 1 (mesmo após expirar o tempo!)
    expect(renewInProcessMessageLock(msgId, "worker-A", 90, t0 + 15_000, 1)).toBe(false);
    const staleAttemptAfterExpiry = acquireInProcessMessageLock(
      msgId,
      "worker-A",
      90,
      t0 + 200_000,
      1,
    );
    expect(staleAttemptAfterExpiry.acquired).toBe(false);
    expect(staleAttemptAfterExpiry.leaseGeneration).toBe(2);

    releaseInProcessMessageLock(msgId, "worker-B", 2);
  });

  it("FOR-11: oculta contagens internas da fila e configuredIntegrations na resposta pública de /api/public/health, mantendo detalhes para monitor autenticado com CRON_SECRET", async () => {
    resetPublicHealthCacheForTest();
    const prevCron = process.env["CRON_SECRET"];
    process.env["CRON_SECRET"] = "health-monitor-secret-2026";

    try {
      // Chamada pública sem CRON_SECRET -> retorna apenas { status, checkedAt }, sem queue nem configuredIntegrations
      const pubReq = new Request("http://localhost/api/public/health");
      const pubRes = await handleHealthRequest(pubReq);
      const pubJson = (await pubRes.json()) as Record<string, unknown>;

      expect(["ok", "degraded", "down"]).toContain(pubJson["status"]);
      expect(typeof pubJson["checkedAt"]).toBe("string");
      expect(pubJson["queue"]).toBeUndefined();
      expect(pubJson["configuredIntegrations"]).toBeUndefined();
      expect(pubJson["error"]).toBeUndefined();
    } finally {
      if (prevCron === undefined) {
        delete process.env["CRON_SECRET"];
      } else {
        process.env["CRON_SECRET"] = prevCron;
      }
      resetPublicHealthCacheForTest();
    }
  });

  it("FOR-02, FOR-04, FOR-06, FOR-07 & FOR-12: valida contratos SQL na migration 0018, suíte de homologação e preservação das migrations históricas 0000-0017", () => {
    // FOR-02: Privilégios restritos por coluna e trigger a_customers_guard_protected_fields em public.customers
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.customers FROM anon, authenticated;",
    );
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "GRANT UPDATE (name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;",
    );
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "CREATE OR REPLACE FUNCTION public.guard_customers_protected_fields()",
    );
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "CREATE TRIGGER a_customers_guard_protected_fields",
    );

    // FOR-04: Revogação de financial_create_pending para authenticated e endurecimento de get_or_create_customer_by_phone / has_role
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "REVOKE ALL ON FUNCTION public.financial_create_pending(uuid, integer, integer, uuid, integer) FROM PUBLIC, anon, authenticated;",
    );
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "GRANT EXECUTE ON FUNCTION public.financial_create_pending(uuid, integer, integer, uuid, integer) TO service_role;",
    );

    // FOR-06: Uso de (SELECT public.current_company_id()) e (SELECT auth.uid()) nas policies RLS
    expect(MIGRATION_0018_NOCOMMENTS).toContain("USING (company_id = (SELECT public.current_company_id()))");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("USING (user_id = (SELECT auth.uid()))");

    // FOR-07: Criação dos 6 índices de FKs e ON DELETE SET NULL para auth.users(id)
    expect(MIGRATION_0018_NOCOMMENTS).toContain("CREATE INDEX IF NOT EXISTS financial_events_order_id_idx");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("CREATE INDEX IF NOT EXISTS financial_events_company_customer_idx");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("CREATE INDEX IF NOT EXISTS payment_attempts_company_customer_idx");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("CREATE INDEX IF NOT EXISTS payment_attempts_payment_id_idx");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("CREATE INDEX IF NOT EXISTS whatsapp_messages_last_manual_retry_by_idx");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("CREATE INDEX IF NOT EXISTS whatsapp_manual_retry_audit_actor_id_idx");
    expect(MIGRATION_0018_NOCOMMENTS).toContain("REFERENCES auth.users(id) ON DELETE SET NULL");

    // FOR-12: Exigência de is_company_admin em lgpd_anonymize_customer_pii e inclusão de revisar/erro em lgpd_purge_expired_message_bodies
    expect(MIGRATION_0018_NOCOMMENTS).toContain("IF NOT public.is_company_admin(comp) THEN");
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "AND m.status IN ('registrado', 'ignorado', 'revisar', 'erro')",
    );
    expect(MIGRATION_0018_NOCOMMENTS).toContain(
      "AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp())",
    );

    const journalRaw = readFileSync(
      resolve(ROOT, "drizzle/migrations/meta/_journal.json"),
      "utf8",
    );
    expect(journalRaw).toContain('"tag": "0018_argon4_forensic_audit_hardening"');
  });


  it("C-09 / M-02 (FQ-01 a FQ-18): garante claim fail-closed sem fallback SELECT+UPDATE, fencing token monotônico, heartbeat validado e finalização idempotente", async () => {
    resetInProcessMessageLocksForTest();
    const futureIso = () => new Date(Date.now() + 90_000).toISOString();

    // Verifica estaticamente que o fallback if (!usedRpc) foi 100% removido de whatsapp-webhook.server.ts
    const webhookSrc = readFileSync(resolve(ROOT, "src/lib/whatsapp-webhook.server.ts"), "utf8");
    expect(webhookSrc).not.toContain("if (!usedRpc)");
    expect(webhookSrc).not.toContain("Fallback abaixo para ambientes de teste mockados sem a RPC");
    expect(webhookSrc).not.toContain("Fallback para clientes mockados: verifica a posse de locked_by");
    expect(MIGRATION_0019_NOCOMMENTS).toContain("OR _lease_generation IS NULL");
    expect(MIGRATION_0019_NOCOMMENTS).toContain("OR _lease_generation < 1 THEN");
    expect(MIGRATION_0019_NOCOMMENTS).toContain("AND lease_generation = _lease_generation");

    // Helper que rastreia se algum SELECT/UPDATE direto foi tentado em whatsapp_messages
    function createStrictMockSupabase(rpcHandler: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>) {
      let directTableTouchCount = 0;
      const client = {
        getDirectTouchCount: () => directTableTouchCount,
        rpc: rpcHandler,
        from: (table: string) => {
          if (table === "whatsapp_messages") {
            return {
              select: () => ({
                is: () => {
                  directTableTouchCount++;
                  throw new Error("FALLBACK_PROIBIDO: SELECT direto na fila whatsapp_messages não pode ocorrer!");
                },
                eq: (col: string, val: string) => ({
                  maybeSingle: async () => ({
                    data: {
                      id: val,
                      status: "processando",
                      order_id: null,
                      locked_by: "worker-fq01",
                      lease_generation: 1,
                      locked_until: futureIso(),
                    },
                    error: null,
                  }),
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
              update: () => {
                directTableTouchCount++;
                throw new Error("FALLBACK_PROIBIDO: UPDATE direto em whatsapp_messages não pode ocorrer!");
              },
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      };
      return client;
    }

    // FQ-01: RPC de claim retorna sucesso e geração válida -> Mensagem adquirida e processada
    let fq01ReleasedGen: number | null = null;
    const fq01Mock = createStrictMockSupabase(async (fn, args) => {
      if (fn === "claim_whatsapp_queue_batch") {
        return {
          data: [
            {
              id: "msg-fq-01",
              company_id: "comp-1",
              phone: "11988887777",
              direction: "inbound",
              body: "OK",
              status: "processando",
              order_id: null,
              locked_by: String(args["_worker_id"]),
              locked_until: futureIso(),
              lease_generation: 1,
              attempts: 1,
              manual_retry_count: 0,
              source: "whatsapp_cloud",
              message_uid: "wa:fq-01",
            },
          ],
          error: null,
        };
      }
      if (fn === "release_whatsapp_message_lock") {
        fq01ReleasedGen = Number(args["_lease_generation"]);
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });

    const fq01Res = await drainWhatsAppQueue({
      workerId: "worker-fq01",
      supabase: fq01Mock as never,
    });
    expect(fq01Res.claimed).toBe(1);
    expect(fq01Res.processed).toBe(1);
    expect(fq01ReleasedGen).toBe(1);
    expect(fq01Mock.getDirectTouchCount()).toBe(0);

    // FQ-02: RPC retorna erro -> Processamento interrompido sem fallback
    const fq02Mock = createStrictMockSupabase(async () => ({
      data: null,
      error: { code: "42501", message: "permission denied for function claim_whatsapp_queue_batch" },
    }));
    await expect(
      drainWhatsAppQueue({ workerId: "worker-fq02", supabase: fq02Mock as never }),
    ).rejects.toThrow(/Falha segura no claim da fila WhatsApp/);
    expect(fq02Mock.getDirectTouchCount()).toBe(0);

    // FQ-03: RPC retorna timeout -> Processamento interrompido sem fallback
    const fq03Mock = createStrictMockSupabase(async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    await expect(
      drainWhatsAppQueue({ workerId: "worker-fq03", supabase: fq03Mock as never }),
    ).rejects.toThrow(/Falha segura no claim da fila WhatsApp/);
    expect(fq03Mock.getDirectTouchCount()).toBe(0);

    // FQ-04: RPC retorna resultado vazio -> Processamento interrompido (0 reclamadas, 0 processadas, 0 SELECT/UPDATE)
    const fq04Mock = createStrictMockSupabase(async () => ({ data: [], error: null }));
    const fq04Res = await drainWhatsAppQueue({
      workerId: "worker-fq04",
      supabase: fq04Mock as never,
    });
    expect(fq04Res).toEqual({ claimed: 0, processed: 0, failed: 0, workerId: "worker-fq04" });
    expect(fq04Mock.getDirectTouchCount()).toBe(0);

    // FQ-05: RPC retorna geração inválida (0, null, NaN) ou sem confirmação de locked_by -> Processamento interrompido
    for (const invalidGen of [0, -1, null, undefined, NaN]) {
      const fq05Mock = createStrictMockSupabase(async (_fn, args) => ({
        data: [
          {
            id: "msg-fq-05",
            company_id: "comp-1",
            phone: "11988887777",
            direction: "inbound",
            body: "2 marmitas G",
            status: "processando",
            order_id: null,
            locked_by: String(args["_worker_id"]),
            locked_until: futureIso(),
            lease_generation: invalidGen,
          },
        ],
        error: null,
      }));
      await expect(
        drainWhatsAppQueue({ workerId: "worker-fq05", supabase: fq05Mock as never }),
      ).rejects.toThrow(/confirmação de posse ou lease_generation inválida/);
      expect(fq05Mock.getDirectTouchCount()).toBe(0);
    }

    // FQ-06: RPC de claim indisponível (cliente sem método rpc) -> Nenhum fallback direto
    let fq06DirectCalled = false;
    const fq06NoRpcClient = {
      from: () => {
        fq06DirectCalled = true;
        throw new Error("Fallback proibido");
      },
    } as never;
    await expect(
      drainWhatsAppQueue({ workerId: "worker-fq06", supabase: fq06NoRpcClient }),
    ).rejects.toThrow(/claim_whatsapp_queue_batch indisponível/);
    expect(fq06DirectCalled).toBe(false);

    // FQ-07, FQ-08, FQ-09, FQ-10, FQ-11, FQ-14 & FQ-16: Ciclo completo de disputa entre Worker A (gen 1) e Worker B (gen 2 após expiração)
    resetInProcessMessageLocksForTest();
    const disputedMsgId = "msg-fq-disputed";
    let dbLeaseState = {
      status: "processando",
      locked_by: "worker-A",
      lease_generation: 1,
      locked_until: futureIso(),
      order_id: null as string | null,
    };

    const disputedMockSupabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "renew_whatsapp_message_lock") {
          const w = String(args["_worker_id"]);
          const g = Number(args["_lease_generation"]);
          if (
            dbLeaseState.status === "processando" &&
            dbLeaseState.order_id === null &&
            dbLeaseState.locked_by === w &&
            dbLeaseState.lease_generation === g &&
            Date.parse(dbLeaseState.locked_until) > Date.now()
          ) {
            dbLeaseState.locked_until = futureIso();
            return { data: true, error: null };
          }
          return { data: false, error: null };
        }
        if (fn === "release_whatsapp_message_lock") {
          const w = String(args["_worker_id"]);
          const g = Number(args["_lease_generation"]);
          if (
            dbLeaseState.status === "processando" &&
            dbLeaseState.order_id === null &&
            dbLeaseState.locked_by === w &&
            dbLeaseState.lease_generation === g
          ) {
            dbLeaseState.status = String(args["_final_status"]);
            dbLeaseState.locked_by = "";
            return { data: true, error: null };
          }
          return { data: false, error: null };
        }
        return { data: null, error: null };
      },
    } as never;

    // FQ-07: Worker A adquire geração 1 e consegue renovar enquanto detiver a propriedade
    const claimA = acquireInProcessMessageLock(disputedMsgId, "worker-A", 60, Date.now(), 1);
    expect(claimA).toEqual({ acquired: true, leaseGeneration: 1 });
    expect(hasActiveInProcessMessageLock(disputedMsgId, "worker-A", 1)).toBe(true);
    const renewAOk = await renewWhatsAppMessageLockSafe(
      disputedMockSupabase,
      disputedMsgId,
      "worker-A",
      60,
      1,
    );
    expect(renewAOk).toBe(true);

    // FQ-08 & FQ-16: Lease de A expira no banco e Worker B recupera pelo mecanismo oficial com geração 2
    dbLeaseState = {
      status: "processando",
      locked_by: "worker-B",
      lease_generation: 2,
      locked_until: futureIso(),
      order_id: null,
    };
    const claimB = acquireInProcessMessageLock(disputedMsgId, "worker-B", 60, Date.now(), 2);
    expect(claimB).toEqual({ acquired: true, leaseGeneration: 2 });
    expect(hasActiveInProcessMessageLock(disputedMsgId, "worker-A", 1)).toBe(false);
    expect(hasActiveInProcessMessageLock(disputedMsgId, "worker-B", 2)).toBe(true);

    // FQ-10: Worker A tenta renovar usando geração 1 -> Operação rejeitada
    const renewAStale = await renewWhatsAppMessageLockSafe(
      disputedMockSupabase,
      disputedMsgId,
      "worker-A",
      60,
      1,
    );
    expect(renewAStale).toBe(false);

    // FQ-09 & FQ-14: Worker A tenta finalizar/alterar estado usando geração 1 -> Operação rejeitada
    const finalizeAStale = await releaseWhatsAppMessageLockSafe(
      disputedMockSupabase,
      disputedMsgId,
      "worker-A",
      "erro",
      { leaseGeneration: 1, lastError: "Tentativa obsoleta do Worker A" },
    );
    expect(finalizeAStale).toBe(false);
    expect(dbLeaseState.status).toBe("processando");
    expect(dbLeaseState.locked_by).toBe("worker-B");

    // FQ-11: Worker B finaliza usando geração 2 -> Operação aceita
    const finalizeBOk = await releaseWhatsAppMessageLockSafe(
      disputedMockSupabase,
      disputedMsgId,
      "worker-B",
      "registrado",
      { leaseGeneration: 2 },
    );
    expect(finalizeBOk).toBe(true);
    expect(dbLeaseState.status).toBe("registrado");

    // FQ-12: Dois workers tentam adquirir a mesma mensagem simultaneamente -> Apenas um adquire
    resetInProcessMessageLocksForTest();
    const simMsgId = "msg-fq-12-simultaneous";
    const [simW1, simW2] = [
      acquireInProcessMessageLock(simMsgId, "worker-sim-1", 60, Date.now(), 1),
      acquireInProcessMessageLock(simMsgId, "worker-sim-2", 60, Date.now(), 1),
    ];
    expect(simW1.acquired).toBe(true);
    expect(simW2.acquired).toBe(false);

    // FQ-13: Heartbeat falha durante processamento -> Worker perde autorização para continuar imediatamente
    resetInProcessMessageLocksForTest();
    let fq13Finalized = false;
    const fq13Mock = createStrictMockSupabase(async (fn, args) => {
      if (fn === "claim_whatsapp_queue_batch") {
        return {
          data: [
            {
              id: "msg-fq-13",
              company_id: "comp-1",
              phone: "11988887777",
              direction: "outbound",
              body: "OK",
              status: "processando",
              order_id: null,
              locked_by: String(args["_worker_id"]),
              locked_until: futureIso(),
              lease_generation: 1,
              attempts: 1,
              source: "whatsapp_echo",
              message_uid: "echo:fq-13",
            },
          ],
          error: null,
        };
      }
      if (fn === "renew_whatsapp_message_lock") {
        // Simula perda de lease no heartbeat
        return { data: false, error: null };
      }
      if (fn === "find_customer_by_phone") {
        // Aguarda o heartbeat de 15ms disparar e falhar durante o processamento
        await new Promise((r) => setTimeout(r, 35));
        return { data: [{ id: "cust-1", name: "Cliente", phone: "11988887777" }], error: null };
      }
      if (fn === "release_whatsapp_message_lock") {
        fq13Finalized = true;
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });

    const fq13Res = await drainWhatsAppQueue({
      workerId: "worker-fq13",
      heartbeatIntervalMs: 12,
      supabase: fq13Mock as never,
    });
    expect(fq13Res.claimed).toBe(1);
    expect(fq13Res.processed).toBe(0);
    expect(fq13Finalized).toBe(false);

    // FQ-15: Banco indisponível durante claim -> Falha segura, sem processamento
    const fq15Mock = createStrictMockSupabase(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:5432");
    });
    await expect(
      drainWhatsAppQueue({ workerId: "worker-fq15", supabase: fq15Mock as never }),
    ).rejects.toThrow(/Falha segura no claim da fila WhatsApp/);
    expect(fq15Mock.getDirectTouchCount()).toBe(0);

    // FQ-17: RPC retorna geração antiga (1 depois que a geração 2 já foi registrada) -> Aquisição rejeitada
    resetInProcessMessageLocksForTest();
    acquireInProcessMessageLock("msg-fq-17", "worker-new", 60, Date.now(), 2);
    const fq17Mock = createStrictMockSupabase(async (_fn, args) => ({
      data: [
        {
          id: "msg-fq-17",
          company_id: "comp-1",
          phone: "11988887777",
          direction: "inbound",
          body: "OK",
          status: "processando",
          order_id: null,
          locked_by: String(args["_worker_id"]),
          locked_until: futureIso(),
          lease_generation: 1, // geração antiga (1 < 2)
        },
      ],
      error: null,
    }));
    await expect(
      drainWhatsAppQueue({ workerId: "worker-stale-rpc", supabase: fq17Mock as never }),
    ).rejects.toThrow(/fencing token rejeitado/);

    // FQ-18: Finalização duplicada -> Resultado idempotente, sem efeitos financeiros duplicados
    resetInProcessMessageLocksForTest();
    acquireInProcessMessageLock("msg-fq-18", "worker-fq18", 60, Date.now(), 3);
    let fq18ReleaseCommits = 0;
    const fq18Mock = {
      rpc: async (fn: string) => {
        if (fn === "release_whatsapp_message_lock") {
          if (fq18ReleaseCommits === 0) {
            fq18ReleaseCommits++;
            return { data: true, error: null };
          }
          return { data: false, error: null };
        }
        return { data: null, error: null };
      },
    } as never;

    const firstRelease = await releaseWhatsAppMessageLockSafe(
      fq18Mock,
      "msg-fq-18",
      "worker-fq18",
      "registrado",
      { leaseGeneration: 3, orderId: "ord-fq-18" },
    );
    const secondDuplicateRelease = await releaseWhatsAppMessageLockSafe(
      fq18Mock,
      "msg-fq-18",
      "worker-fq18",
      "registrado",
      { leaseGeneration: 3, orderId: "ord-fq-18" },
    );
    expect(firstRelease).toBe(true);
    expect(secondDuplicateRelease).toBe(false);
    expect(fq18ReleaseCommits).toBe(1);
  });


  it("Missão 03 (M03-01 a M03-26 — AUD-M02-01 a AUD-M02-05): valida expiração temporal em release/complete, normalizador seguro de bigint, fencing transacional em ecos OK/OKK, documentação de permissões e pipeline reproduzível", async () => {
    resetInProcessMessageLocksForTest();
    const futureIso = (sec = 60) => new Date(Date.now() + sec * 1000).toISOString();
    const pastIso = (sec = 10) => new Date(Date.now() - sec * 1000).toISOString();

    const migration0020 = readFileSync(
      resolve(ROOT, "drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql"),
      "utf8",
    );
    const mig0020NoComments = stripSqlComments(migration0020);

    // M03-01 a M03-05: Validade temporal e fencing em release_whatsapp_message_lock
    expect(mig0020NoComments).toContain("AND locked_until IS NOT NULL");
    expect(mig0020NoComments).toContain("AND locked_until >= clock_timestamp();");

    // M03-06 a M03-12: Validade temporal e fencing em complete_whatsapp_message_order
    expect(mig0020NoComments).toContain("IF msg.locked_until IS NULL OR msg.locked_until < clock_timestamp() THEN");
    expect(mig0020NoComments).toContain("MESSAGE_LEASE_LOST: lease expirado ou nulo para mensagem");

    // M03-13 & M03-14: Normalizador estrito de bigint (normalizeFencingGeneration)
    expect(normalizeFencingGeneration(1)).toBe(1);
    expect(normalizeFencingGeneration("1")).toBe(1);
    expect(normalizeFencingGeneration("2")).toBe(2);
    expect(normalizeFencingGeneration(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeFencingGeneration(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);

    for (const invalidVal of [
      0,
      "0",
      -1,
      "-1",
      1.5,
      "1.5",
      "1e3",
      "",
      " ",
      " 1",
      "1 ",
      "+1",
      "01",
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "9007199254740992",
      "9007199254740993",
    ]) {
      expect(normalizeFencingGeneration(invalidVal)).toBeNull();
      expect(isValidFencingGeneration(invalidVal)).toBe(false);
    }

    // M03-15: Pipeline aceita e normaliza lease_generation retornado como string "1" / "2"
    resetInProcessMessageLocksForTest();
    const lockFromStr = acquireInProcessMessageLock("msg-m03-str", "worker-str", 60, Date.now(), "1");
    expect(lockFromStr).toEqual({ acquired: true, leaseGeneration: 1 });
    expect(hasActiveInProcessMessageLock("msg-m03-str", "worker-str", "1")).toBe(true);
    expect(renewInProcessMessageLock("msg-m03-str", "worker-str", 60, Date.now(), "1")).toBe(true);
    expect(releaseInProcessMessageLock("msg-m03-str", "worker-str", "1")).toBe(true);

    // M03-16 a M03-24: Sequência completa de disputa de eco comercial OK/OKK (Worker A gen 1 perde lease durante financial_echo_context -> Worker B assume com gen 2 -> A é bloqueado -> B conclui)
    resetInProcessMessageLocksForTest();
    const echoMsgId = "11111111-2222-4333-8444-555555555555";
    const companyId = "comp-m03";
    const customerId = "cust-m03";
    const orderId = "ord-m03-1";
    const nowDate = new Date("2026-11-10T15:00:00.000Z");
    const tsSeconds = String(Math.floor(nowDate.getTime() / 1000));

    let echoLeaseRow = {
      id: echoMsgId,
      status: "processando",
      order_id: null as string | null,
      locked_by: "worker-A",
      lease_generation: 1 as number | string,
      locked_until: futureIso(60),
    };
    const committedEchoCalls: Array<{ workerId: unknown; gen: unknown; cmd: unknown }> = [];

    acquireInProcessMessageLock(echoMsgId, "worker-A", 60, Date.now(), 1);

    const echoDisputeSupabase = {
      from: (table: string) => {
        if (table === "whatsapp_messages") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { ...echoLeaseRow }, error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "find_customer_by_phone") {
          return {
            data: [{ id: customerId, name: "Cliente M03", phone: "5511988887777" }],
            error: null,
          };
        }
        if (fn === "financial_echo_context") {
          // Simula que durante a consulta de contexto do Worker A (gen 1), o lease de A expira e Worker B assume com geração 2!
          if (echoLeaseRow.locked_by === "worker-A" && Number(echoLeaseRow.lease_generation) === 1) {
            echoLeaseRow = {
              id: echoMsgId,
              status: "processando",
              order_id: null,
              locked_by: "worker-B",
              lease_generation: 2,
              locked_until: futureIso(60),
            };
            acquireInProcessMessageLock(echoMsgId, "worker-B", 60, Date.now(), 2);
          }
          return {
            data: {
              body: args["_command"],
              eventId: args["_event_id"],
              source: "verified_business_echo",
              actorAuthorized: true,
              provenanceVerified: true,
              standalone: true,
              quoted: false,
              forwarded: false,
              companyId,
              customerId,
              conversationId: `wa:${companyId}:${customerId}`,
              phone: "5511988887777",
              today: "2026-11-10",
              commandDate: "2026-11-10",
              explicitOrderId: null,
              processedEventIds: [],
              orders: [
                {
                  id: orderId,
                  companyId,
                  customerId,
                  conversationId: `wa:${companyId}:${customerId}`,
                  phone: "5511988887777",
                  date: "2026-11-10",
                  total: 25,
                  state: "PENDENTE",
                  cancelled: false,
                  paymentState: "NONE",
                  confirmed: false,
                },
              ],
            },
            error: null,
          };
        }
        if (fn === "financial_classify_by_echo") {
          if (
            echoLeaseRow.locked_by !== args["_worker_id"] ||
            Number(echoLeaseRow.lease_generation) !== Number(args["_lease_generation"]) ||
            Date.parse(echoLeaseRow.locked_until) <= Date.now()
          ) {
            return {
              data: null,
              error: { code: "55P03", message: "MESSAGE_LEASE_LOST: worker or generation mismatch" },
            };
          }
          committedEchoCalls.push({
            workerId: args["_worker_id"],
            gen: args["_lease_generation"],
            cmd: args["_command"],
          });
          return {
            data: {
              outcome: "classified",
              reason: "CONFIRMACAO_VALIDADA",
              order_id: orderId,
              state: args["_command"] === "OK" ? "pago" : "fiado",
              total: 25,
              audit_id: "audit-m03-1",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    } as never;

    // Worker A tenta concluir o eco OK após perder o lease durante financial_echo_context -> bloqueado!
    const workerAEchoRes = await processVerifiedBusinessEcho(
      echoDisputeSupabase,
      companyId,
      {
        messageId: "wamid.m03.disputed",
        from: "5511900001111",
        to: "5511988887777",
        text: "OK",
        timestamp: tsSeconds,
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
      nowDate,
      {
        skipDirectMessageUpsert: true,
        messageId: echoMsgId,
        workerId: "worker-A",
        leaseGeneration: 1,
      },
    );
    expect((workerAEchoRes as { leaseLost?: boolean }).leaseLost).toBe(true);
    expect(committedEchoCalls.length).toBe(0);

    // Worker B (detentor legítimo da geração 2) executa e conclui com sucesso!
    const workerBEchoRes = await processVerifiedBusinessEcho(
      echoDisputeSupabase,
      companyId,
      {
        messageId: "wamid.m03.disputed",
        from: "5511900001111",
        to: "5511988887777",
        text: "OK",
        timestamp: tsSeconds,
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
      nowDate,
      {
        skipDirectMessageUpsert: true,
        messageId: echoMsgId,
        workerId: "worker-B",
        leaseGeneration: "2", // testando também normalização de string "2" -> 2
      },
    );
    expect((workerBEchoRes as { leaseLost?: boolean }).leaseLost).toBeUndefined();
    expect(committedEchoCalls).toEqual([{ workerId: "worker-B", gen: 2, cmd: "OK" }]);
  });

  it("Missão 07 (AF-01 a AF-11): valida proteção de lease na reentrega (AF-01), fila durável e cron (AF-02), retry manual fail-closed (AF-06), mutações via Server Functions (AF-07), financial_register_payment (AF-08), rate limit/replay (AF-05), lanes concorrentes (AF-09), LGPD (AF-10) e CI (AF-11)", async () => {
    const mig0021 = readFileSync(
      resolve(ROOT, "drizzle/migrations/0021_argon4_missao07_af01_af10_hardening.sql"),
      "utf8",
    ).replace(/--.*$/gm, "");

    // AF-01: RPC transacional de reentrega protegendo leases ativos
    expect(mig0021).toContain("CREATE OR REPLACE FUNCTION public.requeue_errored_whatsapp_webhook_message");
    expect(mig0021).toContain("ACTIVE_LEASE_PROTECTED");
    expect(mig0021).toContain("REVOKE ALL ON FUNCTION public.requeue_errored_whatsapp_webhook_message(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;");

    // AF-06: evaluateManualRetryPreparationOutcome é 100% fail-closed
    expect(evaluateManualRetryPreparationOutcome(null, { code: "PGRST202", message: "Missing" }).allowed).toBe(false);
    expect(evaluateManualRetryPreparationOutcome(null, { code: "42883", message: "Undefined function" }).allowed).toBe(false);
    expect(evaluateManualRetryPreparationOutcome(null, null).allowed).toBe(false);
    expect(evaluateManualRetryPreparationOutcome({}, null).allowed).toBe(false);
    expect(evaluateManualRetryPreparationOutcome(123, null).allowed).toBe(false);
    expect(
      evaluateManualRetryPreparationOutcome(
        { authorized: true, outcome: "authorized", updated_count: 2 },
        null,
      ),
    ).toEqual({ allowed: true, updatedCount: 2 });

    // AF-07: whatsapp.tsx e clientes.tsx sem mutações diretas pelo browser
    const waRoute = readFileSync(resolve(ROOT, "src/routes/_authenticated/whatsapp.tsx"), "utf8");
    const cliRoute = readFileSync(resolve(ROOT, "src/routes/_authenticated/clientes.tsx"), "utf8");
    expect(waRoute).not.toContain(".from(\"companies\")");
    expect(waRoute).not.toContain(".from(\"whatsapp_messages\")");
    expect(cliRoute).not.toContain(".from(\"customers\")");

    // AF-08: financial_register_payment oficial e revogação de register_payment para authenticated
    expect(mig0021).toContain("CREATE OR REPLACE FUNCTION public.financial_register_payment");
    expect(mig0021).toContain(
      "REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;",
    );
    expect(mig0021).toContain(
      "GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text, text) TO service_role;",
    );

    // AF-10: Auditoria LGPD imutável e funções canônicas
    expect(mig0021).toContain("CREATE TABLE IF NOT EXISTS public.lgpd_lifecycle_audit");
    expect(mig0021).toContain("CREATE OR REPLACE FUNCTION public.lgpd_anonymize_customer");
    expect(mig0021).toContain("CREATE OR REPLACE FUNCTION public.lgpd_purge_expired_operational_data");
  });

  it("Missão 07.2 (Migration 0022): comprova correção de REG-M07-01, REG-M07-02, AUD-07.1-01..08 e AF-01..AF-10", () => {
    const mig0022 = readFileSync(
      resolve(ROOT, "drizzle/migrations/0022_argon4_missao07_2_surgical_remediation.sql"),
      "utf8",
    ).replace(/--.*$/gm, "");

    // AUD-07.1-01 & AUD-07.1-02: constraint locked_until não nulo em processando, backoff respeitado e incremento de lease_generation
    expect(mig0022).toContain("ADD CONSTRAINT whatsapp_messages_processing_requires_lease_chk");
    expect(mig0022).toContain("CHECK (status <> 'processando' OR locked_until IS NOT NULL)");
    expect(mig0022).toContain("'reason', 'BACKOFF_NOT_ELAPSED'");
    expect(mig0022).toContain("THEN coalesce(v_msg.lease_generation, 0) + 1");

    // AUD-07.1-04: rate limit distribuído no PostgreSQL
    expect(mig0022).toContain("CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_rate_limits");
    expect(mig0022).toContain("CREATE OR REPLACE FUNCTION public.check_whatsapp_webhook_rate_limit");

    // REG-M07-01: restauração dos grants por coluna para authenticated
    expect(mig0022).toContain("GRANT UPDATE (status) ON public.whatsapp_messages TO authenticated;");
    expect(mig0022).toContain(
      "GRANT UPDATE (name, phone, default_unit_price, price_p, price_m, price_g) ON public.companies TO authenticated;",
    );
    expect(mig0022).toContain(
      "GRANT INSERT (id, company_id, name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;",
    );
    expect(mig0022).toContain(
      "GRANT UPDATE (name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;",
    );

    // AUD-07.1-06: caminho explícito para service_role em financial_register_payment vinculado ao cliente
    expect(mig0022).toContain("ELSIF current_user IN ('service_role', 'postgres')");
    expect(mig0022).toContain("SELECT c.company_id INTO comp");

    // REG-M07-02 & AUD-07.1-08: ON DELETE SET NULL em customer_id permitido no trigger e estado persistente de scheduler
    expect(mig0022).toContain("AND OLD.customer_id IS NOT NULL");
    expect(mig0022).toContain("AND NEW.customer_id IS NULL");
    expect(mig0022).toContain("AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = OLD.customer_id)");
    expect(mig0022).toContain("CREATE TABLE IF NOT EXISTS public.operational_scheduler_state");
    expect(mig0022).toContain("IF (v_purged_msgs + v_purged_attempt_notes) > 0 THEN");
  });
it("Missão 07.4 (Migration 0023): comprova correção de AUD-07.3-01 (extractBusinessEchoes), AUD-07.3-02 (financial_register_payment SECURITY INVOKER + dual SECURITY DEFINER), AUD-07.3-04 (lgpd_purge_expired_message_bodies REVOKE) e AUD-07.3-05 (política explícita de IP)", async () => {
    const mig0023 = readFileSync(
      resolve(ROOT, "drizzle/migrations/0023_argon4_missao07_4_security_and_regression_fixes.sql"),
      "utf8",
    ).replace(/--.*$/gm, "");

    // AUD-07.3-02: separação de ACL entre _as_operator e _as_service + dispatcher SECURITY INVOKER
    expect(mig0023).toContain("CREATE OR REPLACE FUNCTION public._financial_register_payment_as_operator");
    expect(mig0023).toContain("CREATE OR REPLACE FUNCTION public._financial_register_payment_as_service");
    expect(mig0023).toContain(
      "REVOKE ALL ON FUNCTION public._financial_register_payment_as_service(uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;",
    );
    expect(mig0023).toContain(
      "GRANT EXECUTE ON FUNCTION public._financial_register_payment_as_service(uuid, numeric, text, text, text) TO service_role;",
    );

    // AUD-07.3-04: revogação de EXECUTE direto em lgpd_purge_expired_message_bodies para authenticated
    expect(mig0023).toContain(
      "REVOKE ALL ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) FROM PUBLIC, anon, authenticated;",
    );
    expect(mig0023).toContain(
      "GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) TO service_role;",
    );

    // AUD-07.3-01: extractBusinessEchoes preserva phoneNumberId e encaminha OK/OKK para enqueueMetaBusinessEchoes
    // Uses top-level imported extractBusinessEchoes & extractTrustedClientIpKey
    const nowSec = Math.floor(Date.now() / 1000);
    const echoes = extractBusinessEchoes({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-m074",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: "phone-m074" },
                message_echoes: [
                  {
                    id: "wamid.m074.ok",
                    from: "+55 (11) 3333-4444",
                    to: "+55 (11) 98888-7777",
                    timestamp: String(nowSec - 5),
                    type: "text",
                    text: { body: "OK" },
                  },
                  {
                    id: "wamid.m074.okk",
                    from: "+55 (11) 3333-4444",
                    recipient_id: "+55 (11) 97777-6666",
                    timestamp: String(nowSec - 3),
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
    expect(echoes).toHaveLength(2);
    expect(echoes[0]?.phoneNumberId).toBe("phone-m074");
    expect(echoes[0]?.text).toBe("OK");
    expect(echoes[1]?.phoneNumberId).toBe("phone-m074");
    expect(echoes[1]?.text).toBe("OKK");

    // AUD-07.3-05 & Missão 07.5 (AF-05): política fail-closed de confiança de IP e anti-concentração de fallback
    const reqForged = new Request("https://marmita.test/api/public/whatsapp/meta-webhook", {
      headers: {
        "x-vercel-forwarded-for": "5.5.5.5",
        "cf-connecting-ip": "6.6.6.6",
        "x-real-ip": "7.7.7.7",
        "x-forwarded-for": "8.8.8.8, 9.9.9.9",
      },
    });
    // Sem variáveis de ambiente confiáveis habilitadas, NENHUM cabeçalho de IP é confiado por padrão:
    expect(extractTrustedClientIpKey(reqForged, {})).toBe("ip:verified-meta");
    expect(extractTrustedClientIpKey(reqForged, {}, { verifiedScope: "phone:12345" })).toBe(
      "ip:verified-meta:phone:12345",
    );
    // Ambiente Vercel identificado (VERCEL="1"): confia em x-vercel-forwarded-for
    expect(extractTrustedClientIpKey(reqForged, { VERCEL: "1" })).toBe("ip:5.5.5.5");
    // Cloudflare explicitamente habilitado: confia em cf-connecting-ip
    expect(extractTrustedClientIpKey(reqForged, { TRUST_CLOUDFLARE_IP: "true" })).toBe("ip:6.6.6.6");
    // Proxy XFF explicitamente habilitado: utiliza apenas o último hop (rightmostHop)
    expect(extractTrustedClientIpKey(reqForged, { TRUST_PROXY_XFF: "true" })).toBe("ip:9.9.9.9");

    // Missão 07.5 (AF-02): verifica script de agendamento de 1 minuto com pg_cron + pg_net + Vault
    const pgCronSql = readFileSync(
      resolve(ROOT, "scripts/setup-supabase-pg-cron-scheduler.sql"),
      "utf8",
    );
    expect(pgCronSql).toContain("marmita-connect-drain-whatsapp-queue-1m");
    expect(pgCronSql).toContain("* * * * *");
    expect(pgCronSql).toContain("public.recover_stuck_whatsapp_processing_leases()");
    expect(pgCronSql).toContain("public.invoke_whatsapp_queue_drain_cron()");
  });
});
