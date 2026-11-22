import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { classifyWithPersistence, type FinancialCommit } from "./financial-persistence";
import type { FinancialContext } from "./financial-command";

const commandSchema = z
  .object({
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    command: z.enum(["OK", "OKK"]),
  })
  .strict();

const pendingSchema = z
  .object({
    customerId: z.string().uuid(),
    eventId: z.string().uuid(),
    qtyG: z.number().int().min(0),
    qtyM: z.number().int().min(0).optional().default(0),
    qtyP: z.number().int().min(0),
  })
  .strict()
  .refine((data) => data.qtyG + data.qtyM + data.qtyP > 0, "Informe pelo menos uma marmita.");

const paymentSchema = z
  .object({
    customerId: z.string().uuid(),
    amount: z.number().finite().positive().max(1_000_000),
    method: z.string().trim().min(1).max(40).default("manual"),
    notes: z.string().max(500).nullable().optional(),
    idempotencyKey: z.string().trim().min(8).max(160),
  })
  .strict();

type RpcTransport = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
};

async function callRpc(client: RpcTransport, name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883")
      throw new Error(
        "Infraestrutura financeira (migração 0010/0021) ainda não aplicada. Nenhum pedido foi alterado.",
      );
    throw new Error(error.message);
  }
  if (data === null) throw new Error("Resposta financeira indisponível.");
  return data;
}

/**
 * Confirma financeiramente um pedido do dia atual como OK (pago na hora) ou OKK (fiado).
 * Usa exatamente a mesma regra pura (`evaluateFinancialCommand`) e transação SQL que o WhatsApp.
 */
export const classifyFinancialOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => commandSchema.parse(input))
  .handler(async ({ data, context }) => {
    const receivedAt = new Date().toISOString();
    const client = context.supabase as unknown as RpcTransport;
    const args = {
      _order_id: data.orderId,
      _event_id: data.eventId,
      _command: data.command,
      _received_at: receivedAt,
    };
    return classifyWithPersistence(
      {
        load: async () =>
          (await callRpc(client, "financial_command_context", args)) as FinancialContext,
        commit: async (_request, decision) =>
          (await callRpc(client, "financial_classify_order", {
            ...args,
            _validation_allowed: decision.acao_financeira === "SOLICITAR_CLASSIFICACAO",
            _validation_reason: decision.motivo,
          })) as FinancialCommit,
      },
      data,
    );
  });

export const createPendingFinancialOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => pendingSchema.parse(input))
  .handler(async ({ data, context }) =>
    callRpc(context.supabase as unknown as RpcTransport, "financial_create_pending", {
      _customer_id: data.customerId,
      _event_id: data.eventId,
      _qty_g: data.qtyG,
      _qty_m: data.qtyM ?? 0,
      _qty_p: data.qtyP,
    }),
  );

export const updateFinancialDelivery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        orderId: z.string().uuid(),
        status: z.enum(["pendente", "preparando", "em_rota", "entregue", "cancelado"]),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await (context.supabase as unknown as RpcTransport).rpc(
      "financial_update_delivery",
      { _order_id: data.orderId, _status: data.status },
    );
    if (error) throw new Error(error.message);
    return { updated: true };
  });

/**
 * CORREÇÃO AF-08:
 * Registra pagamento de cliente utilizando exclusivamente a função oficial
 * `public.financial_register_payment` com chave de idempotência obrigatória.
 */
export async function executeRegisterFinancialPayment(
  client: RpcTransport,
  input: z.infer<typeof paymentSchema>,
): Promise<{ paymentId: string }> {
  const parsed = paymentSchema.parse(input);
  const paymentId = await callRpc(client, "financial_register_payment", {
    _customer_id: parsed.customerId,
    _amount: parsed.amount,
    _method: parsed.method,
    _notes: parsed.notes ?? null,
    _idempotency_key: parsed.idempotencyKey,
  });

  if (typeof paymentId !== "string" || !paymentId.trim()) {
    throw new Error("Identificador de pagamento inválido retornado pelo banco.");
  }

  return { paymentId };
}

export const registerFinancialPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => paymentSchema.parse(input))
  .handler(async ({ data, context }) => {
    return executeRegisterFinancialPayment(context.supabase as unknown as RpcTransport, data);
  });
