import { describe, expect, it } from "vitest";
import { evaluateFinancialCommand, type FinancialContext, type FinancialOrder } from "./financial-command";
import { brToday } from "./format";

const order: FinancialOrder = {
  id: "order-today", companyId: "company-a", customerId: "customer-a",
  conversationId: "chat-a", phone: "11999999999", date: "2026-10-26", total: 174,
  state: "PENDENTE", cancelled: false, paymentState: "NONE", confirmed: false,
};
const context = (patch: Partial<FinancialContext> = {}): FinancialContext => ({
  body: "OK", eventId: "event-1", source: "authenticated_operator", actorAuthorized: true,
  provenanceVerified: true, standalone: true, quoted: false, forwarded: false,
  companyId: "company-a", customerId: "customer-a", conversationId: "chat-a",
  phone: "+55 (11) 99999-9999", today: "2026-10-26", commandDate: "2026-10-26",
  explicitOrderId: "order-today", processedEventIds: [], orders: [{ ...order }], ...patch,
});
const blocked = (input: FinancialContext, reason?: string) => {
  const result = evaluateFinancialCommand(input);
  expect(result.acao_financeira).toBe("NENHUMA");
  expect(result.status_solicitado).toBe("NENHUM");
  if (reason) expect(result.motivo).toBe(reason);
};

describe("Financial command preparation (no persistence)", () => {
  it.each([ ["OK", "PAGO"], ["OKK", "FIADO"] ])("%s only requests %s on the existing order", (body, state) => {
    const input = context({ body });
    const before = structuredClone(input);
    expect(evaluateFinancialCommand(input)).toMatchObject({
      pedido_id: "order-today", valor_pedido: 174, status_atual: "PENDENTE",
      status_solicitado: state, acao_financeira: "SOLICITAR_CLASSIFICACAO",
    });
    expect(input).toEqual(before);
  });
  it.each(["ok", "okk", " OK", "OK\n", "ok, obrigado", "ok pode mandar", "okk depois pago", "confirmo OK", "O"])
    ("rejects non-exact command %s", (body) => blocked(context({ body }), "COMANDO_NAO_RECONHECIDO"));
  it.each(["customer", "unknown"] as const)("rejects %s despite authorization flags", (source) =>
    blocked(context({ source }), "ORIGEM_NAO_AUTORIZADA"));
  it("rejects unauthorized employees", () => blocked(context({ actorAuthorized: false })));
  it("rejects unverified provenance", () => blocked(context({ provenanceVerified: false })));
  it("requires independent messages", () => blocked(context({ standalone: false })));
  it("rejects quoted commands", () => blocked(context({ quoted: true })));
  it("rejects forwarded commands", () => blocked(context({ forwarded: true })));
  it.each(["quoted", "forwarded", "standalone"] as const)("rejects missing %s metadata", (key) =>
    blocked(context({ [key]: null })));
  it("rejects unidentified events", () => blocked(context({ eventId: null })));
  it("rejects repeated events", () => blocked(context({ processedEventIds: ["event-1"] }), "EVENTO_DUPLICADO"));
  it.each([null, "2026-02-30", "UTC"])("requires a real local date %s", (today) => blocked(context({ today })));
  it("rejects delayed commands", () => blocked(context({ commandDate: "2026-10-25" })));
  it.each(["companyId", "customerId", "conversationId", "phone"] as const)
    ("requires %s", (key) => blocked(context({ [key]: null })));
  it("rejects invalid phone", () => blocked(context({ phone: "55" })));
  it.each(["companyId", "customerId", "conversationId", "phone"] as const)
    ("rejects explicit order conflicting on %s", (key) =>
      blocked(context({ orders: [{ ...order, [key]: "other" }] }), "CONTEXTO_CONFLITANTE"));
  it("never falls back from an unknown explicit ID", () => blocked(context({ explicitOrderId: "missing" })));
  it("rejects yesterday even with explicit ID", () => blocked(context({ orders: [{ ...order, date: "2026-10-25" }] }), "PEDIDO_FORA_DO_PERIODO_PERMITIDO"));
  it("does not select old debt as fallback", () => blocked(context({ explicitOrderId: null, orders: [{ ...order, date: "2026-10-25", state: "FIADO" }] })));
  it("rejects cancelled orders", () => blocked(context({ orders: [{ ...order, cancelled: true }] })));
  it.each(["PAGO", "FIADO"] as const)("does not reclassify %s", (state) => blocked(context({ orders: [{ ...order, state }] }), "PEDIDO_JA_CLASSIFICADO"));
  it("rejects prior confirmations", () => blocked(context({ orders: [{ ...order, confirmed: true }] })));
  it.each(["PARTIAL", "UNKNOWN"] as const)("blocks %s allocation", (paymentState) => blocked(context({ orders: [{ ...order, paymentState }] })));
  it.each([0, -1, NaN, Infinity])("never invents an invalid amount %s", (total) => blocked(context({ orders: [{ ...order, total }] })));
  it("rejects two eligible orders instead of choosing newest", () => blocked(context({ explicitOrderId: null, orders: [order, { ...order, id: "second" }] }), "MULTIPLOS_PEDIDOS_ELEGIVEIS"));
  it("accepts an explicit validated ID among two eligible orders", () => expect(evaluateFinancialCommand(context({ orders: [order, { ...order, id: "second" }] })).pedido_id).toBe(order.id));
  it("accepts exactly one eligible order without explicit ID", () => expect(evaluateFinancialCommand(context({ explicitOrderId: null })).acao_financeira).toBe("SOLICITAR_CLASSIFICACAO"));
  it("does not bypass unknown partials on another candidate", () => blocked(context({ explicitOrderId: null, orders: [order, { ...order, id: "second", paymentState: "UNKNOWN" }] })));
  it("returns no fabricated order or value for missing context", () => expect(evaluateFinancialCommand(context({ orders: [] }))).toMatchObject({ pedido_id: null, valor_pedido: null }));
  it.each([
    ["2026-10-27T02:59:59Z", "2026-10-26"],
    ["2026-10-27T03:00:00Z", "2026-10-27"],
    ["2026-10-27T03:00:01Z", "2026-10-27"],
  ])("uses Brazilian day at %s", (timestamp, expected) => expect(brToday(new Date(timestamp))).toBe(expected));
  it("blocks a previously valid command after local midnight", () => blocked(context({ today: brToday(new Date("2026-10-27T03:00:00Z")) })));
});