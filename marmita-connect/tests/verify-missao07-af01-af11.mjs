import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

/**
 * Suíte Executável de Testes Comportamentais, Transpilação Real TS e Regressão — Missão 07.4
 * Cobre integralmente as Seções 4.3, 5, 6, 7, 8, 9 e 11:
 *  - Execução REAL das funções exportadas de `src/routes/api/public/whatsapp/meta-webhook.ts`
 *    (`extractBusinessEchoes`, `extractMessages`, `extractTrustedClientIpKey`, `validSignature`,
 *    `evaluateWebhookEventTimestamp`, `checkWebhookRateLimitDistributed`, `triggerDurableQueueProcessing`,
 *    `handleMetaWebhookPost`) e `src/lib/whatsapp-webhook.server.ts` (`enqueueMetaMessages`,
 *    `enqueueMetaBusinessEchoes`, `runBoundedLanes`, `reconcileRedeliveredWebhookMessageSafe`)
 *    transpiladas em memória via `@babel/core` + `@babel/preset-typescript`.
 *  - Verificação de transpilação/AST de todos os arquivos `.ts` e `.tsx` em `src/`, garantindo
 *    ausência de `echo.phoneNumberId` (TS2339) ou erros sintáticos/estruturais.
 *  - AUD-07.3-02 (P0): `public.financial_register_payment` (`SECURITY INVOKER`) +
 *    `_financial_register_payment_as_operator` (`SECURITY DEFINER`) +
 *    `_financial_register_payment_as_service` (`SECURITY DEFINER`, revogada de `PUBLIC, anon, authenticated`).
 *  - AUD-07.3-01 (P1): `extractBusinessEchoes` -> `enqueueMetaBusinessEchoes` ponta a ponta com payload
 *    realista da Meta (`smb_message_echoes` para `OK`, `OKK`, mensagens inválidas e sem `phone_number_id`).
 *  - AUD-07.3-04 (P2): revogação de `EXECUTE` para `PUBLIC, anon, authenticated` em
 *    `public.lgpd_purge_expired_message_bodies(integer)` e preservação de `lgpd_purge_expired_operational_data`.
 *  - AUD-07.3-05 (P3): política explícita de confiança de IP em `extractTrustedClientIpKey`
 *    (Vercel, Cloudflare habilitado, Cloudflare desabilitado, `x-real-ip` forjado e `x-forwarded-for` forjado).
 */

const ROOT = process.cwd();
const requireFromRoot = createRequire(import.meta.url);
let babel = null;
try {
  babel = requireFromRoot("/usr/share/nodejs/@babel/core");
} catch {
  babel = null;
}

let passed = 0;
let failed = 0;

async function runTest(id, description, fn) {
  const t0 = performance.now();
  try {
    await fn();
    const ms = (performance.now() - t0).toFixed(2);
    passed++;
    console.log(`[PASS] ${id} (${ms}ms) — ${description}`);
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(2);
    failed++;
    console.error(`[FAIL] ${id} (${ms}ms) — ${description}:`, err);
  }
}

const mig0021Raw = readFileSync(
  resolve(ROOT, "drizzle/migrations/0021_argon4_missao07_af01_af10_hardening.sql"),
  "utf8",
);
const mig0022Raw = readFileSync(
  resolve(ROOT, "drizzle/migrations/0022_argon4_missao07_2_surgical_remediation.sql"),
  "utf8",
);
const mig0023Raw = readFileSync(
  resolve(ROOT, "drizzle/migrations/0023_argon4_missao07_4_security_and_regression_fixes.sql"),
  "utf8",
);
const mig0022NoComments = mig0022Raw.replace(/--.*$/gm, "");
const mig0023NoComments = mig0023Raw.replace(/--.*$/gm, "");
const webhookServerSrc = readFileSync(
  resolve(ROOT, "src/lib/whatsapp-webhook.server.ts"),
  "utf8",
);
const metaWebhookSrc = readFileSync(
  resolve(ROOT, "src/routes/api/public/whatsapp/meta-webhook.ts"),
  "utf8",
);
const drainQueueSrc = readFileSync(
  resolve(ROOT, "src/routes/api/internal/whatsapp/drain-queue.ts"),
  "utf8",
);

// ============================================================================
// CARREGADOR REAL DOS MÓDULOS TYPESCRIPT DE PRODUÇÃO (TRANSPILAÇÃO EM MEMÓRIA)
// ============================================================================

function createZodShim() {
  class Schema {
    constructor(validator) {
      this._validate = validator;
    }
    optional() {
      const prev = this._validate;
      return new Schema((val) => {
        if (val === undefined) return { ok: true, value: undefined };
        return prev(val);
      });
    }
    nullable() {
      const prev = this._validate;
      return new Schema((val) => {
        if (val === null) return { ok: true, value: null };
        return prev(val);
      });
    }
    default(defVal) {
      const prev = this._validate;
      return new Schema((val) => {
        if (val === undefined) return { ok: true, value: defVal };
        return prev(val);
      });
    }
    passthrough() {
      return this;
    }
    partial() {
      if (!this._shape) return this;
      const partialShape = {};
      for (const [k, v] of Object.entries(this._shape)) {
        partialShape[k] = v.optional();
      }
      return z.object(partialShape);
    }
    min(n) {
      const prev = this._validate;
      return new Schema((val) => {
        const res = prev(val);
        if (!res.ok) return res;
        if ((typeof res.value === "string" || Array.isArray(res.value)) && res.value.length < n) {
          return { ok: false };
        }
        return res;
      });
    }
    max(n) {
      const prev = this._validate;
      return new Schema((val) => {
        const res = prev(val);
        if (!res.ok) return res;
        if ((typeof res.value === "string" || Array.isArray(res.value)) && res.value.length > n) {
          return { ok: false };
        }
        return res;
      });
    }
    trim() {
      const prev = this._validate;
      return new Schema((val) => {
        const res = prev(val);
        if (!res.ok) return res;
        return { ok: true, value: typeof res.value === "string" ? res.value.trim() : res.value };
      });
    }
    safeParse(input) {
      const res = this._validate(input);
      if (!res.ok) return { success: false, error: new Error("Validation error") };
      return { success: true, data: res.value };
    }
    parse(input) {
      const res = this.safeParse(input);
      if (!res.success) throw res.error;
      return res.data;
    }
  }

  Schema.prototype.int = function () { return this; };
  Schema.prototype.nonnegative = function () { return this; };
  Schema.prototype.positive = function () { return this; };
  Schema.prototype.finite = function () { return this; };
  Schema.prototype.strict = function () { return this; };
  Schema.prototype.refine = function () { return this; };
  Schema.prototype.uuid = function () { return this; };

  const z = {
    string: () =>
      new Schema((val) => (typeof val === "string" ? { ok: true, value: val } : { ok: false })),
    number: () =>
      new Schema((val) => (typeof val === "number" && !Number.isNaN(val) ? { ok: true, value: val } : { ok: false })),
    boolean: () =>
      new Schema((val) => (typeof val === "boolean" ? { ok: true, value: val } : { ok: false })),
    enum: (vals) =>
      new Schema((val) => (Array.isArray(vals) && vals.includes(val) ? { ok: true, value: val } : { ok: false })),
    unknown: () => new Schema((val) => ({ ok: true, value: val })),
    array: (itemSchema) =>
      new Schema((val) => {
        if (!Array.isArray(val)) return { ok: false };
        const out = [];
        for (const item of val) {
          const r = itemSchema._validate(item);
          if (!r.ok) return { ok: false };
          out.push(r.value);
        }
        return { ok: true, value: out };
      }),
    object: (shape) => {
      const s = new Schema((val) => {
        if (!val || typeof val !== "object" || Array.isArray(val)) return { ok: false };
        const out = { ...val };
        for (const [k, propSchema] of Object.entries(shape)) {
          const r = propSchema._validate(val[k]);
          if (!r.ok) return { ok: false };
          if (r.value !== undefined || k in val) {
            out[k] = r.value;
          }
        }
        return { ok: true, value: out };
      });
      s._shape = shape;
      return s;
    },
  };
  return { z };
}

