import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateCronRequest,
  inspectOperationalQueueHealth,
} from "@/lib/operational-alerts.server";

const PUBLIC_HEALTH_CACHE_TTL_MS = 5_000;

let cachedPublicHealth: {
  expiresAtMs: number;
  statusHttp: number;
  body: { status: "ok" | "degraded" | "down"; checkedAt: string };
} | null = null;

export function resetPublicHealthCacheForTest() {
  cachedPublicHealth = null;
}

/**
 * CORREÇÃO FOR-11:
 * - Para chamadas públicas (sem `CRON_SECRET`), retorna exclusivamente o estado mínimo
 *   de disponibilidade `{ status: "ok" | "degraded" | "down", checkedAt }`, com cache curto
 *   de 5 segundos para impedir flood de queries `service_role` e sem jamais expor contagens
 *   internas da fila (`queue`), `configuredIntegrations` ou mensagens de erro internas.
 * - Detalhes operacionais completos (`queue`, `configuredIntegrations`, `dbConnected`) são
 *   retornados apenas quando a requisição apresenta autenticação válida (`authenticateCronRequest`).
 */
export async function handleHealthRequest(request?: Request): Promise<Response> {
  const isAuthorizedMonitor = request ? authenticateCronRequest(request) : false;
  const nowMs = Date.now();

  if (!isAuthorizedMonitor && cachedPublicHealth && cachedPublicHealth.expiresAtMs > nowMs) {
    return new Response(JSON.stringify(cachedPublicHealth.body), {
      status: cachedPublicHealth.statusHttp,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=5",
      },
    });
  }

  const requiredEnv = {
    supabaseUrl: Boolean(process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"]),
    supabaseServiceRole: Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]),
    geminiApiKey: Boolean(process.env["GEMINI_API_KEY"]),
    whatsappVerifyToken: Boolean(process.env["WHATSAPP_VERIFY_TOKEN"]),
    whatsappAppSecret: Boolean(process.env["WHATSAPP_APP_SECRET"]),
  };

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (!isAuthorizedMonitor) {
      const checkedAt = new Date(nowMs).toISOString();
      const ping = await supabaseAdmin.from("companies").select("id").limit(1);
      const dbOk = !ping.error;
      const publicStatus: "ok" | "down" = dbOk ? "ok" : "down";
      const statusHttp = dbOk ? 200 : 503;
      const publicBody = {
        status: publicStatus,
        checkedAt,
      };

      cachedPublicHealth = {
        expiresAtMs: nowMs + PUBLIC_HEALTH_CACHE_TTL_MS,
        statusHttp,
        body: publicBody,
      };

      return new Response(JSON.stringify(publicBody), {
        status: statusHttp,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=5",
        },
      });
    }

    const queueHealth = await inspectOperationalQueueHealth(supabaseAdmin);
    const status = queueHealth.dbConnected ? 200 : 503;

    return new Response(
      JSON.stringify({
        status: queueHealth.healthy ? "ok" : queueHealth.dbConnected ? "degraded" : "down",
        dbConnected: queueHealth.dbConnected,
        queue: queueHealth.counts,
        configuredIntegrations: requiredEnv,
        checkedAt: queueHealth.checkedAt,
      }),
      {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    const checkedAt = new Date(nowMs).toISOString();
    const publicDown = {
      status: "down" as const,
      checkedAt,
    };

    cachedPublicHealth = {
      expiresAtMs: nowMs + PUBLIC_HEALTH_CACHE_TTL_MS,
      statusHttp: 503,
      body: publicDown,
    };

    if (!isAuthorizedMonitor) {
      return new Response(JSON.stringify(publicDown), {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return new Response(
      JSON.stringify({
        status: "down",
        dbConnected: false,
        configuredIntegrations: requiredEnv,
        checkedAt,
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
}

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async ({ request }) => handleHealthRequest(request),
    },
  },
});
