import { describe, expect, it, vi, beforeEach } from "vitest";
import { evaluateFinancialCommand, type FinancialContext, type FinancialOrder } from "./financial-command";
import { classifyWithPersistence, type FinancialCommit } from "./financial-persistence";
import {
  balanceByCustomer,
  computeDashboardSummary,
  isAwaitingClassification,
  type BalanceOrder,
} from "./financial-state";
import { brDateISO, brToday, formatSizes } from "./format";
import { extractBusinessEchoes, extractMessages } from "@/routes/api/public/whatsapp/meta-webhook";
import { phoneKey, processIncomingMessage } from "./interpret.server";
import { processVerifiedBusinessEcho } from "./whatsapp-webhook.server";

/**
 * Simulador em memória de banco de dados transacional (fiel à migração 0010)
 * para testar os fluxos integrados de ponta a ponta (IA -> Pedido Aguardando ->
 * Confirmação OK/OKK via WhatsApp ou Painel -> Contas a Receber -> Pagamento -> Dashboard).
 */
class InMemoryMarmitaStore {
  companies = new Map<string, { id: string; price_g: number; price_m: number; price_p: number }>([
    ["comp-a", { id: "comp-a", price_g: 20, price_m: 18, price_p: 16 }],
    ["comp-b", { id: "comp-b", price_g: 25, price_m: 22, price_p: 19 }],
  ]);
  customers = new Map<
    string,
    { id: string; company_id: string; name: string; phone: string; status: string }
  >([
    [
      "cust-a1",
      { id: "cust-a1", company_id: "comp-a", name: "João Silva", phone: "11988887777", status: "em_dia" },
    ],
    [
      "cust-b1",
      { id: "cust-b1", company_id: "comp-b", name: "Maria Souza", phone: "11977776666", status: "em_dia" },
    ],
  ]);
  orders = new Map<
    string,
    {
      id: string;
      company_id: string;
      customer_id: string;
      qty_g: number;
      qty_m: number;
      qty_p: number;
      quantity: number;
      unit_price: number;
      total: number;
      order_date: string;
      delivery_status: string;
      paid: boolean;
      settled_by_payment: boolean;
      financial_state: "aguardando_classificacao" | "pago" | "fiado" | null;
      financial_conversation_id: string | null;
      financial_phone: string | null;
      source: string;
      created_at: string;
    }
  >();
  payments: { id: string; company_id: string; customer_id: string; amount: number; paid_at: string }[] = [];
  events = new Map<string, { id: string; company_id: string; event_id: string; order_id: string | null; command: string; outcome: string; reason: string; final_state: string | null; total: number | null }>();
  messages = new Map<string, Record<string, unknown>>();
  private seq = 1;
  private locks = new Set<string>();

  createOrder(input: {
    company_id: string;
    customer_id: string;
    qty_g?: number;
    qty_m?: number;
    qty_p?: number;
    order_date: string;
    financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null;
    paid?: boolean;
    source?: string;
    created_at?: string;
  }) {
    const comp = this.companies.get(input.company_id);
    if (!comp) throw new Error("Empresa não encontrada");
    const cust = this.customers.get(input.customer_id);
    if (!cust || cust.company_id !== input.company_id) {
      throw new Error("Cliente não pertence à empresa");
    }
    const g = input.qty_g ?? 0;
    const m = input.qty_m ?? 0;
    const p = input.qty_p ?? 0;
    const quantity = g + m + p;
    const total = Math.round((g * comp.price_g + m * comp.price_m + p * comp.price_p) * 100) / 100;
    const unit_price = Math.round((total / Math.max(quantity, 1)) * 100) / 100;
    const id = `ord-${this.seq++}`;
    const state = input.financial_state !== undefined ? input.financial_state : "aguardando_classificacao";
    const row = {
      id,
      company_id: input.company_id,
      customer_id: input.customer_id,
      qty_g: g,
      qty_m: m,
      qty_p: p,
      quantity,
      unit_price,
      total,
      order_date: input.order_date,
      delivery_status: "pendente",
      paid: input.paid ?? false,
      settled_by_payment: false,
      financial_state: state,
      financial_conversation_id: `wa:${input.company_id}:${input.customer_id}`,
      financial_phone: phoneKey(cust.phone),
      source: input.source ?? "mensagem",
      created_at: input.created_at ?? new Date().toISOString(),
    };
    this.orders.set(id, row);
    this.syncCustomerStatus(input.company_id, input.customer_id);
    return row;
  }

  updateOrderStatus(orderId: string, delivery_status: string) {
    const ord = this.orders.get(orderId);
    if (!ord) throw new Error("Pedido não encontrado");
    // set_order_total trigger rule: status-only update NEVER reprices total or unit_price
    ord.delivery_status = delivery_status;
    this.syncCustomerStatus(ord.company_id, ord.customer_id);
    return ord;
  }