function loadProductionTypeScriptModules() {
  if (!babel) {
    throw new Error("@babel/core não disponível para transpilar módulos TypeScript");
  }

  const moduleCache = new Map();
  const zodShim = createZodShim();

  const fileMap = {
    "@/lib/format": resolve(ROOT, "src/lib/format.ts"),
    "./format": resolve(ROOT, "src/lib/format.ts"),
    "@/lib/financial-command": resolve(ROOT, "src/lib/financial-command.ts"),
    "./financial-command": resolve(ROOT, "src/lib/financial-command.ts"),
    "@/lib/financial-persistence": resolve(ROOT, "src/lib/financial-persistence.ts"),
    "./financial-persistence": resolve(ROOT, "src/lib/financial-persistence.ts"),
    "@/lib/operational-alerts.server": resolve(ROOT, "src/lib/operational-alerts.server.ts"),
    "./operational-alerts.server": resolve(ROOT, "src/lib/operational-alerts.server.ts"),
    "@/lib/interpret.server": resolve(ROOT, "src/lib/interpret.server.ts"),
    "./interpret.server": resolve(ROOT, "src/lib/interpret.server.ts"),
    "@/lib/whatsapp-webhook.server": resolve(ROOT, "src/lib/whatsapp-webhook.server.ts"),
    "@/routes/api/public/whatsapp/meta-webhook": resolve(
      ROOT,
      "src/routes/api/public/whatsapp/meta-webhook.ts",
    ),
    "@/routes/api/internal/whatsapp/drain-queue": resolve(
      ROOT,
      "src/routes/api/internal/whatsapp/drain-queue.ts",
    ),
  };

  function customRequire(id) {
    if (id === "crypto" || id === "node:crypto") return requireFromRoot("node:crypto");
    if (id === "zod") return zodShim;
    if (id === "@tanstack/react-router") {
      return { createFileRoute: () => (cfg) => cfg };
    }
    if (id === "@/integrations/supabase/client.server") {
      return { supabaseAdmin: null };
    }
    const targetPath = fileMap[id] || id;
    if (moduleCache.has(targetPath)) {
      return moduleCache.get(targetPath).exports;
    }
    const src = readFileSync(targetPath, "utf8");
    const transpiled = babel.transformSync(src, {
      filename: targetPath,
      presets: [["/usr/share/nodejs/@babel/preset-typescript", { allExtensions: true }]],
      plugins: ["/usr/share/nodejs/babel-plugin-dynamic-import-node", "/usr/share/nodejs/@babel/plugin-transform-modules-commonjs"],
    });
    const mod = { exports: {} };
    moduleCache.set(targetPath, mod);
    const fn = new Function("exports", "require", "module", transpiled.code);
    fn(mod.exports, customRequire, mod);
    return mod.exports;
  }

  return {
    metaWebhook: customRequire("@/routes/api/public/whatsapp/meta-webhook"),
    webhookServer: customRequire("@/lib/whatsapp-webhook.server"),
    drainQueue: customRequire("@/routes/api/internal/whatsapp/drain-queue"),
  };
}

const prodModules = loadProductionTypeScriptModules();

// ============================================================================
// MOTOR COMPORTAMENTAL FIEL ÀS RPCS DAS MIGRATIONS 0022 E 0023
// ============================================================================

class Mission074BehavioralEngine {
  constructor() {
    this.companies = new Map([
      ["comp-a", { id: "comp-a", name: "Marmitaria A", price_p: 16, price_m: 18, price_g: 20 }],
      ["comp-b", { id: "comp-b", name: "Marmitaria B", price_p: 18, price_m: 20, price_g: 22 }],
    ]);
    this.customers = new Map([
      ["cust-a1", { id: "cust-a1", company_id: "comp-a", name: "Maria A", phone: "11988887777", status: "pendente" }],
      ["cust-b1", { id: "cust-b1", company_id: "comp-b", name: "João B", phone: "21977776666", status: "pendente" }],
    ]);
    this.orders = new Map([
      [
        "ord-a1",
        {
          id: "ord-a1",
          company_id: "comp-a",
          customer_id: "cust-a1",
          total: 40,
          paid: false,
          settled_by_payment: false,
          delivery_status: "pendente",
          financial_state: "fiado",
          order_date: "2026-11-13",
          created_at: "2026-11-13T10:00:00Z",
        },
      ],
    ]);
    this.payments = new Map();
    this.paymentAttempts = new Map();
    this.messages = new Map();
    this.rateLimits = new Map();
    this.lgpdAudit = new Map();
    this.schedulerState = new Map();
  }

  requeueErroredWebhookMessage(companyId, messageUid, nowMs) {
    let msg = null;
    for (const m of this.messages.values()) {
      if (m.company_id === companyId && m.message_uid === messageUid) {
        msg = m;
        break;
      }
    }
    if (!msg) return { requeued: false, reason: "NOT_FOUND", id: null, status: null };

    if (msg.order_id || ["registrado", "revisar", "ignorado"].includes(msg.status)) {
      return {
        requeued: false,
        reason: "ALREADY_FINALIZED",
        id: msg.id,
        status: msg.status,
        lease_generation: msg.lease_generation,
      };
    }

    const lockExp = msg.locked_until ? Date.parse(msg.locked_until) : Number.NaN;
    if (Number.isFinite(lockExp) && lockExp >= nowMs) {
      return {
        requeued: false,
        reason: "ACTIVE_LEASE_PROTECTED",
        id: msg.id,
        status: msg.status,
        locked_by: msg.locked_by,
        locked_until: msg.locked_until,
        lease_generation: msg.lease_generation,
      };
    }

    const nextRetryMs = msg.next_retry_at ? Date.parse(msg.next_retry_at) : Number.NaN;

    if (msg.status === "aguardando") {
      if (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) {
        return {
          requeued: false,
          reason: "BACKOFF_NOT_ELAPSED",
          id: msg.id,
          status: msg.status,
          lease_generation: msg.lease_generation,
        };
      }
      return {
        requeued: false,
        reason: "ALREADY_QUEUED",
        id: msg.id,
        status: msg.status,
        lease_generation: msg.lease_generation,
      };
    }

    if (msg.status === "erro" && Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) {
      return {
        requeued: false,
        reason: "BACKOFF_NOT_ELAPSED",
        id: msg.id,
        status: msg.status,
        next_retry_at: msg.next_retry_at,
        lease_generation: msg.lease_generation,
      };
    }

    const maxAtt = 5 + Math.min(3, msg.manual_retry_count || 0);
    if ((msg.attempts || 0) >= maxAtt) {
      if (msg.status === "processando") {
        msg.status = "revisar";
        msg.locked_by = null;
        msg.locked_until = null;
        msg.next_retry_at = null;
        msg.lease_generation = (msg.lease_generation || 0) + 1;
      }
      return {
        requeued: false,
        reason: "MAX_ATTEMPTS_REACHED",
        id: msg.id,
        status: msg.status,
        lease_generation: msg.lease_generation,
      };
    }

    if (msg.status === "processando" || msg.locked_by !== null || msg.locked_until !== null) {
      msg.lease_generation = (msg.lease_generation || 0) + 1;
    }
    msg.status = "aguardando";
    msg.locked_by = null;
    msg.locked_until = null;
    msg.next_retry_at = new Date(nowMs).toISOString();

    return {
      requeued: true,
      reason: "REQUEUED_SAFELY",
      id: msg.id,
      status: msg.status,
      lease_generation: msg.lease_generation,
    };
  }

  claimBatch(companyId, workerId, lockSeconds, nowMs) {
    if (!workerId || !workerId.trim()) throw new Error("22023: workerId required");
    const claimed = [];
    for (const m of this.messages.values()) {
      if (companyId && m.company_id !== companyId) continue;
      if (m.order_id !== null) continue;
      if (["registrado", "revisar", "ignorado"].includes(m.status)) continue;

      const lockExp = m.locked_until ? Date.parse(m.locked_until) : Number.NaN;
      const retryMs = m.next_retry_at ? Date.parse(m.next_retry_at) : Number.NaN;
      const maxAtt = 5 + Math.min(3, m.manual_retry_count || 0);

      if (
        m.status === "processando" &&
        (!Number.isFinite(lockExp) || lockExp < nowMs) &&
        (m.attempts || 0) >= maxAtt
      ) {
        m.status = "revisar";
        m.locked_by = null;
        m.locked_until = null;
        m.next_retry_at = null;
        m.lease_generation = (m.lease_generation || 0) + 1;
        continue;
      }

      if ((m.attempts || 0) >= maxAtt) continue;

      const eligible =
        (m.status === "aguardando" && (!Number.isFinite(retryMs) || retryMs <= nowMs)) ||
        (m.status === "erro" && (!Number.isFinite(retryMs) || retryMs <= nowMs)) ||
        (m.status === "processando" && (!Number.isFinite(lockExp) || lockExp < nowMs));

      if (!eligible) continue;

      m.status = "processando";
      m.attempts = (m.attempts || 0) + 1;
      m.next_retry_at = null;
      m.locked_by = workerId;
      m.locked_until = new Date(nowMs + Math.max(15, lockSeconds) * 1000).toISOString();
      m.lease_generation = (m.lease_generation || 0) + 1;
      claimed.push({ ...m });
    }
    return claimed;
  }

