import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { verifyRemoteSupabaseSession } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  MAX_MANUAL_RETRIES,
  MANUAL_RETRY_COOLDOWN_SECONDS,
} from "./interpret.server";
import { normalizePhone, isValidNormalizedPhone } from "./format";
import { evaluateManualRetryPreparationOutcome } from "./company.functions";

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

const inFlightCompanySetupByUser = new Map<string, Promise<{ companyId: string }>>();
const inFlightManualRetries = new Map<
  string,
  Promise<{ total: number; recovered: number; failed: number }>
>();

export type CompanyOperatorAuthContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
  token?: string;
};

export type LgpdCustomerInspectionResult = {
  customer_id: string;
  has_open_debt: boolean;
  open_debt_amount: number;
  has_pending_classification: boolean;
  pending_orders_count: number;
  orders_count: number;
  payments_count: number;
  messages_count: number;
  allowed_scopes: ("dados_complementares" | "anonimizacao_completa")[];
  legal_basis_summary: string;
};

export type LgpdCustomerAnonymizationResult = {
  customer_id: string;
  scope_executed: "dados_complementares" | "anonimizacao_completa";
  redacted_messages_count: number;
  financial_records_preserved: boolean;
  protocol: string;
  audit_id?: string | null;
};

export async function authorizeCompanyOperatorOperation(
  context: CompanyOperatorAuthContext | null | undefined,
): Promise<{ companyId: string; userId: string }> {
  if (!context?.userId || !context?.supabase) {
    throw new Error("Acesso negado: autenticação obrigatória.");
  }

  if (context.supabase.auth && typeof context.supabase.auth.getUser === "function") {
    await verifyRemoteSupabaseSession(context.supabase, context.userId, context.token);
  }

  const profile = await context.supabase
    .from("profiles")
    .select("company_id")
    .eq("id", context.userId)
    .maybeSingle();

  const companyId = profile.data?.company_id;
  if (profile.error || !companyId) {
    throw new Error("Empresa não encontrada.");
  }

  const maybeRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
      ) => PromiseLike<{ data: string | null; error: { code?: string; message?: string } | null }>;
    }
  ).rpc;

  if (typeof maybeRpc !== "function") {
    throw new Error("Permissão financeira/operacional necessária.");
  }

  let opCheck: { data: string | null; error: { code?: string; message?: string } | null };
  try {
    opCheck = await maybeRpc.call(context.supabase, "financial_require_operator");
  } catch {
    throw new Error("Permissão financeira/operacional necessária.");
  }

  if (opCheck.error || !opCheck.data || opCheck.data !== companyId) {
    throw new Error("Permissão financeira/operacional necessária.");
  }

  return { companyId, userId: context.userId };
}

export async function authorizeCompanyAdminOperation(
  context: CompanyOperatorAuthContext | null | undefined,
): Promise<{ companyId: string; userId: string }> {
  if (!context?.userId || !context?.supabase) {
    throw new Error("Acesso negado: autenticação obrigatória.");
  }

  if (context.supabase.auth && typeof context.supabase.auth.getUser === "function") {
    await verifyRemoteSupabaseSession(context.supabase, context.userId, context.token);
  }

  const profile = await context.supabase
    .from("profiles")
    .select("company_id")
    .eq("id", context.userId)
    .maybeSingle();

  const companyId = profile.data?.company_id;
  if (profile.error || !companyId) {
    throw new Error("Empresa não encontrada.");
  }

  const maybeRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{ data: boolean | null; error: { code?: string; message?: string } | null }>;
    }
  ).rpc;

  if (typeof maybeRpc !== "function") {
    throw new Error("Permissão administrativa necessária para executar esta operação.");
  }

  let adminCheck: { data: boolean | null; error: { code?: string; message?: string } | null };
  try {
    adminCheck = await maybeRpc.call(context.supabase, "is_company_admin", {
      _company_id: companyId,
    });
  } catch {
    throw new Error("Permissão administrativa necessária para executar esta operação.");
  }

  if (adminCheck.error || adminCheck.data !== true) {
    throw new Error("Permissão administrativa necessária para executar esta operação.");
  }

  return { companyId, userId: context.userId };
}

