import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  balanceByCustomer,
  computeDashboardSummary,
  isAwaitingClassification,
  isConfirmedOrder,
  isConfirmedUnpaid,
  isFiadoOrder,
  isPaidOnSpotOrder,
  round2,
  type DashboardFinancialSummary,
  type FinancialFields,
} from "./financial-state";
import { isoDay, startOfMonthISO } from "./format";

export {
  balanceByCustomer,
  computeDashboardSummary,
  isAwaitingClassification,
  isConfirmedOrder,
  isConfirmedUnpaid,
  isFiadoOrder,
  isPaidOnSpotOrder,
  round2,
};

export type Customer = Database["public"]["Tables"]["customers"]["Row"];
export type Order = Database["public"]["Tables"]["orders"]["Row"] & FinancialFields;
export type Payment = Database["public"]["Tables"]["payments"]["Row"];
export type Company = Database["public"]["Tables"]["companies"]["Row"];
export type WhatsMessage = Database["public"]["Tables"]["whatsapp_messages"]["Row"] & {
  orders?: {
    total: number;
    financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null;
    paid?: boolean;
  } | null;
};
export type WhatsConnection = Database["public"]["Tables"]["whatsapp_connections"]["Row"];
export type OrderWithCustomer = Order & { customers: Pick<Customer, "name" | "phone"> | null };

export type OrderCursor = {
  order_date: string;
  created_at: string;
  id: string;
};

export type OrderQueryOptions = {
  companyId?: string;
  customerId?: string;
  fromDate?: string;
  toDate?: string;
  onlyUnpaid?: boolean;
  includeOpenFiado?: boolean;
  financialState?: "aguardando_classificacao" | "pago" | "fiado";
  deliveryStatus?: Order["delivery_status"] | Order["delivery_status"][];
  excludeCancelled?: boolean;
  cursor?: OrderCursor | null;
  pageSize?: number;
  page?: number;
  maxPages?: number;
};

export type PaymentCursor = {
  paid_at: string;
  id: string;
};

export type PaymentQueryOptions = {
  companyId?: string;
  customerId?: string;
  fromDate?: string;
  toDate?: string;
  cursor?: PaymentCursor | null;
  pageSize?: number;
  page?: number;
  maxPages?: number;
};

export type CustomerCursor = {
  name: string;
  id: string;
};

export type CustomerQueryOptions = {
  companyId?: string;
  customerIds?: string[];
  status?: Customer["status"] | Customer["status"][];
  search?: string;
  cursor?: CustomerCursor | null;
  pageSize?: number;
  page?: number;
  maxPages?: number;
  enabled?: boolean;
};

export type CustomerBalanceRow = {
  customer_id: string;
  open_orders_count: number;
  qty_p: number;
  qty_m: number;
  qty_g: number;
  total_meals: number;
  fiado_total: number;
  payments_total: number;
  balance: number;
};

export type AuthoritativeBalancesResult = {
  rows: CustomerBalanceRow[];
  balancesMap: Map<string, number>;
  totalOpenReceivable: number;
  totalCustomerCredit: number;
  source: "rpc" | "historical_ledger";
};

const PAGE = 1000;
export const DEFAULT_OPERATIONAL_PAGE_SIZE = 100;
export const MAX_CUSTOMER_IDS_CHUNK_SIZE = 100;

/**
 * CORREÇÃO AUD5-04:
 * Deduplica e divide um array de `customerIds` em lotes de no máximo 100 UUIDs
 * (`MAX_CUSTOMER_IDS_CHUNK_SIZE = 100`), impedindo que consultas PostgREST `.in("id", ...)`
 * gerem URLs excessivamente longas (`HTTP 414 URI Too Long`) quando uma marmitaria
 * possuir 300, 1.500, 5.000 ou 10.000+ clientes com saldo.
 */
export function chunkCustomerIds(
  ids: readonly string[],
  chunkSize: number = MAX_CUSTOMER_IDS_CHUNK_SIZE,
): string[][] {
  const safeSize = Math.min(Math.max(1, Math.trunc(chunkSize) || MAX_CUSTOMER_IDS_CHUNK_SIZE), MAX_CUSTOMER_IDS_CHUNK_SIZE);
  const uniqueIds: string[] = [];
  const seen = new Set<string>();

  for (const raw of ids) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueIds.push(trimmed);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += safeSize) {
    chunks.push(uniqueIds.slice(i, i + safeSize));
  }
  return chunks;
}

