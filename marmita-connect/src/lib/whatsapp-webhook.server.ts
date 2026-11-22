import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  phoneKey,
  processIncomingMessage,
  computeInboundErrorBackoffMs,
  MAX_INBOUND_AUTO_ATTEMPTS,
  MAX_MANUAL_RETRIES,
  normalizeFencingGeneration,
  isValidFencingGeneration,
  verifyWorkerStillOwnsLease,
} from "./interpret.server";

export { normalizeFencingGeneration, isValidFencingGeneration };
import { classifyWithPersistence, type FinancialCommit } from "./financial-persistence";
import type { FinancialContext, FinancialOrder } from "./financial-command";
import { brDateISO, brToday } from "./format";
import type { ExtractedBusinessEcho } from "@/routes/api/public/whatsapp/meta-webhook";
import {
  emitOperationalAlert,
  sanitizeFreeTextForOperationalLog,
} from "./operational-alerts.server";

export type IncomingWhatsAppMessage = {
  messageId: string;
  from: string;
  profileName: string | null;
  text: string;
  timestamp: string | null;
  phoneNumberId: string;
  wabaId?: string | null;
};

export const MAX_ECHO_ORDER_WAIT_ATTEMPTS = 5;
export const MAX_ENQUEUE_CONCURRENCY = 5;

/**
 * CORREÇÃO AUD-05:
 * Calcula backoff exponencial com jitter entre 2.000ms e 20.000ms (2s, 4s, 8s, 16s, 20s ->
 * janela acumulada de ~50s), cobrindo atrasos do Gemini de 1s, 5s, 10s, 20s e 30s sem
 * esgotar prematuramente as 5 tentativas e evitando tempestade de retries simultâneos.
 */
export function computeEchoRetryBackoffMs(
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const normalizedAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  const baseMs = Math.min(20_000, 2_000 * Math.pow(2, normalizedAttempt - 1));
  const jitterMs = Math.floor(Math.max(0, Math.min(1, randomFn())) * 400);
  return Math.min(20_000, baseMs + jitterMs);
}

/**
 * CORREÇÃO C-09 / M-02 (Seções 4.1 e 4.2):
 * Controle local de posse e fencing token monotônico (`lease_generation`):
 * - NUNCA inventa geração em memória: exige obrigatoriamente que `explicitGeneration` seja um
 *   inteiro positivo (`>= 1`) confirmado pelo PostgreSQL (`claim_whatsapp_queue_batch`).
 * - Se `explicitGeneration` estiver ausente, for `<= 0`, `NaN` ou não-inteiro, rejeita a aquisição
 *   imediatamente (`acquired: false`).
 * - Uma geração mais antiga (`explicitGeneration < cur.leaseGeneration`) é SEMPRE rejeitada,
 *   mesmo após expiração do relógio local (`lockedUntilMs <= nowMs`).
 * - Dois workers distintos jamais podem adquirir a mesma geração (`explicitGeneration === cur.leaseGeneration`).
 * - Uma geração estritamente superior (`explicitGeneration > cur.leaseGeneration`) confirmada pelo
 *   PostgreSQL substitui legitimamente o lock anterior e invalida imediatamente a geração antiga.
 */
const activeInProcessMessageLocks = new Map<
  string,
  { workerId: string; lockedUntilMs: number; leaseGeneration: number }
>();

export function resetInProcessMessageLocksForTest(): void {
  activeInProcessMessageLocks.clear();
}

export function acquireInProcessMessageLock(
  messageId: string,
  workerId: string,
  lockSeconds = 90,
  nowMs = Date.now(),
  explicitGeneration?: number | string | null,
): { acquired: boolean; leaseGeneration: number } {
  const cleanMsgId = typeof messageId === "string" ? messageId.trim() : "";
  const cleanWorkerId = typeof workerId === "string" ? workerId.trim() : "";
  const cur = activeInProcessMessageLocks.get(cleanMsgId);
  const normalizedGen = normalizeFencingGeneration(explicitGeneration);

  if (!cleanMsgId || !cleanWorkerId || normalizedGen === null) {
    return { acquired: false, leaseGeneration: cur?.leaseGeneration ?? 0 };
  }

  if (cur) {
    // Regra 1 (Fencing Token Monotônico): jamais aceita uma geração mais antiga que a já observada
    if (normalizedGen < cur.leaseGeneration) {
      return { acquired: false, leaseGeneration: cur.leaseGeneration };
    }

    // Regra 2: Dois workers distintos jamais podem compartilhar a mesma geração de lease
    if (cur.workerId !== cleanWorkerId && normalizedGen <= cur.leaseGeneration) {
      return { acquired: false, leaseGeneration: cur.leaseGeneration };
    }
  }

  activeInProcessMessageLocks.set(cleanMsgId, {
    workerId: cleanWorkerId,
    lockedUntilMs: nowMs + Math.max(15, lockSeconds) * 1000,
    leaseGeneration: normalizedGen,
  });
  return { acquired: true, leaseGeneration: normalizedGen };
}

export function renewInProcessMessageLock(
  messageId: string,
  workerId: string,
  lockSeconds = 90,
  nowMs = Date.now(),
  expectedGeneration?: number | string | null,
): boolean {
  const cur = activeInProcessMessageLocks.get(messageId);
  if (!cur || cur.workerId !== workerId) return false;
  const normalizedGen = normalizeFencingGeneration(expectedGeneration);
  if (normalizedGen === null || cur.leaseGeneration !== normalizedGen) {
    return false;
  }
  if (cur.lockedUntilMs <= nowMs) {
    activeInProcessMessageLocks.delete(messageId);
    return false;
  }
  cur.lockedUntilMs = nowMs + Math.max(15, lockSeconds) * 1000;
  return true;
}

export function hasActiveInProcessMessageLock(
  messageId: string,
  workerId: string,
  expectedGeneration?: number | string | null,
  nowMs = Date.now(),
): boolean {
  const cur = activeInProcessMessageLocks.get(messageId);
  if (!cur || cur.workerId !== workerId) return false;
  const normalizedGen = normalizeFencingGeneration(expectedGeneration);
  if (normalizedGen === null || cur.leaseGeneration !== normalizedGen) {
    return false;
  }
  if (cur.lockedUntilMs <= nowMs) {
    return false;
  }
  return true;
}

export function hasAnyActiveInProcessMessageLock(
  messageId: string,
  nowMs = Date.now(),
): boolean {
  const cur = activeInProcessMessageLocks.get(messageId);
  if (!cur) return false;
  return cur.lockedUntilMs > nowMs;
}

export function releaseInProcessMessageLock(
  messageId: string,
  workerId?: string,
  expectedGeneration?: number | string | null,
): boolean {
  const cur = activeInProcessMessageLocks.get(messageId);
  if (!cur) return false;
  if (workerId && cur.workerId !== workerId) return false;
  if (expectedGeneration !== undefined && expectedGeneration !== null) {
    const normalizedGen = normalizeFencingGeneration(expectedGeneration);
    if (normalizedGen === null || cur.leaseGeneration !== normalizedGen) {
      return false;
    }
  }
  activeInProcessMessageLocks.delete(messageId);
  return true;
}

/**
 * CORREÇÃO C-09 / M-02 (Seção 4.3 — Heartbeat Fail-Closed):
 * Renova o lease da mensagem validando propriedade (`locked_by = workerId`) e geração atual
 * (`lease_generation = leaseGeneration`) diretamente no PostgreSQL via RPC `renew_whatsapp_message_lock`.
 * Se a renovação falhar (retorno `false`, erro do banco, timeout ou RPC indisponível):
 * - Revoga imediatamente a autorização local do worker (`releaseInProcessMessageLock`);
 * - Retorna `false` para interromper o processamento.
 */
export async function renewWhatsAppMessageLockSafe(
  supabase: SupabaseClient<Database>,
  messageId: string,
  workerId: string,
  lockSeconds = 90,
  leaseGeneration?: number | string | null,
  nowMs = Date.now(),
): Promise<boolean> {
  const normalizedGen = normalizeFencingGeneration(leaseGeneration);
  if (
    !messageId?.trim() ||
    !workerId?.trim() ||
    normalizedGen === null ||
    !hasActiveInProcessMessageLock(messageId, workerId, normalizedGen, nowMs)
  ) {
    return false;
  }

  const maybeRpc = (
    supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: boolean | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc !== "function") {
    releaseInProcessMessageLock(messageId, workerId, normalizedGen);
    return false;
  }

  try {
    const rpcRes = await maybeRpc.call(supabase, "renew_whatsapp_message_lock", {
      _message_id: messageId,
      _worker_id: workerId,
      _lock_seconds: Math.max(15, lockSeconds),
      _lease_generation: normalizedGen,
    });

    if (rpcRes.error || rpcRes.data !== true) {
      releaseInProcessMessageLock(messageId, workerId, normalizedGen);
      return false;
    }

    return renewInProcessMessageLock(messageId, workerId, lockSeconds, Date.now(), normalizedGen);
  } catch {
    releaseInProcessMessageLock(messageId, workerId, normalizedGen);
    return false;
  }
}