export async function executeSetupCompany(
  context: CompanyOperatorAuthContext & { claims?: Record<string, unknown> },
  data: z.infer<typeof setupSchema>,
) {
  const userId = context.userId;
  if (context.supabase?.auth && typeof context.supabase.auth.getUser === "function") {
    await verifyRemoteSupabaseSession(context.supabase, userId, context.token);
  }

  const inflight = inFlightCompanySetupByUser.get(userId);
  if (inflight) {
    return inflight;
  }

  const task = (async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const existing = await supabaseAdmin
      .from("profiles")
      .select("company_id")
      .eq("id", userId)
      .maybeSingle();
    if (existing.data?.company_id) return { companyId: existing.data.company_id };

    const claimsObj = (context.claims ?? {}) as {
      email?: string | null;
      user_metadata?: { full_name?: string; name?: string; company_name?: string };
    };
    const meta = claimsObj.user_metadata ?? {};

    const resolvedCompanyName =
      data.companyName.trim() ||
      (typeof meta.company_name === "string" ? meta.company_name.trim() : "") ||
      "Minha marmitaria";

    const resolvedFullName =
      data.fullName.trim() ||
      (typeof meta.full_name === "string" ? meta.full_name.trim() : "") ||
      (typeof meta.name === "string" ? meta.name.trim() : "") ||
      claimsObj.email ||
      "Responsável";

    const company = await supabaseAdmin
      .from("companies")
      .insert({ name: resolvedCompanyName })
      .select("id")
      .single();
    if (company.error) throw new Error(company.error.message);

    const profile = await supabaseAdmin.from("profiles").insert({
      id: userId,
      company_id: company.data.id,
      full_name: resolvedFullName,
      email: claimsObj.email ?? null,
    });
    if (profile.error) {
      await supabaseAdmin.from("companies").delete().eq("id", company.data.id);
      const retryExisting = await supabaseAdmin
        .from("profiles")
        .select("company_id")
        .eq("id", userId)
        .maybeSingle();
      if (retryExisting.data?.company_id) {
        return { companyId: retryExisting.data.company_id };
      }
      throw new Error(profile.error.message);
    }

    await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: "admin" });

    await supabaseAdmin
      .from("financial_permissions")
      .upsert(
        { company_id: company.data.id, user_id: userId, can_classify: true },
        { onConflict: "company_id,user_id" },
      );

    return { companyId: company.data.id };
  })();

  inFlightCompanySetupByUser.set(userId, task);
  try {
    return await task;
  } finally {
    inFlightCompanySetupByUser.delete(userId);
  }
}

export async function executeInterpretMessage(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof parseSchema>,
  deps?: {
    supabaseAdmin?: SupabaseClient<Database>;
    processIncomingMessageImpl?: typeof import("./interpret.server").processIncomingMessage;
  },
) {
  const { companyId } = await authorizeCompanyOperatorOperation(context);

  const supabaseAdmin =
    deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const processIncoming =
    deps?.processIncomingMessageImpl ??
    (await import("./interpret.server")).processIncomingMessage;

  return processIncoming(supabaseAdmin, companyId, {
    ...data,
    externalId: data.externalId ? `manual:${data.externalId}` : undefined,
  });
}