/**
 * CORREÇÃO AUD5-04:
 * Executa a busca de clientes por `customerIds` dividida em lotes controlados de no máximo
 * 100 UUIDs por requisição PostgREST:
 *   - Propaga imediatamente qualquer erro de qualquer lote (nunca retorna resultados parciais como completos);
 *   - Deduplica por `id` e preserva a ordenação determinística (`name ASC, id ASC`);
 *   - Preserva paginação opcional (`page`, `pageSize`, `maxPages`).
 */
export async function fetchCustomersByIdsChunked(
  options: CustomerQueryOptions & { supabaseClient?: SupabaseClient<Database> },
): Promise<{
  items: Customer[];
  chunksQueried: number;
  maxChunkSizeUsed: number;
}> {
  const client = options.supabaseClient ?? supabase;
  const chunks = chunkCustomerIds(options.customerIds ?? [], MAX_CUSTOMER_IDS_CHUNK_SIZE);
  if (chunks.length === 0) {
    return { items: [], chunksQueried: 0, maxChunkSizeUsed: 0 };
  }

  const deduped = new Map<string, Customer>();
  let maxChunkSizeUsed = 0;

  // Executa em janelas controladas de até 4 lotes simultâneos para não saturar conexões
  const CONCURRENCY = 4;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batchChunks = chunks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batchChunks.map(async (chunk) => {
        if (chunk.length > maxChunkSizeUsed) {
          maxChunkSizeUsed = chunk.length;
        }
        let q = client.from("customers").select("*");
        if (options.companyId) {
          q = q.eq("company_id", options.companyId);
        }
        q = q.in("id", chunk);
        if (options.status) {
          if (Array.isArray(options.status)) {
            q = q.in("status", options.status);
          } else {
            q = q.eq("status", options.status);
          }
        }
        if (options.search?.trim()) {
          q = q.ilike("name", `%${options.search.trim()}%`);
        }
        const res = await q
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(0, chunk.length - 1);
        if (res.error) {
          throw res.error;
        }
        return (res.data ?? []) as Customer[];
      }),
    );

    for (const rows of batchResults) {
      for (const c of rows) {
        deduped.set(c.id, c);
      }
    }
  }

  const sorted = Array.from(deduped.values()).sort((a, b) => {
    const cmp = (a.name ?? "").localeCompare(b.name ?? "");
    if (cmp !== 0) return cmp;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  if (typeof options.page === "number" && options.page >= 0 && typeof options.pageSize === "number") {
    const start = options.page * options.pageSize;
    return {
      items: sorted.slice(start, start + options.pageSize),
      chunksQueried: chunks.length,
      maxChunkSizeUsed,
    };
  }

  if (typeof options.maxPages === "number" && Number.isFinite(options.maxPages) && typeof options.pageSize === "number") {
    const limitTotal = options.maxPages * options.pageSize;
    return {
      items: sorted.slice(0, limitTotal),
      chunksQueried: chunks.length,
      maxChunkSizeUsed,
    };
  }

  return {
    items: sorted,
    chunksQueried: chunks.length,
    maxChunkSizeUsed,
  };
}

/**
 * Paginação determinística em blocos com desempate por `id` único.
 * Nunca perde nem duplica registros entre páginas, respeitando `page`/`pageSize`
 * ou `maxPages` quando informado.
 */
export async function fetchAll<T>(
  pageFn: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  options?: { pageSize?: number; page?: number; maxPages?: number },
): Promise<T[]> {
  const pageSize = Math.min(Math.max(1, options?.pageSize ?? PAGE), PAGE);
  if (typeof options?.page === "number" && options.page >= 0) {
    const start = options.page * pageSize;
    const { data, error } = await pageFn(start, start + pageSize - 1);
    if (error) throw error;
    return data ?? [];
  }

  const maxPages = options?.maxPages ?? Number.POSITIVE_INFINITY;
  const out: T[] = [];
  let pagesFetched = 0;

  for (let from = 0; pagesFetched < maxPages; from += pageSize) {
    const { data, error } = await pageFn(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    pagesFetched++;
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * CORREÇÃO AUD-08:
 * Filtros compostos PostgREST e funções de paginação por cursor real (Keyset / Seek Pagination)
 * executadas no PostgreSQL via RPC (`list_orders_cursor`, `list_payments_cursor`,
 * `list_customers_cursor`) ou via cláusula `.or(...)` com índice composto determinístico.
 */
export function buildOrdersKeysetOrFilter(cursor: OrderCursor): string {
  return [
    `order_date.lt.${cursor.order_date}`,
    `and(order_date.eq.${cursor.order_date},created_at.lt.${cursor.created_at})`,
    `and(order_date.eq.${cursor.order_date},created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
  ].join(",");
}

export function buildPaymentsKeysetOrFilter(cursor: PaymentCursor): string {
  return [
    `paid_at.lt.${cursor.paid_at}`,
    `and(paid_at.eq.${cursor.paid_at},id.lt.${cursor.id})`,
  ].join(",");
}

export function buildCustomersKeysetOrFilter(cursor: CustomerCursor): string {
  const escapedName = cursor.name.replace(/"/g, '\\"');
  return [
    `name.gt."${escapedName}"`,
    `and(name.eq."${escapedName}",id.gt.${cursor.id})`,
  ].join(",");
}

export function filterOrderAfterCursor<
  T extends { order_date: string; created_at: string; id: string },
>(
  rows: readonly T[],
  cursor: OrderCursor | null | undefined,
  pageSize: number,
): { items: T[]; nextCursor: OrderCursor | null } {
  const filtered = !cursor
    ? [...rows]
    : rows.filter((r) => {
        if (r.order_date !== cursor.order_date) {
          return r.order_date < cursor.order_date;
        }
        if (r.created_at !== cursor.created_at) {
          return r.created_at < cursor.created_at;
        }
        return r.id < cursor.id;
      });

  const items = filtered.slice(0, pageSize);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === pageSize && last
      ? { order_date: last.order_date, created_at: last.created_at, id: last.id }
      : null;
  return { items, nextCursor };
}

export function filterPaymentAfterCursor<T extends { paid_at: string; id: string }>(
  rows: readonly T[],
  cursor: PaymentCursor | null | undefined,
  pageSize: number,
): { items: T[]; nextCursor: PaymentCursor | null } {
  const filtered = !cursor
    ? [...rows]
    : rows.filter((r) => {
        if (r.paid_at !== cursor.paid_at) {
          return r.paid_at < cursor.paid_at;
        }
        return r.id < cursor.id;
      });

  const items = filtered.slice(0, pageSize);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === pageSize && last ? { paid_at: last.paid_at, id: last.id } : null;
  return { items, nextCursor };
}

export function filterCustomerAfterCursor<T extends { name: string; id: string }>(
  rows: readonly T[],
  cursor: CustomerCursor | null | undefined,
  pageSize: number,
): { items: T[]; nextCursor: CustomerCursor | null } {
  const filtered = !cursor
    ? [...rows]
    : rows.filter((r) => {
        const cmp = r.name.localeCompare(cursor.name);
        if (cmp !== 0) return cmp > 0;
        return r.id > cursor.id;
      });

  const items = filtered.slice(0, pageSize);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === pageSize && last ? { name: last.name, id: last.id } : null;
  return { items, nextCursor };
}

/**
 * CORREÇÃO AUD-08:
 * Executa paginação por cursor real no PostgreSQL para `orders` (usando a RPC
 * `list_orders_cursor` ou PostgREST `.or(buildOrdersKeysetOrFilter(cursor))`),
 * sem carregar a tabela inteira para a memória da aplicação.
 */
export async function fetchOrdersCursorPage(
  options?: OrderQueryOptions & { supabaseClient?: SupabaseClient<Database> },
): Promise<{
  items: OrderWithCustomer[];
  nextCursor: OrderCursor | null;
  keysetFilter: string | null;
  usedRpc: boolean;
}> {
  const client = options?.supabaseClient ?? supabase;
  const pageSize = Math.min(Math.max(1, options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE), PAGE);
  const cursor = options?.cursor ?? null;
  const keysetFilter = cursor ? buildOrdersKeysetOrFilter(cursor) : null;

  const maybeRpc = (
    client as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: OrderWithCustomer[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (
    typeof maybeRpc === "function" &&
    !options?.financialState &&
    !options?.deliveryStatus &&
    !options?.customerId
  ) {
    try {
      const rpcRes = await maybeRpc.call(client, "list_orders_cursor", {
        _company_id: options?.companyId ?? null,
        _from_date: options?.fromDate ?? null,
        _to_date: options?.toDate ?? null,
        _only_unpaid: options?.onlyUnpaid ?? false,
        _cursor_order_date: cursor?.order_date ?? null,
        _cursor_created_at: cursor?.created_at ?? null,
        _cursor_id: cursor?.id ?? null,
        _page_size: pageSize,
      });
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        const items = rpcRes.data.slice(0, pageSize);
        const last = items[items.length - 1];
        const nextCursor =
          items.length === pageSize && last
            ? { order_date: last.order_date, created_at: last.created_at, id: last.id }
            : null;
        return { items, nextCursor, keysetFilter, usedRpc: true };
      }
    } catch {
      // Fallback para consulta PostgREST indexada com cláusula .or(...)
    }
  }

  let q = client.from("orders").select("*, customers(name, phone)");
  if (options?.companyId) q = q.eq("company_id", options.companyId);
  if (options?.customerId) q = q.eq("customer_id", options.customerId);
  if (options?.fromDate) q = q.gte("order_date", options.fromDate);
  if (options?.toDate) q = q.lte("order_date", options.toDate);
  if (options?.onlyUnpaid) q = q.eq("paid", false).neq("delivery_status", "cancelado");
  if (options?.excludeCancelled) q = q.neq("delivery_status", "cancelado");
  if (options?.financialState) q = q.eq("financial_state", options.financialState);
  if (options?.deliveryStatus) {
    if (Array.isArray(options.deliveryStatus)) {
      q = q.in("delivery_status", options.deliveryStatus);
    } else {
      q = q.eq("delivery_status", options.deliveryStatus);
    }
  }
  if (keysetFilter && typeof (q as { or?: (f: string) => typeof q }).or === "function") {
    q = (q as { or: (f: string) => typeof q }).or(keysetFilter);
  }

  const { data, error } = await q
    .order("order_date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize);
  if (error) throw error;

  const items = ((data ?? []) as OrderWithCustomer[]).slice(0, pageSize);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === pageSize && last
      ? { order_date: last.order_date, created_at: last.created_at, id: last.id }
      : null;

  return { items, nextCursor, keysetFilter, usedRpc: false };
}

/**
 * CORREÇÃO AUD-08:
 * Executa paginação por cursor real no PostgreSQL para `payments` (usando a RPC
 * `list_payments_cursor` ou PostgREST `.or(buildPaymentsKeysetOrFilter(cursor))`).
 */
export async function fetchPaymentsCursorPage(
  options?: PaymentQueryOptions & { supabaseClient?: SupabaseClient<Database> },
): Promise<{
  items: (Payment & { customers: { name: string } | null })[];
  nextCursor: PaymentCursor | null;
  keysetFilter: string | null;
  usedRpc: boolean;
}> {
  const client = options?.supabaseClient ?? supabase;
  const pageSize = Math.min(Math.max(1, options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE), PAGE);
  const cursor = options?.cursor ?? null;
  const keysetFilter = cursor ? buildPaymentsKeysetOrFilter(cursor) : null;

  const maybeRpc = (
    client as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: (Payment & { customers: { name: string } | null })[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    try {
      const rpcRes = await maybeRpc.call(client, "list_payments_cursor", {
        _company_id: options?.companyId ?? null,
        _customer_id: options?.customerId ?? null,
        _from_paid_at: options?.fromDate ? `${options.fromDate}T00:00:00-03:00` : null,
        _to_paid_at: options?.toDate ? `${options.toDate}T23:59:59.999-03:00` : null,
        _cursor_paid_at: cursor?.paid_at ?? null,
        _cursor_id: cursor?.id ?? null,
        _page_size: pageSize,
      });
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        const items = rpcRes.data.slice(0, pageSize);
        const last = items[items.length - 1];
        const nextCursor =
          items.length === pageSize && last ? { paid_at: last.paid_at, id: last.id } : null;
        return { items, nextCursor, keysetFilter, usedRpc: true };
      }
    } catch {
      // Fallback para consulta PostgREST indexada com cláusula .or(...)
    }
  }

  let q = client.from("payments").select("*, customers(name)");
  if (options?.companyId) q = q.eq("company_id", options.companyId);
  if (options?.customerId) q = q.eq("customer_id", options.customerId);
  if (options?.fromDate) q = q.gte("paid_at", `${options.fromDate}T00:00:00-03:00`);
  if (options?.toDate) q = q.lte("paid_at", `${options.toDate}T23:59:59.999-03:00`);
  if (keysetFilter && typeof (q as { or?: (f: string) => typeof q }).or === "function") {
    q = (q as { or: (f: string) => typeof q }).or(keysetFilter);
  }

  const { data, error } = await q
    .order("paid_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize);
  if (error) throw error;

  const items = ((data ?? []) as (Payment & { customers: { name: string } | null })[]).slice(
    0,
    pageSize,
  );
  const last = items[items.length - 1];
  const nextCursor =
    items.length === pageSize && last ? { paid_at: last.paid_at, id: last.id } : null;

  return { items, nextCursor, keysetFilter, usedRpc: false };
}

/**
 * CORREÇÃO AUD-08:
 * Executa paginação por cursor real no PostgreSQL para `customers` (usando a RPC
 * `list_customers_cursor` ou PostgREST `.or(buildCustomersKeysetOrFilter(cursor))`).
 */
export async function fetchCustomersCursorPage(
  options?: CustomerQueryOptions & { supabaseClient?: SupabaseClient<Database> },
): Promise<{
  items: Customer[];
  nextCursor: CustomerCursor | null;
  keysetFilter: string | null;
  usedRpc: boolean;
}> {
  const client = options?.supabaseClient ?? supabase;
  const pageSize = Math.min(Math.max(1, options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE), PAGE);
  const cursor = options?.cursor ?? null;
  const keysetFilter = cursor ? buildCustomersKeysetOrFilter(cursor) : null;
  const statuses = options?.status
    ? Array.isArray(options.status)
      ? options.status
      : [options.status]
    : null;

  const maybeRpc = (
    client as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: Customer[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    try {
      const rpcRes = await maybeRpc.call(client, "list_customers_cursor", {
        _company_id: options?.companyId ?? null,
        _statuses: statuses,
        _search: options?.search?.trim() || null,
        _cursor_name: cursor?.name ?? null,
        _cursor_id: cursor?.id ?? null,
        _page_size: pageSize,
      });
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        const items = rpcRes.data.slice(0, pageSize);
        const last = items[items.length - 1];
        const nextCursor =
          items.length === pageSize && last ? { name: last.name, id: last.id } : null;
        return { items, nextCursor, keysetFilter, usedRpc: true };
      }
    } catch {
      // Fallback para consulta PostgREST indexada com cláusula .or(...)
    }
  }

  let q = client.from("customers").select("*");
  if (options?.companyId) q = q.eq("company_id", options.companyId);
  if (statuses) q = q.in("status", statuses);
  if (options?.search?.trim()) q = q.ilike("name", `%${options.search.trim()}%`);
  if (keysetFilter && typeof (q as { or?: (f: string) => typeof q }).or === "function") {
    q = (q as { or: (f: string) => typeof q }).or(keysetFilter);
  }

  const { data, error } = await q
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(pageSize);
  if (error) throw error;

  const items = ((data ?? []) as Customer[]).slice(0, pageSize);
  const last = items[items.length - 1];
  const nextCursor =
    items.length === pageSize && last ? { name: last.name, id: last.id } : null;

  return { items, nextCursor, keysetFilter, usedRpc: false };
}

/**
 * CORREÇÃO AUD-06 & AUD-07:
 * Obtém o mapa autoritativo de saldos por cliente (`get_customer_balances` no PostgreSQL),
 * com fallback exato que consulta o razão completo de fiado + TODOS os pagamentos históricos
 * (nunca calculando saldo a partir de pagamentos filtrados por data!).
 */
export async function fetchAuthoritativeCustomerBalances(
  companyId?: string,
  client: SupabaseClient<Database> = supabase,
): Promise<AuthoritativeBalancesResult> {
  const maybeRpc = (
    client as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: CustomerBalanceRow[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    try {
      const res = await maybeRpc.call(client, "get_customer_balances", {
        _company_id: companyId ?? null,
      });
      if (!res.error && Array.isArray(res.data)) {
        const balancesMap = new Map<string, number>();
        let totalOpenReceivable = 0;
        let totalCustomerCredit = 0;
        for (const row of res.data) {
          const bal = round2(Number(row.balance));
          balancesMap.set(row.customer_id, bal);
          if (bal > 0.009) {
            totalOpenReceivable = round2(totalOpenReceivable + bal);
          } else if (bal < -0.009) {
            totalCustomerCredit = round2(totalCustomerCredit + Math.abs(bal));
          }
        }
        return {
          rows: res.data,
          balancesMap,
          totalOpenReceivable,
          totalCustomerCredit,
          source: "rpc",
        };
      }
    } catch {
      // Fallback para razão contábil completo caso a RPC não esteja disponível
    }
  }

  const allFiadoOrders = await fetchAll<Order>(
    (a, b) => {
      let q = client
        .from("orders")
        .select("*")
        .neq("delivery_status", "cancelado");
      if (companyId) q = q.eq("company_id", companyId);
      return q
        .order("order_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(a, b);
    },
    { pageSize: PAGE },
  );

  const allHistoricalPayments = await fetchAll<Payment>(
    (a, b) => {
      let q = client.from("payments").select("*");
      if (companyId) q = q.eq("company_id", companyId);
      return q
        .order("paid_at", { ascending: false })
        .order("id", { ascending: false })
        .range(a, b);
    },
    { pageSize: PAGE },
  );

  return computeAuthoritativeBalancesFromLedger(allFiadoOrders, allHistoricalPayments);
}

/**
 * Constrói o resultado autoritativo de saldos a partir do livro-razão completo
 * (todos os pedidos e todos os pagamentos históricos, sem filtro de data em pagamentos).
 */
export function computeAuthoritativeBalancesFromLedger(
  allOrders: readonly {
    customer_id: string;
    total: number | string;
    paid: boolean;
    settled_by_payment?: boolean | null;
    delivery_status: string;
    financial_state?: "aguardando_classificacao" | "pago" | "fiado" | null;
    qty_p?: number | null;
    qty_m?: number | null;
    qty_g?: number | null;
    quantity?: number | null;
  }[],
  allHistoricalPayments: readonly {
    customer_id: string;
    amount: number | string;
  }[],
): AuthoritativeBalancesResult {
  const balancesMap = balanceByCustomer(allOrders, allHistoricalPayments);
  const perCustOrders = new Map<
    string,
    {
      open_orders_count: number;
      qty_p: number;
      qty_m: number;
      qty_g: number;
      total_meals: number;
      fiado_total: number;
    }
  >();
  const perCustPayments = new Map<string, number>();

  for (const o of allOrders) {
    if (o.delivery_status === "cancelado" || isAwaitingClassification(o)) continue;
    const cur = perCustOrders.get(o.customer_id) ?? {
      open_orders_count: 0,
      qty_p: 0,
      qty_m: 0,
      qty_g: 0,
      total_meals: 0,
      fiado_total: 0,
    };
    if (!o.paid) {
      cur.open_orders_count += 1;
      cur.qty_p += o.qty_p ?? 0;
      cur.qty_m += o.qty_m ?? 0;
      cur.qty_g += o.qty_g ?? 0;
      cur.total_meals += o.quantity ?? (o.qty_p ?? 0) + (o.qty_m ?? 0) + (o.qty_g ?? 0);
    }
    if (isFiadoOrder(o)) {
      cur.fiado_total = round2(cur.fiado_total + Number(o.total));
    }
    perCustOrders.set(o.customer_id, cur);
  }

  for (const p of allHistoricalPayments) {
    perCustPayments.set(
      p.customer_id,
      round2((perCustPayments.get(p.customer_id) ?? 0) + Number(p.amount)),
    );
  }

  const allCustomerIds = new Set<string>([
    ...balancesMap.keys(),
    ...perCustOrders.keys(),
    ...perCustPayments.keys(),
  ]);

  const rows: CustomerBalanceRow[] = [];
  let totalOpenReceivable = 0;
  let totalCustomerCredit = 0;

  for (const cid of allCustomerIds) {
    const oa = perCustOrders.get(cid);
    const payTotal = perCustPayments.get(cid) ?? 0;
    const bal = round2(balancesMap.get(cid) ?? 0);
    if (Math.abs(bal) > 0.009 || (oa?.open_orders_count ?? 0) > 0) {
      rows.push({
        customer_id: cid,
        open_orders_count: oa?.open_orders_count ?? 0,
        qty_p: oa?.qty_p ?? 0,
        qty_m: oa?.qty_m ?? 0,
        qty_g: oa?.qty_g ?? 0,
        total_meals: oa?.total_meals ?? 0,
        fiado_total: oa?.fiado_total ?? 0,
        payments_total: payTotal,
        balance: bal,
      });
    }
    if (bal > 0.009) {
      totalOpenReceivable = round2(totalOpenReceivable + bal);
    } else if (bal < -0.009) {
      totalCustomerCredit = round2(totalCustomerCredit + Math.abs(bal));
    }
  }

  return {
    rows,
    balancesMap,
    totalOpenReceivable,
    totalCustomerCredit,
    source: "historical_ledger",
  };
}

/**
 * CORREÇÃO AUD-06:
 * Reconcilia `DashboardFinancialSummary` com o saldo autoritativo por cliente,
 * garantindo que TANTO `general.accountsReceivableOpen` QUANTO `fiadoSales.pendingAmount`
 * reflitam exatamente o mesmo saldo devedor líquido (abatendo todos os pagamentos
 * parciais históricos e de hoje).
 */
export function reconcileDashboardSummaryWithBalances(
  baseSummary: DashboardFinancialSummary,
  authoritativeOpenReceivable: number,
): DashboardFinancialSummary {
  const openTotal = round2(Math.max(0, Number(authoritativeOpenReceivable) || 0));
  return {
    ...baseSummary,
    general: {
      ...baseSummary.general,
      accountsReceivableOpen: openTotal,
    },
    fiadoSales: {
      ...baseSummary.fiadoSales,
      pendingAmount: openTotal,
    },
  };
}

export function useCustomerBalances(companyId?: string) {
  return useQuery({
    queryKey: ["customer_balances_authoritative", companyId ?? "current"],
    queryFn: async (): Promise<AuthoritativeBalancesResult> => {
      return await fetchAuthoritativeCustomerBalances(companyId, supabase);
    },
  });
}

export function useCompany() {
  return useQuery({
    queryKey: ["company"],
    queryFn: async (): Promise<Company | null> => {
      const { data, error } = await supabase.from("companies").select("*").limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useWhatsAppConnection(companyId?: string) {
  return useQuery({
    queryKey: ["whatsapp_connection", companyId ?? "current"],
    enabled: Boolean(companyId),
    queryFn: async (): Promise<Pick<
      WhatsConnection,
      "id" | "phone_number_id" | "whatsapp_business_account_id" | "status" | "display_phone_number"
    > | null> => {
      if (!companyId) return null;
      const { data, error } = await supabase
        .from("whatsapp_connections")
        .select("id, phone_number_id, whatsapp_business_account_id, status, display_phone_number")
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useCustomers(options?: CustomerQueryOptions) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: [
      "customers",
      options?.companyId ?? "current",
      options?.customerIds ?? "all_ids",
      options?.status ?? "all",
      options?.search ?? "",
      options?.cursor ?? null,
      options?.page ?? 0,
      options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE,
      options?.maxPages ?? 1,
    ],
    queryFn: async (): Promise<Customer[]> => {
      if (Array.isArray(options?.customerIds)) {
        if (options.customerIds.length === 0) {
          return [];
        }
        const chunkedRes = await fetchCustomersByIdsChunked(options);
        return chunkedRes.items;
      }
      if (options?.cursor) {
        const res = await fetchCustomersCursorPage(options);
        return res.items;
      }
      const pageSize = options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE;
      const maxPages = options?.maxPages ?? 1;
      const page = options?.page ?? (maxPages === 1 ? 0 : undefined);

      return await fetchAll(
        (a, b) => {
          let q = supabase.from("customers").select("*");
          if (options?.companyId) {
            q = q.eq("company_id", options.companyId);
          }
          if (options?.status) {
            if (Array.isArray(options.status)) {
              q = q.in("status", options.status);
            } else {
              q = q.eq("status", options.status);
            }
          }
          if (options?.search?.trim()) {
            q = q.ilike("name", `%${options.search.trim()}%`);
          }
          return q
            .order("name", { ascending: true })
            .order("id", { ascending: true })
            .range(a, b);
        },
        { pageSize, page, maxPages },
      );
    },
  });
}

export function useOrders(options?: OrderQueryOptions) {
  return useQuery({
    queryKey: [
      "orders",
      options?.companyId ?? "current",
      options?.customerId ?? "all",
      options?.fromDate ?? "",
      options?.toDate ?? "",
      options?.onlyUnpaid ?? false,
      options?.includeOpenFiado ?? false,
      options?.financialState ?? "all",
      options?.deliveryStatus ?? "all",
      options?.excludeCancelled ?? false,
      options?.cursor ?? null,
      options?.page ?? 0,
      options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE,
      options?.maxPages ?? 1,
    ],
    queryFn: async (): Promise<OrderWithCustomer[]> => {
      if (options?.cursor) {
        const res = await fetchOrdersCursorPage(options);
        return res.items;
      }

      const pageSize = options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE;
      const maxPages = options?.maxPages ?? 1;
      const page = options?.page ?? (maxPages === 1 ? 0 : undefined);

      const periodOrders = (await fetchAll(
        (a, b) => {
          let q = supabase.from("orders").select("*, customers(name, phone)");
          if (options?.companyId) {
            q = q.eq("company_id", options.companyId);
          }
          if (options?.customerId) {
            q = q.eq("customer_id", options.customerId);
          }
          if (options?.fromDate) {
            q = q.gte("order_date", options.fromDate);
          }
          if (options?.toDate) {
            q = q.lte("order_date", options.toDate);
          }
          if (options?.onlyUnpaid) {
            q = q.eq("paid", false).neq("delivery_status", "cancelado");
          }
          if (options?.excludeCancelled) {
            q = q.neq("delivery_status", "cancelado");
          }
          if (options?.financialState) {
            q = q.eq("financial_state", options.financialState);
          }
          if (options?.deliveryStatus) {
            if (Array.isArray(options.deliveryStatus)) {
              q = q.in("delivery_status", options.deliveryStatus);
            } else {
              q = q.eq("delivery_status", options.deliveryStatus);
            }
          }
          return q
            .order("order_date", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(a, b);
        },
        { pageSize, page, maxPages },
      )) as OrderWithCustomer[];

      if (options?.includeOpenFiado && options?.fromDate) {
        const olderUnpaid = (await fetchAll(
          (a, b) => {
            let q = supabase
              .from("orders")
              .select("*, customers(name, phone)")
              .eq("paid", false)
              .neq("delivery_status", "cancelado")
              .lt("order_date", options.fromDate!);
            if (options?.companyId) {
              q = q.eq("company_id", options.companyId);
            }
            return q
              .order("order_date", { ascending: false })
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .range(a, b);
          },
          { pageSize, maxPages },
        )) as OrderWithCustomer[];

        if (olderUnpaid.length > 0) {
          const seen = new Set(periodOrders.map((o) => o.id));
          for (const u of olderUnpaid) {
            if (!seen.has(u.id)) {
              periodOrders.push(u);
              seen.add(u.id);
            }
          }
        }
      }

      return periodOrders;
    },
  });
}

export function usePayments(options?: PaymentQueryOptions) {
  return useQuery({
    queryKey: [
      "payments",
      options?.companyId ?? "current",
      options?.customerId ?? "all",
      options?.fromDate ?? "",
      options?.toDate ?? "",
      options?.cursor ?? null,
      options?.page ?? 0,
      options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE,
      options?.maxPages ?? 1,
    ],
    queryFn: async (): Promise<(Payment & { customers: { name: string } | null })[]> => {
      if (options?.cursor) {
        const res = await fetchPaymentsCursorPage(options);
        return res.items;
      }

      const pageSize = options?.pageSize ?? DEFAULT_OPERATIONAL_PAGE_SIZE;
      const maxPages = options?.maxPages ?? 1;
      const page = options?.page ?? (maxPages === 1 ? 0 : undefined);

      return (await fetchAll(
        (a, b) => {
          let q = supabase.from("payments").select("*, customers(name)");
          if (options?.companyId) {
            q = q.eq("company_id", options.companyId);
          }
          if (options?.customerId) {
            q = q.eq("customer_id", options.customerId);
          }
          if (options?.fromDate) {
            q = q.gte("paid_at", `${options.fromDate}T00:00:00-03:00`);
          }
          if (options?.toDate) {
            q = q.lte("paid_at", `${options.toDate}T23:59:59.999-03:00`);
          }
          return q
            .order("paid_at", { ascending: false })
            .order("id", { ascending: false })
            .range(a, b);
        },
        { pageSize, page, maxPages },
      )) as (Payment & { customers: { name: string } | null })[];
    },
  });
}

/**
 * CORREÇÃO ARGON4-04 & AUD-06:
 * Consulta específica para o Dashboard (`painel.tsx`) que usa `useCustomerBalances`
 * como fonte única de verdade para os saldos de Contas a Receber e Vendas Fiadas Pendentes.
 */
export function useDashboardData(companyId?: string) {
  const today = isoDay();
  const sevenDaysAgo = isoDay(-6);
  const monthStart = startOfMonthISO();
  const windowStart = monthStart < sevenDaysAgo ? monthStart : sevenDaysAgo;

  const ordersQuery = useOrders({
    companyId,
    fromDate: windowStart,
    toDate: today,
    includeOpenFiado: true,
    pageSize: 500,
    maxPages: 5,
  });

  const todayPaymentsQuery = usePayments({
    companyId,
    fromDate: today,
    toDate: today,
    pageSize: 200,
    maxPages: 2,
  });

  const pendingCustomersQuery = useCustomers({
    companyId,
    status: ["pendente", "atrasado"],
    pageSize: 200,
    maxPages: 2,
  });

  const balancesQuery = useCustomerBalances(companyId);

  return {
    orders: ordersQuery.data ?? [],
    todayPayments: todayPaymentsQuery.data ?? [],
    pendingCustomers: pendingCustomersQuery.data ?? [],
    authoritativeBalances: balancesQuery.data ?? null,
    rpcBalances: balancesQuery.data?.rows ?? null,
    isLoading:
      ordersQuery.isLoading || todayPaymentsQuery.isLoading || balancesQuery.isLoading,
  };
}

export function useMessages() {
  return useQuery({
    queryKey: ["messages"],
    queryFn: async (): Promise<WhatsMessage[]> => {
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("*, orders(total, financial_state, paid)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) {
        const fallback = await supabase
          .from("whatsapp_messages")
          .select("*, orders(total, paid)")
          .order("created_at", { ascending: false })
          .limit(100);
        if (fallback.error) throw fallback.error;
        return (fallback.data ?? []) as WhatsMessage[];
      }
      return (data ?? []) as WhatsMessage[];
    },
  });
}

export function whatsappLink(phone: string, text: string) {
  const digits = phone.replace(/\D/g, "");
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}
