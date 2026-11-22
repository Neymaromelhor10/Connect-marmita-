import { authenticateCronRequest as verifyCronSecret } from "@/lib/operational-alerts.server";

/**
 * CORREÇÃO FOR-05:
 * Delega integralmente para a implementação canônica de `authenticateCronRequest`
 * em `@/lib/operational-alerts.server` (comparação constante de digests SHA-256
 * de 32 bytes com suporte a `CRON_SECRET` e `CRON_SECRET_PREVIOUS`), eliminando
 * duplicação de código.
 */
export async function authenticateCronRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<Response | null> {
  const currentSecret = (env["CRON_SECRET"] ?? "").trim();
  if (!currentSecret) {
    return new Response("Server configuration error", { status: 500 });
  }

  if (!verifyCronSecret(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}