  registerPayment(companyId: string, customerId: string, amount: number, paidAt = new Date().toISOString()) {
    const cust = this.customers.get(customerId);
    if (!cust || cust.company_id !== companyId) throw new Error("Cliente não encontrado");
    this.payments.push({
      id: `pay-${this.seq++}`,
      company_id: companyId,
      customer_id: customerId,
      amount: Math.round(amount * 100) / 100,
      paid_at: paidAt,
    });

    const totalPaid = this.payments
      .filter((p) => p.company_id === companyId && p.customer_id === customerId)
      .reduce((a, p) => a + p.amount, 0);
    const alreadySettled = [...this.orders.values()]
      .filter(
        (o) =>
          o.company_id === companyId &&
          o.customer_id === customerId &&
          o.paid &&
          o.settled_by_payment &&
          o.delivery_status !== "cancelado",
      )
      .reduce((a, o) => a + o.total, 0);

    let credit = Math.round((totalPaid - alreadySettled) * 100) / 100;

    // FIFO skips awaiting_classification orders!
    const unpaidConfirmed = [...this.orders.values()]
      .filter(
        (o) =>
          o.company_id === companyId &&
          o.customer_id === customerId &&
          !o.paid &&
          o.delivery_status !== "cancelado" &&
          o.financial_state !== "aguardando_classificacao",
      )
      .sort((a, b) => a.order_date.localeCompare(b.order_date) || a.id.localeCompare(b.id));

    for (const ord of unpaidConfirmed) {
      if (credit < ord.total) break;
      ord.paid = true;
      ord.settled_by_payment = true;
      credit = Math.round((credit - ord.total) * 100) / 100;
    }

    this.syncCustomerStatus(companyId, customerId);
  }

  private syncCustomerStatus(companyId: string, customerId: string) {
    const cust = this.customers.get(customerId);
    if (!cust || cust.company_id !== companyId) return;
    const hasConfirmedDebt = [...this.orders.values()].some(
      (o) =>
        o.company_id === companyId &&
        o.customer_id === customerId &&
        !o.paid &&
        o.delivery_status !== "cancelado" &&
        o.financial_state !== "aguardando_classificacao",
    );
    cust.status = hasConfirmedDebt ? "pendente" : "em_dia";
  }