/**
 * CORREÇÃO AUD-01 & C-09 / M-02 (Seção 4.4 — Finalização Fail-Closed):
 * Finaliza a mensagem e libera o lock exclusivamente via RPC `release_whatsapp_message_lock`,
 * exigindo obrigatoriamente:
 * - `messageId` válido;
 * - `workerId` proprietário atual do lease;
 * - `leaseGeneration` inteiro positivo (`>= 1`) correspondente à geração ativa;
 * - `finalStatus` válido;
 * - Confirmação explícita (`data === true`) do PostgreSQL.
 * Não existe fallback para `SELECT` + `UPDATE` direto.
 */
export async function releaseWhatsAppMessageLockSafe(
  supabase: SupabaseClient<Database>,
  messageId: string,
  workerId: string,
  finalStatus: "aguardando" | "registrado" | "revisar" | "ignorado" | "erro",
  options?: {
    lastError?: string | null;
    nextRetryAt?: string | null;
    leaseGeneration?: number | string | null;
    orderId?: string | null;
    parsed?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const validStatuses = new Set(["aguardando", "registrado", "revisar", "ignorado", "erro"]);
  const leaseGen = normalizeFencingGeneration(options?.leaseGeneration);

  if (
    !messageId?.trim() ||
    !workerId?.trim() ||
    !validStatuses.has(finalStatus) ||
    leaseGen === null
  ) {
    return false;
  }

  if (!hasActiveInProcessMessageLock(messageId, workerId, leaseGen)) {
    return false;
  }

  const maybeRpc = (
    supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: boolean | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc !== "function") {
    return false;
  }

  try {
    const rpcRes = await maybeRpc.call(supabase, "release_whatsapp_message_lock", {
      _message_id: messageId,
      _worker_id: workerId,
      _final_status: finalStatus,
      _last_error: options?.lastError ?? null,
      _next_retry_at: options?.nextRetryAt ?? null,
      _lease_generation: leaseGen,
      _order_id: options?.orderId ?? null,
      _parsed: options?.parsed ?? null,
    });

    if (rpcRes.error || typeof rpcRes.data !== "boolean") {
      return false;
    }

    if (rpcRes.data === true) {
      releaseInProcessMessageLock(messageId, workerId, leaseGen);
      return true;
    }

    // O banco rejeitou a finalização (outro worker já assumiu nova geração ou a mensagem já foi finalizada)
    releaseInProcessMessageLock(messageId, workerId, leaseGen);
    return false;
  } catch {
    return false;
  }
}

/**
 * CORREÇÃO ARGON4-02 & AUD-03:
 * Localiza cliente pelo telefone normalizado em O(log N) via RPC find_customer_by_phone
 * (usando o índice funcional customers_company_phone_key_idx).
 */
export async function findCustomerByPhoneIndexed(
  supabase: SupabaseClient<Database>,
  companyId: string,
  rawOrNormalizedPhone: string,
): Promise<{ id: string; name: string; phone: string } | null> {
  const targetKey = phoneKey(rawOrNormalizedPhone);
  if (!companyId || !targetKey) return null;

  const maybeRpc = (
    supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: { id: string; name: string; phone: string }[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    try {
      const rpcRes = await maybeRpc.call(supabase, "find_customer_by_phone", {
        _company_id: companyId,
        _phone: targetKey,
      });
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        return rpcRes.data[0] ?? null;
      }
    } catch {
      // Fallback paginado apenas para leitura de clientes por telefone em testes unitários
    }
  }

  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const baseQuery = supabase
      .from("customers")
      .select("id, name, phone")
      .eq("company_id", companyId);

    const hasOrderAndRange =
      typeof (baseQuery as unknown as { order?: unknown }).order === "function";

    if (!hasOrderAndRange) {
      const simpleRes = await baseQuery;
      if (simpleRes.error) throw new Error(simpleRes.error.message);
      const found = (simpleRes.data ?? []).find((c) => phoneKey(c.phone) === targetKey);
      return found ?? null;
    }

    const pageRes = await baseQuery.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (pageRes.error) throw new Error(pageRes.error.message);
    const rows = pageRes.data ?? [];
    const hit = rows.find((c) => phoneKey(c.phone) === targetKey);
    if (hit) return hit;
    if (rows.length < PAGE) break;
  }

  return null;
}

async function resolveActiveConnectionCached(
  supabaseAdmin: SupabaseClient<Database>,
  phoneNumberId: string,
  cache: Map<
    string,
    Promise<{ company_id: string; whatsapp_business_account_id: string } | null>
  >,
): Promise<{ company_id: string; whatsapp_business_account_id: string } | null> {
  const existing = cache.get(phoneNumberId);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    const conn = await supabaseAdmin
      .from("whatsapp_connections")
      .select("company_id, whatsapp_business_account_id")
      .eq("phone_number_id", phoneNumberId)
      .eq("status", "ativo")
      .maybeSingle();
    if (conn.error) {
      cache.delete(phoneNumberId);
      throw new Error(conn.error.message);
    }
    return conn.data ?? null;
  })();
  cache.set(phoneNumberId, pending);
  return pending;
}

export type BoundedLaneFailure<T> = {
  item: T;
  laneIndex: number;
  error: Error;
};

/**
 * CORREÇÃO AF-09 & AUD-07.1-07:
 * Executor de filas particionadas (lanes) com concorrência estritamente limitada (`1..10`)
 * e ISOLAMENTO DE EXCEÇÕES POR LANE:
 * - Itens dentro da mesma lane (mesmo telefone na mesma empresa) são executados em ordem
 *   estritamente sequencial para preservar a causalidade das mensagens daquele cliente.
 * - Se um item falhar, o erro é capturado, registrado em `failures` e reportado via `onItemError`;
 *   a lane afetada interrompe itens subsequentes do mesmo telefone (para evitar inversão de ordem),
 *   mas TODAS AS OUTRAS LANES continuam até o fim sem abortar o lote inteiro!
 */
export async function runBoundedLanes<T>(
  lanes: readonly (readonly T[])[],
  maxConcurrency: number,
  handler: (item: T) => Promise<void>,
  options?: {
    stopLaneOnError?: boolean;
    onItemError?: (item: T, error: Error, laneIndex: number) => void | Promise<void>;
  },
): Promise<{ completedCount: number; failures: BoundedLaneFailure<T>[] }> {
  const nonEmptyLanes = lanes.filter((lane) => lane.length > 0);
  if (nonEmptyLanes.length === 0) {
    return { completedCount: 0, failures: [] };
  }

  const boundedConcurrency = Math.min(
    Math.max(1, Math.trunc(Number(maxConcurrency) || MAX_ENQUEUE_CONCURRENCY)),
    10,
    nonEmptyLanes.length,
  );
  const stopLaneOnError = options?.stopLaneOnError ?? true;

  let laneCursor = 0;
  let completedCount = 0;
  const failures: BoundedLaneFailure<T>[] = [];

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (laneCursor < nonEmptyLanes.length) {
      const idx = laneCursor++;
      const lane = nonEmptyLanes[idx];
      if (!lane) continue;
      for (const item of lane) {
        try {
          await handler(item);
          completedCount += 1;
        } catch (rawErr) {
          const errObj =
            rawErr instanceof Error ? rawErr : new Error(String(rawErr ?? "Unknown lane error"));
          failures.push({ item, laneIndex: idx, error: errObj });
          if (options?.onItemError) {
            await options.onItemError(item, errObj, idx);
          }
          if (stopLaneOnError) {
            break;
          }
        }
      }
    }
  });

  await Promise.all(workers);
  return { completedCount, failures };
}

