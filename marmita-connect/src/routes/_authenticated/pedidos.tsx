import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Check, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  useCustomers,
  useOrders,
  useCompany,
  useCustomerBalances,
  isAwaitingClassification,
  DEFAULT_OPERATIONAL_PAGE_SIZE,
  type OrderWithCustomer,
} from "@/lib/queries";
import { classifyFinancialOrder } from "@/lib/financial.functions";
import { brl, deliveryLabel, formatSizes, fullDate, isoDay } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/pedidos")({
  head: () => ({
    meta: [
      { title: "Pedidos · Verde&Mesa" },
      {
        name: "description",
        content: "Lista de pedidos de marmitas com confirmação OK / OKK, entrega e pagamento.",
      },
      { property: "og:title", content: "Pedidos · Verde&Mesa" },
      { property: "og:description", content: "Controle diário de pedidos da marmitaria." },
    ],
  }),
  component: Pedidos,
});

type OrderUpdate = Database["public"]["Tables"]["orders"]["Update"];
type ManualCondition = "pago" | "fiado" | "aguardando_classificacao";

const filters = [
  "todos",
  "aguardando",
  "hoje",
  "pendente",
  "entregue",
  "nao_pago",
] as const;

const filterLabel: Record<(typeof filters)[number], string> = {
  todos: "Todos",
  aguardando: "Aguardando OK/OKK",
  hoje: "Hoje",
  pendente: "A entregar",
  entregue: "Entregues",
  nao_pago: "Fiado em aberto",
};