export async function executeRetryPendingMessages(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof retrySchema>,
  deps?: {
    supabaseAdmin?: SupabaseClient<Database>;
    drainWhatsAppQueueImpl?: typeof import("./whatsapp-webhook.server").drainWhatsAppQueue;
    rpcTimeoutMs?: number;
  },
): Promise<{ total: number; recovered: number; failed: number }> {
  const { companyId, userId } = await authorizeCompanyOperatorOperation(context);
  const supabaseAdmin =
    deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const timeoutMs = Math.max(100, deps?.rpcTimeoutMs ?? 10_000);

  let prepRpc: {
    data: unknown;
    error: { code?: string; message?: string } | null;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const rpcPromise = supabaseAdmin.rpc("prepare_manual_whatsapp_retry", {
      _company_id: companyId,
      _message_id: data.messageId ?? null,
      _actor_id: userId,
      _max_manual_retries: MAX_MANUAL_RETRIES,
      _cooldown_seconds: MANUAL_RETRY_COOLDOWN_SECONDS,
    });

    prepRpc = await Promise.race([
      rpcPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              "Reprocessamento manual bloqueado: tempo limite excedido ao validar permissão e auditoria no banco.",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    const msg =
      err instanceof Error && err.message
        ? err.message
        : "Reprocessamento manual bloqueado: falha de comunicação ao validar auditoria no banco.";
    throw new Error(msg);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const outcomeEval = evaluateManualRetryPreparationOutcome(prepRpc?.data, prepRpc?.error ?? null);
  if (!outcomeEval.allowed) {
    throw new Error(outcomeEval.errorMessage);
  }

  if (outcomeEval.updatedCount === 0) {
    return {
      total: 0,
      recovered: 0,
      failed: 0,
    };
  }

  const drainWhatsAppQueue =
    deps?.drainWhatsAppQueueImpl ??
    (await import("./whatsapp-webhook.server")).drainWhatsAppQueue;
  const workerId = `manual-retry:${userId}:${randomUUID()}`;
  const result = await drainWhatsAppQueue({
    companyId,
    messageId: data.messageId,
    limit: 25,
    concurrency: 3,
    workerId,
    supabase: supabaseAdmin,
  });

  return {
    total: result.claimed,
    recovered: result.processed,
    failed: result.failed,
  };
}

export async function executeCoalescedRetryPendingMessages(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof retrySchema>,
): Promise<{ total: number; recovered: number; failed: number }> {
  const { companyId } = await authorizeCompanyOperatorOperation(context);

  const inflightKey = `${companyId}:${data.messageId ?? "batch"}`;
  const active = inFlightManualRetries.get(inflightKey);
  if (active) {
    return active;
  }

  const task = executeRetryPendingMessages(context, data);

  inFlightManualRetries.set(inflightKey, task);
  try {
    return await task;
  } finally {
    inFlightManualRetries.delete(inflightKey);
  }
}

export async function executeUpdateCompanyPrices(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof updatePricesSchema>,
  deps?: { supabaseAdmin?: SupabaseClient<Database> },
): Promise<{ id: string; price_p: number; price_m: number; price_g: number }> {
  const { companyId } = await authorizeCompanyAdminOperation(context);
  const parsed = updatePricesSchema.parse(data);

  const clientRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: { id?: string; price_p?: number; price_m?: number; price_g?: number } | null;
        error: { code?: string; message?: string } | null;
      }>;
    }
  ).rpc;

  if (typeof clientRpc === "function") {
    const rpcRes = await clientRpc.call(context.supabase, "update_company_prices", {
      _price_p: parsed.priceP,
      _price_m: parsed.priceM,
      _price_g: parsed.priceG,
    });
    if (!rpcRes.error && rpcRes.data && rpcRes.data.id === companyId) {
      return {
        id: companyId,
        price_p: Number(rpcRes.data.price_p ?? parsed.priceP),
        price_m: Number(rpcRes.data.price_m ?? parsed.priceM),
        price_g: Number(rpcRes.data.price_g ?? parsed.priceG),
      };
    }
    if (rpcRes.error && rpcRes.error.code !== "PGRST202" && rpcRes.error.code !== "42883") {
      throw new Error(
        rpcRes.error.message || "Permissão administrativa necessária para alterar os preços da empresa.",
      );
    }
  }

  const supabaseAdmin =
    deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  const updated = await supabaseAdmin
    .from("companies")
    .update({
      price_p: Math.round(parsed.priceP * 100) / 100,
      price_m: Math.round(parsed.priceM * 100) / 100,
      price_g: Math.round(parsed.priceG * 100) / 100,
    })
    .eq("id", companyId)
    .select("id, price_p, price_m, price_g")
    .single();

  if (updated.error || !updated.data) {
    throw new Error(updated.error?.message || "Não foi possível atualizar os preços da empresa.");
  }

  return {
    id: updated.data.id,
    price_p: Number(updated.data.price_p),
    price_m: Number(updated.data.price_m ?? updated.data.price_p),
    price_g: Number(updated.data.price_g),
  };
}

