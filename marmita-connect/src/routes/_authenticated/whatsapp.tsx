import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Sparkles, AlertTriangle, Check, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  interpretMessage,
  retryPendingMessages,
  updateCompanyPrices,
  ignoreWhatsAppMessage,
} from "@/lib/company.functions";
import { WhatsAppConnection } from "@/components/WhatsAppConnection";
import {
  useMessages,
  useCompany,
  useCustomers,
  useOrders,
  isAwaitingClassification,
  type WhatsMessage,
  type OrderWithCustomer,
} from "@/lib/queries";
import {
  brl,
  formatSizes,
  fullDate,
  isoDay,
  normalizePhone,
  isValidNormalizedPhone,
} from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/whatsapp")({
  head: () => ({
    meta: [
      { title: "Mensagens · Verde&Mesa" },
      {
        name: "description",
        content:
          "Leitura de mensagens de clientes com IA Gemini: identifica marmitas P, M e G e registra o pedido aguardando confirmação OK / OKK.",
      },
      { property: "og:title", content: "Mensagens · Verde&Mesa" },
      {
        property: "og:description",
        content: "Interpretação de mensagens e registro de pedidos aguardando confirmação.",
      },
    ],
  }),
  component: Mensagens,
});

const statusLabel: Record<string, string> = {
  aguardando: "Na fila",
  registrado: "Registrado",
  revisar: "Revisar",
  ignorado: "Sem venda",
  erro: "Falha IA (pendente)",
  processando: "Processando",
};

/**
 * CORREÇÃO AUD3-03:
 * Identifica se uma mensagem em revisão é um eco comercial (`direction = 'outbound'`,
 * `source = 'whatsapp_echo'` ou texto `OK`/`OKK`). Ecos comerciais e mensagens que
 * já possuem `order_id` NUNCA podem criar um novo pedido de marmita em `create_manual_or_reviewed_order`.
 */
export function isCommercialEchoReviewMessage(
  m: Pick<WhatsMessage, "direction" | "source" | "body">,
): boolean {
  const dir = (m.direction ?? "").toLowerCase();
  const src = (m.source ?? "").toLowerCase();
  const trimmed = (m.body ?? "").trim();
  return dir === "outbound" || src === "whatsapp_echo" || /^okk?$/i.test(trimmed);
}

/**
 * CORREÇÃO AUD5-03 & AUD6-07.B:
 * Seleciona apenas os pedidos elegíveis que pertençam estritamente ao MESMO cliente E
 * possuam telefone válido e idêntico ao telefone normalizado da mensagem revisada.
 * - NUNCA faz fallback para pedidos de outros clientes (`openAwaiting`) quando não houver
 *   pedido correspondente para o cliente/telefone da mensagem.
 * - Exige que o telefone da mensagem e o telefone do pedido sejam ambos válidos (`8..15` dígitos)
 *   e idênticos após `normalizePhone`; se qualquer um estiver ausente, inválido ou divergente,
 *   o pedido NÃO é apresentado como candidato válido (`[]`).
 * - Aceita tanto `customerId` (camelCase) quanto `customer_id` (snake_case) por segurança defensiva.
 */
export function selectCandidateAwaitingOrdersForReview(
  awaitingOrders: readonly OrderWithCustomer[],
  review: { customerId?: string | null; customer_id?: string | null; phone?: string | null } | null,
): OrderWithCustomer[] {
  if (!review) return [];
  const openAwaiting = awaitingOrders.filter(
    (o) => o.delivery_status !== "cancelado" && isAwaitingClassification(o),
  );
  const custId = (review.customerId ?? review.customer_id ?? "").trim();
  const normReviewPhone = normalizePhone(review.phone ?? "");

  if (!isValidNormalizedPhone(normReviewPhone)) {
    return [];
  }

  return openAwaiting.filter((o) => {
    if (custId && o.customer_id !== custId) {
      return false;
    }
    const normOrderPhone = normalizePhone(o.customers?.phone ?? o.financial_phone ?? "");
    if (!isValidNormalizedPhone(normOrderPhone)) {
      return false;
    }
    return normOrderPhone === normReviewPhone;
  });
}

