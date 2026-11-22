import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const setupSchema = z.object({
  companyName: z.string().max(120).optional().default(""),
  fullName: z.string().max(120).optional().default(""),
});

const parseSchema = z.object({
  phone: z.string().max(30).optional().default(""),
  body: z.string().min(1).max(2000),
  externalId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
});

const retrySchema = z.object({
  messageId: z.string().uuid().optional(),
});

const updatePricesSchema = z
  .object({
    priceP: z.number().finite().min(0).max(10_000),
    priceM: z.number().finite().min(0).max(10_000),
    priceG: z.number().finite().min(0).max(10_000),
  })
  .strict();

const ignoreMessageSchema = z
  .object({
    messageId: z.string().uuid(),
  })
  .strict();

const upsertCustomerSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(160),
    phone: z.string().trim().min(8).max(30),
    address: z.string().max(300).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    payment_cycle: z.enum(["diario", "semanal", "quinzenal", "mensal"]).default("semanal"),
  })
  .strict();

const inspectLgpdSchema = z
  .object({
    customerId: z.string().uuid(),
  })
  .strict();

const anonymizeLgpdSchema = z
  .object({
    customerId: z.string().uuid(),
    scope: z.enum(["dados_complementares", "anonimizacao_completa"]),
    confirmToken: z.string().trim().min(10).max(100),
    protocol: z.string().trim().min(3).max(240),
  })
  .strict();

export type {
  CompanyOperatorAuthContext,
  LgpdCustomerInspectionResult,
  LgpdCustomerAnonymizationResult,
} from "./company.server";

/**
 * CORREÇÃO AF-06 (RETRY MANUAL 100% FAIL-CLOSED):
 * Função pura que interpreta o resultado estruturado (JSONB) retornado por
 * `public.prepare_manual_whatsapp_retry`.
 */
export function evaluateManualRetryPreparationOutcome(
  prepData: unknown,
  prepError: { code?: string; message?: string } | null,
):
  | { allowed: true; updatedCount: number }
  | { allowed: false; reason: string; errorCode: string; errorMessage: string } {
  if (prepError) {
    const code = (prepError.code ?? "").trim() || "RPC_ERROR";
    if (code === "PGRST202" || code === "42883") {
      return {
        allowed: false,
        reason: "RPC_UNAVAILABLE",
        errorCode: code,
        errorMessage:
          "Reprocessamento manual indisponível: a função de segurança prepare_manual_whatsapp_retry não foi encontrada no banco de dados.",
      };
    }
    return {
      allowed: false,
      reason: "RPC_ERROR",
      errorCode: code,
      errorMessage:
        prepError.message || "Reprocessamento manual bloqueado pelas regras de segurança.",
    };
  }

  if (!prepData || typeof prepData !== "object" || Array.isArray(prepData)) {
    return {
      allowed: false,
      reason: "INVALID_RPC_RESPONSE",
      errorCode: "INVALID_RPC_RESPONSE",
      errorMessage:
        "Reprocessamento manual bloqueado: o banco de dados não retornou uma confirmação válida de preparação e auditoria.",
    };
  }

  const payload = prepData as {
    authorized?: unknown;
    updated_count?: unknown;
    outcome?: unknown;
    reason?: unknown;
    error_code?: unknown;
    message?: unknown;
  };

  const outcome = typeof payload.outcome === "string" ? payload.outcome.trim() : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  const errorCode =
    typeof payload.error_code === "string" && payload.error_code.trim()
      ? payload.error_code.trim()
      : "MANUAL_RETRY_BLOCKED";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const rawCount = payload.updated_count;
  const hasValidCount =
    typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0;

  if (outcome === "blocked" || payload.authorized === false) {
    if (outcome === "noop" && hasValidCount && rawCount === 0) {
      return { allowed: true, updatedCount: 0 };
    }
    return {
      allowed: false,
      reason: reason || "MANUAL_RETRY_BLOCKED",
      errorCode,
      errorMessage:
        message ||
        (reason
          ? `Reprocessamento manual bloqueado (${reason}).`
          : "Reprocessamento manual bloqueado pelas regras de segurança."),
    };
  }

  if (outcome === "noop" && hasValidCount && rawCount === 0) {
    return { allowed: true, updatedCount: 0 };
  }

  if (outcome === "authorized" && payload.authorized === true && hasValidCount && rawCount >= 1) {
    return { allowed: true, updatedCount: rawCount };
  }

  return {
    allowed: false,
    reason: "UNCONFIRMED_PREPARATION_STATE",
    errorCode: "UNCONFIRMED_PREPARATION_STATE",
    errorMessage:
      "Reprocessamento manual bloqueado: estrutura de resposta da RPC prepare_manual_whatsapp_retry inválida ou incompleta.",
  };
}

export const setupCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setupSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { executeSetupCompany } = await import("./company.server");
    return executeSetupCompany(context, data);
  });

export const interpretMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { executeInterpretMessage } = await import("./company.server");
    return executeInterpretMessage(context, data);
  });

export const retryPendingMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => retrySchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { executeCoalescedRetryPendingMessages } = await import("./company.server");
    return executeCoalescedRetryPendingMessages(context, data);
  });

export const updateCompanyPrices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updatePricesSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { executeUpdateCompanyPrices } = await import("./company.server");
    return executeUpdateCompanyPrices(context, data);
  });

export const ignoreWhatsAppMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ignoreMessageSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { executeIgnoreWhatsAppMessage } = await import("./company.server");
    return executeIgnoreWhatsAppMessage(context, data);
  });

export const saveCompanyCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => upsertCustomerSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { executeSaveCompanyCustomer } = await import("./company.server");
    return executeSaveCompanyCustomer(context, data);
  });

export const inspectCustomerLgpd = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inspectLgpdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { executeInspectCustomerLgpd } = await import("./company.server");
    return executeInspectCustomerLgpd(context, data);
  });

export const anonymizeCustomerLgpd = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => anonymizeLgpdSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { executeAnonymizeCustomerLgpd } = await import("./company.server");
    return executeAnonymizeCustomerLgpd(context, data);
  });
