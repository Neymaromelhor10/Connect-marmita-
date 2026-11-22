import { createHash, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type OperationalAlertSeverity = "info" | "warning" | "critical";

export type OperationalAlertPayload = {
  code: string;
  severity: OperationalAlertSeverity;
  title: string;
  details: Record<string, unknown>;
  timestamp?: string;
};

const alertCooldownMap = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos por código de alerta

export function resetAlertCooldownsForTest() {
  alertCooldownMap.clear();
}

/**
 * CORREÇÃO AUD8-03:
 * Valida estritamente que a limpeza de registros sintéticos (incluindo whatsapp_manual_retry_audit
 * via SET LOCAL app.allow_audit_cleanup = 'on') ocorre exclusivamente em ambiente de teste/staging
 * isolado e jamais pode ser ativada em produção.
 */
export function assertIsolatedNonProductionCleanupAllowed(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const nodeEnv = (env["NODE_ENV"] || "").trim().toLowerCase();
  const appEnv = (env["APP_ENV"] || "").trim().toLowerCase();
  if (nodeEnv === "production" || appEnv === "production" || appEnv === "producao") {
    throw new Error(
      "[BLOQUEIO DE SEGURANÇA AUD8-03] Limpeza de auditoria de testes (app.allow_audit_cleanup) é estritamente proibida em ambiente de produção!",
    );
  }

  const runLiveFlag = (env["RUN_LIVE_HOMOLOGATION"] || "").trim();
  const stagingMarker = (env["STAGING_CONFIRM_MARKER"] || env["STAGING_CONFIRM_NON_PROD"] || "").trim();
  if (
    runLiveFlag !== "1" &&
    stagingMarker !== "HOMOLOGACAO_AUTORIZADA" &&
    stagingMarker !== "HOMOLOGACAO_STAGING_AUTORIZADA"
  ) {
    throw new Error(
      "[BLOQUEIO DE SEGURANÇA AUD8-03] Marcador explícito de homologação/teste ausente para limpeza de dados sintéticos.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("[BLOQUEIO DE SEGURANÇA AUD8-03] STAGING_DATABASE_URL inválida para cleanup.");
  }

  const host = parsed.hostname.toLowerCase();
  const user = decodeURIComponent(parsed.username || "").toLowerCase();
  const dbName = (parsed.pathname.replace(/^\//, "") || "postgres").toLowerCase();
  const optionsParam = (parsed.searchParams.get("options") || "").toLowerCase();

  const blockedRefs = new Set(["ehsmkjuelryvoqyweiga"]);
  const prodRef = (env["PRODUCTION_PROJECT_REF"] || "").trim().toLowerCase();
  if (prodRef) blockedRefs.add(prodRef);

  for (const ref of blockedRefs) {
    if (
      host === `db.${ref}.supabase.co` ||
      user.endsWith(`.${ref}`) ||
      optionsParam.includes(`project=${ref}`)
    ) {
      throw new Error(
        `[BLOQUEIO DE SEGURANÇA AUD8-03] STAGING_DATABASE_URL aponta para o projeto de PRODUÇÃO (${ref})! Cleanup abortado.`,
      );
    }
  }

  if (dbName.includes("prod") || host.includes("prod")) {
    throw new Error(
      `[BLOQUEIO DE SEGURANÇA AUD8-03] Host ou nome do banco (${host}/${dbName}) contém indicador de produção! Cleanup abortado.`,
    );
  }
}

/**
 * Mascaramento LGPD para telefones em logs e alertas operacionais:
 * preserva apenas os 4 últimos dígitos, sem afetar o valor armazenado ou processado no banco.
 */
export function maskPhoneForOperationalLog(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "[sem-telefone]";
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

/**
 * CORREÇÃO AUD6-09:
 * Mascara números de telefone e redige tokens/segredos/credenciais embutidos
 * dentro de strings livres (como `err.message`, stacks ou mensagens de erro de rede/banco).
 */
export function sanitizeFreeTextForOperationalLog(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Redige credenciais em URIs de banco/serviços (ex.: postgres://user:pass@host), tokens Bearer e chaves de API
  out = out.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\/\s@]+:)([^@\s\/]+)(@)/g,
    "$1[REDACTED]$3",
  );
  out = out.replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
    "$1[REDACTED]",
  );
  out = out.replace(
    /((?:secret|token|apikey|api_key|password|authorization|key)\s*[:=]\s*["']?)([^"'\s,;]+)/gi,
    "$1[REDACTED]",
  );

  // 2. Mascara sequências telefônicas (+55 (11) 98888-7766, 5511988887766, (11) 98888-7766, 11988887766)
  //    preservando UUIDs (que possuem hifens hexadecimais 8-4-4-4-12) e datas ISO (YYYY-MM-DD).
  out = out.replace(
    /(?<![0-9a-fA-F-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,3}\)[\s.-]?|\d{2,3}[\s.-]?)\d{4,5}[\s.-]?\d{4}(?![0-9a-fA-F-])/g,
    (match) => {
      const digits = match.replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) {
        return maskPhoneForOperationalLog(digits);
      }
      return match;
    },
  );

  return out;
}

function sanitizeUnknownValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    return sanitizeFreeTextForOperationalLog(val);
  }
  if (val instanceof Error) {
    return {
      name: val.name,
      message: sanitizeFreeTextForOperationalLog(val.message),
    };
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeUnknownValue(item));
  }
  if (typeof val === "object") {
    return sanitizeOperationalAlertDetails(val as Record<string, unknown>);
  }
  return val;
}

