import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  Tooltip,
  Cell,
  CartesianGrid,
} from "recharts";
import { MessageCircle, Clock, CheckCircle2, Wallet } from "lucide-react";
import {
  useCompany,
  useDashboardData,
  computeDashboardSummary,
  reconcileDashboardSummaryWithBalances,
  isAwaitingClassification,
  isConfirmedOrder,
  round2,
  whatsappLink,
  type OrderWithCustomer,
} from "@/lib/queries";
import {
  brl,
  isoDay,
  startOfWeekISO,
  startOfMonthISO,
  deliveryLabel,
  cycleLabel,
  shortDate,
  formatSizes,
} from "@/lib/format";

export const Route = createFileRoute("/_authenticated/painel")({
  head: () => ({
    meta: [
      { title: "Painel · Verde&Mesa" },
      {
        name: "description",
        content:
          "Indicadores gerais, vendas pagas (OK), vendas fiadas (OKK) e pedidos aguardando confirmação.",
      },
      { property: "og:title", content: "Painel · Verde&Mesa" },
      { property: "og:description", content: "Resumo financeiro diário da sua marmitaria." },
    ],
  }),
  component: Painel,
});

const sum = (list: OrderWithCustomer[], f: (o: OrderWithCustomer) => number) =>
  list.reduce((acc, o) => acc + f(o), 0);