/**
 * CORREÇÃO AF-01, AUD-07.1-01 & AUD-07.1-02:
 * Trata de maneira atômica e fail-safe a reentrega pela Meta de uma mensagem já existente
 * em `(company_id, message_uid)`:
 * - Utiliza a RPC transacional `requeue_errored_whatsapp_webhook_message` (`FOR UPDATE`),
 *   que:
 *     1. Protege leases ativos (`locked_until IS NOT NULL AND locked_until >= now`);
 *     2. Recupera mensagens com lease expirado ou `locked_until IS NULL` em `status = 'processando'`;
 *     3. Não reencaminha mensagens em `status = 'erro'` antes de `next_retry_at` (`BACKOFF_NOT_ELAPSED`);
 *     4. Incrementa `lease_generation` sempre que limpar/invalidar um lease anterior.
 */
export async function reconcileRedeliveredWebhookMessageSafe(
  supabaseAdmin: SupabaseClient<Database>,
  companyId: string,
  messageUid: string,
  insertErrorMessage?: string | null,
  nowMs = Date.now(),
): Promise<{
  action: "enqueued" | "skipped";
  id: string;
  reason: string;
  leaseGeneration?: number | null;
}> {
  const maybeRpc = (
    supabaseAdmin as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: {
          requeued?: boolean;
          reason?: string;
          id?: string | null;
          status?: string | null;
          lease_generation?: number | string | null;
        } | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    const rpcRes = await maybeRpc.call(
      supabaseAdmin,
      "requeue_errored_whatsapp_webhook_message",
      {
        _company_id: companyId,
        _message_uid: messageUid,
        _now: new Date(nowMs).toISOString(),
      },
    );

    if (!rpcRes.error && rpcRes.data && typeof rpcRes.data === "object") {
      const rowId = typeof rpcRes.data.id === "string" ? rpcRes.data.id : "";
      const reason = typeof rpcRes.data.reason === "string" ? rpcRes.data.reason : "RPC_DECISION";
      const gen = normalizeFencingGeneration(rpcRes.data.lease_generation);
      if (!rowId) {
        throw new Error(
          insertErrorMessage ?? "Mensagem duplicada não localizada durante reconciliação segura",
        );
      }
      if (hasAnyActiveInProcessMessageLock(rowId, nowMs)) {
        return {
          action: "skipped",
          id: rowId,
          reason: "IN_PROCESS_ACTIVE_LEASE_PROTECTED",
          leaseGeneration: gen,
        };
      }
      if (rpcRes.data.requeued === true) {
        return { action: "enqueued", id: rowId, reason, leaseGeneration: gen };
      }
      return { action: "skipped", id: rowId, reason, leaseGeneration: gen };
    }

    const errCode = rpcRes.error?.code ?? "";
    if (rpcRes.error && errCode !== "PGRST202" && errCode !== "42883") {
      throw new Error(
        `Falha segura ao reconciliar reentrega do webhook (${errCode}): ${rpcRes.error.message}`,
      );
    }
  }

  // Caminho de inspeção somente-leitura para clientes mockados em testes unitários que não implementam a RPC:
  const existing = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id, status, order_id, locked_by, locked_until, lease_generation, next_retry_at")
    .eq("company_id", companyId)
    .eq("message_uid", messageUid)
    .maybeSingle();

  if (!existing.data) {
    throw new Error(insertErrorMessage ?? "Falha ao enfileirar mensagem na fila durável");
  }

  const row = existing.data as {
    id: string;
    status: string;
    order_id?: string | null;
    locked_by?: string | null;
    locked_until?: string | null;
    lease_generation?: number | string | null;
    next_retry_at?: string | null;
  };

  if (hasAnyActiveInProcessMessageLock(row.id, nowMs)) {
    return { action: "skipped", id: row.id, reason: "IN_PROCESS_ACTIVE_LEASE_PROTECTED" };
  }

  // AUD-07.1-02: Só considera lease ativo no banco se locked_until for uma data válida e >= nowMs.
  // Se status === 'processando' mas locked_until for NULL ou expirado, NÃO bloqueia como ACTIVE_LEASE_PROTECTED!
  const lockExpiryMs =
    typeof row.locked_until === "string" ? Date.parse(row.locked_until) : Number.NaN;
  const hasActiveDbLease = Number.isFinite(lockExpiryMs) && lockExpiryMs >= nowMs;

  if (hasActiveDbLease) {
    return { action: "skipped", id: row.id, reason: "ACTIVE_LEASE_PROTECTED" };
  }

  if (row.order_id || ["registrado", "revisar", "ignorado"].includes(row.status)) {
    return { action: "skipped", id: row.id, reason: "ALREADY_FINALIZED" };
  }

  // AUD-07.1-01: Respeita janela de backoff (next_retry_at) antes de permitir reencaminhamento
  const nextRetryMs =
    typeof row.next_retry_at === "string" ? Date.parse(row.next_retry_at) : Number.NaN;
  if (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) {
    return { action: "skipped", id: row.id, reason: "BACKOFF_NOT_ELAPSED" };
  }

  if (row.status === "aguardando") {
    return { action: "skipped", id: row.id, reason: "ALREADY_QUEUED" };
  }

  return { action: "enqueued", id: row.id, reason: "ERROR_OR_EXPIRED_LEASE_ELIGIBLE" };
}

export type EnqueueBatchResult = {
  enqueuedIds: string[];
  skippedIds: string[];
  failedIds: string[];
  errors: { messageId: string; error: string }[];
};

/**
 * Enfileira mensagens recebidas da Meta na fila durável (public.whatsapp_messages)
 * com status = 'aguardando' ANTES de retornar HTTP 200 para a Meta.
 *
 * CORREÇÕES AF-01, AF-09, AUD-07.1-01, AUD-07.1-02 & AUD-07.1-07:
 * - Protege leases ativos, respeita `next_retry_at` e recupera leases nulos/expirados.
 * - Isola falhas por lane de telefone (`runBoundedLanes`), impedindo que um erro em uma
 *   mensagem interrompa o enfileiramento das outras lanes do lote.
 * - Registra falhas parciais com alerta operacional sanitizado (`failedIds` / `errors`).
 */
export async function enqueueMetaMessages(
  messages: IncomingWhatsAppMessage[],
  customSupabase?: SupabaseClient<Database>,
  options?: { concurrency?: number; nowMs?: number; throwOnAllFailed?: boolean },
): Promise<EnqueueBatchResult> {
  const enqueuedIds: string[] = [];
  const skippedIds: string[] = [];
  const failedIds: string[] = [];
  const errors: { messageId: string; error: string }[] = [];
  if (messages.length === 0) return { enqueuedIds, skippedIds, failedIds, errors };

  const supabaseAdmin =
    customSupabase ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const connCache = new Map<
    string,
    Promise<{ company_id: string; whatsapp_business_account_id: string } | null>
  >();
  const nowMs = options?.nowMs ?? Date.now();

  const seenBatchKeys = new Set<string>();
  const lanesByPhone = new Map<string, IncomingWhatsAppMessage[]>();

  for (const m of messages) {
    const batchKey = `${m.phoneNumberId}:${m.messageId}`;
    if (seenBatchKeys.has(batchKey)) {
      skippedIds.push(m.messageId);
      continue;
    }
    seenBatchKeys.add(batchKey);

    const normalizedPhone = phoneKey(m.from) || m.from || "sem-telefone";
    const laneKey = `${m.phoneNumberId}:${normalizedPhone}`;
    const lane = lanesByPhone.get(laneKey);
    if (lane) {
      lane.push(m);
    } else {
      lanesByPhone.set(laneKey, [m]);
    }
  }

  await runBoundedLanes(
    Array.from(lanesByPhone.values()),
    options?.concurrency ?? MAX_ENQUEUE_CONCURRENCY,
    async (m) => {
      const connData = await resolveActiveConnectionCached(
        supabaseAdmin,
        m.phoneNumberId,
        connCache,
      );
      if (!connData) {
        skippedIds.push(m.messageId);
        return;
      }
      if (m.wabaId && m.wabaId !== connData.whatsapp_business_account_id) {
        skippedIds.push(m.messageId);
        return;
      }

      const companyId = connData.company_id;
      const uid = `wa:${m.messageId}`;
      const ts = Number(m.timestamp);
      const receivedAt =
        Number.isFinite(ts) && ts > 0
          ? new Date(ts * 1000).toISOString()
          : new Date(nowMs).toISOString();
      const normalizedPhone = phoneKey(m.from) || m.from || "sem-telefone";

      const ins = await supabaseAdmin
        .from("whatsapp_messages")
        .insert({
          company_id: companyId,
          phone: normalizedPhone,
          direction: "inbound",
          body: m.text,
          status: "aguardando",
          message_uid: uid,
          source: "whatsapp_cloud",
          profile_name: m.profileName,
          phone_number_id: m.phoneNumberId,
          received_at: receivedAt,
        } as never)
        .select("id")
        .single();

      if (ins.data) {
        enqueuedIds.push((ins.data as { id: string }).id);
        return;
      }

      const reconciled = await reconcileRedeliveredWebhookMessageSafe(
        supabaseAdmin,
        companyId,
        uid,
        ins.error?.message,
        nowMs,
      );
      if (reconciled.action === "enqueued") {
        enqueuedIds.push(reconciled.id);
      } else {
        skippedIds.push(reconciled.id);
      }
    },
    {
      stopLaneOnError: true,
      onItemError: async (m, err) => {
        const safeErr = sanitizeFreeTextForOperationalLog(err.message);
        failedIds.push(m.messageId);
        errors.push({ messageId: m.messageId, error: safeErr });
      },
    },
  );

  if (failedIds.length > 0) {
    await emitOperationalAlert({
      code: "WHATSAPP_WEBHOOK_ENQUEUE_PARTIAL_FAILURE",
      severity: "critical",
      title: "Falha ao persistir uma ou mais mensagens na fila durável do WhatsApp",
      details: {
        enqueuedCount: enqueuedIds.length,
        skippedCount: skippedIds.length,
        failedCount: failedIds.length,
        failedIds,
        errors,
      },
    });

    if (options?.throwOnAllFailed !== false && enqueuedIds.length === 0 && skippedIds.length === 0) {
      throw new Error(errors[0]?.error || "Falha ao enfileirar mensagem na fila durável");
    }
  }

  return { enqueuedIds, skippedIds, failedIds, errors };
}

