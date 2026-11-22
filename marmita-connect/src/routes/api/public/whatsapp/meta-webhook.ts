import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

/**
 * Webhook da Meta WhatsApp Cloud API (somente RECEBIMENTO).
 * GET  -> verificação do webhook (hub.challenge) com WHATSAPP_VERIFY_TOKEN.
 * POST -> mensagens recebidas (messages) e ecos comerciais da marmitaria (smb_message_echoes),
 *         assinados com X-Hub-Signature-256 (WHATSAPP_APP_SECRET).
 *
 * CORREÇÕES AF-02, AF-05, AUD-07.1-03..05, AUD-07.3-01, AUD-07.3-05 & MISSÃO 07.5:
 * - Validação criptográfica HMAC-SHA256 (`validSignature` com `timingSafeEqual`) executada
 *   SEMPRE ANTES de qualquer consumo de cota de rate limit ou acesso ao banco, impedindo que
 *   requisições sem assinatura válida esgotem o rate limit de webhooks legítimos.
 * - Política FAIL-CLOSED de confiança em cabeçalhos de IP (`extractTrustedClientIpKey` — Missão 07.5):
 *     1. NÃO confia em `x-forwarded-for` por padrão (exige `TRUST_PROXY_XFF === "true"`);
 *     2. NÃO confia em `x-vercel-forwarded-for` fora do ambiente Vercel efetivamente identificado
 *        (`(VERCEL === "1" || Boolean(VERCEL_ENV) || Boolean(VERCEL_REGION)) && TRUST_VERCEL_FORWARDED_FOR !== "false"`
 *        ou `TRUST_VERCEL_FORWARDED_FOR === "true"`);
 *     3. NÃO confia em `cf-connecting-ip` sem `TRUST_CLOUDFLARE_IP === "true"` ou
 *        `TRUST_CLOUDFLARE_HEADERS === "true"`;
 *     4. NÃO confia em `x-real-ip` sem `TRUST_X_REAL_IP === "true"`;
 *     5. Quando não há IP confiável disponível, `handleMetaWebhookPost` particiona o fallback
 *        pelo escopo autenticado do payload assinado pela Meta (`ip:verified-meta:<phone_number_id|waba_id>`),
 *        impedindo que todas as requisições caiam em um único bucket global que poderia causar
 *        bloqueio cruzado entre empresas.
 * - Rate limit distribuído e persistente no PostgreSQL via RPC `check_whatsapp_webhook_rate_limit`
 *   (compartilhado entre todas as instâncias serverless), com fallback local caso o cliente de banco
 *   não seja injetado em testes unitários isolados.
 * - Rejeição de `timestamp` ausente por padrão em produção (`allowMissingTimestamp: false`),
 *   aceitando eventos frescos (`<= 24h`) e retries legítimos da Meta (`24h < idade <= 7 dias`) e
 *   bloqueando desvios futuros (`> +300s`) e replays expirados (`> 7 dias`).
 * - Integração com a API oficial de contexto do runtime Vercel (`Symbol.for("@vercel/request-context")`)
 *   para registro de `waitUntil` em `triggerDurableQueueProcessing`.
 */

export const WEBHOOK_MAX_FUTURE_SKEW_SECONDS = 300; // 5 minutos de tolerância de relógio
export const WEBHOOK_DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 dias (janela máxima de reentrega da Meta)
export const WEBHOOK_DEFAULT_RATE_LIMIT_PER_MIN = 120;
export const WEBHOOK_DEFAULT_INLINE_DRAIN_BUDGET_MS = 1_200;

const VERCEL_REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");

const webhookRateBuckets = new Map<string, { count: number; windowStartMs: number }>();
const MAX_RATE_BUCKET_KEYS = 5_000;

export function resetWebhookRateLimiterForTest(): void {
  webhookRateBuckets.clear();
}