function Painel() {
  const { data: company } = useCompany();
  const {
    orders,
    todayPayments,
    pendingCustomers,
    authoritativeBalances,
    isLoading,
  } = useDashboardData(company?.id);

  const today = isoDay();
  const week = startOfWeekISO();
  const month = startOfMonthISO();

  const active = useMemo(
    () => orders.filter((o) => o.delivery_status !== "cancelado"),
    [orders],
  );
  const confirmedActive = useMemo(
    () => active.filter((o) => isConfirmedOrder(o)),
    [active],
  );

  const todayOrders = useMemo(
    () => active.filter((o) => o.order_date === today),
    [active, today],
  );

  // CORREÇÃO AUD-06: Fonte única de verdade para saldos por cliente (useCustomerBalances).
  // Nunca passa `todayPayments` como se fosse `allPayments`!
  const balances = useMemo(() => {
    if (authoritativeBalances) {
      return authoritativeBalances.balancesMap;
    }
    return new Map<string, number>();
  }, [authoritativeBalances]);

  const summary = useMemo(() => {
    const base = computeDashboardSummary(todayOrders, active, todayPayments, todayPayments);
    if (authoritativeBalances) {
      return reconcileDashboardSummaryWithBalances(
        base,
        authoritativeBalances.totalOpenReceivable,
      );
    }
    let openTotal = 0;
    for (const val of balances.values()) {
      if (val > 0.009) openTotal = round2(openTotal + val);
    }
    return reconcileDashboardSummaryWithBalances(base, openTotal);
  }, [todayOrders, active, todayPayments, authoritativeBalances, balances]);

  const weekConfirmed = useMemo(
    () => confirmedActive.filter((o) => o.order_date >= week),
    [confirmedActive, week],
  );
  const monthConfirmed = useMemo(
    () => confirmedActive.filter((o) => o.order_date >= month),
    [confirmedActive, month],
  );

  const debtors = pendingCustomers
    .map((c) => ({ customer: c, balance: balances.get(c.id) ?? 0 }))
    .filter((d) => d.balance > 0.009)
    .sort((a, b) => b.balance - a.balance);

  const chart = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => isoDay(i - 6));
    return days.map((d) => ({
      dia: shortDate(d + "T12:00:00"),
      iso: d,
      valor: sum(
        confirmedActive.filter((o) => o.order_date === d),
        (o) => Number(o.total),
      ),
    }));
  }, [confirmedActive, today]);

  return (
    <div className="space-y-5 px-4 pt-5 pb-8">
      {/* 1. INDICADORES GERAIS */}
      <section>
        <div className="flex items-end justify-between">
          <h1 className="font-display text-xl">Indicadores gerais (hoje)</h1>
          <span className="text-[11px] text-muted-foreground">
            {new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "short" })
              .format(new Date())}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Kpi
            label="Pedidos finalizados"
            value={String(summary.general.finalizedOrdersCount)}
            hint={`${summary.general.confirmedMealsCount} marmitas confirmadas`}
          />
          <Kpi
            label="Marmitas confirmadas"
            value={String(summary.general.confirmedMealsCount)}
            hint={`${summary.paidSales.qtyG + summary.fiadoSales.qtyG} G · ${summary.paidSales.qtyM + summary.fiadoSales.qtyM} M · ${summary.paidSales.qtyP + summary.fiadoSales.qtyP} P`}
          />
          <Kpi
            label="Faturamento classificado"
            value={brl(summary.general.classifiedRevenue)}
            hint={`Semana: ${brl(sum(weekConfirmed, (o) => Number(o.total)))} · Mês: ${brl(sum(monthConfirmed, (o) => Number(o.total)))}`}
          />
          <Kpi
            label="Valor efetivamente recebido"
            value={brl(summary.general.cashReceived)}
            hint="Vendas OK + recebimentos do dia"
          />
          <Kpi
            label="Em aberto (Contas a Receber)"
            value={brl(summary.general.accountsReceivableOpen)}
            hint={`${debtors.length} clientes no fiado`}
          />
          <Kpi
            label="Aguardando classificação"
            value={String(summary.general.awaitingOrdersCount)}
            hint={
              summary.awaitingOrders.ordersCount > 0
                ? `${summary.awaitingOrders.totalMeals} marmitas · est. ${brl(summary.awaitingOrders.amount)}`
                : "Tudo conferido hoje"
            }
          />
        </div>
      </section>

      {/* 2. VENDAS PAGAS (OK) & 3. VENDAS FIADAS (OKK) */}
      <section className="grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-good" />
              <h2 className="font-display text-lg">Vendas pagas (OK)</h2>
            </div>
            <span className="rounded-full bg-good/10 px-2.5 py-0.5 text-[11px] font-semibold text-good">
              {summary.paidSales.ordersCount} pedidos
            </span>
          </div>
          <div className="mt-3 flex items-baseline justify-between border-b border-border pb-3">
            <span className="text-[12px] text-muted-foreground">Valor efetivamente recebido</span>
            <span className="font-display text-2xl text-good">{brl(summary.paidSales.amount)}</span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            <SizeBox label="G pagas" value={summary.paidSales.qtyG} />
            <SizeBox label="M pagas" value={summary.paidSales.qtyM} />
            <SizeBox label="P pagas" value={summary.paidSales.qtyP} />
            <SizeBox label="Total pagas" value={summary.paidSales.totalMeals} highlight />
          </div>
        </div>

        <div className="panel p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wallet className="size-4 text-accent" />
              <h2 className="font-display text-lg">Vendas fiadas (OKK)</h2>
            </div>
            <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold text-accent">
              {summary.fiadoSales.ordersCount} pedidos
            </span>
          </div>
          <div className="mt-3 flex items-baseline justify-between border-b border-border pb-3">
            <span className="text-[12px] text-muted-foreground">Valor pendente de recebimento</span>
            <span className="font-display text-2xl text-accent">
              {brl(summary.fiadoSales.pendingAmount)}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            <SizeBox label="G fiadas" value={summary.fiadoSales.qtyG} />
            <SizeBox label="M fiadas" value={summary.fiadoSales.qtyM} />
            <SizeBox label="P fiadas" value={summary.fiadoSales.qtyP} />
            <SizeBox label="Total fiadas" value={summary.fiadoSales.totalMeals} highlight />
          </div>
        </div>
      </section>

      {/* 4. ÁREA SEPARADA: PEDIDOS AGUARDANDO CONFIRMAÇÃO (OK / OKK) */}
      <section className="panel border-gilt/40 bg-gilt/5 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-gilt" />
            <h2 className="font-display text-lg">Pedidos aguardando confirmação (OK / OKK)</h2>
          </div>
          <Link
            to="/pedidos"
            className="rounded-full bg-brand px-3 py-1 text-[11px] font-medium text-brand-foreground"
          >
            Conferir pedidos
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Estes pedidos ainda não entram em Vendas pagas nem em Contas a Receber até que a marmitaria
          confirme com OK (pago) ou OKK (fiado).
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <SizeBox label="Pedidos" value={summary.awaitingOrders.ordersCount} />
          <SizeBox label="Qtd G" value={summary.awaitingOrders.qtyG} />
          <SizeBox label="Qtd M" value={summary.awaitingOrders.qtyM} />
          <SizeBox label="Qtd P" value={summary.awaitingOrders.qtyP} />
          <div className="rounded-lg bg-card p-2.5 text-center border border-border">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Valor estimado
            </div>
            <div className="mt-0.5 font-display text-base text-gilt">
              {brl(summary.awaitingOrders.amount)}
            </div>
          </div>
        </div>
      </section>

      <section className="panel p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-lg">Faturamento confirmado dos últimos 7 dias</h2>
        </div>
        <div className="mt-3 h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="dia"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              />
              <Tooltip
                cursor={{ fill: "var(--color-muted)" }}
                formatter={(v: number) => brl(Number(v))}
                contentStyle={{
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="valor" radius={[6, 6, 0, 0]}>
                {chart.map((c) => (
                  <Cell
                    key={c.iso}
                    fill={c.iso === today ? "var(--color-brand)" : "var(--color-gilt)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl">Clientes com pagamento pendente</h2>
          <Link to="/fiado" className="text-[11px] text-muted-foreground underline">
            ver fiado
          </Link>
        </div>
        <div className="mt-3 space-y-2.5">
          {debtors.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">
              Nenhum cliente com saldo em aberto.
            </p>
          )}
          {debtors.slice(0, 4).map(({ customer, balance }) => (
            <div key={customer.id} className="panel p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-display text-[15px] leading-tight">{customer.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {cycleLabel[customer.payment_cycle]} · {customer.phone}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                    customer.status === "atrasado"
                      ? "bg-accent/10 text-accent"
                      : "bg-gilt/15 text-gilt"
                  }`}
                >
                  {customer.status === "atrasado" ? "Atrasado" : "Pendente"}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[12px] text-muted-foreground">Saldo devedor</span>
                <span className="font-display text-lg text-accent">{brl(balance)}</span>
              </div>
              <a
                href={whatsappLink(
                  customer.phone,
                  `Olá ${customer.name}! Passando para lembrar do fechamento das marmitas: total de ${brl(balance)}. Obrigado!`,
                )}
                target="_blank"
                rel="noreferrer"
                className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-[13px] font-medium text-brand-foreground transition-opacity hover:opacity-95 active:opacity-85"
              >
                <MessageCircle className="size-4" /> Enviar cobrança no WhatsApp
              </a>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl">Pedidos de hoje</h2>
          <Link to="/pedidos" className="text-[11px] text-muted-foreground underline">
            ver todos
          </Link>
        </div>
        <div className="mt-3 space-y-2">
          {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!isLoading && todayOrders.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">Nenhum pedido hoje ainda.</p>
          )}
          {todayOrders.map((o) => {
            const awaiting = isAwaitingClassification(o);
            return (
              <div key={o.id} className="panel flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{o.customers?.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatSizes(o.qty_g, o.qty_m, o.qty_p, o.quantity)} ·{" "}
                    {o.source === "whatsapp" || o.source === "mensagem"
                      ? "via WhatsApp"
                      : "manual"}
                  </p>
                </div>
                <span className="text-[13px] font-medium">{brl(Number(o.total))}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    awaiting
                      ? "bg-gilt/15 text-gilt"
                      : o.paid
                        ? "bg-good/10 text-good"
                        : "bg-accent/10 text-accent"
                  }`}
                >
                  {awaiting ? "Aguardando OK/OKK" : o.paid ? "OK · Pago" : "OKK · Fiado"}
                </span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-secondary-foreground">
                  {deliveryLabel[o.delivery_status]}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="panel p-3.5">
      <div className="label-cap">{label}</div>
      <div className="mt-1 font-display text-2xl">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function SizeBox({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 text-center ${
        highlight ? "border-brand/30 bg-brand/5" : "border-border bg-card"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-display text-base">{value}</div>
    </div>
  );
}