function Pedidos() {
  const { data: company } = useCompany();
  const [filter, setFilter] = useState<(typeof filters)[number]>("todos");
  const [page, setPage] = useState(0);
  const today = isoDay();

  // CORREÇÃO AUD-07: Filtros e paginação server-side (pageSize = 100, sem carregar histórico ilimitado)
  const orderQueryOptions = useMemo(() => {
    const base = {
      companyId: company?.id,
      page,
      pageSize: DEFAULT_OPERATIONAL_PAGE_SIZE,
      maxPages: 1,
    };
    switch (filter) {
      case "aguardando":
        return {
          ...base,
          financialState: "aguardando_classificacao" as const,
          excludeCancelled: true,
        };
      case "hoje":
        return {
          ...base,
          fromDate: today,
          toDate: today,
        };
      case "pendente":
        return {
          ...base,
          deliveryStatus: ["pendente", "preparando", "em_rota"] as Database["public"]["Enums"]["delivery_status"][],
        };
      case "entregue":
        return {
          ...base,
          deliveryStatus: "entregue" as const,
        };
      case "nao_pago":
        return {
          ...base,
          onlyUnpaid: true,
        };
      default:
        return base;
    }
  }, [company?.id, filter, page, today]);

  const { data: orders = [], isLoading } = useOrders(orderQueryOptions);

  // CORREÇÃO AUD3-05: Consulta dedicada para a contagem de pedidos aguardando OK/OKK,
  // evitando que o indicador "X aguardando OK/OKK" caia para 0 ao alternar para abas como "Entregues" ou "Fiado em aberto".
  const { data: awaitingOrders = [] } = useOrders({
    companyId: company?.id,
    financialState: "aguardando_classificacao",
    excludeCancelled: true,
    page: 0,
    pageSize: 200,
    maxPages: 2,
  });

  const { data: customers = [] } = useCustomers({
    companyId: company?.id,
    page: 0,
    pageSize: 500,
    maxPages: 2,
  });
  const { data: authoritativeBalances } = useCustomerBalances(company?.id);

  const qc = useQueryClient();
  const classifyFn = useServerFn(classifyFinancialOrder);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  const [eventMap, setEventMap] = useState<Record<string, string>>({});

  const [draft, setDraft] = useState<{
    customer_id: string;
    qty_p: number;
    qty_m: number;
    qty_g: number;
    condition: ManualCondition | "";
    order_date: string;
  }>({
    customer_id: "",
    qty_p: 0,
    qty_m: 0,
    qty_g: 1,
    condition: "",
    order_date: isoDay(),
  });

  const priceP = Number(company?.price_p ?? 0);
  const priceM = Number(company?.price_m ?? company?.price_p ?? 0);
  const priceG = Number(company?.price_g ?? 0);
  const draftTotal = draft.qty_p * priceP + draft.qty_m * priceM + draft.qty_g * priceG;

  const awaitingCount = useMemo(() => {
    const ids = new Set<string>();
    for (const o of awaitingOrders) {
      if (o.delivery_status !== "cancelado" && isAwaitingClassification(o)) {
        ids.add(o.id);
      }
    }
    for (const o of orders) {
      if (o.delivery_status !== "cancelado" && isAwaitingClassification(o)) {
        ids.add(o.id);
      }
    }
    return ids.size;
  }, [awaitingOrders, orders]);

  const list = useMemo(() => {
    switch (filter) {
      case "aguardando":
        return orders.filter(
          (o) => o.delivery_status !== "cancelado" && isAwaitingClassification(o),
        );
      case "hoje":
        return orders.filter((o) => o.order_date === today);
      case "pendente":
        return orders.filter((o) => !["entregue", "cancelado"].includes(o.delivery_status));
      case "entregue":
        return orders.filter((o) => o.delivery_status === "entregue");
      case "nao_pago":
        return orders.filter(
          (o) =>
            !o.paid &&
            o.delivery_status !== "cancelado" &&
            !isAwaitingClassification(o),
        );
      default:
        return orders;
    }
  }, [orders, filter, today]);

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["payments"] });
    qc.invalidateQueries({ queryKey: ["customer_balances_authoritative"] });
    qc.invalidateQueries({ queryKey: ["messages"] });
  }

  async function createOrder() {
    if (!company || !draft.customer_id) {
      toast.error("Escolha um cliente.");
      return;
    }
    const p = Math.max(0, Math.trunc(Number(draft.qty_p) || 0));
    const m = Math.max(0, Math.trunc(Number(draft.qty_m) || 0));
    const g = Math.max(0, Math.trunc(Number(draft.qty_g) || 0));
    if (p + m + g < 1) {
      toast.error("Informe pelo menos uma marmita.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.order_date)) {
      toast.error("Informe uma data válida.");
      return;
    }
    if (!draft.condition) {
      toast.error(
        "Selecione explicitamente a condição financeira (Pago na hora, Fiado ou Aguardar confirmação).",
      );
      return;
    }
    setSaving(true);

    const { error } = await supabase.rpc("create_manual_or_reviewed_order", {
      _customer_id: draft.customer_id,
      _qty_p: p,
      _qty_m: m,
      _qty_g: g,
      _order_date: draft.order_date,
      _financial_state: draft.condition,
      _source: "manual",
      _event_id: crypto.randomUUID(),
    });

    setSaving(false);
    if (error) {
      toast.error(error.message || "Não foi possível registrar o pedido. Tente novamente.");
      return;
    }
    toast.success(
      draft.condition === "aguardando_classificacao"
        ? "Pedido registrado aguardando confirmação (OK / OKK)"
        : draft.condition === "pago"
          ? "Pedido registrado como Pago (OK)"
          : "Pedido registrado no Fiado (OKK)",
    );
    setOpen(false);
    refreshAll();
  }

  async function confirmOrderCommand(order: OrderWithCustomer, command: "OK" | "OKK") {
    if (classifyingId) return; // proteção contra clique duplo simultâneo
    if (order.order_date !== today) {
      toast.error(
        "A confirmação OK / OKK só pode ser aplicada a pedidos do dia atual (horário de Brasília).",
      );
      return;
    }
    const key = `${order.id}:${command}`;
    const eventId = eventMap[key] ?? crypto.randomUUID();
    if (!eventMap[key]) {
      setEventMap((prev) => ({ ...prev, [key]: eventId }));
    }

    setClassifyingId(order.id);
    try {
      const response = await classifyFn({
        data: { orderId: order.id, eventId, command },
      });
      const outcome = response.result.outcome;
      if (outcome === "classified" || outcome === "duplicate") {
        toast.success(
          command === "OK"
            ? `OK confirmado · ${brl(Number(order.total))} registrado como pago!`
            : `OKK confirmado · ${brl(Number(order.total))} enviado para Contas a Receber!`,
        );
        refreshAll();
      } else {
        toast.error(`Confirmação bloqueada: ${response.result.reason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(msg || "Não foi possível confirmar o pedido.");
    } finally {
      setClassifyingId(null);
    }
  }

  async function updateDelivery(id: string, patch: OrderUpdate) {
    if (!patch.delivery_status) return;
    if (
      patch.delivery_status === "cancelado" &&
      !window.confirm("Cancelar este pedido? Ele deixa de contar no faturamento e no fiado.")
    ) {
      return;
    }
    const { error } = await supabase.rpc("financial_update_delivery", {
      _order_id: id,
      _status: patch.delivery_status,
    });
    if (error) {
      toast.error("Não foi possível atualizar o pedido.");
      return;
    }
    toast.success("Pedido atualizado");
    refreshAll();
  }

  async function togglePaid(order: OrderWithCustomer) {
    if (order.settled_by_payment) {
      toast.error("Este pedido foi quitado por um recebimento no Fiado e não pode ser desfeito aqui.");
      return;
    }
    if (order.financial_state === "pago" || order.financial_state === "fiado") {
      toast.error(
        order.financial_state === "fiado"
          ? "Pedido confirmado como Fiado (OKK). Registre o recebimento na aba Fiado."
          : "Pedido já confirmado como Pago na hora (OK).",
      );
      return;
    }

    const nextPaid = !order.paid;
    if (nextPaid && authoritativeBalances) {
      const bRow = authoritativeBalances.rows.find((r) => r.customer_id === order.customer_id);
      if (bRow && bRow.payments_total > 0 && bRow.balance > 0.009 && bRow.balance < bRow.fiado_total) {
        toast.error(
          "Este cliente possui pagamento parcial em aberto. Registre o restante na aba Fiado para abater o saldo corretamente.",
        );
        return;
      }
    }

    const rpc = await supabase.rpc("toggle_order_paid", {
      _order_id: order.id,
      _paid: nextPaid,
    });

    if (rpc.error) {
      toast.error(rpc.error.message || "Não foi possível atualizar o pagamento do pedido.");
      return;
    }

    toast.success(nextPaid ? "Pedido marcado como pago" : "Pedido reaberto como fiado");
    refreshAll();
  }

  return (
    <div className="space-y-4 px-4 pt-5 pb-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-xl">Pedidos</h1>
          {awaitingCount > 0 && (
            <span className="rounded-full bg-gilt/20 px-2.5 py-0.5 text-[11px] font-semibold text-gilt">
              {awaitingCount} aguardando OK/OKK
            </span>
          )}
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              className="min-h-10 px-3.5"
              onClick={() =>
                setDraft({
                  customer_id: "",
                  qty_p: 0,
                  qty_m: 0,
                  qty_g: 1,
                  condition: "",
                  order_date: isoDay(),
                })
              }
            >
              <Plus className="size-4" /> Novo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display">Novo pedido</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="order-customer">Cliente</Label>
                <Select
                  value={draft.customer_id}
                  onValueChange={(v) => setDraft({ ...draft, customer_id: v })}
                >
                  <SelectTrigger id="order-customer">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div className="space-y-1.5">
                  <Label htmlFor="order-qty-p">P ({brl(priceP)})</Label>
                  <Input
                    id="order-qty-p"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={draft.qty_p}
                    onChange={(e) => setDraft({ ...draft, qty_p: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="order-qty-m">M ({brl(priceM)})</Label>
                  <Input
                    id="order-qty-m"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={draft.qty_m}
                    onChange={(e) => setDraft({ ...draft, qty_m: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="order-qty-g">G ({brl(priceG)})</Label>
                  <Input
                    id="order-qty-g"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={draft.qty_g}
                    onChange={(e) => setDraft({ ...draft, qty_g: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="order-date">Data</Label>
                <Input
                  id="order-date"
                  type="date"
                  value={draft.order_date}
                  onChange={(e) => setDraft({ ...draft, order_date: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="order-condition">Condição financeira (obrigatório)</Label>
                <Select
                  value={draft.condition}
                  onValueChange={(v) => setDraft({ ...draft, condition: v as ManualCondition })}
                >
                  <SelectTrigger id="order-condition">
                    <SelectValue placeholder="Escolha a condição financeira" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pago">1. Pago na hora (OK)</SelectItem>
                    <SelectItem value="fiado">2. Fiado — pagar depois (OKK)</SelectItem>
                    <SelectItem value="aguardando_classificacao">
                      3. Aguardar confirmação (OK / OKK)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-sm">
                <span className="text-muted-foreground">Total</span>
                <span className="font-display text-lg">{brl(draftTotal)}</span>
              </div>

              <Button className="w-full" disabled={saving} onClick={createOrder}>
                {saving ? "Registrando…" : "Registrar pedido"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="no-print flex gap-2 overflow-x-auto pb-1">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f);
              setPage(0);
            }}
            className={`min-h-9 shrink-0 rounded-full border px-3.5 py-1.5 text-[12px] transition-colors ${
              filter === f
                ? "border-brand bg-brand text-brand-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            {filterLabel[f]}
            {f === "aguardando" && awaitingCount > 0 ? ` (${awaitingCount})` : ""}
          </button>
        ))}
      </div>

      <div className="space-y-2.5">
        {isLoading && (
          <p className="panel p-4 text-sm text-muted-foreground">Carregando pedidos…</p>
        )}
        {!isLoading && list.length === 0 && (
          <p className="panel p-4 text-sm text-muted-foreground">Nenhum pedido neste filtro.</p>
        )}
        {list.map((o) => {
          const awaiting = isAwaitingClassification(o);
          const isToday = o.order_date === today;
          return (
            <div key={o.id} className="panel p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-display text-[15px] leading-tight">
                    {o.customers?.name ?? "Cliente"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {fullDate(o.order_date + "T12:00:00")} ·{" "}
                    {formatSizes(o.qty_g, o.qty_m, o.qty_p, o.quantity)} ·{" "}
                    {o.source === "manual" ? "manual" : "via WhatsApp"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display text-lg">{brl(Number(o.total))}</div>
                  <div
                    className={`text-[11px] font-medium ${
                      awaiting
                        ? "text-gilt"
                        : o.paid
                          ? "text-good"
                          : "text-accent"
                    }`}
                  >
                    {awaiting
                      ? "Aguardando confirmação"
                      : o.paid
                        ? o.settled_by_payment
                          ? "Quitado no fiado"
                          : "OK · Pago"
                        : "OKK · Fiado"}
                  </div>
                </div>
              </div>

              {awaiting && o.delivery_status !== "cancelado" && (
                <div className="mt-3 rounded-lg border border-gilt/30 bg-gilt/10 p-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                    <Clock className="size-3.5 text-gilt" />
                    {isToday
                      ? "Confirme a condição financeira deste pedido:"
                      : "Pedido de data anterior — confirmação automática OK/OKK restrita ao dia atual."}
                  </div>
                  {isToday && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        className="h-10 bg-good text-white hover:bg-good/90"
                        disabled={classifyingId === o.id}
                        onClick={() => confirmOrderCommand(o, "OK")}
                      >
                        <Check className="size-4" /> OK · Pago
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-10 border border-accent/30 text-accent hover:bg-accent/10"
                        disabled={classifyingId === o.id}
                        onClick={() => confirmOrderCommand(o, "OKK")}
                      >
                        OKK · Fiado
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <Select
                  value={o.delivery_status}
                  onValueChange={(v) =>
                    updateDelivery(o.id, { delivery_status: v as typeof o.delivery_status })
                  }
                >
                  <SelectTrigger aria-label="Status de entrega" className="h-10 flex-1 text-[12px]">
                    <SelectValue>{deliveryLabel[o.delivery_status]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(deliveryLabel).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!awaiting &&
                  (o.settled_by_payment ? (
                    <span className="inline-flex h-10 items-center rounded-md bg-secondary px-3 text-[12px] font-medium text-muted-foreground">
                      <Check className="mr-1.5 size-3.5 text-good" /> Recebido no Fiado
                    </span>
                  ) : o.financial_state === "pago" || o.financial_state === "fiado" ? (
                    <span className="inline-flex h-10 items-center rounded-md bg-secondary px-3 text-[12px] font-medium text-muted-foreground">
                      {o.financial_state === "pago" ? "Confirmado OK" : "Confirmado OKK"}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      className="h-10 px-3"
                      variant={o.paid ? "secondary" : "default"}
                      onClick={() => togglePaid(o)}
                    >
                      <Check className="size-4" /> {o.paid ? "Desfazer" : "Marcar pago"}
                    </Button>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      {(page > 0 || orders.length >= DEFAULT_OPERATIONAL_PAGE_SIZE) && (
        <div className="no-print flex items-center justify-between pt-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Página anterior
          </Button>
          <span className="text-[11px] text-muted-foreground">Página {page + 1}</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={orders.length < DEFAULT_OPERATIONAL_PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima página
          </Button>
        </div>
      )}
    </div>
  );
}