export async function executeIgnoreWhatsAppMessage(
  context: CompanyOperatorAuthContext,
  data: { messageId: string },
): Promise<{ ignored: true; messageId: string }> {
  await authorizeCompanyOperatorOperation(context);
  const parsed = z.object({ messageId: z.string().uuid() }).strict().parse(data);

  const clientRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: boolean | null;
        error: { code?: string; message?: string } | null;
      }>;
    }
  ).rpc;

  if (typeof clientRpc !== "function") {
    throw new Error("Operação indisponível: RPC ignore_whatsapp_message não configurada.");
  }

  const rpcRes = await clientRpc.call(context.supabase, "ignore_whatsapp_message", {
    _message_id: parsed.messageId,
  });

  if (rpcRes.error || rpcRes.data !== true) {
    throw new Error(
      rpcRes.error?.message ||
        "Não foi possível dispensar a mensagem (verifique se ela pertence à sua empresa e não possui pedido ou processamento ativo).",
    );
  }

  return { ignored: true, messageId: parsed.messageId };
}

export async function executeSaveCompanyCustomer(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof upsertCustomerSchema>,
  deps?: { supabaseAdmin?: SupabaseClient<Database> },
): Promise<{ id: string; company_id: string; name: string; phone: string }> {
  const { companyId } = await authorizeCompanyOperatorOperation(context);
  const parsed = upsertCustomerSchema.parse(data);
  const cleanPhone = normalizePhone(parsed.phone);

  if (!isValidNormalizedPhone(cleanPhone) || cleanPhone.length < 10) {
    throw new Error("Telefone inválido. Use DDD + número, ex.: 11987654321.");
  }

  const clientRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: { id?: string; company_id?: string; name?: string; phone?: string } | null;
        error: { code?: string; message?: string } | null;
      }>;
    }
  ).rpc;

  if (typeof clientRpc === "function") {
    const rpcRes = await clientRpc.call(context.supabase, "upsert_company_customer", {
      _customer_id: parsed.id ?? null,
      _name: parsed.name.trim(),
      _phone: cleanPhone,
      _address: parsed.address?.trim() || null,
      _notes: parsed.notes?.trim() || null,
      _payment_cycle: parsed.payment_cycle,
    });

    if (!rpcRes.error && rpcRes.data && typeof rpcRes.data.id === "string") {
      if (rpcRes.data.company_id && rpcRes.data.company_id !== companyId) {
        throw new Error("Acesso negado: cliente pertence a outra empresa.");
      }
      return {
        id: rpcRes.data.id,
        company_id: companyId,
        name: rpcRes.data.name ?? parsed.name.trim(),
        phone: rpcRes.data.phone ?? cleanPhone,
      };
    }

    if (rpcRes.error && rpcRes.error.code !== "PGRST202" && rpcRes.error.code !== "42883") {
      if (rpcRes.error.code === "23505") {
        throw new Error("Já existe um cliente com esse telefone.");
      }
      throw new Error(rpcRes.error.message || "Não foi possível salvar o cliente.");
    }
  }

  const supabaseAdmin =
    deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  if (parsed.id) {
    const existing = await supabaseAdmin
      .from("customers")
      .select("id, company_id, phone")
      .eq("id", parsed.id)
      .maybeSingle();

    if (existing.error || !existing.data || existing.data.company_id !== companyId) {
      throw new Error("Acesso negado: cliente não encontrado na sua empresa.");
    }

    const updated = await supabaseAdmin
      .from("customers")
      .update({
        name: parsed.name.trim(),
        phone: cleanPhone,
        address: parsed.address?.trim() || null,
        notes: parsed.notes?.trim() || null,
        payment_cycle: parsed.payment_cycle,
      })
      .eq("id", parsed.id)
      .eq("company_id", companyId)
      .select("id, company_id, name, phone")
      .single();

    if (updated.error || !updated.data) {
      if (updated.error?.code === "23505") {
        throw new Error("Já existe um cliente com esse telefone.");
      }
      throw new Error(updated.error?.message || "Não foi possível atualizar o cliente.");
    }
    return updated.data;
  }

  const inserted = await supabaseAdmin
    .from("customers")
    .insert({
      company_id: companyId,
      name: parsed.name.trim(),
      phone: cleanPhone,
      address: parsed.address?.trim() || null,
      notes: parsed.notes?.trim() || null,
      payment_cycle: parsed.payment_cycle,
    })
    .select("id, company_id, name, phone")
    .single();

  if (inserted.error || !inserted.data) {
    if (inserted.error?.code === "23505") {
      throw new Error("Já existe um cliente com esse telefone.");
    }
    throw new Error(inserted.error?.message || "Não foi possível cadastrar o cliente.");
  }

  return inserted.data;
}