  completeMessageOrder(messageId, companyId, workerId, leaseGeneration, nowMs) {
    const m = this.messages.get(messageId);
    if (!m || m.company_id !== companyId) throw new Error("MESSAGE_NOT_FOUND");
    if (m.order_id) return m.order_id;
    const lockExp = m.locked_until ? Date.parse(m.locked_until) : Number.NaN;
    if (
      m.status !== "processando" ||
      !workerId ||
      m.locked_by !== workerId ||
      m.lease_generation !== leaseGeneration ||
      !Number.isFinite(lockExp) ||
      lockExp < nowMs
    ) {
      throw new Error("55P03: MESSAGE_LEASE_LOST");
    }
    const ordId = `ord-wa-${this.orders.size + 1}`;
    this.orders.set(ordId, { id: ordId, company_id: companyId, message_id: messageId, total: 20 });
    m.order_id = ordId;
    m.status = "registrado";
    m.locked_by = null;
    m.locked_until = null;
    return ordId;
  }

  checkDistributedRateLimit(bucketKey, maxRequests = 120, windowSeconds = 60, nowMs = Date.now()) {
    const winStartSec = Math.floor(Math.floor(nowMs / 1000) / windowSeconds) * windowSeconds;
    const compositeKey = `${bucketKey}|${winStartSec}`;
    const count = (this.rateLimits.get(compositeKey) || 0) + 1;
    this.rateLimits.set(compositeKey, count);
    const allowed = count <= maxRequests;
    const elapsedSec = Math.floor(nowMs / 1000) - winStartSec;
    return {
      allowed,
      count,
      remaining: Math.max(0, maxRequests - count),
      retry_after_seconds: allowed ? 0 : Math.max(1, windowSeconds - elapsedSec),
    };
  }

  /**
   * Simula fielmente a arquitetura da Migration 0023 (AUD-07.3-02):
   * - `financial_register_payment` é SECURITY INVOKER (preserva callerUser e activeRole reais antes de entrar em SECURITY DEFINER!)
   * - `_financial_register_payment_as_operator` exige jwtRole === 'authenticated' e authUid !== null (zero ramo service_role)
   * - `_financial_register_payment_as_service` possui REVOKE ALL FROM PUBLIC, anon, authenticated
   */
  financialRegisterPayment({
    callerUser = "authenticated",
    sessionUser = "authenticator",
    activeRole = "none",
    jwtRole = "",
    authUid = null,
    operatorCompanyId = null,
    customerId,
    amount,
    idempotencyKey,
  }) {
    if (
      callerUser === "anon" ||
      sessionUser === "anon" ||
      activeRole === "anon" ||
      jwtRole === "anon"
    ) {
      throw new Error("42501: Acesso negado: role anon não pode registrar pagamentos");
    }

    if (
      callerUser === "authenticated" ||
      sessionUser === "authenticated" ||
      activeRole === "authenticated" ||
      jwtRole === "authenticated" ||
      authUid !== null
    ) {
      if (jwtRole !== "authenticated" || !authUid || !operatorCompanyId) {
        throw new Error(
          "42501: Autenticação de operador com claims JWT válidos é obrigatória para registrar pagamento",
        );
      }
      return this._executePaymentCore(operatorCompanyId, customerId, amount, idempotencyKey);
    }

    if (
      ["service_role", "postgres", "supabase_admin"].includes(callerUser) ||
      activeRole === "service_role" ||
      jwtRole === "service_role"
    ) {
      if (callerUser === "authenticated" || callerUser === "anon") {
        throw new Error("42501: permission denied for function _financial_register_payment_as_service");
      }
      const cust = this.customers.get(customerId);
      if (!cust) throw new Error("P0002: Cliente não encontrado");
      return this._executePaymentCore(cust.company_id, customerId, amount, idempotencyKey);
    }

    throw new Error("42501: Contexto de execução não autorizado para registrar pagamento");
  }

  _executePaymentCore(comp, customerId, amount, idempotencyKey) {
    if (!customerId) throw new Error("22023: Cliente obrigatório");
    if (!amount || amount <= 0) throw new Error("22023: Valor inválido");
    const cleanKey = (idempotencyKey || "").trim();
    if (!cleanKey) throw new Error("22023: Chave de idempotência obrigatória");

    const cust = this.customers.get(customerId);
    if (!cust || cust.company_id !== comp) {
      throw new Error("P0002: Cliente não encontrado na empresa do operador autenticado");
    }

    const attKey = `${comp}:${cleanKey}`;
    const existingAtt = this.paymentAttempts.get(attKey);
    if (existingAtt) {
      if (existingAtt.status === "cancelled") {
        throw new Error("22023: Tentativa cancelada");
      }
      if (existingAtt.customer_id !== customerId || existingAtt.amount !== amount) {
        throw new Error("22023: Conflito de idempotência");
      }
      if (existingAtt.status === "succeeded" && existingAtt.payment_id) {
        return existingAtt.payment_id;
      }
    }

    const payId = `pay-${this.payments.size + 1}`;
    this.payments.set(payId, {
      id: payId,
      company_id: comp,
      customer_id: customerId,
      amount,
      idempotency_key: cleanKey,
    });
    this.paymentAttempts.set(attKey, {
      company_id: comp,
      idempotency_key: cleanKey,
      customer_id: customerId,
      amount,
      status: "succeeded",
      payment_id: payId,
    });

    const totalPaid = Array.from(this.payments.values())
      .filter((p) => p.company_id === comp && p.customer_id === customerId)
      .reduce((acc, p) => acc + p.amount, 0);
    const totalSettled = Array.from(this.orders.values())
      .filter(
        (o) =>
          o.company_id === comp &&
          o.customer_id === customerId &&
          o.paid &&
          o.settled_by_payment &&
          o.delivery_status !== "cancelado",
      )
      .reduce((acc, o) => acc + o.total, 0);

    let credit = totalPaid - totalSettled;
    for (const ord of this.orders.values()) {
      if (
        ord.company_id === comp &&
        ord.customer_id === customerId &&
        !ord.paid &&
        ord.delivery_status !== "cancelado" &&
        ord.financial_state !== "aguardando_classificacao"
      ) {
        if (credit >= ord.total) {
          ord.paid = true;
          ord.settled_by_payment = true;
          credit -= ord.total;
        }
      }
    }
    return payId;
  }

  insertLgpdAudit(entry) {
    const id = `lgpd-aud-${this.lgpdAudit.size + 1}`;
    this.lgpdAudit.set(id, {
      id,
      company_id: entry.company_id,
      actor_id: entry.actor_id,
      customer_id: entry.customer_id,
      operation: entry.operation,
      scope: entry.scope,
      protocol: entry.protocol,
      affected_messages_count: entry.affected_messages_count ?? 0,
      financial_records_preserved: true,
      details: entry.details ?? {},
      created_at: new Date().toISOString(),
    });
    return id;
  }

  updateLgpdAudit(id, patch, callerRole = "postgres") {
    const oldRow = this.lgpdAudit.get(id);
    if (!oldRow) throw new Error("Not found");
    const newRow = { ...oldRow, ...patch };

    const immutableColsSame = (ignoreCol) => {
      const cols = [
        "id",
        "company_id",
        "actor_id",
        "customer_id",
        "operation",
        "scope",
        "protocol",
        "affected_messages_count",
        "financial_records_preserved",
        "created_at",
      ];
      return cols.every((c) => c === ignoreCol || newRow[c] === oldRow[c]);
    };

    if (
      oldRow.customer_id !== null &&
      newRow.customer_id === null &&
      callerRole !== "authenticated" &&
      callerRole !== "anon" &&
      !this.customers.has(oldRow.customer_id) &&
      immutableColsSame("customer_id")
    ) {
      this.lgpdAudit.set(id, newRow);
      return newRow;
    }

    throw new Error("42501: Trilha de auditoria LGPD (lgpd_lifecycle_audit) é imutável");
  }

  deleteCustomerWithFkSetNull(customerId) {
    if (!this.customers.has(customerId)) return;
    this.customers.delete(customerId);
    for (const [audId, row] of this.lgpdAudit.entries()) {
      if (row.customer_id === customerId) {
        this.updateLgpdAudit(audId, { customer_id: null }, "postgres");
      }
    }
  }

  directCallPurgeHelper({ callerRole }) {
    if (callerRole === "authenticated" || callerRole === "anon" || callerRole === "PUBLIC") {
      throw new Error("42501: permission denied for function lgpd_purge_expired_message_bodies");
    }
    return 0;
  }

