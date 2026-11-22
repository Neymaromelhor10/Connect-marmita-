import { describe, expect, it } from "vitest";
import { balanceByCustomer, isConfirmedUnpaid, type BalanceOrder } from "./financial-state";

const order = (patch: Partial<BalanceOrder> = {}): BalanceOrder => ({
  customer_id: "a", delivery_status: "pendente", paid: false,
  settled_by_payment: false, total: 174, ...patch,
});

describe("pending infrastructure balance compatibility", () => {
  it("pending R$174 creates no confirmed debt", () => {
    expect(balanceByCustomer([order({ financial_state: "aguardando_classificacao" })]).get("a") ?? 0).toBe(0);
  });
  it("pending never appears in the confirmed unpaid detail", () => {
    expect(isConfirmedUnpaid(order({ financial_state: "aguardando_classificacao" }))).toBe(false);
  });
  it("legacy debt 100 + 40 minus partial payment 50 remains 90, on-spot 60 excluded", () => {
    expect(balanceByCustomer([order({ total: 100 }), order({ total: 60, paid: true }), order({ total: 40 })],
      [{ customer_id: "a", amount: 50 }]).get("a")).toBe(90);
  });
  it("null legacy state and missing state have identical balances", () => {
    expect(balanceByCustomer([order({ financial_state: null })]).get("a")).toBe(174);
    expect(balanceByCustomer([order()]).get("a")).toBe(174);
  });
  it("OK paid-on-spot R$174 is not debt", () => {
    expect(balanceByCustomer([order({ paid: true, financial_state: "pago" })]).get("a") ?? 0).toBe(0);
  });
  it("OKK R$174 is one debt", () => {
    expect(balanceByCustomer([order({ financial_state: "fiado" })]).get("a")).toBe(174);
  });
  it("FIFO-settled new fiado minus R$174 payment is zero", () => {
    expect(balanceByCustomer([order({ financial_state: "fiado", paid: true, settled_by_payment: true })],
      [{ customer_id: "a", amount: 174 }]).get("a")).toBe(0);
  });
  it("pending cannot absorb R$40 customer credit", () => {
    expect(balanceByCustomer([order({ financial_state: "aguardando_classificacao" })],
      [{ customer_id: "a", amount: 40 }]).get("a")).toBe(-40);
  });
  it("cancelled debt is excluded", () => {
    expect(balanceByCustomer([order({ financial_state: "fiado", delivery_status: "cancelado" })]).get("a") ?? 0).toBe(0);
  });
});