/**
 * CORREÇÃO ARGON4-03, AF-01, AF-09 & AUD-07.1-07:
 * Persiste de forma durável os ecos comerciais (OK / OKK) enviados pela marmitaria
 * na fila public.whatsapp_messages (direction = 'outbound', source = 'whatsapp_echo',
 * status = 'aguardando') ANTES do HTTP 200 do webhook, com isolamento de falhas por lane.
 */
export async function enqueueMetaBusinessEchoes(
  echoes: ExtractedBusinessEcho[],
  customSupabase?: SupabaseClient<Database>,
  options?: { concurrency?: number; nowMs?: number; throwOnAllFailed?: boolean },
): Promise<EnqueueBatchResult> {
  const enqueuedIds: string[] = [];
  const skippedIds: string[] = [];
  const failedIds: string[] = [];
  const errors: { messageId: string; error: string }[] = [];
  if (echoes.length === 0) return { enqueuedIds, skippedIds, failedIds, errors };

  const supabaseAdmin =
    customSupabase ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const connCache = new Map<
    string,
    Promise<{ company_id: string; whatsapp_business_account_id: string } | null>
  >();
  const nowMs = options?.nowMs ?? Date.now();

  const seenBatchKeys = new Set<string>();
  const lanesByRecipient = new Map<string, ExtractedBusinessEcho[]>();

  for (const echo of echoes) {
    const cmd = echo.text.trim();
    if (cmd !== "OK" && cmd !== "OKK") {
      skippedIds.push(echo.messageId);
      continue;
    }

    const batchKey = `${echo.phoneNumberId}:${echo.messageId}`;
    if (seenBatchKeys.has(batchKey)) {
      skippedIds.push(echo.messageId);
      continue;
    }
    seenBatchKeys.add(batchKey);

    const normalizedPhone = phoneKey(echo.to) || echo.to || "sem-telefone";
    const laneKey = `${echo.phoneNumberId}:${normalizedPhone}`;
    const lane = lanesByRecipient.get(laneKey);
    if (lane) {
      lane.push(echo);
    } else {
      lanesByRecipient.set(laneKey, [echo]);
    }
  }

  await runBoundedLanes(
    Array.from(lanesByRecipient.values()),
    options?.concurrency ?? MAX_ENQUEUE_CONCURRENCY,
    async (echo) => {
      const cmd = echo.text.trim();
      const connData = await resolveActiveConnectionCached(
        supabaseAdmin,
        echo.phoneNumberId,
        connCache,
      );
      if (!connData) {
        skippedIds.push(echo.messageId);
        return;
      }
      if (echo.wabaId && echo.wabaId !== connData.whatsapp_business_account_id) {
        skippedIds.push(echo.messageId);
        return;
      }

      const companyId = connData.company_id;
      const uid = `echo:${echo.messageId}`;
      const ts = Number(echo.timestamp);
      const receivedAt =
        Number.isFinite(ts) && ts > 0
          ? new Date(ts * 1000).toISOString()
          : new Date(nowMs).toISOString();
      const normalizedPhone = phoneKey(echo.to) || echo.to || "sem-telefone";

      const ins = await supabaseAdmin
        .from("whatsapp_messages")
        .insert({
          company_id: companyId,
          phone: normalizedPhone,
          direction: "outbound",
          body: cmd,
          status: "aguardando",
          message_uid: uid,
          source: "whatsapp_echo",
          phone_number_id: echo.phoneNumberId,
          received_at: receivedAt,
          parsed: {
            eh_pedido: false,
            echo_meta: {
              messageId: echo.messageId,
              from: echo.from,
              to: echo.to,
              text: cmd,
              timestamp: echo.timestamp,
              phoneNumberId: echo.phoneNumberId,
              wabaId: echo.wabaId,
              quoted: echo.quoted,
              forwarded: echo.forwarded,
              standalone: echo.standalone,
            },
          },
        } as never)
        .select("id")
        .single();

      if (ins.data) {
        enqueuedIds.push((ins.data as { id: string }).id);
        return;
      }

      const reconciled = await reconcileRedeliveredWebhookMessageSafe(
        supabaseAdmin,
        companyId,
        uid,
        ins.error?.message,
        nowMs,
      );
      if (reconciled.action === "enqueued") {
        enqueuedIds.push(reconciled.id);
      } else {
        skippedIds.push(reconciled.id);
      }
    },
    {
      stopLaneOnError: true,
      onItemError: async (echo, err) => {
        const safeErr = sanitizeFreeTextForOperationalLog(err.message);
        failedIds.push(echo.messageId);
        errors.push({ messageId: echo.messageId, error: safeErr });
      },
    },
  );

  if (failedIds.length > 0) {
    await emitOperationalAlert({
      code: "WHATSAPP_WEBHOOK_ECHO_ENQUEUE_PARTIAL_FAILURE",
      severity: "critical",
      title: "Falha ao persistir um ou mais ecos comerciais na fila durável do WhatsApp",
      details: {
        enqueuedCount: enqueuedIds.length,
        skippedCount: skippedIds.length,
        failedCount: failedIds.length,
        failedIds,
        errors,
      },
    });

    if (options?.throwOnAllFailed !== false && enqueuedIds.length === 0 && skippedIds.length === 0) {
      throw new Error(errors[0]?.error || "Falha ao enfileirar eco comercial na fila durável");
    }
  }

  return { enqueuedIds, skippedIds, failedIds, errors };
}

/**
 * Verifica se há mensagem inbound do mesmo cliente ainda aguardando ou em processamento
 * na IA Gemini (evitando que um eco OK/OKK enviado imediatamente falhe com SEM_PEDIDO_ELEGIVEL).
 */
export async function hasInflightCustomerOrderMessage(
  supabase: SupabaseClient<Database>,
  companyId: string,
  customerPhone: string,
): Promise<boolean> {
  const normPhone = phoneKey(customerPhone);
  if (!companyId || !normPhone) return false;

  const maybeRpc = (
    supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: boolean | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    try {
      const rpcRes = await maybeRpc.call(supabase, "has_inflight_customer_order_message", {
        _company_id: companyId,
        _phone: normPhone,
      });
      if (!rpcRes.error && typeof rpcRes.data === "boolean") {
        return rpcRes.data;
      }
    } catch {
      // Fallback apenas para leitura booleana de mensagem inbound em voo
    }
  }

  try {
    const res = await supabase
      .from("whatsapp_messages")
      .select("id, phone, direction, status, order_id, attempts, manual_retry_count")
      .eq("company_id", companyId)
      .is("order_id", null)
      .in("status", ["aguardando", "processando", "erro"])
      .limit(50);

    if (res.error || !res.data) return false;
    return res.data.some((m) => {
      const maxAtt =
        MAX_INBOUND_AUTO_ATTEMPTS + Math.min(MAX_MANUAL_RETRIES, Math.max(0, m.manual_retry_count ?? 0));
      return (
        (m.direction ?? "inbound") === "inbound" &&
        (m.attempts ?? 0) < maxAtt &&
        phoneKey(m.phone) === normPhone
      );
    });
  } catch {
    return false;
  }
}