export function checkWebhookRateLimit(
  key: string,
  options?: {
    nowMs?: number;
    maxRequestsPerWindow?: number;
    windowMs?: number;
  },
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const cleanKey = (key || "anonymous").trim().slice(0, 128);
  const nowMs = options?.nowMs ?? Date.now();
  const windowMs = Math.max(1_000, options?.windowMs ?? 60_000);
  const maxRequests = Math.max(
    1,
    options?.maxRequestsPerWindow ??
      (Number(process.env["WHATSAPP_WEBHOOK_RATE_LIMIT_PER_MIN"]) ||
        WEBHOOK_DEFAULT_RATE_LIMIT_PER_MIN),
  );

  if (webhookRateBuckets.size >= MAX_RATE_BUCKET_KEYS && !webhookRateBuckets.has(cleanKey)) {
    for (const [k, v] of webhookRateBuckets.entries()) {
      if (nowMs - v.windowStartMs >= windowMs) {
        webhookRateBuckets.delete(k);
      }
      if (webhookRateBuckets.size < MAX_RATE_BUCKET_KEYS / 2) break;
    }
  }

  const alignedWindowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const current = webhookRateBuckets.get(cleanKey);
  if (!current || current.windowStartMs !== alignedWindowStartMs) {
    webhookRateBuckets.set(cleanKey, { count: 1, windowStartMs: alignedWindowStartMs });
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterSeconds: 0,
    };
  }

  current.count += 1;
  if (current.count > maxRequests) {
    const elapsedMs = Math.max(0, nowMs - current.windowStartMs);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - current.count),
    retryAfterSeconds: 0,
  };
}

/**
 * CORREÇÃO AUD-07.1-04:
 * Rate limit distribuído e persistente no PostgreSQL via RPC `check_whatsapp_webhook_rate_limit`,
 * compartilhando contadores entre todas as instâncias serverless da Vercel.
 */
export async function checkWebhookRateLimitDistributed(
  key: string,
  options?: {
    supabaseAdmin?: SupabaseClient<Database> | null;
    nowMs?: number;
    maxRequestsPerWindow?: number;
    windowSeconds?: number;
  },
): Promise<{
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  source: "postgres" | "memory_fallback";
}> {
  const cleanKey = (key || "anonymous").trim().slice(0, 128);
  const nowMs = options?.nowMs ?? Date.now();
  const windowSeconds = Math.max(1, options?.windowSeconds ?? 60);
  const maxRequests = Math.max(
    1,
    options?.maxRequestsPerWindow ??
      (Number(process.env["WHATSAPP_WEBHOOK_RATE_LIMIT_PER_MIN"]) ||
        WEBHOOK_DEFAULT_RATE_LIMIT_PER_MIN),
  );

  const client = options?.supabaseAdmin;
  const maybeRpc = (
    client as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: {
          allowed?: boolean;
          remaining?: number;
          retry_after_seconds?: number;
        } | null;
        error: { code?: string; message?: string } | null;
      }>;
    }
  )?.rpc;

  if (client && typeof maybeRpc === "function") {
    try {
      const rpcRes = await maybeRpc.call(client, "check_whatsapp_webhook_rate_limit", {
        _bucket_key: cleanKey,
        _max_requests: maxRequests,
        _window_seconds: windowSeconds,
        _now: new Date(nowMs).toISOString(),
      });

      if (!rpcRes.error && rpcRes.data && typeof rpcRes.data.allowed === "boolean") {
        return {
          allowed: rpcRes.data.allowed,
          remaining:
            typeof rpcRes.data.remaining === "number" ? Math.max(0, rpcRes.data.remaining) : 0,
          retryAfterSeconds:
            typeof rpcRes.data.retry_after_seconds === "number"
              ? Math.max(0, rpcRes.data.retry_after_seconds)
              : 0,
          source: "postgres",
        };
      }
    } catch {
      // Fallback para o limitador em memória caso o banco esteja indisponível
    }
  }

  const mem = checkWebhookRateLimit(cleanKey, {
    nowMs,
    maxRequestsPerWindow: maxRequests,
    windowMs: windowSeconds * 1000,
  });
  return {
    ...mem,
    source: "memory_fallback",
  };
}

export type WebhookTimestampFreshness =
  | {
      accepted: true;
      classification: "fresh" | "delayed_legitimate_retry" | "missing_timestamp_allowed";
      ageSeconds: number | null;
    }
  | {
      accepted: false;
      classification:
        | "missing_timestamp_rejected"
        | "future_skew_rejected"
        | "expired_replay_rejected"
        | "invalid_timestamp";
      reason: string;
      ageSeconds: number | null;
    };