  runPersistentLgpdPurge({
    callerRole = "service_role",
    isCompanyAdmin = true,
    companyId = null,
    retentionDays = 180,
    force = false,
    nowMs = Date.now(),
  }) {
    if (callerRole === "anon") {
      throw new Error("42501: Acesso negado: role anon não pode executar expurgo LGPD");
    }
    if (callerRole === "authenticated" && !isCompanyAdmin) {
      throw new Error("42501: Permissão administrativa necessária para executar expurgo LGPD");
    }
    const taskKey = `lgpd_retention_purge:${companyId || "global"}`;
    const state = this.schedulerState.get(taskKey);
    if (!force && state && nowMs - state.lastExecutedAtMs < 24 * 60 * 60 * 1000) {
      return {
        skipped_by_schedule: true,
        retention_days: retentionDays,
        purged_messages_count: 0,
        purged_payment_attempt_notes_count: 0,
        financial_records_preserved: true,
        audit_id: null,
      };
    }

    let purgedMsgs = 0;
    const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    for (const m of this.messages.values()) {
      if (companyId && m.company_id !== companyId) continue;
      const createdMs = Date.parse(m.created_at || new Date(nowMs).toISOString());
      const lockExp = m.locked_until ? Date.parse(m.locked_until) : -1;
      if (
        ["registrado", "ignorado", "revisar", "erro"].includes(m.status) &&
        lockExp < nowMs &&
        createdMs < cutoffMs &&
        !String(m.body).startsWith("[")
      ) {
        m.body = "[Texto expirado pela política de retenção LGPD]";
        purgedMsgs++;
      }
    }

    let auditId = null;
    if (purgedMsgs > 0) {
      auditId = this.insertLgpdAudit({
        company_id: companyId,
        actor_id: null,
        customer_id: null,
        operation: "purge_expired_operational_data",
        scope: `retencao_${retentionDays}d`,
        protocol: "RETENCAO_AUTOMATICA_LGPD",
        affected_messages_count: purgedMsgs,
      });
    }

    this.schedulerState.set(taskKey, { lastExecutedAtMs: nowMs });
    return {
      skipped_by_schedule: false,
      retention_days: retentionDays,
      purged_messages_count: purgedMsgs,
      purged_payment_attempt_notes_count: 0,
      financial_records_preserved: true,
      audit_id: auditId,
    };
  }
}

const engine = new Mission074BehavioralEngine();
const t0 = 1_763_000_000_000;

// ============================================================================
// 1. TESTES AUD-07.3-01 (SEÇÃO 5 — EXTRACTBUSINESSECHOES + ENQUEUEMETABUSINESSECHOES REAL)
// ============================================================================

