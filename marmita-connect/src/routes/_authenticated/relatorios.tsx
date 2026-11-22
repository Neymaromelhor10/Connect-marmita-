import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import {
  useCompany,
  useOrders,
  useCustomers,
  usePayments,
  useCustomerBalances,
  isAwaitingClassification,
  isConfirmedOrder,
  isConfirmedUnpaid,
  type Customer,
} from "@/lib/queries";
import {
  brDateISO,
  brl,
  downloadCsv,
  formatSizes,
  fullDate,
  isoDay,
  startOfMonthISO,
  startOfWeekISO,
} from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/relatorios")({
  head: () => ({
    meta: [
      { title: "Relatórios · Verde&Mesa" },
      {
        name: "description",
        content: "Relatórios de faturamento confirmado, clientes que mais compram e exportação em CSV.",
      },
      { property: "og:title", content: "Relatórios · Verde&Mesa" },
      { property: "og:description", content: "Faturamento por período e ranking de clientes." },
    ],
  }),
  component: Relatorios,
});

function Relatorios() {
  const { data: company } = useCompany();
  const [from, setFrom] = useState(startOfMonthISO());
  const [to, setTo] = useState(isoDay());

  const queryFrom = useMemo(() => {
    const w = startOfWeekISO();
    const m = startOfMonthISO();
    return [from, w, m].sort()[0]!;
  }, [from]);

  const queryTo = useMemo(() => {
    const t = isoDay();
    return to > t ? to : t;
  }, [to]);

  const { data: orders = [] } = useOrders({
    companyId: company?.id,
    fromDate: queryFrom,
    toDate: queryTo,
    includeOpenFiado: true,
    pageSize: 500,
    maxPages: 10,
  });

  // CORREÇÃO AUD-09 & AUD5-04:
  // Usa `useCustomerBalances` como fonte única de verdade para o saldo devedor e carrega
  // especificamente os `customerIds` dos clientes com saldo em aberto em lotes de até 100 UUIDs
  // (`fetchCustomersByIdsChunked`), garantindo que devedores além dos primeiros 5.000 nomes
  // alfabéticos jamais desapareçam dos relatórios mesmo em empresas com 10.000+ clientes.
  const { data: authoritativeBalances } = useCustomerBalances(company?.id);

  const balanceCustomerIds = useMemo(
    () =>
      authoritativeBalances?.rows
        ? authoritativeBalances.rows
            .filter((r) => Number(r.balance) > 0.009 || r.open_orders_count > 0)
            .map((r) => r.customer_id)
        : [],
    [authoritativeBalances?.rows],
  );

  const { data: pendingStatusCustomers = [] } = useCustomers({
    companyId: company?.id,
    status: ["pendente", "atrasado"],
    pageSize: 500,
    maxPages: 5,
    enabled: Boolean(company?.id),
  });

  const { data: balanceCustomers = [] } = useCustomers({
    companyId: company?.id,
    customerIds: balanceCustomerIds,
    enabled: Boolean(company?.id) && Boolean(authoritativeBalances),
  });

  const customers = useMemo(() => {
    const map = new Map<string, Customer>();
    for (const c of pendingStatusCustomers) {
      map.set(c.id, c);
    }
    for (const c of balanceCustomers) {
      map.set(c.id, c);
    }
    return Array.from(map.values());
  }, [pendingStatusCustomers, balanceCustomers]);

  const { data: payments = [] } = usePayments({
    companyId: company?.id,
    fromDate: queryFrom,
    toDate: queryTo,
    pageSize: 500,
    maxPages: 10,
  });

  // Todos os pedidos não cancelados no intervalo (para exportação CSV completa)
  const allRange = useMemo(
    () =>
      orders.filter(
        (o) => o.delivery_status !== "cancelado" && o.order_date >= from && o.order_date <= to,
      ),
    [orders, from, to],
  );

  // Somente pedidos confirmados (OK ou OKK) entram nos totais financeiros e ranking
  const confirmedRange = useMemo(
    () => allRange.filter((o) => isConfirmedOrder(o)),
    [allRange],
  );

  const paymentsInRange = useMemo(
    () =>
      payments.filter((p) => {
        const day = brDateISO(p.paid_at);
        return day >= from && day <= to;
      }),
    [payments, from, to],
  );

  const revenue = confirmedRange.reduce((a, o) => a + Number(o.total), 0);
  const meals = confirmedRange.reduce((a, o) => a + o.quantity, 0);
  const pRange = confirmedRange.reduce((a, o) => a + (o.qty_p ?? 0), 0);
  const mRange = confirmedRange.reduce((a, o) => a + (o.qty_m ?? 0), 0);
  const gRange = confirmedRange.reduce((a, o) => a + (o.qty_g ?? 0), 0);
  const paidOnSpotInRange = confirmedRange
    .filter((o) => o.paid && !o.settled_by_payment)
    .reduce((a, o) => a + Number(o.total), 0);
  const received = paidOnSpotInRange + paymentsInRange.reduce((a, p) => a + Number(p.amount), 0);

  const balances = useMemo(() => {
    if (authoritativeBalances) {
      return authoritativeBalances.balancesMap;
    }
    return new Map<string, number>();
  }, [authoritativeBalances]);

  const balanceRowByCustomer = useMemo(() => {
    const m = new Map<string, NonNullable<typeof authoritativeBalances>["rows"][number]>();
    for (const r of authoritativeBalances?.rows ?? []) {
      m.set(r.customer_id, r);
    }
    return m;
  }, [authoritativeBalances]);

  const confirmedActive = useMemo(
    () => orders.filter((o) => isConfirmedOrder(o)),
    [orders],
  );

  const periods = useMemo(() => {
    const today = isoDay();
    const week = startOfWeekISO();
    const month = startOfMonthISO();
    const agg = (list: typeof confirmedActive) => ({
      p: list.reduce((a, o) => a + (o.qty_p ?? 0), 0),
      m: list.reduce((a, o) => a + (o.qty_m ?? 0), 0),
      g: list.reduce((a, o) => a + (o.qty_g ?? 0), 0),
      qty: list.reduce((a, o) => a + o.quantity, 0),
      total: list.reduce((a, o) => a + Number(o.total), 0),
    });
    return [
      { label: "Hoje", ...agg(confirmedActive.filter((o) => o.order_date === today)) },
      { label: "Semana", ...agg(confirmedActive.filter((o) => o.order_date >= week)) },
      { label: "Mês", ...agg(confirmedActive.filter((o) => o.order_date >= month)) },
    ];
  }, [confirmedActive]);

  const [openCustomer, setOpenCustomer] = useState<string | null>(null);
  const fiado = useMemo(() => {
    return customers
      .map((c) => {
        const rows = orders.filter((o) => o.customer_id === c.id && isConfirmedUnpaid(o));
        const bRow = balanceRowByCustomer.get(c.id);
        const p = bRow ? Number(bRow.qty_p) : rows.reduce((a, o) => a + (o.qty_p ?? 0), 0);
        const m = bRow ? Number(bRow.qty_m) : rows.reduce((a, o) => a + (o.qty_m ?? 0), 0);
        const g = bRow ? Number(bRow.qty_g) : rows.reduce((a, o) => a + (o.qty_g ?? 0), 0);
        const qty = bRow ? Number(bRow.total_meals) : rows.reduce((a, o) => a + o.quantity, 0);
        return {
          c,
          p,
          m,
          g,
          qty,
          value: balances.get(c.id) ?? 0,
          rows,
        };
      })
      .filter((r) => r.value > 0.009 || r.qty > 0)
      .sort((a, b) => b.value - a.value);
  }, [customers, orders, balances, balanceRowByCustomer]);

  const ranking = useMemo(() => {
    const map = new Map<
      string,
      { name: string; qty: number; p: number; m: number; g: number; total: number }
    >();
    for (const o of confirmedRange) {
      const cur = map.get(o.customer_id) ?? {
        name: o.customers?.name ?? "Cliente",
        qty: 0,
        p: 0,
        m: 0,
        g: 0,
        total: 0,
      };
      cur.qty += o.quantity;
      cur.p += o.qty_p ?? 0;
      cur.m += o.qty_m ?? 0;
      cur.g += o.qty_g ?? 0;
      cur.total += Number(o.total);
      map.set(o.customer_id, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [confirmedRange]);

  function exportOrders() {
    downloadCsv(`pedidos_${from}_${to}.csv`, [
      ["Data", "Cliente", "P", "M", "G", "Qtd", "Unitário", "Total", "Entrega", "Pago", "Origem"],
      ...allRange.map((o) => [
        o.order_date,
        o.customers?.name ?? "",
        o.qty_p ?? 0,
        o.qty_m ?? 0,
        o.qty_g ?? 0,
        o.quantity,
        Number(o.unit_price).toFixed(2),
        Number(o.total).toFixed(2),
        o.delivery_status,
        isAwaitingClassification(o) ? "aguardando classificação" : o.paid ? "sim" : "não",
        o.source,
      ]),
    ]);
  }

  function exportDebts() {
    downloadCsv("fiado.csv", [
      ["Cliente", "Telefone", "P", "M", "G", "Marmitas", "Ciclo", "Status", "Saldo"],
      ...fiado.map((r) => [
        r.c.name,
        r.c.phone,
        r.p,
        r.m,
        r.g,
        r.qty,
        r.c.payment_cycle,
        r.c.status,
        r.value.toFixed(2),
      ]),
    ]);
  }

  return (
    <div className="space-y-5 px-4 pt-5 pb-8">
      <h1 className="font-display text-xl">Relatórios</h1>

      <section className="panel space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="report-from">De</Label>
            <Input
              id="report-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-to">Até</Label>
            <Input
              id="report-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
          <Metric label="Faturamento confirmado" value={brl(revenue)} />
          <Metric label="Marmitas confirmadas" value={`${meals} (${pRange}P/${mRange}M/${gRange}G)`} />
          <Metric label="Recebido" value={brl(received)} />
        </div>
        <div className="no-print grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Button variant="secondary" onClick={exportOrders}>
            <Download className="size-4" /> Pedidos CSV
          </Button>
          <Button variant="secondary" onClick={exportDebts}>
            <Download className="size-4" /> Fiado CSV
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="size-4" /> Imprimir / PDF
          </Button>
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl">Marmitas vendidas (confirmadas)</h2>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
          {periods.map((p) => (
            <div key={p.label} className="panel p-3.5">
              <div className="label-cap">{p.label}</div>
              <div className="mt-1 font-display text-2xl">{brl(p.total)}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {p.p} P · {p.m} M · {p.g} G · {p.qty} marmitas
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl">Fiado por cliente</h2>
        <div className="mt-3 space-y-2">
          {fiado.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">Ninguém no fiado.</p>
          )}
          {fiado.map((r) => (
            <div key={r.c.id} className="panel p-3">
              <button
                className="flex w-full items-center gap-3 text-left"
                onClick={() => setOpenCustomer(openCustomer === r.c.id ? null : r.c.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{r.c.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {r.p} P · {r.m} M · {r.g} G · {r.qty} marmitas
                  </div>
                </div>
                <span className="font-display text-[15px] text-accent">{brl(r.value)}</span>
              </button>
              {openCustomer === r.c.id && (
                <div className="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
                  {r.rows.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">Sem registros em aberto.</p>
                  )}
                  {r.rows.map((o) => (
                    <div key={o.id} className="flex items-center justify-between text-[12px]">
                      <span className="text-muted-foreground">
                        {fullDate(o.order_date + "T12:00:00")} ·{" "}
                        {formatSizes(o.qty_g, o.qty_m, o.qty_p, o.quantity)}
                      </span>
                      <span>{brl(Number(o.total))}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl">Clientes que mais compram</h2>
        <div className="mt-3 space-y-2">
          {ranking.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">Sem dados no período.</p>
          )}
          {ranking.map((r, i) => (
            <div key={r.name + i} className="panel flex items-center gap-3 p-3">
              <span className="font-display text-lg text-gilt">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{r.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {r.p} P · {r.m} M · {r.g} G · {r.qty} marmitas
                </div>
              </div>
              <span className="font-display text-[15px]">{brl(r.total)}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl">Recebimentos no período</h2>
        <div className="mt-3 space-y-2">
          {paymentsInRange.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">
              Nenhum recebimento no período.
            </p>
          )}
          {paymentsInRange.map((p) => (
            <div key={p.id} className="panel flex items-center justify-between p-3">
              <div>
                <div className="text-[13px] font-medium">{p.customers?.name ?? "Cliente"}</div>
                <div className="text-[11px] text-muted-foreground">{fullDate(p.paid_at)}</div>
              </div>
              <span className="font-display text-[15px] text-good">{brl(Number(p.amount))}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label-cap">{label}</div>
      <div className="mt-0.5 font-display text-lg">{value}</div>
    </div>
  );
}