/**
 * CORREÇÃO AF-05 & AUD-07.1-05:
 * Avalia o campo `timestamp` (Unix epoch em segundos da criação da mensagem na Meta):
 * - Por padrão (`allowMissingTimestamp: false`), REJEITA `timestamp` ausente ou vazio
 *   (`missing_timestamp_rejected`), impedindo que a proteção de replay seja contornada pela omissão do campo;
 * - Aceita eventos frescos (`<= 24h`);
 * - Aceita retentativas legítimas atrasadas da Meta (`24h < idade <= 7 dias`);
 * - Rejeita replays expirados (`> 7 dias` ou `WHATSAPP_WEBHOOK_MAX_AGE_SECONDS`);
 * - Rejeita timestamps no futuro além da tolerância de 5 minutos (`> +300s`).
 */
export function evaluateWebhookEventTimestamp(
  rawTimestamp: string | null | undefined,
  options?: {
    nowMs?: number;
    maxAgeSeconds?: number;
    maxFutureSkewSeconds?: number;
    allowMissingTimestamp?: boolean;
  },
): WebhookTimestampFreshness {
  if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp.trim() === "") {
    if (options?.allowMissingTimestamp === true) {
      return {
        accepted: true,
        classification: "missing_timestamp_allowed",
        ageSeconds: null,
      };
    }
    return {
      accepted: false,
      classification: "missing_timestamp_rejected",
      reason: "MISSING_REQUIRED_EVENT_TIMESTAMP",
      ageSeconds: null,
    };
  }

  const trimmed = rawTimestamp.trim();
  if (!/^\d{9,13}$/.test(trimmed)) {
    return {
      accepted: false,
      classification: "invalid_timestamp",
      reason: "INVALID_TIMESTAMP_FORMAT",
      ageSeconds: null,
    };
  }

  const parsedNum = Number(trimmed);
  const eventSeconds = trimmed.length > 10 ? Math.floor(parsedNum / 1000) : parsedNum;
  if (!Number.isFinite(eventSeconds) || eventSeconds <= 0) {
    return {
      accepted: false,
      classification: "invalid_timestamp",
      reason: "NON_POSITIVE_TIMESTAMP",
      ageSeconds: null,
    };
  }

  const nowSeconds = Math.floor((options?.nowMs ?? Date.now()) / 1000);
  const maxFutureSkew = options?.maxFutureSkewSeconds ?? WEBHOOK_MAX_FUTURE_SKEW_SECONDS;
  const maxAgeSeconds =
    options?.maxAgeSeconds ??
    (Number(process.env["WHATSAPP_WEBHOOK_MAX_AGE_SECONDS"]) || WEBHOOK_DEFAULT_MAX_AGE_SECONDS);

  const ageSeconds = nowSeconds - eventSeconds;

  if (ageSeconds < -maxFutureSkew) {
    return {
      accepted: false,
      classification: "future_skew_rejected",
      reason: "TIMESTAMP_IN_FUTURE_BEYOND_SKEW",
      ageSeconds,
    };
  }

  if (ageSeconds > maxAgeSeconds) {
    return {
      accepted: false,
      classification: "expired_replay_rejected",
      reason: "TIMESTAMP_OLDER_THAN_MAX_RETRY_WINDOW",
      ageSeconds,
    };
  }

  if (ageSeconds > 24 * 60 * 60) {
    return {
      accepted: true,
      classification: "delayed_legitimate_retry",
      ageSeconds,
    };
  }

  return {
    accepted: true,
    classification: "fresh",
    ageSeconds,
  };
}