/**
 * CORREÇÃO AUD6-09:
 * Higieniza recursivamente os metadados de alertas operacionais antes de gravar em log
 * ou enviar para webhook externo.
 */
export function sanitizeOperationalAlertDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    const lower = k.toLowerCase();
    if (/secret|token|apikey|api_key|password|authorization|credential|private_key/i.test(lower)) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (lower === "phone" || lower === "to" || lower === "from" || lower.endsWith("phone")) {
      out[k] = typeof v === "string" || typeof v === "number" ? maskPhoneForOperationalLog(v) : sanitizeUnknownValue(v);
      continue;
    }
    out[k] = sanitizeUnknownValue(v);
  }
  return out;
}

export async function emitOperationalAlert(
  alert: OperationalAlertPayload,
  options?: { cooldownMs?: number },
): Promise<{ emitted: boolean; webhookDelivered: boolean }> {
  const now = Date.now();
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastAt = alertCooldownMap.get(alert.code) ?? 0;

  if (cooldownMs > 0 && now - lastAt < cooldownMs) {
    return { emitted: false, webhookDelivered: false };
  }
  alertCooldownMap.set(alert.code, now);

  const safeDetails = sanitizeOperationalAlertDetails(alert.details ?? {});

  const structuredEntry = {
    level: alert.severity === "critical" ? "error" : alert.severity === "warning" ? "warn" : "info",
    type: "operational_alert",
    code: alert.code,
    title: sanitizeFreeTextForOperationalLog(alert.title),
    details: safeDetails,
    timestamp: alert.timestamp ?? new Date(now).toISOString(),
  };

  if (alert.severity === "critical") {
    console.error(JSON.stringify(structuredEntry));
  } else if (alert.severity === "warning") {
    console.warn(JSON.stringify(structuredEntry));
  } else {
    console.info(JSON.stringify(structuredEntry));
  }

  const webhookUrl = process.env["OPERATIONAL_ALERT_WEBHOOK_URL"]?.trim();
  if (!webhookUrl) {
    return { emitted: true, webhookDelivered: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(webhookUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(structuredEntry),
    });
    clearTimeout(timer);
    return { emitted: true, webhookDelivered: res.ok };
  } catch (err) {
    const rawErrMsg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "error",
        type: "operational_alert_webhook_error",
        code: alert.code,
        error: sanitizeFreeTextForOperationalLog(rawErrMsg),
      }),
    );
    return { emitted: true, webhookDelivered: false };
  }
}