export async function executeInspectCustomerLgpd(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof inspectLgpdSchema>,
): Promise<LgpdCustomerInspectionResult> {
  await authorizeCompanyAdminOperation(context);
  const parsed = inspectLgpdSchema.parse(data);

  const clientRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: LgpdCustomerInspectionResult | null;
        error: { code?: string; message?: string } | null;
      }>;
    }
  ).rpc;

  if (typeof clientRpc !== "function") {
    throw new Error("Inspeção LGPD indisponível.");
  }

  const rpcRes = await clientRpc.call(context.supabase, "lgpd_inspect_customer", {
    _customer_id: parsed.customerId,
  });

  if (rpcRes.error || !rpcRes.data) {
    throw new Error(rpcRes.error?.message || "Não foi possível inspecionar a elegibilidade LGPD do cliente.");
  }

  return rpcRes.data;
}

export async function executeAnonymizeCustomerLgpd(
  context: CompanyOperatorAuthContext,
  data: z.infer<typeof anonymizeLgpdSchema>,
): Promise<LgpdCustomerAnonymizationResult> {
  await authorizeCompanyAdminOperation(context);
  const parsed = anonymizeLgpdSchema.parse(data);

  const expectedToken = `LGPD_CONFIRM_${parsed.customerId}`;
  if (parsed.confirmToken !== expectedToken) {
    throw new Error(
      `Token de confirmação explícita inválido. Digite exatamente: ${expectedToken}`,
    );
  }

  const clientRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: LgpdCustomerAnonymizationResult | null;
        error: { code?: string; message?: string } | null;
      }>;
    }
  ).rpc;

  if (typeof clientRpc !== "function") {
    throw new Error("Anonimização LGPD indisponível.");
  }

  let rpcRes = await clientRpc.call(context.supabase, "lgpd_anonymize_customer", {
    _customer_id: parsed.customerId,
    _scope: parsed.scope,
    _confirm_token: parsed.confirmToken,
    _protocol: parsed.protocol,
  });

  if (rpcRes.error && (rpcRes.error.code === "PGRST202" || rpcRes.error.code === "42883")) {
    rpcRes = await clientRpc.call(context.supabase, "lgpd_anonymize_customer_pii", {
      _customer_id: parsed.customerId,
      _scope: parsed.scope,
      _confirm_token: parsed.confirmToken,
      _protocol: parsed.protocol,
    });
  }

  if (rpcRes.error || !rpcRes.data) {
    throw new Error(
      rpcRes.error?.message || "Não foi possível concluir a anonimização LGPD do cliente.",
    );
  }

  return rpcRes.data;
}