/**
 * Coalescência (Singleflight) em memória para disparos assíncronos de drainWhatsAppQueue.
 */
let activeBackgroundDrainPromise: Promise<{
  claimed: number;
  processed: number;
  failed: number;
}> | null = null;
let pendingTrailingDrain = false;

export function scheduleDrainWhatsAppQueue(options?: {
  companyId?: string;
  limit?: number;
  concurrency?: number;
  supabase?: SupabaseClient<Database>;
}): Promise<{ claimed: number; processed: number; failed: number }> {
  if (activeBackgroundDrainPromise) {
    pendingTrailingDrain = true;
    return activeBackgroundDrainPromise;
  }

  const runLoop = async () => {
    let totalClaimed = 0;
    let totalProcessed = 0;
    let totalFailed = 0;

    do {
      pendingTrailingDrain = false;
      const res = await drainWhatsAppQueue(options);
      totalClaimed += res.claimed;
      totalProcessed += res.processed;
      totalFailed += res.failed;
    } while (pendingTrailingDrain);

    return { claimed: totalClaimed, processed: totalProcessed, failed: totalFailed };
  };

  activeBackgroundDrainPromise = runLoop().finally(() => {
    activeBackgroundDrainPromise = null;
  });

  return activeBackgroundDrainPromise;
}

/**
 * Worker durável de drenagem da fila do WhatsApp (mensagens de clientes e ecos OK/OKK).
 *
 * CORREÇÃO CRÍTICA C-09 / M-02 (Seções 4.1 a 4.5):
 * - Aquisição (Claim) 100% FAIL-CLOSED: depende exclusivamente da RPC oficial
 *   `claim_whatsapp_queue_batch`. NENHUM fallback para `SELECT` + `UPDATE` direto ou
 *   geração inventada em memória é permitido.
 * - Se a RPC estiver ausente, falhar (erro PostgreSQL, timeout, falha de conexão), retornar
 *   resposta nula/malformada ou retornar qualquer linha sem confirmação válida de propriedade
 *   (`locked_by === workerId`, `status === 'processando'` e `lease_generation >= 1`), o
 *   processamento é interrompido imediatamente com erro operacional sanitizado.
 */