const textMessage = z.object({
  id: z.string().min(1).max(200),
  from: z.string().min(3).max(32),
  to: z.string().min(3).max(32).optional(),
  recipient_id: z.string().min(3).max(32).optional(),
  timestamp: z.string().max(20).optional(),
  type: z.string(),
  text: z.object({ body: z.string().max(4096) }).optional(),
  context: z
    .object({
      id: z.string().optional(),
      forwarded: z.boolean().optional(),
      frequently_forwarded: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

const payloadSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z.array(
          z.object({
            field: z.string(),
            value: z
              .object({
                metadata: z
                  .object({
                    phone_number_id: z.string(),
                    display_phone_number: z.string().optional(),
                  })
                  .partial()
                  .optional(),
                contacts: z
                  .array(
                    z.object({
                      wa_id: z.string().optional(),
                      profile: z.object({ name: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
                messages: z.array(z.unknown()).optional(),
                message_echoes: z.array(z.unknown()).optional(),
              })
              .passthrough(),
          }),
        ),
      }),
    )
    .max(50),
});

export function validSignature(raw: string, header: string | null, secret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const aHex = header.slice(7).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(aHex)) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ExtractedMessage = {
  messageId: string;
  from: string;
  profileName: string | null;
  text: string;
  timestamp: string | null;
  phoneNumberId: string;
  wabaId: string | null;
};

export type ExtractedBusinessEcho = {
  messageId: string;
  from: string;
  to: string;
  text: string;
  timestamp: string | null;
  phoneNumberId: string;
  wabaId: string | null;
  quoted: boolean;
  forwarded: boolean;
  standalone: boolean;
};

export function extractMessages(
  payload: z.infer<typeof payloadSchema>,
  options?: { nowMs?: number; maxAgeSeconds?: number; allowMissingTimestamp?: boolean },
): ExtractedMessage[] {
  const out: ExtractedMessage[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const m of change.value.messages ?? []) {
        const msg = textMessage.safeParse(m);
        if (!msg.success || msg.data.type !== "text" || !msg.data.text?.body.trim()) continue;
        const freshness = evaluateWebhookEventTimestamp(msg.data.timestamp, options);
        if (!freshness.accepted) continue;
        const contact = change.value.contacts?.find((c) => c.wa_id === msg.data.from);
        out.push({
          messageId: msg.data.id,
          from: msg.data.from.replace(/\D/g, ""),
          profileName: contact?.profile?.name ?? null,
          text: msg.data.text.body.trim().slice(0, 2000),
          timestamp: msg.data.timestamp ?? null,
          phoneNumberId,
          wabaId: entry.id ?? null,
        });
      }
    }
  }
  return out;
}

export function extractBusinessEchoes(
  payload: z.infer<typeof payloadSchema>,
  options?: { nowMs?: number; maxAgeSeconds?: number; allowMissingTimestamp?: boolean },
): ExtractedBusinessEcho[] {
  const out: ExtractedBusinessEcho[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "smb_message_echoes" && !change.value.message_echoes) continue;
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const list = change.value.message_echoes ?? change.value.messages ?? [];
      for (const rawEcho of list) {
        const echo = textMessage.safeParse(rawEcho);
        if (!echo.success || echo.data.type !== "text" || !echo.data.text?.body) continue;
        const freshness = evaluateWebhookEventTimestamp(echo.data.timestamp, options);
        if (!freshness.accepted) continue;
        const recipient = (echo.data.to ?? echo.data.recipient_id ?? "").replace(/\D/g, "");
        if (!recipient) continue;
        const ctx = echo.data.context;
        const quoted = Boolean(ctx?.id);
        const forwarded = Boolean(ctx?.forwarded || ctx?.frequently_forwarded);
        out.push({
          messageId: echo.data.id,
          from: echo.data.from.replace(/\D/g, ""),
          to: recipient,
          text: echo.data.text.body,
          timestamp: echo.data.timestamp ?? null,
          phoneNumberId,
          wabaId: entry.id ?? null,
          quoted,
          forwarded,
          standalone: !quoted && !forwarded,
        });
      }
    }
  }
  return out;
}

/**
 * CORREÇÃO AF-05, AUD-07.3-05 & MISSÃO 07.5 (Seção 4 — Política Fail-Closed de Cabeçalhos de IP):
 * 1. NÃO confia em `x-forwarded-for` por padrão (exige `TRUST_PROXY_XFF === "true"`);
 * 2. NÃO confia em `x-vercel-forwarded-for` fora do ambiente Vercel efetivamente identificado
 *    (`(VERCEL === "1" || Boolean(VERCEL_ENV) || Boolean(VERCEL_REGION)) && TRUST_VERCEL_FORWARDED_FOR !== "false"`
 *    ou `TRUST_VERCEL_FORWARDED_FOR === "true"`);
 * 3. NÃO confia em `cf-connecting-ip` sem `TRUST_CLOUDFLARE_IP === "true"` ou `TRUST_CLOUDFLARE_HEADERS === "true"`;
 * 4. NÃO confia em `x-real-ip` por padrão (exige `TRUST_X_REAL_IP === "true"`);
 * 5. Quando nenhum cabeçalho confiável estiver habilitado/presente, evita concentrar múltiplos tenants
 *    em um único bucket global ao aceitar `options.verifiedScope` (derivado do payload já autenticado
 *    via HMAC-SHA256 da Meta, como `phone_number_id` ou `waba_id`), mantendo `"ip:verified-meta"`
 *    quando chamado sem escopo.
 */