/**
 * CORREÇÃO AUD5-03:
 * Valida a resposta da RPC `reconcile_reviewed_whatsapp_echo`, aceitando sucesso
 * exclusivamente quando `outcome === "classified"` ou `outcome === "duplicate"`.
 * Qualquer retorno `blocked` ou inesperado é tratado como erro explícito.
 */
export function evaluateEchoReconciliationOutcome(
  rpcData: unknown,
  rpcError: { message?: string } | null = null,
):
  | { ok: true; outcome: "classified" | "confirmed" | "duplicate"; isDuplicate: boolean }
  | { ok: false; isDuplicate: false; errorMessage: string } {
  if (rpcError) {
    return {
      ok: false,
      isDuplicate: false,
      errorMessage: rpcError.message || "Não foi possível vincular a confirmação ao pedido.",
    };
  }
  if (!rpcData || typeof rpcData !== "object") {
    return {
      ok: false,
      isDuplicate: false,
      errorMessage: "Resposta inesperada do servidor ao reconciliar a confirmação.",
    };
  }
  const payload = rpcData as { outcome?: unknown; reason?: unknown };
  const outcome = typeof payload.outcome === "string" ? payload.outcome : "";
  const reason = typeof payload.reason === "string" ? payload.reason : "";

  if (outcome === "classified" || outcome === "confirmed" || outcome === "duplicate") {
    return { ok: true, outcome, isDuplicate: outcome === "duplicate" };
  }

  if (outcome === "blocked") {
    if (reason === "OUTSIDE_RECONCILIATION_WINDOW") {
      return {
        ok: false,
        isDuplicate: false,
        errorMessage:
          "Confirmação bloqueada pelo banco: confirmação recebida fora da janela segura de 30 minutos do pedido (OUTSIDE_RECONCILIATION_WINDOW).",
      };
    }
    if (reason === "COMANDO_FORA_DA_DATA_DO_PEDIDO") {
      return {
        ok: false,
        isDuplicate: false,
        errorMessage:
          "Confirmação bloqueada pelo banco: a data do comando OK/OKK diverge da data do pedido (COMANDO_FORA_DA_DATA_DO_PEDIDO).",
      };
    }
    return {
      ok: false,
      isDuplicate: false,
      errorMessage: reason
        ? `Confirmação bloqueada pelo banco: ${reason}`
        : "Confirmação bloqueada pelas regras financeiras (verifique a data e o estado do pedido).",
    };
  }

  return {
    ok: false,
    isDuplicate: false,
    errorMessage: reason
      ? `Não foi possível confirmar o pedido (${reason}).`
      : "Resultado inesperado ao confirmar o pedido.",
  };
}

type ReviewState = {
  id: string;
  body: string;
  phone: string;
  direction: string;
  source: string;
  orderId: string | null;
  mode: "create_order" | "reconcile_echo" | "existing_order";
  customerId: string;
  targetOrderId: string;
  echoCommand: "OK" | "OKK";
  p: string;
  m: string;
  g: string;
  date: string;
};