export async function drainWhatsAppQueue(options?: {
  companyId?: string;
  messageId?: string;
  limit?: number;
  concurrency?: number;
  workerId?: string;
  lockSeconds?: number;
  heartbeatIntervalMs?: number;
  supabase?: SupabaseClient<Database>;
}): Promise<{ claimed: number; processed: number; failed: number; workerId: string }> {
  const supabaseAdmin =
    options?.supabase ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const limit = Math.min(Math.max(1, options?.limit ?? 15), 100);
  const concurrency = Math.min(Math.max(1, options?.concurrency ?? 3), 5);
  const lockSeconds = Math.max(15, options?.lockSeconds ?? 90);
  const workerId = options?.workerId?.trim() || `worker:${randomUUID()}`;

  const maybeRpc = (
    supabaseAdmin as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: Database["public"]["Tables"]["whatsapp_messages"]["Row"][] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  )?.rpc;

  if (typeof maybeRpc !== "function") {
    await emitOperationalAlert({
      code: "WHATSAPP_QUEUE_CLAIM_RPC_UNAVAILABLE",
      severity: "critical",
      title: "Claim da fila WhatsApp abortado: RPC claim_whatsapp_queue_batch indisponível",
      details: { workerId, companyId: options?.companyId ?? null },
    });
    throw new Error(
      "Falha segura no claim da fila WhatsApp: mecanismo oficial claim_whatsapp_queue_batch indisponível.",
    );
  }

  let rpcRes: {
    data: Database["public"]["Tables"]["whatsapp_messages"]["Row"][] | null;
    error: { code?: string; message: string } | null;
  };

  try {
    rpcRes = await maybeRpc.call(supabaseAdmin, "claim_whatsapp_queue_batch", {
      _batch_size: limit,
      _lock_seconds: lockSeconds,
      _company_id: options?.companyId ?? null,
      _message_id: options?.messageId ?? null,
      _limit: limit,
      _worker_id: workerId,
    });
  } catch (err) {
    const safeMsg = sanitizeFreeTextForOperationalLog(
      err instanceof Error ? err.message : String(err),
    );
    await emitOperationalAlert({
      code: "WHATSAPP_QUEUE_CLAIM_RPC_EXCEPTION",
      severity: "critical",
      title: "Exceção de rede/timeout ao executar claim_whatsapp_queue_batch",
      details: { workerId, companyId: options?.companyId ?? null, error: safeMsg },
    });
    throw new Error(
      `Falha segura no claim da fila WhatsApp: não foi possível comunicar com claim_whatsapp_queue_batch (${safeMsg}).`,
    );
  }

  if (!rpcRes || rpcRes.error || !Array.isArray(rpcRes.data)) {
    const rawCode = rpcRes?.error?.code ?? "INVALID_CLAIM_RESPONSE";
    const safeMsg = sanitizeFreeTextForOperationalLog(
      rpcRes?.error?.message ?? "Resposta nula ou malformada de claim_whatsapp_queue_batch",
    );
    await emitOperationalAlert({
      code: "WHATSAPP_QUEUE_CLAIM_RPC_ERROR",
      severity: "critical",
      title: "Erro retornado por claim_whatsapp_queue_batch; processamento interrompido (fail-closed)",
      details: { workerId, code: rawCode, error: safeMsg },
    });
    throw new Error(
      `Falha segura no claim da fila WhatsApp (${rawCode}): processamento interrompido.`,
    );
  }

  if (rpcRes.data.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, workerId };
  }

  const nowMs = Date.now();
  const claimedRows: Database["public"]["Tables"]["whatsapp_messages"]["Row"][] = [];

  for (const r of rpcRes.data) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id.trim()) {
      for (const prev of claimedRows) {
        releaseInProcessMessageLock(prev.id, workerId, prev.lease_generation);
      }
      throw new Error(
        "Falha segura no claim da fila WhatsApp: linha reclamada sem identificador válido.",
      );
    }

    if (r.order_id || ["revisar", "registrado", "ignorado"].includes(r.status)) {
      continue;
    }

    const gen = normalizeFencingGeneration(r.lease_generation);
    const lockedByMatches = typeof r.locked_by === "string" && r.locked_by === workerId;
    const statusValid = r.status === "processando";
    const lockedUntilValid =
      typeof r.locked_until === "string" &&
      Number.isFinite(Date.parse(r.locked_until)) &&
      Date.parse(r.locked_until) > nowMs;

    if (!statusValid || !lockedByMatches || gen === null || !lockedUntilValid) {
      for (const prev of claimedRows) {
        releaseInProcessMessageLock(prev.id, workerId, prev.lease_generation);
      }
      await emitOperationalAlert({
        code: "WHATSAPP_QUEUE_INVALID_CLAIM_FENCING",
        severity: "critical",
        title: "Claim da fila WhatsApp rejeitado: ausência de confirmação de propriedade ou lease_generation inválida",
        details: {
          workerId,
          messageId: r.id,
          status: r.status ?? null,
          lockedByMatches,
          leaseGeneration: gen ?? null,
        },
      });
      throw new Error(
        `Falha segura no claim da fila WhatsApp: confirmação de posse ou lease_generation inválida para a mensagem ${r.id}.`,
      );
    }

    const lockInfo = acquireInProcessMessageLock(r.id, workerId, lockSeconds, nowMs, gen);
    if (!lockInfo.acquired) {
      for (const prev of claimedRows) {
        releaseInProcessMessageLock(prev.id, workerId, prev.lease_generation);
      }
      throw new Error(
        `Falha segura no claim da fila WhatsApp: fencing token rejeitado para a mensagem ${r.id} (geração ${gen}).`,
      );
    }

    claimedRows.push({
      ...r,
      locked_by: workerId,
      lease_generation: lockInfo.leaseGeneration,
      next_retry_at: null,
    });
  }

  if (claimedRows.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, workerId };
  }

  const inboundRows = claimedRows.filter(
    (r) => r.direction !== "outbound" && r.source !== "whatsapp_echo",
  );
  const echoRows = claimedRows.filter(
    (r) => r.direction === "outbound" || r.source === "whatsapp_echo",
  );

  let processed = 0;
  let failed = 0;
  const deferredEchoes: Database["public"]["Tables"]["whatsapp_messages"]["Row"][] = [];
  const heartbeatIntervalMs =
    typeof options?.heartbeatIntervalMs === "number" && options.heartbeatIntervalMs >= 10
      ? options.heartbeatIntervalMs
      : Math.max(10_000, Math.floor((lockSeconds * 1000) / 3));

  async function processSingleRow(
    row: Database["public"]["Tables"]["whatsapp_messages"]["Row"],
    isRetryPass = false,
  ) {
    const rowLeaseGen = normalizeFencingGeneration(row.lease_generation);

    if (
      rowLeaseGen === null ||
      row.order_id ||
      ["revisar", "registrado", "ignorado"].includes(row.status)
    ) {
      releaseInProcessMessageLock(
        row.id,
        workerId,
        rowLeaseGen !== null ? rowLeaseGen : undefined,
      );
      return;
    }

    let leaseLost = false;
    let heartbeatInFlight: Promise<boolean> | null = null;

    const triggerHeartbeat = (): Promise<boolean> => {
      if (leaseLost) return Promise.resolve(false);
      if (heartbeatInFlight) return heartbeatInFlight;
      heartbeatInFlight = renewWhatsAppMessageLockSafe(
        supabaseAdmin,
        row.id,
        workerId,
        lockSeconds,
        rowLeaseGen,
      )
        .then((ok) => {
          if (!ok) {
            leaseLost = true;
          }
          return ok;
        })
        .catch(() => {
          leaseLost = true;
          releaseInProcessMessageLock(row.id, workerId, rowLeaseGen);
          return false;
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
      return heartbeatInFlight;
    };

    const renewTimer = setInterval(() => {
      void triggerHeartbeat();
    }, heartbeatIntervalMs);

    try {
      if (leaseLost || !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)) {
        return;
      }

      if (row.direction === "outbound" || row.source === "whatsapp_echo") {
        const parsedObj = (row.parsed ?? {}) as {
          echo_meta?: Partial<ExtractedBusinessEcho>;
        };
        const meta = parsedObj.echo_meta ?? {};
        const echo: ExtractedBusinessEcho = {
          messageId:
            meta.messageId ||
            (row.message_uid?.startsWith("echo:") ? row.message_uid.slice(5) : row.id),
          from: meta.from || "",
          to: meta.to || row.phone,
          text: (meta.text || row.body || "").trim(),
          timestamp:
            meta.timestamp ??
            (row.received_at ? String(Math.floor(Date.parse(row.received_at) / 1000)) : null),
          phoneNumberId: meta.phoneNumberId || row.phone_number_id || "",
          wabaId: meta.wabaId ?? null,
          quoted: Boolean(meta.quoted),
          forwarded: Boolean(meta.forwarded),
          standalone: meta.standalone !== undefined ? Boolean(meta.standalone) : true,
        };

        const inflight = await hasInflightCustomerOrderMessage(
          supabaseAdmin,
          row.company_id,
          echo.to,
        );
        if (inflight && !isRetryPass && inboundRows.length > 0) {
          deferredEchoes.push(row);
          return;
        }

        if (heartbeatInFlight) {
          await heartbeatInFlight;
        }
        if (leaseLost || !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)) {
          return;
        }

        const echoRes = await processVerifiedBusinessEcho(
          supabaseAdmin,
          row.company_id,
          echo,
          new Date(),
          {
            skipDirectMessageUpsert: true,
            messageId: row.id,
            workerId,
            leaseGeneration: rowLeaseGen,
            waitForHeartbeat: async () => (heartbeatInFlight ? await heartbeatInFlight : !leaseLost),
            isLeaseLost: () => leaseLost,
          },
        );

        if (heartbeatInFlight) {
          await heartbeatInFlight;
        }
        if (
          (echoRes as { leaseLost?: boolean })?.leaseLost ||
          leaseLost ||
          !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)
        ) {
          releaseInProcessMessageLock(row.id, workerId, rowLeaseGen);
          return;
        }

        const resOutcome = (
          echoRes as {
            result?: { outcome?: string; reason?: string; order_id?: string | null };
          }
        )?.result?.outcome;
        const resReason = (
          echoRes as { result?: { outcome?: string; reason?: string } }
        )?.result?.reason;
        const classifiedOrderId = (
          echoRes as { result?: { order_id?: string | null } }
        )?.result?.order_id;

        const isWaitingPendingOrder =
          resOutcome === "retry_pending_order" ||
          (resOutcome === "blocked" &&
            resReason === "SEM_PEDIDO_ELEGIVEL" &&
            (await hasInflightCustomerOrderMessage(supabaseAdmin, row.company_id, echo.to)));

        if (isWaitingPendingOrder) {
          const currentAttempts = row.attempts ?? 1;
          if (currentAttempts >= MAX_ECHO_ORDER_WAIT_ATTEMPTS) {
            const deadLetterReason = "PEDIDO_NAO_LOCALIZADO_APOS_TENTATIVAS";
            const deadLetterError =
              `Confirmação ${echo.text} não localizou pedido elegível após ${currentAttempts} tentativas. Encaminhada para revisão manual.`;
            const deadLetterParsed = {
              ...(typeof row.parsed === "object" && row.parsed !== null ? row.parsed : {}),
              eh_pedido: false,
              motivo: deadLetterReason,
              dead_letter: {
                reason: deadLetterReason,
                attempts: currentAttempts,
                command: echo.text,
                transitioned_at: new Date().toISOString(),
              },
            };

            const transitioned = await releaseWhatsAppMessageLockSafe(
              supabaseAdmin,
              row.id,
              workerId,
              "revisar",
              {
                lastError: deadLetterError,
                nextRetryAt: null,
                leaseGeneration: rowLeaseGen,
                parsed: deadLetterParsed,
              },
            );

            if (transitioned) {
              await emitOperationalAlert({
                code: "WHATSAPP_ECHO_DEAD_LETTER_REVIEW",
                severity: "warning",
                title: "Eco comercial OK/OKK encaminhado para revisão após esgotar tentativas",
                details: {
                  companyId: row.company_id,
                  messageId: row.id,
                  command: echo.text,
                  phone: echo.to,
                  attempts: currentAttempts,
                  reason: deadLetterReason,
                },
              });
              processed++;
            }
            return;
          }

          const retryDelayMs = computeEchoRetryBackoffMs(currentAttempts);
          const nextRetryIso = new Date(Date.now() + retryDelayMs).toISOString();
          await releaseWhatsAppMessageLockSafe(
            supabaseAdmin,
            row.id,
            workerId,
            "aguardando",
            {
              lastError: "Aguardando conclusão do processamento IA do pedido do cliente",
              nextRetryAt: nextRetryIso,
              leaseGeneration: rowLeaseGen,
            },
          );
          return;
        }

        const isMultipleEligible = resReason === "MULTIPLOS_PEDIDOS_ELEGIVEIS";
        const finalEchoStatus =
          resOutcome === "classified" || resOutcome === "duplicate"
            ? "registrado"
            : isMultipleEligible
              ? "revisar"
              : "ignorado";

        const multipleEligibleDetail = isMultipleEligible
          ? `[Confirmação ${echo.text}]: Cliente possui múltiplos pedidos hoje aguardando classificação. Confirme individualmente na tela de Pedidos.`
          : null;

        const preservedFinalParsed = isMultipleEligible
          ? {
              ...(typeof row.parsed === "object" && row.parsed !== null ? row.parsed : {}),
              eh_pedido: false,
              comando: echo.text,
              motivo: "MULTIPLOS_PEDIDOS_ELEGIVEIS",
              detalhe_revisao: multipleEligibleDetail,
              echo_meta: {
                messageId: echo.messageId,
                from: echo.from,
                to: echo.to,
                text: echo.text,
                timestamp: echo.timestamp,
                phoneNumberId: echo.phoneNumberId,
                wabaId: echo.wabaId,
                quoted: echo.quoted,
                forwarded: echo.forwarded,
                standalone: echo.standalone,
              },
            }
          : undefined;

        const released = await releaseWhatsAppMessageLockSafe(
          supabaseAdmin,
          row.id,
          workerId,
          finalEchoStatus,
          {
            lastError: multipleEligibleDetail,
            nextRetryAt: null,
            leaseGeneration: rowLeaseGen,
            orderId: classifiedOrderId ?? null,
            parsed: preservedFinalParsed,
          },
        );

        if (released) {
          processed++;
        }
        return;
      }

      if (heartbeatInFlight) {
        await heartbeatInFlight;
      }
      if (leaseLost || !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)) {
        return;
      }

      const incomingRes = await processIncomingMessage(
        supabaseAdmin,
        row.company_id,
        {
          phone: row.phone === "sem-telefone" ? "" : row.phone,
          body: row.body,
          externalId: row.message_uid ?? undefined,
          messageId: row.id,
        },
        {
          source: row.source,
          profile_name: row.profile_name,
          phone_number_id: row.phone_number_id,
          received_at: row.received_at,
          attempts: row.attempts ?? 0,
          manual_retry_count: row.manual_retry_count ?? 0,
          worker_id: workerId,
          lease_generation: rowLeaseGen,
        },
      );

      if (heartbeatInFlight) {
        await heartbeatInFlight;
      }
      if (
        (incomingRes as { leaseLost?: boolean })?.leaseLost ||
        leaseLost ||
        !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)
      ) {
        releaseInProcessMessageLock(row.id, workerId, rowLeaseGen);
        return;
      }

      if ((incomingRes as { completedByRpc?: boolean })?.completedByRpc) {
        releaseInProcessMessageLock(row.id, workerId, rowLeaseGen);
        processed++;
        return;
      }

      const finalInboundStatus = (
        incomingRes.status === "registrado" ||
        incomingRes.status === "revisar" ||
        incomingRes.status === "ignorado"
          ? incomingRes.status
          : "registrado"
      ) as "registrado" | "revisar" | "ignorado";

      const releasedInbound = await releaseWhatsAppMessageLockSafe(
        supabaseAdmin,
        row.id,
        workerId,
        finalInboundStatus,
        {
          lastError: null,
          nextRetryAt: null,
          leaseGeneration: rowLeaseGen,
          orderId: (incomingRes as { orderId?: string | null }).orderId ?? undefined,
          parsed: (incomingRes.parsed as Record<string, unknown> | null) ?? undefined,
        },
      );
      if (releasedInbound) {
        processed++;
      }
    } catch (err) {
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const safeErrMsg = sanitizeFreeTextForOperationalLog(rawErrMsg);

      if (heartbeatInFlight) {
        await heartbeatInFlight.catch(() => false);
      }

      if (
        !leaseLost &&
        hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)
      ) {
        const currentAttempts = Math.max(1, row.attempts ?? 1);
        const maxAllowed =
          row.direction === "outbound" || row.source === "whatsapp_echo"
            ? MAX_ECHO_ORDER_WAIT_ATTEMPTS
            : MAX_INBOUND_AUTO_ATTEMPTS +
              Math.min(MAX_MANUAL_RETRIES, Math.max(0, row.manual_retry_count ?? 0));
        const shouldMoveToReview = currentAttempts >= maxAllowed;
        const targetStatus: "revisar" | "erro" = shouldMoveToReview ? "revisar" : "erro";
        const nextRetryIso = shouldMoveToReview
          ? null
          : new Date(Date.now() + computeInboundErrorBackoffMs(currentAttempts)).toISOString();

        try {
          await releaseWhatsAppMessageLockSafe(
            supabaseAdmin,
            row.id,
            workerId,
            targetStatus,
            {
              lastError: safeErrMsg,
              nextRetryAt: nextRetryIso,
              leaseGeneration: rowLeaseGen,
            },
          );
        } catch {
          // O sweep automático de claim_whatsapp_queue_batch recuperará caso o banco esteja inacessível
        }
      }

      console.error(
        JSON.stringify({
          level: "error",
          type: "whatsapp_queue_worker_row_error",
          messageId: row.id,
          error: safeErrMsg,
        }),
      );
      failed++;
    } finally {
      clearInterval(renewTimer);
      releaseInProcessMessageLock(row.id, workerId, rowLeaseGen);
    }
  }

  async function runPool(
    rows: Database["public"]["Tables"]["whatsapp_messages"]["Row"][],
    isRetry = false,
  ) {
    if (rows.length === 0) return;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (cursor < rows.length) {
        const idx = cursor++;
        const r = rows[idx];
        if (r) await processSingleRow(r, isRetry);
      }
    });
    await Promise.all(workers);
  }

  await runPool(inboundRows, false);
  await runPool(echoRows, false);

  if (deferredEchoes.length > 0) {
    await runPool(deferredEchoes, true);
  }

  if (failed > 0) {
    await emitOperationalAlert({
      code: "WHATSAPP_WORKER_BATCH_FAILURES",
      severity: "warning",
      title: "Falha ao processar mensagem(ns) na fila durável do WhatsApp",
      details: { claimed: claimedRows.length, processed, failed, workerId },
    });
  }

  return { claimed: claimedRows.length, processed, failed, workerId };
}