export function extractTrustedClientIpKey(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  options?: { verifiedScope?: string | null },
): string {
  const isVercelRuntimeVerified =
    env["VERCEL"] === "1" ||
    Boolean(env["VERCEL_ENV"]?.trim()) ||
    Boolean(env["VERCEL_REGION"]?.trim());
  const trustVercel =
    env["TRUST_VERCEL_FORWARDED_FOR"] === "true" ||
    (isVercelRuntimeVerified && env["TRUST_VERCEL_FORWARDED_FOR"] !== "false");

  if (trustVercel) {
    const vercelIp = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
    if (vercelIp) return `ip:${vercelIp.slice(0, 64)}`;
  }

  const trustCloudflare =
    env["TRUST_CLOUDFLARE_IP"] === "true" || env["TRUST_CLOUDFLARE_HEADERS"] === "true";
  if (trustCloudflare) {
    const cfIp = request.headers.get("cf-connecting-ip")?.trim();
    if (cfIp) return `ip:${cfIp.slice(0, 64)}`;
  }

  const trustRealIp = env["TRUST_X_REAL_IP"] === "true";
  if (trustRealIp) {
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return `ip:${realIp.slice(0, 64)}`;
  }

  const trustProxyXff = env["TRUST_PROXY_XFF"] === "true";
  if (trustProxyXff) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const rightmostHop = hops[hops.length - 1];
      if (rightmostHop) return `ip:${rightmostHop.slice(0, 64)}`;
    }
  }

  const cleanScope = options?.verifiedScope
    ?.trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "")
    .slice(0, 64);
  if (cleanScope) {
    return `ip:verified-meta:${cleanScope}`;
  }

  return "ip:verified-meta";
}

/**
 * CORREÇÃO AUD-07.1-03 & MISSÃO 07.5 (Seção 5 — waitUntil):
 * Obtém a função `waitUntil` da API oficial de contexto do runtime Vercel
 * (`Symbol.for("@vercel/request-context")`), que é o mecanismo padrão utilizado por
 * `@vercel/functions` no Node.js / Fluid Compute / Nitro na Vercel, mantendo suporte a
 * contextos WinterCG (`request.waitUntil` / `request.ctx.waitUntil`).
 */