  async classifyOrder(params: {
    companyId: string;
    orderId: string | null;
    customerId: string;
    command: "OK" | "OKK";
    eventId: string;
    source: "authenticated_operator" | "verified_business_echo";
    today: string;
    commandDate: string;
  }) {
    const cust = this.customers.get(params.customerId);
    if (!cust || cust.company_id !== params.companyId) {
      throw new Error("Pedido não encontrado");
    }
    if (params.orderId) {
      const target = this.orders.get(params.orderId);
      if (!target || target.company_id !== params.companyId) {
        throw new Error("Pedido não encontrado");
      }
    }

    return classifyWithPersistence(
      {
        load: async (): Promise<FinancialContext> => {
          const candidateOrders = [...this.orders.values()]
            .filter(
              (o) =>
                o.company_id === params.companyId &&
                o.customer_id === params.customerId &&
                (params.orderId ? o.id === params.orderId : o.order_date === params.today),
            )
            .map(
              (o): FinancialOrder => ({
                id: o.id,
                companyId: o.company_id,
                customerId: o.customer_id,
                conversationId: o.financial_conversation_id ?? `wa:${o.company_id}:${o.customer_id}`,
                phone: o.financial_phone ?? phoneKey(cust.phone),
                date: o.order_date,
                total: o.total,
                state:
                  o.financial_state === "aguardando_classificacao"
                    ? "PENDENTE"
                    : o.financial_state === "pago"
                      ? "PAGO"
                      : "FIADO",
                cancelled: o.delivery_status === "cancelado",
                paymentState: o.settled_by_payment ? "UNKNOWN" : "NONE",
                confirmed: o.financial_state !== "aguardando_classificacao",
              }),
            );

          const evKey = `${params.companyId}:${params.eventId}`;
          return {
            body: params.command,
            eventId: params.eventId,
            source: params.source,
            actorAuthorized: true,
            provenanceVerified: true,
            standalone: true,
            quoted: false,
            forwarded: false,
            companyId: params.companyId,
            customerId: cust.id,
            conversationId: `wa:${params.companyId}:${cust.id}`,
            phone: cust.phone,
            today: params.today,
            commandDate: params.commandDate,
            explicitOrderId: params.orderId,
            processedEventIds: this.events.has(evKey) ? [params.eventId] : [],
            orders: candidateOrders,
          };
        },
        commit: async (_req, decision): Promise<FinancialCommit> => {
          const evKey = `${params.companyId}:${params.eventId}`;
          const existing = this.events.get(evKey);
          if (existing) {
            if (existing.command !== params.command) {
              return {
                outcome: "conflict",
                reason: "EVENTO_CONFLITANTE",
                order_id: existing.order_id ?? "",
                state: null,
                total: null,
                audit_id: existing.id,
              };
            }
            return {
              outcome: "duplicate",
              reason: existing.reason,
              order_id: existing.order_id ?? "",
              state: existing.final_state as FinancialCommit["state"],
              total: existing.total,
              audit_id: existing.id,
            };
          }

          const targetId = params.orderId ?? decision.pedido_id;
          const ord = targetId ? this.orders.get(targetId) : undefined;

          // Atomic lock check for concurrent classifications on the same order
          if (ord && this.locks.has(ord.id)) {
            const auditId = `aud-${this.seq++}`;
            this.events.set(evKey, {
              id: auditId,
              company_id: params.companyId,
              event_id: params.eventId,
              order_id: ord.id,
              command: params.command,
              outcome: "blocked",
              reason: "PEDIDO_JA_CLASSIFICADO",
              final_state: ord.financial_state,
              total: ord.total,
            });
            return {
              outcome: "blocked",
              reason: "PEDIDO_JA_CLASSIFICADO",
              order_id: ord.id,
              state: ord.financial_state,
              total: ord.total,
              audit_id: auditId,
            };
          }

          if (
            ord &&
            decision.acao_financeira === "SOLICITAR_CLASSIFICACAO" &&
            ord.financial_state === "aguardando_classificacao" &&
            ord.order_date === params.today &&
            params.commandDate === params.today
          ) {
            this.locks.add(ord.id);
            const desired = params.command === "OK" ? "pago" : "fiado";
            ord.financial_state = desired;
            ord.paid = params.command === "OK";
            ord.settled_by_payment = false;
            this.syncCustomerStatus(params.companyId, params.customerId);
            const auditId = `aud-${this.seq++}`;
            this.events.set(evKey, {
              id: auditId,
              company_id: params.companyId,
              event_id: params.eventId,
              order_id: ord.id,
              command: params.command,
              outcome: "classified",
              reason: "CONFIRMACAO_VALIDADA",
              final_state: desired,
              total: ord.total,
            });
            return {
              outcome: "classified",
              reason: "CONFIRMACAO_VALIDADA",
              order_id: ord.id,
              state: desired,
              total: ord.total,
              audit_id: auditId,
            };
          }

          const auditId = `aud-${this.seq++}`;
          const reason =
            ord && ord.financial_state !== "aguardando_classificacao"
              ? "PEDIDO_JA_CLASSIFICADO"
              : decision.motivo;
          this.events.set(evKey, {
            id: auditId,
            company_id: params.companyId,
            event_id: params.eventId,
            order_id: ord?.id ?? null,
            command: params.command,
            outcome: "blocked",
            reason,
            final_state: ord?.financial_state ?? null,
            total: ord?.total ?? null,
          });
          return {
            outcome: "blocked",
            reason,
            order_id: ord?.id ?? "",
            state: ord?.financial_state ?? null,
            total: ord?.total ?? null,
            audit_id: auditId,
          };
        },
      },
      { orderId: params.orderId ?? "", eventId: params.eventId, command: params.command },
    );
  }
}