/**
 * CORREÇÃO AUD-02:
 * Fluxo unificado da fila durável: enqueueMetaMessages + drainWhatsAppQueue.
 */
export async function handleMetaMessages(
  messages: IncomingWhatsAppMessage[],
  customSupabase?: SupabaseClient<Database>,
) {
  if (messages.length === 0) return;
  const supabaseAdmin =
    customSupabase ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  const { enqueuedIds, failedIds } = await enqueueMetaMessages(messages, supabaseAdmin);
  if (enqueuedIds.length === 0 && failedIds.length === 0) return;

  let drainFailed = 0;
  if (enqueuedIds.length > 0) {
    const drainRes = await drainWhatsAppQueue({
      supabase: supabaseAdmin,
      limit: Math.max(15, enqueuedIds.length),
    });
    drainFailed = drainRes.failed;
  }

  if (failedIds.length > 0 || drainFailed > 0) {
    throw new Error("Uma ou mais mensagens falharam");
  }
}

/**
 * Processa um eco comercial verificado ("OK" ou "OKK") enviado pela própria marmitaria
 * na conversa com o cliente (`to`).
 */
export async function processVerifiedBusinessEcho(
  supabase: SupabaseClient<Database>,
  companyId: string,
  echo: ExtractedBusinessEcho,
  now: Date = new Date(),
  options?: {
    skipDirectMessageUpsert?: boolean;
    messageId?: string | null;
    workerId?: string | null;
    leaseGeneration?: number | string | null;
    waitForHeartbeat?: () => Promise<boolean>;
    isLeaseLost?: () => boolean;
  },
) {
  const commandText = echo.text.trim();
  if (commandText !== "OK" && commandText !== "OKK") {
    return { skipped: true, reason: "COMANDO_NAO_RECONHECIDO" };
  }

  const hasWorkerContext = Boolean(
    options?.skipDirectMessageUpsert ||
      options?.workerId !== undefined ||
      options?.leaseGeneration !== undefined ||
      options?.messageId !== undefined,
  );
  const cleanMessageId = typeof options?.messageId === "string" ? options.messageId.trim() : "";
  const cleanWorkerId = typeof options?.workerId === "string" ? options.workerId.trim() : "";
  const normalizedLeaseGen = normalizeFencingGeneration(options?.leaseGeneration);

  if (hasWorkerContext && (!cleanMessageId || !cleanWorkerId || normalizedLeaseGen === null)) {
    return {
      skipped: false,
      leaseLost: true,
      reason: "MESSAGE_LEASE_LOST",
    };
  }

  const ensureEchoWorkerLeaseValid = async (): Promise<boolean> => {
    if (!hasWorkerContext) return true;
    if (options?.waitForHeartbeat) {
      const hbOk = await options.waitForHeartbeat().catch(() => false);
      if (!hbOk) {
        releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
        return false;
      }
    }
    if (
      options?.isLeaseLost?.() ||
      !hasActiveInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!)
    ) {
      releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
      return false;
    }
    const stillOwnsInDb = await verifyWorkerStillOwnsLease(
      supabase,
      cleanMessageId,
      cleanWorkerId,
      normalizedLeaseGen!,
    );
    if (!stillOwnsInDb) {
      releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
      return false;
    }
    return true;
  };

  if (!(await ensureEchoWorkerLeaseValid())) {
    return {
      skipped: false,
      leaseLost: true,
      reason: "MESSAGE_LEASE_LOST",
    };
  }

  const ts = Number(echo.timestamp);
  const receivedDate =
    Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : now;
  const receivedAt = receivedDate.toISOString();
  const today = brToday(now);
  const commandDate = brDateISO(receivedDate);
  const eventId = `echo:${echo.messageId}`;
  const targetKey = phoneKey(echo.to);

  if (!targetKey || !/^\d{10,11}$/.test(targetKey)) {
    return { skipped: true, reason: "CONTEXTO_NAO_IDENTIFICADO" };
  }

  const customer = await findCustomerByPhoneIndexed(supabase, companyId, targetKey);

  if (!(await ensureEchoWorkerLeaseValid())) {
    return {
      skipped: false,
      leaseLost: true,
      reason: "MESSAGE_LEASE_LOST",
    };
  }

  if (!customer) {
    if (await hasInflightCustomerOrderMessage(supabase, companyId, targetKey)) {
      if (!(await ensureEchoWorkerLeaseValid())) {
        return {
          skipped: false,
          leaseLost: true,
          reason: "MESSAGE_LEASE_LOST",
        };
      }
      return {
        skipped: false,
        retryable: true,
        reason: "PEDIDO_EM_PROCESSAMENTO_IA",
        result: {
          outcome: "retry_pending_order" as const,
          reason: "PEDIDO_EM_PROCESSAMENTO_IA",
          order_id: null,
          state: null,
          total: null,
          audit_id: null,
        },
      };
    }
    return { skipped: true, reason: "CONTEXTO_NAO_IDENTIFICADO" };
  }

  const convId = `wa:${companyId}:${customer.id}`;

  const loadedContext = await (async (): Promise<FinancialContext> => {
    const maybeRpc = (
      supabase as unknown as {
        rpc?: (
          fn: string,
          args: Record<string, unknown>,
        ) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
      }
    ).rpc;

    if (typeof maybeRpc === "function") {
      const rpc = await maybeRpc.call(supabase, "financial_echo_context", {
        _company_id: companyId,
        _customer_id: customer.id,
        _event_id: eventId,
        _command: commandText,
        _received_at: receivedAt,
        _standalone: echo.standalone,
        _quoted: echo.quoted,
        _forwarded: echo.forwarded,
      });

      if (!rpc.error && rpc.data) {
        return rpc.data as FinancialContext;
      }
    }

    const ordersRes = await supabase
      .from("orders")
      .select("*")
      .eq("company_id", companyId)
      .eq("customer_id", customer.id)
      .eq("order_date", today);

    const eventsRes = await supabase
      .from("financial_events")
      .select("event_id")
      .eq("company_id", companyId)
      .eq("event_id", eventId);

    const mappedOrders: FinancialOrder[] = (ordersRes.data ?? []).map((o) => ({
      id: o.id,
      companyId: o.company_id,
      customerId: o.customer_id,
      conversationId: convId,
      phone: o.financial_phone || targetKey,
      date: o.order_date,
      total: Number(o.total),
      state:
        o.financial_state === "aguardando_classificacao"
          ? "PENDENTE"
          : o.financial_state === "pago"
            ? "PAGO"
            : "FIADO",
      cancelled: o.delivery_status === "cancelado",
      paymentState: o.settled_by_payment ? "UNKNOWN" : "NONE",
      confirmed: o.financial_state !== "aguardando_classificacao",
    }));

    return {
      body: commandText,
      eventId,
      source: "verified_business_echo",
      actorAuthorized: true,
      provenanceVerified: true,
      standalone: echo.standalone,
      quoted: echo.quoted,
      forwarded: echo.forwarded,
      companyId,
      customerId: customer.id,
      conversationId: convId,
      phone: customer.phone,
      today,
      commandDate,
      explicitOrderId: null,
      processedEventIds: (eventsRes.data ?? []).map((e) => e.event_id),
      orders: mappedOrders,
    };
  })();

  const eligibleToday = loadedContext.orders.filter(
    (o) => !o.cancelled && o.date === today && o.state === "PENDENTE" && !o.confirmed,
  );

  if (
    eligibleToday.length === 0 &&
    !loadedContext.processedEventIds.includes(eventId) &&
    (await hasInflightCustomerOrderMessage(supabase, companyId, targetKey))
  ) {
    return {
      skipped: false,
      retryable: true,
      reason: "PEDIDO_EM_PROCESSAMENTO_IA",
      result: {
        outcome: "retry_pending_order" as const,
        reason: "PEDIDO_EM_PROCESSAMENTO_IA",
        order_id: null,
        state: null,
        total: null,
        audit_id: null,
      },
    };
  }

  if (!(await ensureEchoWorkerLeaseValid())) {
    return {
      skipped: false,
      leaseLost: true,
      reason: "MESSAGE_LEASE_LOST",
    };
  }

  try {
    return await classifyWithPersistence(
      {
        load: async () => loadedContext,
        commit: async (_req, decision): Promise<FinancialCommit> => {
          if (!(await ensureEchoWorkerLeaseValid())) {
            throw new Error(
              "MESSAGE_LEASE_LOST: posse ou geração do lease perdida antes de financial_classify_by_echo",
            );
          }

          const rpcArgs: Record<string, unknown> = {
            _company_id: companyId,
            _customer_id: customer.id,
            _order_id: decision.pedido_id,
            _event_id: eventId,
            _command: commandText,
            _received_at: receivedAt,
            _validation_allowed: decision.acao_financeira === "SOLICITAR_CLASSIFICACAO",
            _validation_reason: decision.motivo,
          };

          if (hasWorkerContext) {
            rpcArgs["_message_id"] = cleanMessageId;
            rpcArgs["_worker_id"] = cleanWorkerId;
            rpcArgs["_lease_generation"] = normalizedLeaseGen;
          }

          const rpc = await (
            supabase as unknown as {
              rpc: (
                fn: string,
                args: Record<string, unknown>,
              ) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
            }
          ).rpc("financial_classify_by_echo", rpcArgs);

          if (
            rpc.error &&
            (rpc.error.code === "55P03" || /LEASE_LOST|MESSAGE_LEASE_LOST/i.test(rpc.error.message))
          ) {
            if (hasWorkerContext) {
              releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
            }
            throw new Error(`MESSAGE_LEASE_LOST: ${rpc.error.message}`);
          }

          if (!rpc.error && rpc.data) {
            const res = rpc.data as FinancialCommit;
            if (
              !options?.skipDirectMessageUpsert &&
              (decision.motivo === "MULTIPLOS_PEDIDOS_ELEGIVEIS" ||
                res.reason === "MULTIPLOS_PEDIDOS_ELEGIVEIS")
            ) {
              const ambiguityDetail = `[Confirmação ${commandText}]: Cliente possui múltiplos pedidos hoje aguardando classificação. Confirme individualmente na tela de Pedidos.`;
              await supabase.from("whatsapp_messages").upsert(
                {
                  company_id: companyId,
                  customer_id: customer.id,
                  phone: customer.phone,
                  direction: "outbound",
                  body: commandText,
                  status: "revisar",
                  message_uid: eventId,
                  order_date: today,
                  source: "whatsapp_echo",
                  last_error: ambiguityDetail,
                  parsed: {
                    eh_pedido: false,
                    comando: commandText,
                    motivo: "MULTIPLOS_PEDIDOS_ELEGIVEIS",
                    detalhe_revisao: ambiguityDetail,
                    echo_meta: {
                      messageId: echo.messageId,
                      from: echo.from,
                      to: echo.to,
                      text: commandText,
                      timestamp: echo.timestamp,
                      phoneNumberId: echo.phoneNumberId,
                      wabaId: echo.wabaId,
                      quoted: echo.quoted,
                      forwarded: echo.forwarded,
                      standalone: echo.standalone,
                    },
                  },
                } as never,
                { onConflict: "company_id,message_uid" },
              );
            }
            return res;
          }

          if (rpc.error) {
            throw new Error(rpc.error.message);
          }
          throw new Error("Resposta financeira indisponível.");
        },
      },
      { orderId: "", eventId, command: commandText },
    );
  } catch (err) {
    if (err instanceof Error && /LEASE_LOST|MESSAGE_LEASE_LOST/i.test(err.message)) {
      if (hasWorkerContext) {
        releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
      }
      return {
        skipped: false,
        leaseLost: true,
        reason: "MESSAGE_LEASE_LOST",
      };
    }
    throw err;
  }
}

export async function handleMetaBusinessEchoes(
  echoes: ExtractedBusinessEcho[],
  customSupabase?: SupabaseClient<Database>,
) {
  if (echoes.length === 0) return;
  const supabaseAdmin =
    customSupabase ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const { enqueuedIds, failedIds } = await enqueueMetaBusinessEchoes(echoes, supabaseAdmin);
  if (enqueuedIds.length === 0 && failedIds.length === 0) return;
  if (enqueuedIds.length > 0) {
    await drainWhatsAppQueue({
      supabase: supabaseAdmin,
      limit: Math.max(15, enqueuedIds.length),
    });
  }
  if (failedIds.length > 0) {
    throw new Error("Um ou mais ecos comerciais falharam ao enfileirar");
  }
}
