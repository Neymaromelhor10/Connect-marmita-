import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  authenticateCronRequest,
  inspectOperationalQueueHealth,
} from "@/lib/operational-alerts.server";
import { drainWhatsAppQueue } from "@/lib/whatsapp-webhook.server";

export const DEFAULT_LGPD_RETENTION_DAYS = 180;

/**
 * CORREÇÃO AF-10 & AUD-07.1-08:
 * Executa o expurgo periódico de dados operacionais expirados (`lgpd_purge_expired_operational_data`)
 * delegando o controle de periodicidade (24h) de forma persistente ao banco PostgreSQL
 * (`public.operational_scheduler_state`), sem depender de variáveis em memória que se perdem
 * em cold starts e gravando auditoria em `public.lgpd_lifecycle_audit` apenas quando houver
 * dados efetivamente expurgados.
 */
export async function runScheduledLgpdRetentionPurgeIfNeeded(
  supabaseAdmin: SupabaseClient<Database>,
  options?: {
    force?: boolean;
    retentionDays?: number;
  },
): Promise<{
  executed: boolean;
  skippedBySchedule: boolean;
  retentionDays: number;
  purgedMessagesCount: number;
  purgedPaymentAttemptNotesCount: number;
  auditId: string | null;
}> {
  const retentionDays = Math.max(
    30,
    Math.trunc(
      Number(options?.retentionDays ?? process.env["LGPD_RETENTION_DAYS"]) ||
        DEFAULT_LGPD_RETENTION_DAYS,
    ),
  );

  const maybeRpc = (
    supabaseAdmin as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: unknown;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc !== "function") {
    return {
      executed: false,
      skippedBySchedule: false,
      retentionDays,
      purgedMessagesCount: 0,
      purgedPaymentAttemptNotesCount: 0,
      auditId: null,
    };
  }

  try {
    const rpcRes = await maybeRpc.call(
      supabaseAdmin,
      "lgpd_purge_expired_operational_data",
      {
        _retention_days: retentionDays,
        _force: Boolean(options?.force),
      },
    );

    if (!rpcRes.error && rpcRes.data && typeof rpcRes.data === "object") {
      const payload = rpcRes.data as {
        skipped_by_schedule?: unknown;
        purged_messages_count?: unknown;
        purged_payment_attempt_notes_count?: unknown;
        audit_id?: unknown;
      };
      const skipped = payload.skipped_by_schedule === true;
      return {
        executed: !skipped,
        skippedBySchedule: skipped,
        retentionDays,
        purgedMessagesCount:
          typeof payload.purged_messages_count === "number" ? payload.purged_messages_count : 0,
        purgedPaymentAttemptNotesCount:
          typeof payload.purged_payment_attempt_notes_count === "number"
            ? payload.purged_payment_attempt_notes_count
            : 0,
        auditId: typeof payload.audit_id === "string" ? payload.audit_id : null,
      };
    }
  } catch {
    // Não interrompe a drenagem principal da fila caso o expurgo periódico encontre erro transitório
  }

  return {
    executed: false,
    skippedBySchedule: false,
    retentionDays,
    purgedMessagesCount: 0,
    purgedPaymentAttemptNotesCount: 0,
    auditId: null,
  };
}

/**
 * CORREÇÃO AF-02 & AF-10:
 * Endpoint interno protegido por segredo (`CRON_SECRET` / `CRON_SECRET_PREVIOUS`) acionado
 * periodicamente pelo Vercel Cron (ou scheduler externo / pg_cron) para drenar mensagens pendentes
 * ou com retry vencido (`next_retry_at <= now()`) e executar a política persistente de retenção LGPD.
 */
export async function handleDrainQueueRequest(
  request: Request,
  deps?: {
    env?: Record<string, string | undefined>;
    supabaseAdmin?: SupabaseClient<Database>;
    drainWhatsAppQueueImpl?: typeof drainWhatsAppQueue;
    inspectQueueHealthImpl?: typeof inspectOperationalQueueHealth;
    maxPasses?: number;
  },
): Promise<Response> {
  if (!authenticateCronRequest(request, deps?.env ?? process.env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  try {
    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get("limit") ?? "15");
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, Math.trunc(limitParam)), 50)
      : 15;
    const maxPasses = Math.min(Math.max(1, deps?.maxPasses ?? 3), 5);
    const forceLgpdPurge = url.searchParams.get("lgpd_purge") === "1";

    const supabaseAdmin =
      deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
    const drainFn = deps?.drainWhatsAppQueueImpl ?? drainWhatsAppQueue;
    const healthFn = deps?.inspectQueueHealthImpl ?? inspectOperationalQueueHealth;

    let totalClaimed = 0;
    let totalProcessed = 0;
    let totalFailed = 0;
    let passes = 0;
    let lastWorkerId = "";
    const startedMs = Date.now();

    while (passes < maxPasses && Date.now() - startedMs < 20_000) {
      passes += 1;
      const passResult = await drainFn({
        limit,
        concurrency: 3,
        supabase: supabaseAdmin,
      });
      totalClaimed += passResult.claimed;
      totalProcessed += passResult.processed;
      totalFailed += passResult.failed;
      lastWorkerId = passResult.workerId;

      if (passResult.claimed < limit) {
        break;
      }
    }

    const lgpdRetention = await runScheduledLgpdRetentionPurgeIfNeeded(supabaseAdmin, {
      force: forceLgpdPurge,
    });
    const health = await healthFn(supabaseAdmin);

    return new Response(
      JSON.stringify({
        ok: true,
        drain: {
          claimed: totalClaimed,
          processed: totalProcessed,
          failed: totalFailed,
          passes,
          workerId: lastWorkerId,
        },
        lgpdRetention,
        queueHealth: health,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
}

export const Route = createFileRoute("/api/internal/whatsapp/drain-queue")({
  server: {
    handlers: {
      GET: async ({ request }) => handleDrainQueueRequest(request),
      POST: async ({ request }) => handleDrainQueueRequest(request),
    },
  },
});
