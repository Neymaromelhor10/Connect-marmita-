import { evaluateFinancialCommand, type FinancialContext, type FinancialDecision } from "./financial-command";

export type FinancialRequest = { orderId: string; eventId: string; command: "OK" | "OKK" };
export type FinancialCommit = {
  outcome: "classified" | "blocked" | "duplicate" | "conflict";
  reason: string;
  order_id: string;
  state: "aguardando_classificacao" | "pago" | "fiado" | null;
  total: number | null;
  audit_id: string | null;
};

/** Adapters MUST derive every context field from verified server/database data. */
export type FinancialPersistence = {
  load: (request: FinancialRequest) => Promise<FinancialContext>;
  commit: (request: FinancialRequest, decision: FinancialDecision) => Promise<FinancialCommit>;
};

/** Database commit also revalidates under locks: this decision is never a write authorization. */
export async function classifyWithPersistence(adapter: FinancialPersistence, request: FinancialRequest) {
  const context = await adapter.load(request);
  const decision = evaluateFinancialCommand(context);
  // Commit records rejections too, and resolves persistent retries before checking current state.
  const result = await adapter.commit(request, decision);
  return { validation: decision, result };
}