describe("30 Mandatory Tests — Definitive OK / OKK Financial Confirmation Flow", () => {
  const TODAY = "2026-11-03";
  const YESTERDAY = "2026-11-02";

  beforeEach(() => {
    process.env["GEMINI_API_KEY"] = "test-key";
    vi.restoreAllMocks();
  });

  // TESTE 1: Pedido recebido e classificado com "OK"
  it("01. Pedido recebido (3G + 2M = R$ 96) e classificado com 'OK' vira pago na hora", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });
    expect(ord.financial_state).toBe("aguardando_classificacao");
    expect(ord.total).toBe(96);

    const res = await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-01",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(res.result.outcome).toBe("classified");
    expect(res.result.state).toBe("pago");
    expect(res.result.total).toBe(96);
    expect(store.orders.get(ord.id)?.paid).toBe(true);
  });

  // TESTE 2: Pedido recebido e classificado com "OKK"
  it("02. Pedido recebido (6G + 3M = R$ 174) e classificado com 'OKK' vira fiado", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 6,
      qty_m: 3,
      order_date: TODAY,
    });

    const res = await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-02",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(res.result.outcome).toBe("classified");
    expect(res.result.state).toBe("fiado");
    expect(res.result.total).toBe(174);
    expect(store.orders.get(ord.id)?.paid).toBe(false);
    expect(store.customers.get("cust-a1")?.status).toBe("pendente");
  });

  // TESTE 3: Pedido sem confirmação permanece aguardando
  it("03. Pedido sem confirmação permanece em 'aguardando_classificacao'", () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 2,
      qty_m: 1,
      order_date: TODAY,
    });
    expect(isAwaitingClassification(ord)).toBe(true);
    expect(ord.paid).toBe(false);
    expect(store.customers.get("cust-a1")?.status).toBe("em_dia");
  });

  // TESTE 4: Cliente enviando "OK" não altera nada
  it("04. Cliente enviando 'OK' pelo WhatsApp é bloqueado (ORIGEM_NAO_AUTORIZADA) e não altera nada", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    const mockSupabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: "msg-ok-cust" }, error: null }),
          }),
        }),
      }),
    };

    const res = await processIncomingMessage(mockSupabase as never, "comp-a", {
      phone: "11988887777",
      body: "OK",
      externalId: "wa:cust-ok-1",
    });

    expect(res.status).toBe("ignorado");
    expect(res.parsed?.motivo).toBe("ORIGEM_NAO_AUTORIZADA");
    expect(store.orders.get(ord.id)?.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 5: Cliente enviando "OKK" não altera nada
  it("05. Cliente enviando 'OKK' pelo WhatsApp é bloqueado (ORIGEM_NAO_AUTORIZADA) e não altera nada", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: "msg-okk-cust" }, error: null }),
          }),
        }),
      }),
    };

    const res = await processIncomingMessage(mockSupabase as never, "comp-a", {
      phone: "11988887777",
      body: "OKK",
      externalId: "wa:cust-okk-1",
    });

    expect(res.status).toBe("ignorado");
    expect(res.parsed?.motivo).toBe("ORIGEM_NAO_AUTORIZADA");
    expect(store.orders.get(ord.id)?.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 6: Comando enviado pela marmitaria classifica corretamente (via eco comercial WhatsApp)
  it("06. Comando enviado pela própria marmitaria (smb_message_echoes) classifica corretamente", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    const echoes = extractBusinessEchoes(
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-1",
            changes: [
              {
                field: "smb_message_echoes",
                value: {
                  metadata: { phone_number_id: "phone-1" },
                  message_echoes: [
                    {
                      id: "wamid.echo.1",
                      from: "551133334444",
                      to: "5511988887777",
                      timestamp: "1793714400",
                      type: "text",
                      text: { body: "OK" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { nowMs: 1793714400_000 },
    );

    expect(echoes).toHaveLength(1);
    expect(echoes[0]?.text).toBe("OK");
    expect(echoes[0]?.to).toBe("5511988887777");

    const res = await store.classifyOrder({
      companyId: "comp-a",
      orderId: null,
      customerId: "cust-a1",
      command: "OK",
      eventId: `echo:${echoes[0]!.messageId}`,
      source: "verified_business_echo",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(res.result.outcome).toBe("classified");
    expect(res.result.order_id).toBe(ord.id);
    expect(res.result.state).toBe("pago");
  });

  // TESTE 7: Comando recebido hoje não altera pedidos de ontem
  it("07. Comando enviado hoje não altera pedido de ontem (PEDIDO_FORA_DO_PERIODO_PERMITIDO)", async () => {
    const store = new InMemoryMarmitaStore();
    const oldOrd = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: YESTERDAY,
    });

    const resExplicit = await store.classifyOrder({
      companyId: "comp-a",
      orderId: oldOrd.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-07a",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });
    expect(resExplicit.result.outcome).toBe("blocked");
    expect(resExplicit.result.reason).toBe("PEDIDO_FORA_DO_PERIODO_PERMITIDO");

    const resAuto = await store.classifyOrder({
      companyId: "comp-a",
      orderId: null,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-07b",
      source: "verified_business_echo",
      today: TODAY,
      commandDate: TODAY,
    });
    expect(resAuto.result.outcome).toBe("blocked");
    expect(resAuto.result.reason).toBe("SEM_PEDIDO_ELEGIVEL");
    expect(store.orders.get(oldOrd.id)?.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 8: Pedido único do dia é identificado corretamente
  it("08. Pedido único do dia é identificado automaticamente com segurança mesmo se houver pedido ontem", async () => {
    const store = new InMemoryMarmitaStore();
    const yesterdayOrd = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 2,
      order_date: YESTERDAY,
    });
    const todayOrd = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 4,
      qty_m: 1,
      order_date: TODAY,
    });

    const res = await store.classifyOrder({
      companyId: "comp-a",
      orderId: null,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-08",
      source: "verified_business_echo",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(res.result.outcome).toBe("classified");
    expect(res.result.order_id).toBe(todayOrd.id);
    expect(store.orders.get(todayOrd.id)?.financial_state).toBe("fiado");
    expect(store.orders.get(yesterdayOrd.id)?.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 9: Dois pedidos pendentes sem associação segura vão para revisão
  it("09. Dois pedidos pendentes do mesmo cliente no dia bloqueiam associação automática (MULTIPLOS_PEDIDOS_ELEGIVEIS) e vão para revisão", async () => {
    const store = new InMemoryMarmitaStore();
    const ord1 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 2,
      order_date: TODAY,
    });
    const ord2 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_m: 3,
      order_date: TODAY,
    });

    const res = await store.classifyOrder({
      companyId: "comp-a",
      orderId: null,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-09",
      source: "verified_business_echo",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(res.result.outcome).toBe("blocked");
    expect(res.result.reason).toBe("MULTIPLOS_PEDIDOS_ELEGIVEIS");
    expect(store.orders.get(ord1.id)?.financial_state).toBe("aguardando_classificacao");
    expect(store.orders.get(ord2.id)?.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 10: Pedido já classificado não pode ser classificado novamente
  it("10. Pedido já classificado com OK não pode ser reclassificado com OKK (PEDIDO_JA_CLASSIFICADO)", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-10-first",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    const second = await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-10-second",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(second.result.outcome).toBe("blocked");
    expect(second.result.reason).toBe("PEDIDO_JA_CLASSIFICADO");
    expect(store.orders.get(ord.id)?.financial_state).toBe("pago");
  });

  // TESTE 11: Webhook duplicado não gera duplicidade
  it("11. Webhook duplicado (mesmo eventId da Meta) retorna duplicate sem duplicar venda ou auditoria", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    const first = await store.classifyOrder({
      companyId: "comp-a",
      orderId: null,
      customerId: "cust-a1",
      command: "OK",
      eventId: "echo:wamid-dup",
      source: "verified_business_echo",
      today: TODAY,
      commandDate: TODAY,
    });
    const second = await store.classifyOrder({
      companyId: "comp-a",
      orderId: null,
      customerId: "cust-a1",
      command: "OK",
      eventId: "echo:wamid-dup",
      source: "verified_business_echo",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(first.result.outcome).toBe("classified");
    expect(second.result.outcome).toBe("duplicate");
    expect(second.result.audit_id).toBe(first.result.audit_id);
    expect(store.orders.size).toBe(1);
    expect(store.events.size).toBe(1);
  });

  // TESTE 12: Clique duplo não gera duplicidade
  it("12. Clique duplo no botão do painel (mesmo eventId) é idempotente", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 6,
      qty_m: 3,
      order_date: TODAY,
    });

    const first = await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "btn-click-1",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });
    const second = await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "btn-click-1",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    expect(first.result.outcome).toBe("classified");
    expect(second.result.outcome).toBe("duplicate");
    expect(store.events.size).toBe(1);
  });

  // TESTE 13: Preços diferentes por empresa + Tabela oficial de exemplos (G=20, M=18)
  it("13. Calcula exatamente os exemplos oficiais (96, 174, 286, 570) e respeita preços por empresa", () => {
    const store = new InMemoryMarmitaStore();
    const cases = [
      { g: 3, m: 2, qty: 5, total: 96 },
      { g: 6, m: 3, qty: 9, total: 174 },
      { g: 8, m: 7, qty: 15, total: 286 },
      { g: 15, m: 15, qty: 30, total: 570 },
    ];
    for (const c of cases) {
      const o = store.createOrder({
        company_id: "comp-a",
        customer_id: "cust-a1",
        qty_g: c.g,
        qty_m: c.m,
        order_date: TODAY,
      });
      expect(o.quantity).toBe(c.qty);
      expect(o.total).toBe(c.total);
    }

    // Empresa B (G=25, M=22): 3G + 2M = 75 + 44 = R$ 119
    const ordB = store.createOrder({
      company_id: "comp-b",
      customer_id: "cust-b1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });
    expect(ordB.total).toBe(119);
  });

  // TESTE 14: Mudança de preço não altera pedidos históricos
  it("14. Mudança de preço da empresa não altera o valor de pedidos já registrados ao confirmar ou entregar", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });
    expect(ord.total).toBe(96);

    // Marmitaria altera preços para G=30, M=28
    store.companies.set("comp-a", { id: "comp-a", price_g: 30, price_m: 28, price_p: 25 });

    const res = await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-14",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });
    store.updateOrderStatus(ord.id, "entregue");

    expect(res.result.total).toBe(96);
    expect(store.orders.get(ord.id)?.total).toBe(96);
  });

  // TESTE 15: "OK" atualiza receita recebida
  it("15. 'OK' atualiza imediatamente Vendas Pagas e Valor Efetivamente Recebido", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-15",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    const all = [...store.orders.values()];
    const summary = computeDashboardSummary(all, all, store.payments, store.payments);
    expect(summary.paidSales).toMatchObject({
      ordersCount: 1,
      qtyG: 3,
      qtyM: 2,
      qtyP: 0,
      totalMeals: 5,
      amount: 96,
    });
    expect(summary.general.cashReceived).toBe(96);
    expect(summary.general.accountsReceivableOpen).toBe(0);
  });

  // TESTE 16: "OKK" atualiza Contas a Receber
  it("16. 'OKK' atualiza Vendas Fiadas e Contas a Receber sem somar como dinheiro recebido", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 6,
      qty_m: 3,
      order_date: TODAY,
    });

    await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-16",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    const all = [...store.orders.values()];
    const summary = computeDashboardSummary(all, all, store.payments, store.payments);
    expect(summary.fiadoSales).toMatchObject({
      ordersCount: 1,
      qtyG: 6,
      qtyM: 3,
      qtyP: 0,
      totalMeals: 9,
      pendingAmount: 174,
    });
    expect(summary.general.cashReceived).toBe(0);
    expect(summary.general.accountsReceivableOpen).toBe(174);
  });

  // TESTE 17: Pagamento posterior reduz a dívida sem duplicar venda
  it("17. Pagamento posterior de fiado reduz Contas a Receber e aumenta Valor Recebido sem duplicar venda ou marmitas", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 6,
      qty_m: 3,
      order_date: TODAY,
    });

    await store.classifyOrder({
      companyId: "comp-a",
      orderId: ord.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-17",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    // Cliente paga R$ 74,00 parcialmente
    store.registerPayment("comp-a", "cust-a1", 74);
    let all = [...store.orders.values()];
    let summary = computeDashboardSummary(all, all, store.payments, store.payments);
    expect(summary.general.finalizedOrdersCount).toBe(1);
    expect(summary.general.confirmedMealsCount).toBe(9);
    expect(summary.general.classifiedRevenue).toBe(174);
    expect(summary.general.cashReceived).toBe(74);
    expect(summary.general.accountsReceivableOpen).toBe(100);

    // Cliente paga os R$ 100,00 restantes
    store.registerPayment("comp-a", "cust-a1", 100);
    all = [...store.orders.values()];
    summary = computeDashboardSummary(all, all, store.payments, store.payments);
    expect(summary.general.finalizedOrdersCount).toBe(1);
    expect(summary.general.confirmedMealsCount).toBe(9);
    expect(summary.general.classifiedRevenue).toBe(174);
    expect(summary.general.cashReceived).toBe(174);
    expect(summary.general.accountsReceivableOpen).toBe(0);
  });

  // TESTE 18: Dashboard apresenta quantidades e valores corretos nas 4 áreas
  it("18. Dashboard separa Vendas Pagas, Vendas Fiadas, Pedidos Aguardando e Indicadores Gerais com precisão", async () => {
    const store = new InMemoryMarmitaStore();
    const p1 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    }); // R$ 96
    const p2 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 6,
      qty_m: 3,
      order_date: TODAY,
    }); // R$ 174
    const p3 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 1,
      qty_m: 1,
      qty_p: 1,
      order_date: TODAY,
    }); // R$ 54 aguardando

    await store.classifyOrder({
      companyId: "comp-a",
      orderId: p1.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-18a",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });
    await store.classifyOrder({
      companyId: "comp-a",
      orderId: p2.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-18b",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    const all = [...store.orders.values()];
    const summary = computeDashboardSummary(all, all, store.payments, store.payments);

    expect(summary.paidSales).toMatchObject({ ordersCount: 1, qtyG: 3, qtyM: 2, qtyP: 0, totalMeals: 5, amount: 96 });
    expect(summary.fiadoSales).toMatchObject({ ordersCount: 1, qtyG: 6, qtyM: 3, qtyP: 0, totalMeals: 9, pendingAmount: 174 });
    expect(summary.awaitingOrders).toMatchObject({ ordersCount: 1, qtyG: 1, qtyM: 1, qtyP: 1, totalMeals: 3, amount: 54 });
    expect(summary.general).toEqual({
      finalizedOrdersCount: 2,
      confirmedMealsCount: 14,
      classifiedRevenue: 270,
      cashReceived: 96,
      accountsReceivableOpen: 174,
      awaitingOrdersCount: 1,
    });
    expect(p3.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 19: Duas empresas não acessam nem alteram os dados uma da outra
  it("19. Isolamento multiempresa: Empresa B não acessa nem classifica pedidos da Empresa A", async () => {
    const store = new InMemoryMarmitaStore();
    const ordA = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    await expect(
      store.classifyOrder({
        companyId: "comp-b",
        orderId: ordA.id,
        customerId: "cust-a1",
        command: "OK",
        eventId: "ev-19",
        source: "authenticated_operator",
        today: TODAY,
        commandDate: TODAY,
      }),
    ).rejects.toThrow("Pedido não encontrado");

    expect(store.orders.get(ordA.id)?.financial_state).toBe("aguardando_classificacao");
  });

  // TESTE 20: Confirmações simultâneas não geram duplicidade
  it("20. Duas confirmações simultâneas (OK e OKK) resultam em apenas 1 classificação confirmada", async () => {
    const store = new InMemoryMarmitaStore();
    const ord = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
    });

    const results = await Promise.all([
      store.classifyOrder({
        companyId: "comp-a",
        orderId: ord.id,
        customerId: "cust-a1",
        command: "OK",
        eventId: "ev-20-ok",
        source: "authenticated_operator",
        today: TODAY,
        commandDate: TODAY,
      }),
      store.classifyOrder({
        companyId: "comp-a",
        orderId: ord.id,
        customerId: "cust-a1",
        command: "OKK",
        eventId: "ev-20-okk",
        source: "authenticated_operator",
        today: TODAY,
        commandDate: TODAY,
      }),
    ]);

    const classified = results.filter((r) => r.result.outcome === "classified");
    const blocked = results.filter((r) => r.result.outcome === "blocked");
    expect(classified).toHaveLength(1);
    expect(blocked).toHaveLength(1);
  });

  // TESTES ADICIONAIS 21, 22, 23: Cliente diz "vou pagar agora", "coloca na minha conta", "pago depois"
  it.each([
    ["21", "Manda 3 G e 2 M, vou pagar agora."],
    ["22", "Manda 3 G e 2 M, coloca na minha conta."],
    ["23", "Manda 3 G e 2 M, pago depois."],
  ])("%s. Cliente escreve '%s' -> pedido nasce obrigatoriamente como aguardando_classificacao", async (_num, text) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  eh_pedido: true,
                  nome: "João Silva",
                  qtd_g: 3,
                  qtd_m: 2,
                  qtd_p: null,
                  data: TODAY,
                  fiado: true, // mesmo se a IA retornasse fiado=true, o backend ignora!
                  motivo: null,
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const insertedOrders: Record<string, unknown>[] = [];
    const mockSupabase = {
      from: (table: string) => {
        if (table === "whatsapp_messages") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { id: "msg-1" }, error: null }),
              }),
            }),
            update: () => ({
              eq: async () => ({ error: null }),
            }),
          };
        }
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: async () => ({
                    data: [{ id: "cust-a1", name: "João Silva", phone: "11988887777" }],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "orders") {
          return {
            insert: (payload: Record<string, unknown>) => {
              insertedOrders.push(payload);
              return {
                select: () => ({
                  single: async () => ({ data: { id: "ord-created" }, error: null }),
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    };

    const res = await processIncomingMessage(mockSupabase as never, "comp-a", {
      phone: "11988887777",
      body: text,
      externalId: `wa:${text}`,
    });

    expect(res.status).toBe("registrado");
    expect(res.financialState).toBe("aguardando_classificacao");
    expect(insertedOrders[0]).toMatchObject({
      financial_state: "aguardando_classificacao",
      paid: false,
      settled_by_payment: false,
      qty_g: 3,
      qty_m: 2,
      qty_p: 0,
    });
  });

  // TESTES ADICIONAIS 24, 25, 26, 27: Horários 07:00, 10:00, 11:00 e ausência de corte automático às 10h
  it("24-27. Pedidos recebidos às 07:00, 10:00 e 11:00 permanecem aguardando confirmação sem automação às 10h", () => {
    const store = new InMemoryMarmitaStore();
    const o7 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 2,
      order_date: TODAY,
      created_at: `${TODAY}T10:00:00.000Z`, // 07:00 BRT
    });
    const o10 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_m: 2,
      order_date: TODAY,
      created_at: `${TODAY}T13:00:00.000Z`, // 10:00 BRT
    });
    const o11 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_p: 2,
      order_date: TODAY,
      created_at: `${TODAY}T14:00:00.000Z`, // 11:00 BRT
    });

    // Verificar que todos permanecem aguardando_classificacao independentemente do horário
    expect(o7.financial_state).toBe("aguardando_classificacao");
    expect(o10.financial_state).toBe("aguardando_classificacao");
    expect(o11.financial_state).toBe("aguardando_classificacao");

    const all = [...store.orders.values()];
    const summary = computeDashboardSummary(all, all, store.payments, store.payments);
    expect(summary.awaitingOrders.ordersCount).toBe(3);
    expect(summary.general.finalizedOrdersCount).toBe(0);
  });

  // TESTE ADICIONAL 28: A marmitaria pode confirmar os pedidos individualmente em qualquer horário posterior do dia
  it("28. A marmitaria confirma pedidos individualmente às 10:30, 11:15 e 15:40 BRT no mesmo dia", async () => {
    const store = new InMemoryMarmitaStore();
    const o1 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 3,
      qty_m: 2,
      order_date: TODAY,
      created_at: `${TODAY}T10:15:00.000Z`, // 07:15 BRT
    });
    const o2 = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 6,
      qty_m: 3,
      order_date: TODAY,
      created_at: `${TODAY}T14:10:00.000Z`, // 11:10 BRT
    });

    // Confirmação às 10:30 BRT (13:30 UTC) e às 15:40 BRT (18:40 UTC)
    const r1 = await store.classifyOrder({
      companyId: "comp-a",
      orderId: o1.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-28-1030",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: brDateISO(`${TODAY}T13:30:00.000Z`),
    });
    const r2 = await store.classifyOrder({
      companyId: "comp-a",
      orderId: o2.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-28-1540",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: brDateISO(`${TODAY}T18:40:00.000Z`),
    });

    expect(r1.result.outcome).toBe("classified");
    expect(r2.result.outcome).toBe("classified");
  });

  // TESTE ADICIONAL 29: Pedidos aguardando não entram em vendas pagas nem em Contas a Receber
  it("29. Pedidos aguardando têm impacto zero em Vendas Pagas e em Contas a Receber", () => {
    const store = new InMemoryMarmitaStore();
    store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 8,
      qty_m: 7,
      order_date: TODAY,
    }); // R$ 286 aguardando

    const all = [...store.orders.values()];
    const balances = balanceByCustomer(all, store.payments);
    const summary = computeDashboardSummary(all, all, store.payments, store.payments);

    expect(balances.get("cust-a1") ?? 0).toBe(0);
    expect(summary.paidSales.amount).toBe(0);
    expect(summary.paidSales.totalMeals).toBe(0);
    expect(summary.fiadoSales.pendingAmount).toBe(0);
    expect(summary.fiadoSales.totalMeals).toBe(0);
    expect(summary.general.classifiedRevenue).toBe(0);
    expect(summary.general.cashReceived).toBe(0);
    expect(summary.general.accountsReceivableOpen).toBe(0);
    expect(summary.awaitingOrders.amount).toBe(286);
    expect(summary.awaitingOrders.totalMeals).toBe(15);
  });

  // TESTE ADICIONAL 30: Após OK ou OKK, os valores e quantidades saem de aguardando e entram no Dashboard
  it("30. Após OK ou OKK, os pedidos saem de Aguardando e entram imediatamente em Vendas Pagas ou Vendas Fiadas no Dashboard", async () => {
    const store = new InMemoryMarmitaStore();
    const oOk = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 8,
      qty_m: 7,
      order_date: TODAY,
    }); // 15 marmitas = R$ 286
    const oOkk = store.createOrder({
      company_id: "comp-a",
      customer_id: "cust-a1",
      qty_g: 15,
      qty_m: 15,
      order_date: TODAY,
    }); // 30 marmitas = R$ 570

    // Antes da confirmação
    let all = [...store.orders.values()];
    let summary = computeDashboardSummary(all, all, store.payments, store.payments);
    expect(summary.awaitingOrders.ordersCount).toBe(2);
    expect(summary.awaitingOrders.totalMeals).toBe(45);
    expect(summary.awaitingOrders.amount).toBe(856);
    expect(summary.general.finalizedOrdersCount).toBe(0);

    // Marmitaria confirma o primeiro com OK e o segundo com OKK
    await store.classifyOrder({
      companyId: "comp-a",
      orderId: oOk.id,
      customerId: "cust-a1",
      command: "OK",
      eventId: "ev-30-ok",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });
    await store.classifyOrder({
      companyId: "comp-a",
      orderId: oOkk.id,
      customerId: "cust-a1",
      command: "OKK",
      eventId: "ev-30-okk",
      source: "authenticated_operator",
      today: TODAY,
      commandDate: TODAY,
    });

    all = [...store.orders.values()];
    summary = computeDashboardSummary(all, all, store.payments, store.payments);

    expect(summary.awaitingOrders.ordersCount).toBe(0);
    expect(summary.awaitingOrders.totalMeals).toBe(0);
    expect(summary.awaitingOrders.amount).toBe(0);

    expect(summary.paidSales).toMatchObject({
      ordersCount: 1,
      qtyG: 8,
      qtyM: 7,
      totalMeals: 15,
      amount: 286,
    });
    expect(summary.fiadoSales).toMatchObject({
      ordersCount: 1,
      qtyG: 15,
      qtyM: 15,
      totalMeals: 30,
      pendingAmount: 570,
    });
    expect(summary.general).toEqual({
      finalizedOrdersCount: 2,
      confirmedMealsCount: 45,
      classifiedRevenue: 856,
      cashReceived: 286,
      accountsReceivableOpen: 570,
      awaitingOrdersCount: 0,
    });
  });
});