export function extractRuntimeWaitUntil(
  request?: Request,
): ((promise: Promise<unknown>) => void) | null {
  const symbolRegistry = globalThis as unknown as Record<
    symbol,
    { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined
  >;
  const vercelCtxReader = symbolRegistry[VERCEL_REQUEST_CONTEXT_SYMBOL];
  if (vercelCtxReader && typeof vercelCtxReader.get === "function") {
    try {
      const ctx = vercelCtxReader.get();
      if (ctx && typeof ctx.waitUntil === "function") {
        return ctx.waitUntil.bind(ctx);
      }
    } catch {
      // Contexto global indisponível ou inválido; prossegue para os fallbacks do objeto Request
    }
  }

  if (request) {
    const reqWithCtx = request as unknown as {
      waitUntil?: (p: Promise<unknown>) => void;
      ctx?: { waitUntil?: (p: Promise<unknown>) => void };
    };
    if (typeof reqWithCtx.waitUntil === "function") {
      return reqWithCtx.waitUntil.bind(reqWithCtx);
    }
    if (reqWithCtx.ctx && typeof reqWithCtx.ctx.waitUntil === "function") {
      return reqWithCtx.ctx.waitUntil.bind(reqWithCtx.ctx);
    }
  }

  return null;
}

/**
 * CORREÇÃO AF-02, AUD-07.1-03 & MISSÃO 07.5:
 * Dispara o processamento da fila durável combinando:
 * 1. Registro em `waitUntil` via `Symbol.for("@vercel/request-context")` (API oficial da Vercel);
 * 2. Janela controlada de micro-batch (`inlineBudgetMs`) antes de retornar HTTP 200;
 * 3. Persistência prévia garantida no PostgreSQL (`public.whatsapp_messages`), permitindo que
 *    qualquer item cujo processamento em segundo plano seja interrompido seja recuperado após
 *    expiração do lease pelo scheduler de 1 minuto (`pg_cron` + `pg_net` / `/api/internal/whatsapp/drain-queue`).
 */
export async function triggerDurableQueueProcessing(
  scheduleDrainFn: (opts?: {
    limit?: number;
    concurrency?: number;
  }) => Promise<{ claimed: number; processed: number; failed: number }>,
  options?: {
    request?: Request;
    waitUntil?: ((promise: Promise<unknown>) => void) | null;
    inlineBudgetMs?: number;
    limit?: number;
    concurrency?: number;
  },
): Promise<{
  completedInline: boolean;
  registeredWaitUntil: boolean;
  backgroundPromise: Promise<{ claimed: number; processed: number; failed: number }>;
}> {
  const limit = options?.limit ?? 15;
  const concurrency = options?.concurrency ?? 3;
  const inlineBudgetMs =
    options?.inlineBudgetMs ??
    (process.env["WHATSAPP_WEBHOOK_INLINE_BUDGET_MS"] !== undefined
      ? Math.max(0, Number(process.env["WHATSAPP_WEBHOOK_INLINE_BUDGET_MS"]) || 0)
      : WEBHOOK_DEFAULT_INLINE_DRAIN_BUDGET_MS);

  const drainTask = scheduleDrainFn({ limit, concurrency }).catch((err) => {
    console.error(
      "[whatsapp-webhook] falha no worker de fila; permanecerá na fila durável para recuperação",
      err,
    );
    return { claimed: 0, processed: 0, failed: 1 };
  });

  const resolvedWaitUntil =
    options?.waitUntil !== undefined
      ? options.waitUntil
      : extractRuntimeWaitUntil(options?.request);

  let registeredWaitUntil = false;
  if (typeof resolvedWaitUntil === "function") {
    try {
      resolvedWaitUntil(drainTask);
      registeredWaitUntil = true;
    } catch {
      registeredWaitUntil = false;
    }
  }

  if (inlineBudgetMs <= 0) {
    return {
      completedInline: false,
      registeredWaitUntil,
      backgroundPromise: drainTask,
    };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      drainTask.then(() => "completed" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), inlineBudgetMs);
      }),
    ]);
    return {
      completedInline: outcome === "completed",
      registeredWaitUntil,
      backgroundPromise: drainTask,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function handleMetaWebhookPost(
  request: Request,
  deps?: {
    appSecret?: string;
    nowMs?: number;
    maxRequestsPerMinute?: number;
    inlineBudgetMs?: number;
    allowMissingTimestamp?: boolean;
    env?: Record<string, string | undefined>;
    supabaseAdmin?: SupabaseClient<Database> | null;
    waitUntil?: ((promise: Promise<unknown>) => void) | null;
    enqueueMetaMessagesImpl?: typeof import("@/lib/whatsapp-webhook.server").enqueueMetaMessages;
    enqueueMetaBusinessEchoesImpl?: typeof import("@/lib/whatsapp-webhook.server").enqueueMetaBusinessEchoes;
    scheduleDrainWhatsAppQueueImpl?: typeof import("@/lib/whatsapp-webhook.server").scheduleDrainWhatsAppQueue;
  },
): Promise<Response> {
  const effectiveEnv = deps?.env ?? process.env;
  const appSecret = deps?.appSecret ?? effectiveEnv["WHATSAPP_APP_SECRET"];
  if (!appSecret) return new Response("Webhook não configurado", { status: 503 });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
    return new Response("Payload grande demais", { status: 413 });
  }

  const raw = await request.text();
  if (raw.length > 1_000_000) return new Response("Payload grande demais", { status: 413 });

  // CORREÇÃO AUD-07.1-04 & MISSÃO 07.5: Valida obrigatoriamente a assinatura HMAC-SHA256 ANTES
  // de consumir qualquer cota de rate limit ou acessar o banco de dados!
  if (!validSignature(raw, request.headers.get("x-hub-signature-256"), appSecret)) {
    return new Response("Assinatura inválida", { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.object !== "whatsapp_business_account") {
    return new Response("ok", { status: 200 });
  }

  const supabaseAdmin =
    deps?.supabaseAdmin !== undefined
      ? deps.supabaseAdmin
      : (await import("@/integrations/supabase/client.server").catch(() => null))?.supabaseAdmin ??
        null;

  const firstWabaId = parsed.data.entry[0]?.id?.trim() || null;
  const firstPhoneNumberId =
    parsed.data.entry[0]?.changes[0]?.value?.metadata?.phone_number_id?.trim() || null;
  const verifiedScope = firstPhoneNumberId
    ? `phone:${firstPhoneNumberId}`
    : firstWabaId && /^\d{5,32}$/.test(firstWabaId)
      ? `waba:${firstWabaId}`
      : null;

  // Rate limit distribuído pós-autenticação HMAC por IP confiável (ou escopo autenticado caso sem proxy confiável)
  const trustedIpKey = extractTrustedClientIpKey(request, effectiveEnv, {
    verifiedScope,
  });
  const ipRate = await checkWebhookRateLimitDistributed(trustedIpKey, {
    supabaseAdmin,
    nowMs: deps?.nowMs,
    maxRequestsPerWindow: deps?.maxRequestsPerMinute,
  });
  if (!ipRate.allowed) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(ipRate.retryAfterSeconds) },
    });
  }

  if (firstWabaId && /^\d{5,32}$/.test(firstWabaId)) {
    const wabaRate = await checkWebhookRateLimitDistributed(`waba:${firstWabaId}`, {
      supabaseAdmin,
      nowMs: deps?.nowMs,
      maxRequestsPerWindow: (deps?.maxRequestsPerMinute ?? WEBHOOK_DEFAULT_RATE_LIMIT_PER_MIN) * 2,
    });
    if (!wabaRate.allowed) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(wabaRate.retryAfterSeconds) },
      });
    }
  }

  const webhookModule =
    deps?.enqueueMetaMessagesImpl &&
    deps?.enqueueMetaBusinessEchoesImpl &&
    deps?.scheduleDrainWhatsAppQueueImpl
      ? null
      : await import("@/lib/whatsapp-webhook.server");

  const enqueueMetaMessages =
    deps?.enqueueMetaMessagesImpl ?? webhookModule!.enqueueMetaMessages;
  const enqueueMetaBusinessEchoes =
    deps?.enqueueMetaBusinessEchoesImpl ?? webhookModule!.enqueueMetaBusinessEchoes;
  const scheduleDrainWhatsAppQueue =
    deps?.scheduleDrainWhatsAppQueueImpl ?? webhookModule!.scheduleDrainWhatsAppQueue;

  try {
    let hasNewQueuedItems = false;
    let hasPartialFailures = false;

    const inbound = extractMessages(parsed.data, {
      nowMs: deps?.nowMs,
      allowMissingTimestamp: deps?.allowMissingTimestamp,
    });
    if (inbound.length > 0) {
      const enqueued = await enqueueMetaMessages(inbound, supabaseAdmin ?? undefined, {
        nowMs: deps?.nowMs,
        throwOnAllFailed: false,
      });
      if (enqueued.enqueuedIds.length > 0) {
        hasNewQueuedItems = true;
      }
      if (enqueued.failedIds && enqueued.failedIds.length > 0) {
        hasPartialFailures = true;
      }
    }

    const echoes = extractBusinessEchoes(parsed.data, {
      nowMs: deps?.nowMs,
      allowMissingTimestamp: deps?.allowMissingTimestamp,
    });
    if (echoes.length > 0) {
      const enqueuedEchoes = await enqueueMetaBusinessEchoes(echoes, supabaseAdmin ?? undefined, {
        nowMs: deps?.nowMs,
        throwOnAllFailed: false,
      });
      if (enqueuedEchoes.enqueuedIds.length > 0) {
        hasNewQueuedItems = true;
      }
      if (enqueuedEchoes.failedIds && enqueuedEchoes.failedIds.length > 0) {
        hasPartialFailures = true;
      }
    }

    if (hasNewQueuedItems) {
      await triggerDurableQueueProcessing(scheduleDrainWhatsAppQueue, {
        request,
        waitUntil: deps?.waitUntil,
        inlineBudgetMs: deps?.inlineBudgetMs,
        limit: 15,
        concurrency: 3,
      });
    }

    if (hasPartialFailures) {
      return new Response("Falha parcial ao persistir lote na fila durável", { status: 500 });
    }
  } catch (err) {
    console.error("[whatsapp-webhook] falha ao persistir evento na fila durável", err);
    return new Response("Erro ao persistir", { status: 500 });
  }
  return new Response("ok", { status: 200 });
}

export const Route = createFileRoute("/api/public/whatsapp/meta-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"];
        if (!verifyToken) return new Response("Webhook não configurado", { status: 503 });
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        const a = Buffer.from(token);
        const b = Buffer.from(verifyToken);
        if (mode === "subscribe" && a.length === b.length && timingSafeEqual(a, b)) {
          return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("Forbidden", { status: 403 });
      },

      POST: async ({ request }) => handleMetaWebhookPost(request),
    },
  },
});