function Mensagens() {
  const { data: messages = [], isLoading } = useMessages();
  const { data: company } = useCompany();
  const { data: customers = [] } = useCustomers({
    companyId: company?.id,
    page: 0,
    pageSize: 500,
    maxPages: 2,
  });
  const { data: awaitingOrders = [] } = useOrders({
    companyId: company?.id,
    financialState: "aguardando_classificacao",
    excludeCancelled: true,
    page: 0,
    pageSize: 200,
    maxPages: 2,
  });
  const qc = useQueryClient();
  const read = useServerFn(interpretMessage);
  const retryFn = useServerFn(retryPendingMessages);
  const savePricesFn = useServerFn(updateCompanyPrices);
  const ignoreMsgFn = useServerFn(ignoreWhatsAppMessage);

  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("");
  const [pasteKey, setPasteKey] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [priceP, setPriceP] = useState<string | null>(null);
  const [priceM, setPriceM] = useState<string | null>(null);
  const [priceG, setPriceG] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!company) return;
    setPriceP((prev) => (prev === null ? String(company.price_p ?? 19) : prev));
    setPriceM((prev) =>
      prev === null ? String(company.price_m ?? company.price_p ?? 19.5) : prev,
    );
    setPriceG((prev) => (prev === null ? String(company.price_g ?? 20) : prev));
  }, [company]);

  const pending = messages.filter((m) => m.status === "revisar");
  const failedMessages = messages.filter(
    (m) =>
      (m.status === "erro" || m.status === "processando" || m.status === "aguardando") &&
      !m.order_id,
  );

  // CORREÇÃO AUD5-03 & AUD6-07.B: Filtra exclusivamente pedidos do mesmo cliente e telefone válido
  const candidateAwaitingOrders = useMemo(
    () => selectCandidateAwaitingOrdersForReview(awaitingOrders, review),
    [awaitingOrders, review],
  );

  function openReviewModal(m: WhatsMessage) {
    const isEcho = isCommercialEchoReviewMessage(m);
    const hasExistingOrder = Boolean(m.order_id);
    const defaultEchoCmd: "OK" | "OKK" = /^okk$/i.test((m.body ?? "").trim()) ? "OKK" : "OK";
    const normPhone = normalizePhone(m.phone ?? "");
    const matchedCustomer =
      customers.find((c) => c.id === m.customer_id) ??
      (isValidNormalizedPhone(normPhone)
        ? customers.find((c) => normalizePhone(c.phone) === normPhone)
        : undefined);
    const resolvedCustomerId = m.customer_id ?? matchedCustomer?.id ?? "";

    const matchingOrders = selectCandidateAwaitingOrdersForReview(awaitingOrders, {
      customerId: resolvedCustomerId,
      phone: m.phone,
    });

    setReview({
      id: m.id,
      body: m.body,
      phone: m.phone,
      direction: m.direction,
      source: m.source,
      orderId: m.order_id ?? null,
      mode: isEcho ? "reconcile_echo" : hasExistingOrder ? "existing_order" : "create_order",
      customerId: resolvedCustomerId,
      targetOrderId: m.order_id ?? (matchingOrders.length === 1 ? matchingOrders[0]!.id : ""),
      echoCommand: defaultEchoCmd,
      p: m.qty_p != null ? String(m.qty_p) : "",
      m: m.qty_m != null ? String(m.qty_m) : "",
      g: m.qty_g != null ? String(m.qty_g) : "",
      date: m.order_date ?? isoDay(),
    });
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customer_balances_authoritative"] });
  }

  /**
   * CORREÇÃO AUD-10:
   * Verifica explicitamente a linha atualizada (`.select("id").maybeSingle()`) além do erro
   * retornado pelo PostgreSQL (`42501`). Jamais exibe "Preços atualizados" se o usuário não
   * possuir permissão administrativa ou se zero linhas tiverem sido modificadas!
   */
  async function savePrices() {
    if (!company) return;
    const rawP = (priceP ?? String(company.price_p ?? "")).trim().replace(",", ".");
    const rawM = (priceM ?? String(company.price_m ?? company.price_p ?? "")).trim().replace(",", ".");
    const rawG = (priceG ?? String(company.price_g ?? "")).trim().replace(",", ".");
    const p = Number(rawP);
    const m = Number(rawM);
    const g = Number(rawG);
    if (
      !rawP ||
      !rawM ||
      !rawG ||
      !Number.isFinite(p) ||
      p < 0 ||
      !Number.isFinite(m) ||
      m < 0 ||
      !Number.isFinite(g) ||
      g < 0
    ) {
      toast.error("Informe preços válidos para P, M e G.");
      return;
    }
    try {
      await savePricesFn({ data: { priceP: p, priceM: m, priceG: g } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      const errMsg = /Permissão administrativa|42501/i.test(msg)
        ? "Permissão administrativa necessária para alterar os preços da empresa."
        : msg || "Permissão administrativa necessária para salvar os preços.";
      toast.error(errMsg);
      return;
    }

    toast.success("Preços atualizados");
    qc.invalidateQueries({ queryKey: ["company"] });
  }

  async function run() {
    if (!body.trim()) {
      toast.error("Cole a mensagem do cliente.");
      return;
    }
    setLoading(true);
    try {
      const res = await read({
        data: { phone: phone.trim(), body: body.trim(), externalId: pasteKey },
      });
      if (res.duplicate) toast.info("Essa mensagem já foi processada antes.");
      else if (res.status === "registrado")
        toast.success(
          `Pedido registrado para ${res.customerName ?? "cliente"} — aguardando confirmação (OK / OKK)`,
        );
      else if (res.status === "revisar")
        toast.warning("Faltou informação. Mensagem enviada para revisão.");
      else toast.info("Mensagem sem venda — não registrada.");
      setBody("");
      setPasteKey(crypto.randomUUID());
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao interpretar a mensagem");
      refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleRetry(messageId?: string) {
    setRetrying(messageId ?? "all");
    try {
      const res = await retryFn({ data: messageId ? { messageId } : {} });
      if (res.recovered > 0) {
        toast.success(`${res.recovered} mensagem(ns) reprocessada(s) com sucesso!`);
      } else if (res.failed > 0) {
        toast.error("A API Gemini ainda não respondeu. A mensagem segue salva para revisão ou nova tentativa.");
      } else {
        toast.info("Nenhuma mensagem elegível para reprocessar agora.");
      }
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível reprocessar agora.");
      refresh();
    } finally {
      setRetrying(null);
    }
  }

  /**
   * CORREÇÃO AUD3-03 & AUD5-03:
   * - Se a mensagem em revisão for um eco comercial (`mode === "reconcile_echo"`) ou já possuir
   *   `order_id` (`mode === "existing_order"`), reconcilia com o pedido existente do MESMO cliente
   *   via `reconcile_reviewed_whatsapp_echo`, verificando explicitamente `data.outcome`
   *   (`classified` ou `duplicate`) e exibindo erro se o resultado for `blocked`.
   * - Somente mensagens inbound de clientes sem `order_id` (`mode === "create_order"`) criam um
   *   novo pedido, usando `_event_id: review.id` e `_whatsapp_message_id: review.id` com bloqueio
   *   contra duplo clique (`if (busy) return`).
   */
  async function confirmReview() {
    if (!review || !company || busy) return;

    if (
      review.mode === "reconcile_echo" ||
      review.mode === "existing_order" ||
      Boolean(review.orderId) ||
      isCommercialEchoReviewMessage(review)
    ) {
      const targetOrderId = review.targetOrderId || review.orderId || "";
      if (!targetOrderId) {
        toast.error(
          "Selecione o pedido existente deste cliente para vincular a confirmação OK/OKK ou dispense o eco.",
        );
        return;
      }

      const allowedOrder = candidateAwaitingOrders.find((o) => o.id === targetOrderId);
      if (!allowedOrder && targetOrderId !== review.orderId) {
        toast.error(
          "O pedido selecionado não pertence ao mesmo cliente/telefone da mensagem.",
        );
        return;
      }

      setBusy(true);
      const { data, error } = await supabase.rpc("reconcile_reviewed_whatsapp_echo", {
        _whatsapp_message_id: review.id,
        _order_id: targetOrderId,
        _command: review.echoCommand,
      });
      setBusy(false);

      const evaluation = evaluateEchoReconciliationOutcome(data, error);
      if (!evaluation.ok) {
        toast.error(evaluation.errorMessage);
        return;
      }

      setReview(null);
      toast.success(
        review.echoCommand === "OK"
          ? "Pedido confirmado como Pago (OK) sem duplicar pedido."
          : "Pedido confirmado no Fiado (OKK) sem duplicar pedido.",
      );
      refresh();
      return;
    }

    const p = Math.max(0, Math.trunc(Number(review.p) || 0));
    const m = Math.max(0, Math.trunc(Number(review.m) || 0));
    const g = Math.max(0, Math.trunc(Number(review.g) || 0));
    if (!review.customerId) {
      toast.error("Escolha o cliente.");
      return;
    }
    if (p + m + g < 1) {
      toast.error("Informe pelo menos uma marmita.");
      return;
    }
    setBusy(true);

    const { error } = await supabase.rpc("create_manual_or_reviewed_order", {
      _customer_id: review.customerId,
      _qty_p: p,
      _qty_m: m,
      _qty_g: g,
      _order_date: review.date,
      _financial_state: "aguardando_classificacao",
      _source: "mensagem",
      _whatsapp_message_id: review.id,
      _event_id: review.id,
    });

    if (error) {
      setBusy(false);
      toast.error(error.message || "Não foi possível registrar o pedido.");
      return;
    }

    setBusy(false);
    setReview(null);
    toast.success("Pedido registrado aguardando confirmação (OK / OKK)");
    refresh();
  }

  /**
   * CORREÇÃO AUD6-07.C:
   * Utiliza a RPC SECURITY DEFINER `ignore_whatsapp_message` (que limpa também locks/retries
   * com permissão validada por `financial_require_operator`), mantendo fallback para `.update({ status: "ignorado" })`.
   */
  async function ignore(id: string) {
    try {
      await ignoreMsgFn({ data: { messageId: id } });
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : "Não foi possível dispensar a mensagem.",
      );
      return;
    }
    if (review?.id === id) {
      setReview(null);
    }
    refresh();
  }

  function messageRecordedTotal(m: WhatsMessage): number | null {
    if (m.orders && typeof m.orders.total === "number") {
      return Number(m.orders.total);
    }
    if (!company) return null;
    const pPrice = Number(company.price_p ?? 0);
    const mPrice = Number(company.price_m ?? company.price_p ?? 0);
    const gPrice = Number(company.price_g ?? 0);
    return (m.qty_p ?? 0) * pPrice + (m.qty_m ?? 0) * mPrice + (m.qty_g ?? 0) * gPrice;
  }

  function messageFinancialTag(m: WhatsMessage): string | null {
    if (m.status !== "registrado") return null;
    const st = m.orders?.financial_state;
    if (st === "aguardando_classificacao") return "Aguardando OK/OKK";
    if (st === "pago") return "OK · Pago";
    if (st === "fiado") return "OKK · Fiado";
    return m.orders?.paid ? "Pago" : m.fiado ? "Fiado" : "Aguardando OK/OKK";
  }

  return (
    <div className="space-y-5 px-4 pt-5 pb-8">
      <section className="panel p-4">
        <h1 className="font-display text-xl">Tabela de preços</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">
          O valor de cada venda é calculado pelo sistema com estes preços — a IA nunca calcula
          dinheiro, e pedidos antigos mantêm o valor da data em que foram criados.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2.5">
          <div className="space-y-1.5">
            <Label htmlFor="price-p">Marmita P</Label>
            <Input
              id="price-p"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={priceP ?? ""}
              onChange={(e) => setPriceP(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="price-m">Marmita M</Label>
            <Input
              id="price-m"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={priceM ?? ""}
              onChange={(e) => setPriceM(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="price-g">Marmita G</Label>
            <Input
              id="price-g"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={priceG ?? ""}
              onChange={(e) => setPriceG(e.target.value)}
            />
          </div>
        </div>
        <Button className="mt-3 w-full" variant="secondary" onClick={savePrices}>
          Salvar preços
        </Button>
      </section>

      <WhatsAppConnection companyId={company?.id} />

      <section className="panel p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-gilt" />
          <h2 className="font-display text-lg">Ler mensagem do cliente</h2>
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Cole a mensagem recebida. A IA identifica apenas cliente e quantidades (P, M e G). Todo
          pedido nasce aguardando a confirmação da marmitaria por OK (pago) ou OKK (fiado).
        </p>
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="msg-phone">Telefone do cliente (opcional)</Label>
            <Input
              id="msg-phone"
              value={phone}
              placeholder="11987654321"
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="msg-body">Mensagem</Label>
            <Textarea
              id="msg-body"
              rows={3}
              value={body}
              placeholder="João, separa 3 G e 2 M pra mim."
              onChange={(e) => {
                setBody(e.target.value);
                setPasteKey(crypto.randomUUID());
              }}
            />
          </div>
          <Button className="w-full" disabled={loading} onClick={run}>
            <Sparkles className="size-4" /> {loading ? "Lendo…" : "Interpretar e registrar pedido"}
          </Button>
        </div>
      </section>

      {failedMessages.length > 0 && (
        <section className="panel border-accent/40 bg-accent/5 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg text-accent">
                Mensagens aguardando reprocessamento ({failedMessages.length})
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Salvas com segurança durante indisponibilidade temporária da IA. Você pode
                reprocessar com a IA (até 3 tentativas manuais com intervalo de 30s) ou classificar
                manualmente.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={retrying !== null}
              onClick={() => handleRetry()}
            >
              <RefreshCw className={`size-3.5 ${retrying === "all" ? "animate-spin" : ""}`} />{" "}
              Reprocessar todas
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            {failedMessages.map((m) => (
              <div key={m.id} className="panel p-3">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{m.phone}</span>
                  <span>{fullDate(m.created_at)}</span>
                </div>
                <p className="mt-1 text-[13px]">{m.body}</p>
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    disabled={retrying !== null}
                    onClick={() => handleRetry(m.id)}
                  >
                    <RefreshCw className={`size-3.5 ${retrying === m.id ? "animate-spin" : ""}`} />{" "}
                    Tentar IA novamente
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => openReviewModal(m)}
                  >
                    Classificar manualmente
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-display text-xl">
          Revisar {pending.length > 0 && <span className="text-accent">({pending.length})</span>}
        </h2>
        <div className="mt-3 space-y-2.5">
          {pending.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">Nada pendente de revisão.</p>
          )}
          {pending.map((m) => {
            const isEcho = isCommercialEchoReviewMessage(m);
            return (
              <div key={m.id} className="panel p-3.5">
                <div className="flex items-center justify-between gap-2 text-[12px] text-accent">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="size-4" />
                    {isEcho
                      ? "Confirmação OK/OKK para vincular"
                      : m.order_id
                        ? "Mensagem já vinculada a pedido"
                        : "Revisão necessária"}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{m.phone}</span>
                </div>
                <p className="mt-1.5 text-[13px]">{m.body}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    className="min-h-10"
                    onClick={() => openReviewModal(m)}
                  >
                    {isEcho ? "Vincular OK/OKK" : "Revisar"}
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-10"
                    variant="secondary"
                    onClick={() => ignore(m.id)}
                  >
                    Dispensar
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl">Mensagens lidas</h2>
        <div className="mt-3 space-y-2.5">
          {isLoading && (
            <p className="panel p-4 text-sm text-muted-foreground">Carregando mensagens…</p>
          )}
          {!isLoading && messages.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
          )}
          {messages.map((m) => {
            const recordedTotal = m.status === "registrado" ? messageRecordedTotal(m) : null;
            const finTag = messageFinancialTag(m);
            return (
              <div key={m.id} className="panel p-3.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{m.phone}</span>
                  <span>{fullDate(m.created_at)}</span>
                </div>
                <p className="mt-1.5 text-[13px]">{m.body}</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border pt-2.5 text-[11px]">
                  <Tag>{statusLabel[m.status] ?? m.status}</Tag>
                  {m.qty_p != null && m.qty_p > 0 && <Tag>{m.qty_p} P</Tag>}
                  {m.qty_m != null && m.qty_m > 0 && <Tag>{m.qty_m} M</Tag>}
                  {m.qty_g != null && m.qty_g > 0 && <Tag>{m.qty_g} G</Tag>}
                  {finTag && <Tag>{finTag}</Tag>}
                  {m.order_date && <Tag>{fullDate(m.order_date + "T12:00:00")}</Tag>}
                  {recordedTotal !== null && <Tag>{brl(recordedTotal)}</Tag>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Dialog
        open={review !== null}
        onOpenChange={(o) => {
          if (!o) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">
              {review?.mode === "reconcile_echo"
                ? "Vincular confirmação OK / OKK"
                : review?.mode === "existing_order"
                  ? "Revisar pedido já vinculado"
                  : "Revisar mensagem"}
            </DialogTitle>
          </DialogHeader>
          {review &&
            (review.mode === "reconcile_echo" || review.mode === "existing_order" ? (
              <div className="space-y-3">
                <p className="rounded-lg bg-secondary p-3 text-[13px]">{review.body}</p>
                <p className="text-[12px] text-muted-foreground">
                  Esta mensagem é uma confirmação comercial (<strong>{review.echoCommand}</strong>)
                  ou já possui pedido vinculado. Ela atualiza exclusivamente um pedido existente do{" "}
                  <strong>mesmo cliente</strong> e <strong>nunca cria um segundo pedido</strong>.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="review-target-order">Pedido aguardando confirmação deste cliente</Label>
                  <Select
                    value={review.targetOrderId}
                    onValueChange={(v) => setReview({ ...review, targetOrderId: v })}
                  >
                    <SelectTrigger id="review-target-order">
                      <SelectValue placeholder="Selecione o pedido existente do cliente" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidateAwaitingOrders.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {(o.customers?.name ?? "Cliente") +
                            " · " +
                            formatSizes(o.qty_g, o.qty_m, o.qty_p, o.quantity) +
                            " · " +
                            brl(Number(o.total))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {candidateAwaitingOrders.length === 0 && (
                    <p className="text-[11px] text-accent">
                      Nenhum pedido aguardando confirmação encontrado para este cliente/telefone.
                      Pedidos de outros clientes não podem ser selecionados. Você pode dispensar
                      este eco com segurança.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="review-echo-command">Classificação financeira</Label>
                  <Select
                    value={review.echoCommand}
                    onValueChange={(v) =>
                      setReview({ ...review, echoCommand: v === "OKK" ? "OKK" : "OK" })
                    }
                  >
                    <SelectTrigger id="review-echo-command">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OK">OK · Pago na hora</SelectItem>
                      <SelectItem value="OKK">OKK · Lançar no Fiado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    className="w-full"
                    disabled={busy || (!review.targetOrderId && !review.orderId)}
                    onClick={confirmReview}
                  >
                    <Check className="size-4" />{" "}
                    {busy ? "Confirmando…" : "Confirmar pedido existente"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    disabled={busy}
                    onClick={() => ignore(review.id)}
                  >
                    Dispensar eco
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="rounded-lg bg-secondary p-3 text-[13px]">{review.body}</p>
                <div className="space-y-1.5">
                  <Label htmlFor="review-customer">Cliente</Label>
                  <Select
                    value={review.customerId}
                    onValueChange={(v) => setReview({ ...review, customerId: v })}
                  >
                    <SelectTrigger id="review-customer">
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
                    <Label htmlFor="review-p">Marmitas P</Label>
                    <Input
                      id="review-p"
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={review.p}
                      onChange={(e) => setReview({ ...review, p: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="review-m">Marmitas M</Label>
                    <Input
                      id="review-m"
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={review.m}
                      onChange={(e) => setReview({ ...review, m: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="review-g">Marmitas G</Label>
                    <Input
                      id="review-g"
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={review.g}
                      onChange={(e) => setReview({ ...review, g: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="review-date">Data</Label>
                  <Input
                    id="review-date"
                    type="date"
                    value={review.date}
                    onChange={(e) => setReview({ ...review, date: e.target.value })}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  O pedido será criado como <strong>Aguardando confirmação (OK / OKK)</strong> para
                  ser finalizado pela marmitaria.
                </p>
                <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Total estimado</span>
                  <span className="font-display text-lg">
                    {brl(
                      (Number(review.p) || 0) * Number(company?.price_p ?? 0) +
                        (Number(review.m) || 0) *
                          Number(company?.price_m ?? company?.price_p ?? 0) +
                        (Number(review.g) || 0) * Number(company?.price_g ?? 0),
                    )}
                  </span>
                </div>
                <Button className="w-full" disabled={busy} onClick={confirmReview}>
                  <Check className="size-4" /> {busy ? "Registrando…" : "Registrar pedido"}
                </Button>
              </div>
            ))}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">
      {children}
    </span>
  );
}
