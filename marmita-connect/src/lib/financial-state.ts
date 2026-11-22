/** Optional fields keep the current, unmigrated database fully compatible. */
export type FinancialFields = {
  financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null;
  financial_conversation_id?: string | null;
  financial_phone?: string | null;
  financial_creation_event?: string | null;
};

export type BalanceOrder = FinancialFields & {
  customer_id: string;
  delivery_status: string;
  paid: boolean;
  settled_by_payment?: boolean;
  total: number | string;
  qty_g?: number | null;
  qty_m?: number | null;
  qty_p?: number | null;
  quantity?: number;
  order_date?: string;
};

export const isAwaitingClassification = (order: FinancialFields) =>
  order.financial_state === "aguardando_classificacao";

export const isConfirmedOrder = (order: BalanceOrder) =>
  order.delivery_status !== "cancelado" && !isAwaitingClassification(order);

export const isPaidOnSpotOrder = (order: BalanceOrder) =>
  isConfirmedOrder(order) &&
  (order.financial_state === "pago" ||
    (order.financial_state == null && order.paid && !order.settled_by_payment));

export const isFiadoOrder = (order: BalanceOrder) =>
  isConfirmedOrder(order) &&
  (order.financial_state === "fiado" ||
    (order.financial_state == null && (!order.paid || Boolean(order.settled_by_payment))));

export const isConfirmedUnpaid = (order: BalanceOrder) =>
  !isAwaitingClassification(order) && !order.paid && order.delivery_status !== "cancelado";

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Historical debt formula is unchanged; only explicit pending rows are excluded. */
export function balanceByCustomer(
  orders: readonly BalanceOrder[],
  payments: readonly { customer_id: string; amount: number | string }[] = [],
) {
  const balances = new Map<string, number>();
  const add = (id: string, amount: number) =>
    balances.set(id, round2((balances.get(id) ?? 0) + amount));
  for (const order of orders) {
    if (order.delivery_status === "cancelado" || isAwaitingClassification(order)) continue;
    if (!order.paid || order.settled_by_payment) add(order.customer_id, Number(order.total));
  }
  for (const payment of payments) add(payment.customer_id, -Number(payment.amount));
  return balances;
}

export type CategoryBreakdown = {
  ordersCount: number;
  qtyG: number;
  qtyM: number;
  qtyP: number;
  totalMeals: number;
  amount: number;
};

export type DashboardFinancialSummary = {
  /** Vendas pagas na hora (OK) */
  paidSales: CategoryBreakdown;
  /** Vendas fiadas (OKK): inclui quantidades vendidas no fiado e saldo pendente de recebimento */
  fiadoSales: CategoryBreakdown & {
    /** Valor total original vendido como fiado no período */
    invoicedAmount: number;
    /** Valor pendente de recebimento (em aberto) */
    pendingAmount: number;
  };
  /** Pedidos aguardando confirmação (OK / OKK) — isolados de receitas e dívidas */
  awaitingOrders: CategoryBreakdown;
  /** Indicadores gerais consolidados */
  general: {
    finalizedOrdersCount: number;
    confirmedMealsCount: number;
    classifiedRevenue: number;
    cashReceived: number;
    accountsReceivableOpen: number;
    awaitingOrdersCount: number;
  };
};

function sumCategory(rows: readonly BalanceOrder[]): CategoryBreakdown {
  let qtyG = 0;
  let qtyM = 0;
  let qtyP = 0;
  let totalMeals = 0;
  let amount = 0;
  for (const o of rows) {
    const g = o.qty_g ?? 0;
    const m = o.qty_m ?? 0;
    const p = o.qty_p ?? 0;
    const q = o.quantity ?? g + m + p;
    qtyG += g;
    qtyM += m;
    qtyP += p;
    totalMeals += q;
    amount = round2(amount + Number(o.total));
  }
  return {
    ordersCount: rows.length,
    qtyG,
    qtyM,
    qtyP,
    totalMeals,
    amount,
  };
}

/**
 * Calcula os indicadores do Dashboard e Relatórios separando estritamente:
 * - Vendas Pagas (OK)
 * - Vendas Fiadas (OKK)
 * - Pedidos Aguardando Confirmação (aguardando_classificacao)
 * - Indicadores Gerais (onde recebimentos posteriores no Fiado aumentam o valor recebido
 *   e reduzem Contas a Receber sem duplicar vendas ou quantidades de marmitas).
 */
export function computeDashboardSummary(
  periodOrders: readonly BalanceOrder[],
  allOrders: readonly BalanceOrder[],
  allPayments: readonly { customer_id: string; amount: number | string; paid_at?: string }[] = [],
  periodPayments: readonly { customer_id: string; amount: number | string }[] = allPayments,
): DashboardFinancialSummary {
  const activePeriod = periodOrders.filter((o) => o.delivery_status !== "cancelado");

  const awaitingList = activePeriod.filter((o) => isAwaitingClassification(o));
  const paidOnSpotList = activePeriod.filter((o) => isPaidOnSpotOrder(o));
  const fiadoList = activePeriod.filter((o) => isFiadoOrder(o));

  const awaitingOrders = sumCategory(awaitingList);
  const paidOnSpot = sumCategory(paidOnSpotList);
  const fiadoBase = sumCategory(fiadoList);

  const periodPaymentsTotal = round2(
    periodPayments.reduce((acc, p) => acc + Number(p.amount), 0),
  );

  // Valor efetivamente recebido no período = vendas pagas na hora (OK) + recebimentos de fiado no período
  const cashReceived = round2(paidOnSpot.amount + periodPaymentsTotal);

  // Saldo em aberto em Contas a Receber global (todos os pedidos fiados menos pagamentos)
  const balances = balanceByCustomer(allOrders, allPayments);
  let accountsReceivableOpen = 0;
  for (const val of balances.values()) {
    if (val > 0.009) {
      accountsReceivableOpen = round2(accountsReceivableOpen + val);
    }
  }

  // Valor pendente de recebimento dos pedidos fiados do período:
  // Se o período for o histórico/dia atual, reflete o saldo ainda não pago daqueles pedidos
  const unpaidFiadoPeriod = round2(
    fiadoList.filter((o) => !o.paid).reduce((acc, o) => acc + Number(o.total), 0),
  );
  // Se houver pagamento parcial que ainda não baixou um pedido inteiro no FIFO, o saldo global
  // de Contas a Receber é menor que a soma bruta de pedidos não pagos: usamos o mínimo seguro
  // quando os conjuntos coincidem, ou o saldo real em aberto.
  const fiadoPendingAmount =
    periodOrders === allOrders ? accountsReceivableOpen : Math.min(unpaidFiadoPeriod, accountsReceivableOpen || unpaidFiadoPeriod);

  const finalizedOrdersCount = paidOnSpot.ordersCount + fiadoBase.ordersCount;
  const confirmedMealsCount = paidOnSpot.totalMeals + fiadoBase.totalMeals;
  const classifiedRevenue = round2(paidOnSpot.amount + fiadoBase.amount);

  return {
    paidSales: {
      ...paidOnSpot,
      amount: cashReceived,
    },
    fiadoSales: {
      ...fiadoBase,
      amount: fiadoPendingAmount,
      invoicedAmount: fiadoBase.amount,
      pendingAmount: fiadoPendingAmount,
    },
    awaitingOrders,
    general: {
      finalizedOrdersCount,
      confirmedMealsCount,
      classifiedRevenue,
      cashReceived,
      accountsReceivableOpen,
      awaitingOrdersCount: awaitingOrders.ordersCount,
    },
  };
}