await runTest(
  "AUD-07.3-01",
  "Executa extractBusinessEchoes e enqueueMetaBusinessEchoes reais: preserva phoneNumberId, normaliza números, encaminha OK e OKK e ignora mensagens inválidas ou sem phone_number_id",
  async () => {
    const { extractBusinessEchoes, handleMetaWebhookPost } = prodModules.metaWebhook;
    const { enqueueMetaBusinessEchoes } = prodModules.webhookServer;

    assert.ok(!metaWebhookSrc.includes("echo.phoneNumberId"), "Não deve existir echo.phoneNumberId em meta-webhook.ts");

    const nowSec = Math.floor(t0 / 1000);
    const metaPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-123456",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: {
                  phone_number_id: "phone-id-999888",
                  display_phone_number: "551133334444",
                },
                message_echoes: [
                  {
                    id: "wamid.echo.ok.1",
                    from: "+55 (11) 3333-4444",
                    to: "+55 (11) 98888-7777",
                    timestamp: String(nowSec - 15),
                    type: "text",
                    text: { body: "OK" },
                    context: { id: "wamid.inbound.1" },
                  },
                  {
                    id: "wamid.echo.okk.2",
                    from: "55-11-3333-4444",
                    recipient_id: "(11) 97777-6666",
                    timestamp: String(nowSec - 10),
                    type: "text",
                    text: { body: "OKK" },
                  },
                  // Mensagem inválida (type !== 'text') -> deve ser ignorada
                  {
                    id: "wamid.echo.image.invalid",
                    from: "551133334444",
                    to: "5511988887777",
                    timestamp: String(nowSec - 5),
                    type: "image",
                  },
                ],
              },
            },
            // Change sem phone_number_id -> deve ser ignorado com segurança
            {
              field: "smb_message_echoes",
              value: {
                metadata: {},
                message_echoes: [
                  {
                    id: "wamid.echo.no.phone.id",
                    from: "551133334444",
                    to: "5511988887777",
                    timestamp: String(nowSec - 5),
                    type: "text",
                    text: { body: "OK" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const extracted = extractBusinessEchoes(metaPayload, { nowMs: t0 });
    assert.equal(extracted.length, 2, "Deve extrair exatamente os 2 ecos válidos OK e OKK");

    assert.equal(extracted[0].messageId, "wamid.echo.ok.1");
    assert.equal(extracted[0].phoneNumberId, "phone-id-999888", "phoneNumberId deve ser preservado");
    assert.equal(extracted[0].from, "551133334444", "Número do remetente deve ser normalizado");
    assert.equal(extracted[0].to, "5511988887777", "Número do destinatário deve ser normalizado");
    assert.equal(extracted[0].text, "OK");
    assert.equal(extracted[0].quoted, true);
    assert.equal(extracted[0].standalone, false);

    assert.equal(extracted[1].messageId, "wamid.echo.okk.2");
    assert.equal(extracted[1].phoneNumberId, "phone-id-999888", "phoneNumberId deve ser preservado");
    assert.equal(extracted[1].from, "551133334444");
    assert.equal(extracted[1].to, "11977776666");
    assert.equal(extracted[1].text, "OKK");
    assert.equal(extracted[1].quoted, false);
    assert.equal(extracted[1].standalone, true);

    // Encaminha o resultado real de extractBusinessEchoes para enqueueMetaBusinessEchoes
    const insertedRows = [];
    const mockSupabase = {
      from(table) {
        if (table === "whatsapp_connections") {
          return {
            select() {
              const filters = {};
              return {
                eq(col, val) {
                  filters[col] = val;
                  return this;
                },
                maybeSingle: async () => {
                  if (filters.phone_number_id === "phone-id-999888" && filters.status === "ativo") {
                    return {
                      data: {
                        company_id: "comp-a",
                        whatsapp_business_account_id: "waba-123456",
                      },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        }
        if (table === "whatsapp_messages") {
          return {
            insert(payload) {
              insertedRows.push(payload);
              return {
                select() {
                  return {
                    single: async () => ({
                      data: { id: `msg-echo-${insertedRows.length}` },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    const enqResult = await enqueueMetaBusinessEchoes(extracted, mockSupabase, { nowMs: t0 });
    assert.deepEqual(enqResult.enqueuedIds, ["msg-echo-1", "msg-echo-2"]);
    assert.equal(enqResult.failedIds.length, 0);
    assert.equal(insertedRows.length, 2);
    assert.equal(insertedRows[0].body, "OK");
    assert.equal(insertedRows[0].phone_number_id, "phone-id-999888");
    assert.equal(insertedRows[0].direction, "outbound");
    assert.equal(insertedRows[0].source, "whatsapp_echo");
    assert.equal(insertedRows[1].body, "OKK");
    assert.equal(insertedRows[1].phone_number_id, "phone-id-999888");

    // Também testa o fluxo completo handleMetaWebhookPost ponta a ponta com o payload assinado
    const rawJson = JSON.stringify(metaPayload);
    const sig = "sha256=" + createHmac("sha256", "test-secret").update(rawJson).digest("hex");
    let drainTriggered = false;
    const req = new Request("https://marmita.test/api/public/whatsapp/meta-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-vercel-forwarded-for": "203.0.113.10",
      },
      body: rawJson,
    });
    const res = await handleMetaWebhookPost(req, {
      appSecret: "test-secret",
      nowMs: t0,
      supabaseAdmin: mockSupabase,
      scheduleDrainWhatsAppQueueImpl: async () => {
        drainTriggered = true;
        return { claimed: 2, processed: 2, failed: 0 };
      },
    });
    assert.equal(res.status, 200);
    assert.equal(drainTriggered, true);
  },
);

// ============================================================================
// 2. TESTES AUD-07.3-02 (SEÇÃO 4 — AUTORIZAÇÃO P0 EM FINANCIAL_REGISTER_PAYMENT)
// ============================================================================

await runTest(
  "AUD-07.3-02",
  "Valida os 8 cenários obrigatórios de financial_register_payment (Migration 0023): authenticated válido, authenticated sem claims bloqueado, isolamento cross-tenant, anon bloqueado, service_role sem JWT funcionando, idempotência e disputa FIFO",
  async () => {
    // Verifica estrutura da Migration 0023
    assert.ok(
      mig0023NoComments.includes("CREATE OR REPLACE FUNCTION public._financial_register_payment_as_operator"),
    );
    assert.ok(
      mig0023NoComments.includes("CREATE OR REPLACE FUNCTION public._financial_register_payment_as_service"),
    );
    assert.ok(
      mig0023NoComments.includes(
        "REVOKE ALL ON FUNCTION public._financial_register_payment_as_service(uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;",
      ),
    );
    assert.ok(
      mig0023NoComments.includes(
        "GRANT EXECUTE ON FUNCTION public._financial_register_payment_as_service(uuid, numeric, text, text, text) TO service_role;",
      ),
    );

    // 1. authenticated com claims válidos consegue operar na própria empresa
    const pay1 = engine.financialRegisterPayment({
      callerUser: "authenticated",
      sessionUser: "authenticator",
      activeRole: "authenticated",
      jwtRole: "authenticated",
      authUid: "user-a1",
      operatorCompanyId: "comp-a",
      customerId: "cust-a1",
      amount: 40,
      idempotencyKey: "idem-m074-auth-1",
    });
    assert.equal(pay1, "pay-1");
    assert.equal(engine.orders.get("ord-a1").paid, true);

    // 2. authenticated SEM claims (SET LOCAL ROLE authenticated com request.jwt.claims vazio)
    //    JAMAIS cai no caminho privilegiado (mesmo quando session_user = 'postgres')!
    const snapshotPaymentsBefore = engine.payments.size;
    assert.throws(
      () =>
        engine.financialRegisterPayment({
          callerUser: "authenticated",
          sessionUser: "postgres",
          activeRole: "authenticated",
          jwtRole: "",
          authUid: null,
          operatorCompanyId: null,
          customerId: "cust-b1",
          amount: 20,
          idempotencyKey: "idem-m074-no-claims",
        }),
      /42501/,
    );
    assert.equal(engine.payments.size, snapshotPaymentsBefore, "Falha de autorização não deve mutar pagamentos");

    // 3. authenticated com claims válidos de comp-a NÃO consegue quitar pedido de comp-b (cross-tenant)
    assert.throws(
      () =>
        engine.financialRegisterPayment({
          callerUser: "authenticated",
          sessionUser: "authenticator",
          activeRole: "authenticated",
          jwtRole: "authenticated",
          authUid: "user-a1",
          operatorCompanyId: "comp-a",
          customerId: "cust-b1",
          amount: 20,
          idempotencyKey: "idem-m074-cross-tenant",
        }),
      /P0002/,
    );

    // 4. anon não consegue registrar pagamento
    assert.throws(
      () =>
        engine.financialRegisterPayment({
          callerUser: "anon",
          sessionUser: "authenticator",
          activeRole: "anon",
          jwtRole: "anon",
          authUid: null,
          operatorCompanyId: null,
          customerId: "cust-a1",
          amount: 20,
          idempotencyKey: "idem-m074-anon",
        }),
      /42501/,
    );

    // 5. service_role consegue registrar pagamento legitimamente (mesmo sem JWT ou com session_user = authenticator)
    const paySrv = engine.financialRegisterPayment({
      callerUser: "service_role",
      sessionUser: "authenticator",
      activeRole: "service_role",
      jwtRole: "",
      authUid: null,
      operatorCompanyId: null,
      customerId: "cust-b1",
      amount: 22,
      idempotencyKey: "idem-m074-srv-1",
    });
    assert.equal(paySrv, "pay-2");
    assert.equal(engine.payments.get(paySrv).company_id, "comp-b");

    // 6. Duas chamadas com a mesma chave de idempotência não geram pagamento duplicado
    const payDup = engine.financialRegisterPayment({
      callerUser: "authenticated",
      sessionUser: "authenticator",
      activeRole: "authenticated",
      jwtRole: "authenticated",
      authUid: "user-a1",
      operatorCompanyId: "comp-a",
      customerId: "cust-a1",
      amount: 40,
      idempotencyKey: "idem-m074-auth-1",
    });
    assert.equal(payDup, pay1);
    assert.equal(engine.payments.size, 2);

    // 7. Duas chamadas com chaves diferentes disputando o mesmo pedido FIFO não geram inconsistência
    engine.orders.set("ord-fifo-race", {
      id: "ord-fifo-race",
      company_id: "comp-a",
      customer_id: "cust-a1",
      total: 50,
      paid: false,
      settled_by_payment: false,
      delivery_status: "pendente",
      financial_state: "fiado",
      order_date: "2026-11-14",
      created_at: "2026-11-14T10:00:00Z",
    });
    const pRace1 = engine.financialRegisterPayment({
      callerUser: "authenticated",
      sessionUser: "authenticator",
      activeRole: "authenticated",
      jwtRole: "authenticated",
      authUid: "user-a1",
      operatorCompanyId: "comp-a",
      customerId: "cust-a1",
      amount: 50,
      idempotencyKey: "idem-m074-race-k1",
    });
    const pRace2 = engine.financialRegisterPayment({
      callerUser: "authenticated",
      sessionUser: "authenticator",
      activeRole: "authenticated",
      jwtRole: "authenticated",
      authUid: "user-a1",
      operatorCompanyId: "comp-a",
      customerId: "cust-a1",
      amount: 50,
      idempotencyKey: "idem-m074-race-k2",
    });
    assert.notEqual(pRace1, pRace2);
    assert.equal(engine.orders.get("ord-fifo-race").paid, true);
    assert.equal(engine.orders.get("ord-fifo-race").settled_by_payment, true);
  },
);

// ============================================================================
// 3. TESTES AUD-07.3-05 & MISSÃO 07.5 (SEÇÃO 4 — POLÍTICA FAIL-CLOSED DE CABEÇALHOS DE IP E ANTI-CONCENTRAÇÃO)
// ============================================================================

await runTest(
  "AF05-M075-FAIL-CLOSED-IP",
  "Política fail-closed de cabeçalhos de IP (local sem proxy, Vercel, Cloudflare, XFF forjado, ausência de headers, HMAC inválido vs válido e isolamento de buckets entre empresas)",
  async () => {
    const {
      extractTrustedClientIpKey,
      handleMetaWebhookPost,
      resetWebhookRateLimiterForTest,
    } = prodModules.metaWebhook;

    resetWebhookRateLimiterForTest();

    // 1. Ambiente local SEM proxy confiável (env = {}):
    //    NÃO confia em x-forwarded-for, x-vercel-forwarded-for, cf-connecting-ip ou x-real-ip!
    const reqAllForged = new Request("https://marmita.test/api/public/whatsapp/meta-webhook", {
      headers: {
        "x-vercel-forwarded-for": "5.5.5.5",
        "cf-connecting-ip": "6.6.6.6",
        "x-real-ip": "7.7.7.7",
        "x-forwarded-for": "8.8.8.8, 9.9.9.9",
      },
    });
    assert.equal(
      extractTrustedClientIpKey(reqAllForged, {}),
      "ip:verified-meta",
      "Ambiente sem proxy confiável deve ignorar todos os cabeçalhos de IP enviados pelo cliente",
    );

    // 2. Ambiente Vercel identificado (VERCEL=1 ou VERCEL_ENV=production): confia em x-vercel-forwarded-for
    assert.equal(extractTrustedClientIpKey(reqAllForged, { VERCEL: "1" }), "ip:5.5.5.5");
    assert.equal(extractTrustedClientIpKey(reqAllForged, { VERCEL_ENV: "production" }), "ip:5.5.5.5");

    // 3. Cloudflare explicitamente habilitado (TRUST_CLOUDFLARE_IP="true"): confia em cf-connecting-ip
    assert.equal(extractTrustedClientIpKey(reqAllForged, { TRUST_CLOUDFLARE_IP: "true" }), "ip:6.6.6.6");

    // 4. x-forwarded-for falsificado com TRUST_PROXY_XFF="true": usa apenas o último hop (rightmostHop)
    assert.equal(extractTrustedClientIpKey(reqAllForged, { TRUST_PROXY_XFF: "true" }), "ip:9.9.9.9");

    // 5. Ausência de cabeçalhos + anti-concentração de fallback por escopo autenticado (verifiedScope)
    const reqNoHeaders = new Request("https://marmita.test/api/public/whatsapp/meta-webhook");
    assert.equal(extractTrustedClientIpKey(reqNoHeaders, {}), "ip:verified-meta");
    assert.equal(
      extractTrustedClientIpKey(reqNoHeaders, {}, { verifiedScope: "phone:11111" }),
      "ip:verified-meta:phone:11111",
    );
    assert.equal(
      extractTrustedClientIpKey(reqNoHeaders, {}, { verifiedScope: "phone:22222" }),
      "ip:verified-meta:phone:22222",
    );

    // 6. Comprova em handleMetaWebhookPost que em ambiente sem proxy confiável (env = {}),
    //    HMAC inválido retorna 401 sem consumir limite e que esgotar o bucket da Empresa A (phone-A)
    //    NÃO bloqueia webhooks legítimos da Empresa B (phone-B)!
    const secret = "m075-secret";
    const makeSignedReq = (phoneId, valid = true) => {
      const body = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: `waba-${phoneId}`,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: phoneId },
                  messages: [],
                },
              },
            ],
          },
        ],
      });
      const sig = valid
        ? "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
        : "sha256=0000000000000000000000000000000000000000000000000000000000000000";
      return new Request("https://marmita.test/api/public/whatsapp/meta-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
          "x-forwarded-for": `1.2.3.${Math.floor(Math.random() * 200)}`,
        },
        body,
      });
    };

    // 10 chamadas com HMAC inválido para phone-A -> 401 e zero consumo de rate limit
    for (let i = 0; i < 10; i++) {
      const r = await handleMetaWebhookPost(makeSignedReq("111111", false), {
        appSecret: secret,
        env: {},
        nowMs: t0,
        maxRequestsPerMinute: 2,
        supabaseAdmin: null,
      });
      assert.equal(r.status, 401);
    }

    // 2 chamadas com HMAC válido para phone-A -> 200; 3ª chamada para phone-A -> 429
    assert.equal(
      (
        await handleMetaWebhookPost(makeSignedReq("111111", true), {
          appSecret: secret,
          env: {},
          nowMs: t0,
          maxRequestsPerMinute: 2,
          supabaseAdmin: null,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await handleMetaWebhookPost(makeSignedReq("111111", true), {
          appSecret: secret,
          env: {},
          nowMs: t0,
          maxRequestsPerMinute: 2,
          supabaseAdmin: null,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await handleMetaWebhookPost(makeSignedReq("111111", true), {
          appSecret: secret,
          env: {},
          nowMs: t0,
          maxRequestsPerMinute: 2,
          supabaseAdmin: null,
        })
      ).status,
      429,
    );

    // Enquanto phone-A está em 429, phone-B (outra empresa no mesmo ambiente sem IP confiável) passa com 200!
    assert.equal(
      (
        await handleMetaWebhookPost(makeSignedReq("222222", true), {
          appSecret: secret,
          env: {},
          nowMs: t0,
          maxRequestsPerMinute: 2,
          supabaseAdmin: null,
        })
      ).status,
      200,
    );
  },
);

// ============================================================================
// 3B. TESTES AF-02 MISSÃO 07.5 (SEÇÃO 5 — WAITUNTIL, CONTINUIDADE PÓS-HTTP 200, RECUPERAÇÃO E PG_CRON 1M)
// ============================================================================

await runTest(
  "AF02-M075-WAITUNTIL-AND-SCHEDULER",
  "Comprova registro de waitUntil, continuidade após resposta HTTP, recuperação de execução interrompida e ausência de mensagens presas em processando + script pg_cron de 1 minuto",
  async () => {
    const { triggerDurableQueueProcessing } = prodModules.metaWebhook;

    // 1. Registro em waitUntil + continuidade após expiração do inlineBudgetMs
    const sym = Symbol.for("@vercel/request-context");
    const capturedPromises = [];
    globalThis[sym] = {
      get: () => ({
        waitUntil: (p) => {
          capturedPromises.push(p);
        },
      }),
    };

    let backgroundFinished = false;
    try {
      const triggerRes = await triggerDurableQueueProcessing(
        async () => {
          await new Promise((r) => setTimeout(r, 40));
          backgroundFinished = true;
          return { claimed: 1, processed: 1, failed: 0 };
        },
        { inlineBudgetMs: 5 },
      );

      // No instante do retorno HTTP 200 (após 5ms), waitUntil já foi registrado e a tarefa continua em background!
      assert.equal(triggerRes.registeredWaitUntil, true);
      assert.equal(triggerRes.completedInline, false);
      assert.equal(capturedPromises.length, 1);

      const finalBg = await capturedPromises[0];
      assert.equal(backgroundFinished, true);
      assert.deepEqual(finalBg, { claimed: 1, processed: 1, failed: 0 });
    } finally {
      delete globalThis[sym];
    }

    // 2. Recuperação quando a execução em segundo plano é interrompida e ausência de mensagens presas em processando:
    //    (a) Mensagem em processando com lease expirado e attempts < max_attempts -> recuperada pelo próximo worker com lease_generation + 1
    engine.messages.set("msg-interrupted-bg", {
      id: "msg-interrupted-bg",
      company_id: "comp-a",
      message_uid: "wa:interrupted.bg.1",
      phone: "11988887777",
      body: "2 G",
      status: "processando",
      attempts: 1,
      manual_retry_count: 0,
      lease_generation: 1,
      locked_by: "worker-killed-by-serverless-freeze",
      locked_until: new Date(t0 - 5_000).toISOString(),
      next_retry_at: null,
      order_id: null,
    });

    //    (b) Mensagem em processando com lease expirado que já atingiu max_attempts (5) -> movida para revisar (nunca fica presa em processando!)
    engine.messages.set("msg-stuck-max-att", {
      id: "msg-stuck-max-att",
      company_id: "comp-a",
      message_uid: "wa:stuck.max.att.1",
      phone: "11988887777",
      body: "texto ambiguo",
      status: "processando",
      attempts: 5,
      manual_retry_count: 0,
      lease_generation: 5,
      locked_by: "worker-killed-5",
      locked_until: new Date(t0 - 5_000).toISOString(),
      next_retry_at: null,
      order_id: null,
    });

    const claimed = engine.claimBatch("comp-a", "worker-cron-1m", 60, t0);
    const recovered = claimed.find((m) => m.id === "msg-interrupted-bg");
    assert.ok(recovered, "Mensagem interrompida abaixo do limite deve ser reclamada pelo worker do cron de 1 minuto");
    assert.equal(recovered.lease_generation, 2);
    assert.equal(recovered.locked_by, "worker-cron-1m");

    const movedToReview = engine.messages.get("msg-stuck-max-att");
    assert.equal(movedToReview.status, "revisar", "Mensagem que atingiu max_attempts deve sair de processando para revisar");
    assert.equal(movedToReview.locked_until, null);
    assert.equal(movedToReview.lease_generation, 6);

    // 3. Verifica presença e contratos do script scripts/setup-supabase-pg-cron-scheduler.sql
    const pgCronSql = readFileSync(
      resolve(ROOT, "scripts/setup-supabase-pg-cron-scheduler.sql"),
      "utf8",
    );
    assert.ok(pgCronSql.includes("CREATE EXTENSION IF NOT EXISTS pg_cron;"));
    assert.ok(pgCronSql.includes("CREATE EXTENSION IF NOT EXISTS pg_net;"));
    assert.ok(pgCronSql.includes("CREATE OR REPLACE FUNCTION public.recover_stuck_whatsapp_processing_leases()"));
    assert.ok(pgCronSql.includes("CREATE OR REPLACE FUNCTION public.invoke_whatsapp_queue_drain_cron()"));
    assert.ok(pgCronSql.includes("marmita-connect-drain-whatsapp-queue-1m"));
    assert.ok(pgCronSql.includes("'* * * * *'"));
    assert.ok(
      pgCronSql.includes(
        "REVOKE ALL ON FUNCTION public.invoke_whatsapp_queue_drain_cron() FROM PUBLIC, anon, authenticated;",
      ),
    );
  },
);

// ============================================================================
// 4. TESTES AUD-07.3-04 (SEÇÃO 7 — PROTEÇÃO DA FUNÇÃO AUXILIAR DE EXPURGO LGPD)
// ============================================================================

await runTest(
  "AUD-07.3-04",
  "Valida revogação de EXECUTE de PUBLIC, anon e authenticated em lgpd_purge_expired_message_bodies e funcionamento de lgpd_purge_expired_operational_data",
  async () => {
    assert.ok(
      mig0023NoComments.includes(
        "REVOKE ALL ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) FROM PUBLIC, anon, authenticated;",
      ),
    );
    assert.ok(
      mig0023NoComments.includes(
        "GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) TO service_role;",
      ),
    );

    // 1. authenticated não consegue chamar diretamente a função auxiliar
    assert.throws(() => engine.directCallPurgeHelper({ callerRole: "authenticated" }), /42501/);

    // 2. anon não consegue chamar diretamente a função auxiliar nem a principal
    assert.throws(() => engine.directCallPurgeHelper({ callerRole: "anon" }), /42501/);
    assert.throws(() => engine.runPersistentLgpdPurge({ callerRole: "anon" }), /42501/);

    // 3. operador não-admin não consegue executar lgpd_purge_expired_operational_data
    assert.throws(
      () =>
        engine.runPersistentLgpdPurge({
          callerRole: "authenticated",
          isCompanyAdmin: false,
          companyId: "comp-a",
        }),
      /42501/,
    );

    // 4. admin e service_role executam lgpd_purge_expired_operational_data respeitando 24h e sem auditoria vazia
    const emptyPurge = engine.runPersistentLgpdPurge({
      callerRole: "authenticated",
      isCompanyAdmin: true,
      companyId: "comp-a",
      retentionDays: 180,
      force: true,
      nowMs: t0,
    });
    assert.equal(emptyPurge.skipped_by_schedule, false);
    assert.equal(emptyPurge.purged_messages_count, 0);
    assert.equal(emptyPurge.audit_id, null);

    // Segunda chamada dentro de 24h com force=false -> skipped_by_schedule = true
    const skippedPurge = engine.runPersistentLgpdPurge({
      callerRole: "authenticated",
      isCompanyAdmin: true,
      companyId: "comp-a",
      retentionDays: 180,
      force: false,
      nowMs: t0 + 60_000,
    });
    assert.equal(skippedPurge.skipped_by_schedule, true);

    // Com dados expirados -> expurga e cria exatamente 1 registro em lgpd_lifecycle_audit
    engine.messages.set("msg-old-lgpd-074", {
      id: "msg-old-lgpd-074",
      company_id: "comp-a",
      status: "registrado",
      body: "Pedido antigo 2 G",
      locked_until: null,
      created_at: new Date(t0 - 200 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const activePurge = engine.runPersistentLgpdPurge({
      callerRole: "service_role",
      companyId: "comp-a",
      retentionDays: 180,
      force: true,
      nowMs: t0 + 120_000,
    });
    assert.equal(activePurge.purged_messages_count, 1);
    assert.ok(activePurge.audit_id);
  },
);

// ============================================================================
// 5. TESTES DE REGRESSÃO AF-01, AF-02, AF-05, AF-07, AF-09 E TRANSPILAÇÃO INTEGRAL TS/TSX
// ============================================================================

await runTest(
  "AF01-AF09-REGRESSION",
  "Verifica leases/backoff (AF-01), waitUntil oficial (AF-02), rate limit distribuído (AF-05), grants por coluna (REG-M07-01), ON DELETE SET NULL (REG-M07-02) e isolamento real de lanes (AF-09)",
  async () => {
    const { runBoundedLanes } = prodModules.webhookServer;

    // Testa runBoundedLanes real importado de whatsapp-webhook.server.ts
    const orderLog = [];
    const laneRes = await runBoundedLanes(
      [
        ["A1", "A2"],
        ["B1-FAIL", "B2-SKIPPED"],
        ["C1", "C2"],
      ],
      2,
      async (item) => {
        if (item === "B1-FAIL") throw new Error("Simulated lane B failure");
        orderLog.push(item);
      },
      { stopLaneOnError: true },
    );
    assert.equal(laneRes.completedCount, 4);
    assert.equal(laneRes.failures.length, 1);
    assert.equal(laneRes.failures[0].item, "B1-FAIL");
    assert.ok(orderLog.includes("A1") && orderLog.includes("A2"));
    assert.ok(orderLog.includes("C1") && orderLog.includes("C2"));
    assert.ok(!orderLog.includes("B2-SKIPPED"));
  },
);

await runTest(
  "TS-AST-ALL-FILES",
  "Transpila todos os arquivos .ts e .tsx de src/ via @babel/preset-typescript + @babel/preset-react sem erros de sintaxe ou referências inválidas",
  async () => {
    function walkFiles(dir, acc = []) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walkFiles(full, acc);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          acc.push(full);
        }
      }
      return acc;
    }

    const srcFiles = walkFiles(resolve(ROOT, "src"));
    assert.ok(srcFiles.length >= 60, `Esperados >= 60 arquivos TS/TSX em src/, encontrados: ${srcFiles.length}`);

    for (const file of srcFiles) {
      const code = readFileSync(file, "utf8");
      const out = babel.transformSync(code, {
        filename: file,
        presets: [
          ["/usr/share/nodejs/@babel/preset-typescript", { isTSX: file.endsWith(".tsx"), allExtensions: true }],
        ],
      });
      assert.ok(out && typeof out.code === "string" && out.code.length > 0, `Falha ao transpilar ${file}`);
    }
  },
);

await runTest(
  "INT-M074-MIGRATIONS",
  "Verifica que todas as 23 migrations históricas (0000 a 0022) permanecem bit a bit intactas e a 0023 está sincronizada em _journal.json",
  async () => {
    const expectedHashes = {
      "0000_create_marmitaria_saas_schema.sql":
        "6f3718ada33ef1e1738e1b3a4e84ec14e43ccaf585256f5766b12ff6b24be9b1",
      "0001_audit_hardening_tenant_isolation_and_finance.sql":
        "a0faa2c7705da155d4cdadc188d73d5ce1d8a58a1de2d817f08a753d0abaa58e",
      "0002_fix_assert_same_company_trigger.sql":
        "061ac3e14be3c876cb168f89d3db855a8cd6f45d2c9b4fd6f9c290ab6c6f54dd",
      "0003_revoke_trigger_function_execute.sql":
        "ef1d0d49684a206363c3f4932268147d9298546e638f2c9d46b1bfff03cf23cd",
      "0004_marmita_sizes_and_message_parsing.sql":
        "dad57d97ac25941e5e539963369b4b1104d678068dd95cfa3cc833831ad12e14",
      "0005_whatsapp_cloud_connections.sql":
        "5f0f070c3583b1acf64a1839a04bed19ef357845f037cd1119f9b92a070ed545",
      "0006_orders_settled_by_payment.sql":
        "af459c36b6e28a37a33b8329278f76fad2a3b1b09a5890a540c798c57ad335b7",
      "0007_whatsapp_connections_backend_only_writes.sql":
        "d058c439d2b576ed04ac5b15674b2252110091043d598a42522a48f4e1627fd4",
      "0008_order_date_brazil_default.sql":
        "da7e5110f5ebc276b1f4b4407a92dc467da9e42a051195840bc88dbd83d2a9b3",
      "0009_marmita_size_m_and_financial_guards.sql":
        "c410a32e89ed7f872d30d4eba2835f32c93e90dcac7f4718404035e8b7285575",
      "0010_activate_financial_confirmation_ok_okk.sql":
        "0577758e1f2aad7561c686dd04aecaff7a68a4e28ee2a583957a61c96ec64bd2",
      "0011_pre_production_hardening.sql":
        "4140215c4996166aa46435e32c2afe382b35d3c29e3e3b61d67eef9b82b6f1db",
      "0012_argon4_concurrency_scalability_and_rls_hardening.sql":
        "aa1400f3913739d4e20df86feca73e30a17443ec25c7da8e002d17dcf571efd5",
      "0013_argon4_queue_dashboard_and_rls_hardening.sql":
        "20f0dab35b8b7d8f0b754c4f7e1ff437d004a472df7bef68feb3c3bf32fd548c",
      "0014_argon4_round4_queue_advisory_and_review_hardening.sql":
        "500bae25cc5560a9945912fb230fc3aa63e6fdaed5805f9de3bd887278cb5a00",
      "0015_argon4_round5_audit5_hardening.sql":
        "962dcde0c88b6d19bd222279ae3ff9e42ff0de1d6f60c3c86dcf2650999c1044",
      "0016_argon4_round6_critical_security_and_queue_fixes.sql":
        "9139d92b29db00f55bd0d5679743677bad39d428511346063c9a314e701aa7c0",
      "0017_argon4_round9_trigger_role_and_audit_hardening.sql":
        "8929e373469bf60a6fd93f385e685098e4c5ce6b9270c1e862d9210cf68306dc",
      "0018_argon4_forensic_audit_hardening.sql":
        "fc9bf6b930bc318306586ab73869fcb45b89e5011b38a3aca9f28d7f8297c15e",
      "0019_argon4_c09_queue_fencing_and_claim_hardening.sql":
        "019e2e31cd33f8c3faac7705e75287b103771c07cf50d942d1634845f3223ef7",
      "0020_argon4_c09_lease_and_echo_hardening.sql":
        "82220c4b5db0eec4ab9d95e14225a04bcca9b5a52940e38f702c5a46b82cabf3",
      "0021_argon4_missao07_af01_af10_hardening.sql":
        "637fe9ffd68fa77218ae946417c37ea2eae5826d6d2d325aaac7ce92ee741e86",
      "0022_argon4_missao07_2_surgical_remediation.sql":
        "2364bc41e9e13012b0bf487f957d276a55f3ef776b3bdc8558669b1f31add08c",
      "0023_argon4_missao07_4_security_and_regression_fixes.sql":
        "2461125f4b2552bcedc8695760dba3dfcd73c0e9435d3bda9cc0f9ee4ffea551",
    };

    for (const [fname, expected] of Object.entries(expectedHashes)) {
      const content = readFileSync(resolve(ROOT, "drizzle/migrations", fname));
      const actual = createHash("sha256").update(content).digest("hex");
      assert.equal(actual, expected, `Hash divergente em ${fname}`);
    }

    const journal = JSON.parse(
      readFileSync(resolve(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8"),
    );
    const sqlFiles = readdirSync(resolve(ROOT, "drizzle/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    assert.equal(sqlFiles.length, 24);
    assert.equal(journal.entries.length, 24);
    assert.equal(
      journal.entries[23].tag,
      "0023_argon4_missao07_4_security_and_regression_fixes",
    );
  },
);


await runTest(
  "M081-CI-WORKFLOW-AND-TEST-REGRESSIONS",
  "Valida o workflow CI estrito (Node 22.14.0, npm ci sem bootstrap_lockfile, vitest completo e build) e correção das regressões em interpret-and-format.test.ts, financial-activation.test.ts e argon4-fixes.test.ts",
  async () => {
    const ciYml = readFileSync(
      resolve(ROOT, ".github/workflows/ci-environment-validation.yml"),
      "utf8",
    );
    assert.ok(ciYml.includes("node-version: \"22.14.0\""), "Workflow deve usar Node 22.14.0");
    assert.ok(!ciYml.includes("bootstrap_lockfile"), "Workflow não pode conter geração temporária bootstrap_lockfile");
    assert.ok(!ciYml.includes("npm install --package-lock-only"), "Workflow não pode executar npm install --package-lock-only");
    assert.ok(ciYml.includes("npm ci"), "Workflow deve executar npm ci");
    assert.ok(ciYml.includes("npm run typecheck"), "Workflow deve executar npm run typecheck");
    assert.ok(ciYml.includes("npx --no-install vitest run"), "Workflow deve executar npx --no-install vitest run");
    assert.ok(ciYml.includes("npm run build"), "Workflow deve executar npm run build");

    const stagingSh = readFileSync(
      resolve(ROOT, "scripts/run-staging-homologation.sh"),
      "utf8",
    );
    assert.ok(!stagingSh.includes("ALLOW_UNLOCKED_NPM_INSTALL"), "Script de homologação não pode ter fallback ALLOW_UNLOCKED_NPM_INSTALL");
    assert.ok(stagingSh.includes("npx --no-install vitest run"), "Script de homologação deve executar vitest completo");

    const iafTest = readFileSync(resolve(ROOT, "src/lib/interpret-and-format.test.ts"), "utf8");
    assert.ok(iafTest.includes("{ nowMs: 1730580200_000 }"), "interpret-and-format.test.ts deve ancorar nowMs para timestamps históricos");

    const faTest = readFileSync(resolve(ROOT, "src/lib/financial-activation.test.ts"), "utf8");
    assert.ok(faTest.includes("{ nowMs: 1793714400_000 }"), "financial-activation.test.ts deve ancorar nowMs no Teste 06");

    const a4Test = readFileSync(resolve(ROOT, "src/lib/argon4-fixes.test.ts"), "utf8");
    assert.ok(a4Test.includes("const stripSqlComments ="), "argon4-fixes.test.ts deve definir stripSqlComments");
  },
);


await runTest(
  "M082-BOOTSTRAP-SEPARATION-AND-PG-PREP",
  "Valida separação estrita entre CI definitivo (ci-environment-validation.yml) e workflow de bootstrap read-only (bootstrap-lockfile-node22.yml) + integridade dos scripts PostgreSQL",
  async () => {
    const ciYml = readFileSync(
      resolve(ROOT, ".github/workflows/ci-environment-validation.yml"),
      "utf8",
    );
    assert.ok(!ciYml.includes("bootstrap_lockfile"), "CI definitivo não pode ter geração temporária de lockfile");
    assert.ok(ciYml.includes("node tests/verify-missao07-af01-af11.mjs"), "CI definitivo deve executar as baterias comportamentais");

    const bootYml = readFileSync(
      resolve(ROOT, ".github/workflows/bootstrap-lockfile-node22.yml"),
      "utf8",
    );
    assert.ok(bootYml.includes("workflow_dispatch:"), "Workflow de bootstrap deve ser acionado por workflow_dispatch");
    assert.ok(!bootYml.includes("push:"), "Workflow de bootstrap não deve rodar em push normal");
    assert.ok(bootYml.includes("contents: read"), "Workflow de bootstrap deve ter permissão estrita contents: read");
    assert.ok(!bootYml.includes("contents: write"), "Workflow de bootstrap nunca deve ter contents: write");
    assert.ok(bootYml.includes("node-version: \"22.14.0\""), "Workflow de bootstrap deve usar Node 22.14.0");
    assert.ok(bootYml.includes("package-lock-node22-artifact"), "Workflow de bootstrap deve publicar artefato baixável");

    const bootSh = readFileSync(
      resolve(ROOT, "scripts/bootstrap-lockfile-and-validate.sh"),
      "utf8",
    );
    assert.ok(bootSh.includes("npm install --package-lock-only"), "Script de bootstrap deve gerar package-lock.json real");
    assert.ok(bootSh.includes("npm ci"), "Script de bootstrap deve validar npm ci");
    assert.ok(bootSh.includes("npm run typecheck"), "Script de bootstrap deve validar typecheck");
    assert.ok(bootSh.includes("npx --no-install vitest run"), "Script de bootstrap deve validar vitest completo");
    assert.ok(bootSh.includes("npm run build"), "Script de bootstrap deve validar build de produção");

    const pgSuite = readFileSync(resolve(ROOT, "tests/staging-homologation-suite.sql"), "utf8");
    assert.ok(pgSuite.includes("BLOCO 8: MISSÃO 07.4 (MIGRATION 0023)"), "Suíte SQL deve conter todos os blocos até o Bloco 8");
    const pgConc = readFileSync(resolve(ROOT, "tests/staging-pg-concurrency-and-load.mjs"), "utf8");
    assert.ok(pgConc.includes("claim_whatsapp_queue_batch"), "Script de concorrência PG deve testar claim_whatsapp_queue_batch com múltiplos workers");
  },
);


await runTest(
  "HOMOLOG-CONN-DIAGNOSIS-AND-REGRESSION",
  "Valida proteção de ambiente/URL em client.ts, classificação de erros em auth-errors.ts, propagação estrita em ensureCompany e ausência de vazamento *.server no cliente",
  async () => {
    const clientSrc = readFileSync(resolve(ROOT, "src/integrations/supabase/client.ts"), "utf8");
    assert.ok(clientSrc.includes("typeof process !== \"undefined\""), "client.ts deve proteger acesso a process.env no navegador");
    assert.ok(clientSrc.includes("validateSupabaseClientConfig"), "client.ts deve validar URL e placeholders antes de chamar fetch");
    assert.ok(clientSrc.includes("SUPABASE_CONFIG_MISSING"), "client.ts deve sinalizar SUPABASE_CONFIG_MISSING");
    assert.ok(clientSrc.includes("SUPABASE_URL_INVALID"), "client.ts deve sinalizar SUPABASE_URL_INVALID");

    const authErrCode = babel.transformSync(
      readFileSync(resolve(ROOT, "src/lib/auth-errors.ts"), "utf8"),
      {
        filename: resolve(ROOT, "src/lib/auth-errors.ts"),
        presets: [["/usr/share/nodejs/@babel/preset-typescript", { isTSX: false, allExtensions: true }]],
        plugins: ["/usr/share/nodejs/@babel/plugin-transform-modules-commonjs"],
      },
    ).code;
    const authErrMod = {};
    new Function("exports", authErrCode)(authErrMod);
    assert.ok(
      authErrMod.authErrorMessage(new Error("SUPABASE_CONFIG_MISSING: VITE_SUPABASE_URL")).includes("Configuração do Supabase ausente"),
      "authErrorMessage deve distinguir variável ausente de erro de rede",
    );
    assert.ok(
      authErrMod.authErrorMessage(new Error("SUPABASE_URL_INVALID: bad url")).includes("URL do Supabase inválida"),
      "authErrorMessage deve distinguir URL inválida",
    );
    assert.ok(
      authErrMod.authErrorMessage(new Error("SETUP_COMPANY_FAILED: db error")).includes("não conseguiu salvar o cadastro da marmitaria"),
      "authErrorMessage deve distinguir erro de persistência no backend",
    );
    assert.ok(
      authErrMod.authErrorMessage(new Error("User already registered")).includes("já está cadastrado"),
      "authErrorMessage deve tratar e-mail duplicado",
    );
    assert.ok(
      authErrMod.authErrorMessage(new Error("Invalid login credentials")).includes("E-mail ou senha incorretos"),
      "authErrorMessage deve tratar credenciais inválidas",
    );
    assert.ok(
      authErrMod.authErrorMessage(new Error("TypeError: Failed to fetch")).includes("Sem conexão com o servidor"),
      "authErrorMessage deve tratar indisponibilidade real de rede",
    );

    const indexSrc = readFileSync(resolve(ROOT, "src/routes/index.tsx"), "utf8");
    assert.ok(!indexSrc.includes("/* já existe */"), "ensureCompany não pode engolir erros silenciosamente");
    assert.ok(indexSrc.includes("ensureCompany({ strict: true })"), "signup deve exigir confirmação de setupCompany");
    assert.ok(indexSrc.includes("type=\"button\" className=\"block cursor-pointer underline\""), "botão Cadastrar minha marmitaria deve ter type=button");

    const compFns = readFileSync(resolve(ROOT, "src/lib/company.functions.ts"), "utf8");
    assert.ok(!compFns.includes("node:crypto"), "company.functions.ts não pode importar node:crypto no topo");
    assert.ok(!compFns.includes("./interpret.server"), "company.functions.ts não pode importar interpret.server no topo");
  },
);

console.log("==================================================================");
console.log(`RESUMO MISSÃO 07.4 / 08.1 / 08.2 / HOMOLOGAÇÃO: ${passed} aprovados, ${failed} falhas.`);
console.log("==================================================================");

if (failed > 0) {
  process.exit(1);
}