/**
 * CORREÇÃO FOR-05:
 * Implementação única e canônica de autenticação de CRON:
 * - Compara digests SHA-256 de tamanho fixo (32 bytes) com `timingSafeEqual`,
 *   jamais vazando o comprimento de `CRON_SECRET` por canal lateral de tempo;
 * - Suporta rotação sem downtime via `CRON_SECRET_PREVIOUS`;
 * - Rejeita segredos vazios/ausentes e formatos inválidos (ex.: múltiplos tokens ou espaços);
 * - Preserva compatibilidade com `Authorization: Bearer <secret>` e `x-cron-secret`.
 */
export function authenticateCronRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const currentSecret = (env["CRON_SECRET"] ?? "").trim();
  const previousSecret = (env["CRON_SECRET_PREVIOUS"] ?? "").trim();
  if (!currentSecret) return false;

  const authHeader = request.headers.get("authorization");
  const customHeader = request.headers.get("x-cron-secret");

  let provided = "";
  if (authHeader !== null && authHeader.trim() !== "") {
    const match = /^Bearer\s+([^\s,]+)$/i.exec(authHeader.trim());
    if (!match?.[1]) {
      return false;
    }
    provided = match[1].trim();
  } else if (customHeader !== null && customHeader.trim() !== "") {
    if (/[\s,]/.test(customHeader.trim())) {
      return false;
    }
    provided = customHeader.trim();
  }

  if (!provided) return false;

  const sha256Digest = (val: string) => createHash("sha256").update(val, "utf8").digest();
  const providedDigest = sha256Digest(provided);
  const currentDigest = sha256Digest(currentSecret);
  const previousDigest = sha256Digest(previousSecret || currentSecret);

  const currentMatches = timingSafeEqual(providedDigest, currentDigest);
  const previousMatches =
    Boolean(previousSecret) && timingSafeEqual(providedDigest, previousDigest);

  return currentMatches || previousMatches;
}

export type QueueHealthSnapshot = {
  healthy: boolean;
  dbConnected: boolean;
  counts: {
    aguardando: number;
    processando: number;
    erro: number;
    stuckProcessing: number;
  };
  checkedAt: string;
};

export async function inspectOperationalQueueHealth(
  supabaseAdmin: SupabaseClient<Database>,
): Promise<QueueHealthSnapshot> {
  const checkedAt = new Date().toISOString();

  const ping = await supabaseAdmin.from("companies").select("id").limit(1);
  if (ping.error) {
    await emitOperationalAlert({
      code: "DB_CONNECTION_FAILURE",
      severity: "critical",
      title: "Falha de conectividade com o PostgreSQL/Supabase",
      details: { error: ping.error.message },
      timestamp: checkedAt,
    });
    return {
      healthy: false,
      dbConnected: false,
      counts: { aguardando: 0, processando: 0, erro: 0, stuckProcessing: 0 },
      checkedAt,
    };
  }

  const pendingRes = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id, status, locked_until, created_at")
    .is("order_id", null)
    .in("status", ["aguardando", "processando", "erro"])
    .limit(500);

  const rows = (pendingRes.data ?? []) as {
    id: string;
    status: string;
    locked_until?: string | null;
    created_at: string;
  }[];

  const nowMs = Date.now();
  let aguardando = 0;
  let processando = 0;
  let erro = 0;
  let stuckProcessing = 0;

  for (const r of rows) {
    if (r.status === "aguardando") aguardando++;
    else if (r.status === "processando") {
      processando++;
      const lockMs = r.locked_until ? Date.parse(r.locked_until) : Date.parse(r.created_at) + 120_000;
      if (Number.isFinite(lockMs) && lockMs < nowMs) {
        stuckProcessing++;
      }
    } else if (r.status === "erro") {
      erro++;
    }
  }

  if (stuckProcessing > 0 || erro >= 5) {
    await emitOperationalAlert({
      code: "WHATSAPP_QUEUE_DEGRADED",
      severity: erro >= 10 ? "critical" : "warning",
      title: "Mensagens acumuladas em erro ou lock expirado na fila do WhatsApp",
      details: { aguardando, processando, erro, stuckProcessing },
      timestamp: checkedAt,
    });
  }

  return {
    healthy: stuckProcessing === 0 && erro < 10,
    dbConnected: true,
    counts: { aguardando, processando, erro, stuckProcessing },
    checkedAt,
  };
}
