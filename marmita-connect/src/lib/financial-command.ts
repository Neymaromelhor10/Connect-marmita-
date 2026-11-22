/** Pure preparation only: no imports of database, AI or webhook modules.
 * Inputs MUST be built by a future trusted server adapter, never from browser flags.
 * This evaluator requests a transition; it never commits one.
 */
export type FinancialOrder = {
  id: string;
  companyId: string;
  customerId: string;
  conversationId: string;
  phone: string;
  date: string;
  total: number;
  state: "PENDENTE" | "PAGO" | "FIADO";
  cancelled: boolean;
  paymentState: "NONE" | "PARTIAL" | "UNKNOWN";
  confirmed: boolean;
};

export type FinancialContext = {
  body: string;
  eventId: string | null;
  source: "authenticated_operator" | "verified_business_echo" | "customer" | "unknown";
  actorAuthorized: boolean;
  provenanceVerified: boolean;
  standalone: boolean | null;
  quoted: boolean | null;
  forwarded: boolean | null;
  companyId: string | null;
  customerId: string | null;
  conversationId: string | null;
  phone: string | null;
  today: string | null;
  commandDate: string | null;
  explicitOrderId: string | null;
  processedEventIds: readonly string[];
  orders: readonly FinancialOrder[];
};

export type FinancialDecision = {
  tipo_evento: "confirmacao_financeira";
  comando: "OK" | "OKK" | "NENHUM";
  mensagem_autorizada: boolean;
  cliente_identificado: boolean;
  pedido_identificado: boolean;
  pedido_id: string | null;
  data_pedido: string | null;
  data_confirmacao: string | null;
  status_atual: FinancialOrder["state"] | null;
  status_solicitado: "PAGO" | "FIADO" | "NENHUM";
  valor_pedido: number | null;
  acao_financeira: "SOLICITAR_CLASSIFICACAO" | "NENHUMA";
  motivo: string;
};

const phoneKey = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  return (digits.length === 12 || digits.length === 13) && digits.startsWith("55")
    ? digits.slice(2) : digits;
};

function validDay(day: string | null): day is string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function evaluateFinancialCommand(context: FinancialContext): FinancialDecision {
  const command = context.body === "OK" || context.body === "OKK" ? context.body : "NENHUM";
  const authorized = context.provenanceVerified && context.actorAuthorized &&
    (context.source === "authenticated_operator" || context.source === "verified_business_echo");
  const result: FinancialDecision = {
    tipo_evento: "confirmacao_financeira", comando: command,
    mensagem_autorizada: authorized, cliente_identificado: false,
    pedido_identificado: false, pedido_id: null, data_pedido: null,
    data_confirmacao: validDay(context.commandDate) ? context.commandDate : null,
    status_atual: null, status_solicitado: "NENHUM", valor_pedido: null,
    acao_financeira: "NENHUMA", motivo: "COMANDO_NAO_RECONHECIDO",
  };
  const reject = (reason: string) => ({ ...result, motivo: reason });
  if (command === "NENHUM") return result;
  if (!authorized) return reject("ORIGEM_NAO_AUTORIZADA");
  if (context.standalone !== true || context.quoted !== false || context.forwarded !== false)
    return reject("MENSAGEM_NAO_INDEPENDENTE_OU_METADADOS_INSUFICIENTES");
  if (!context.eventId?.trim()) return reject("EVENTO_NAO_IDENTIFICADO");
  if (context.processedEventIds.includes(context.eventId)) return reject("EVENTO_DUPLICADO");
  if (!validDay(context.today) || !validDay(context.commandDate)) return reject("DATA_LOCAL_INDISPONIVEL");
  if (context.today !== context.commandDate) return reject("COMANDO_FORA_DO_DIA_ATUAL");
  if (!context.companyId || !context.customerId || !context.conversationId ||
      !context.phone || !/^\d{10,11}$/.test(phoneKey(context.phone)))
    return reject("CONTEXTO_NAO_IDENTIFICADO");

  const matchesContext = (order: FinancialOrder) =>
    order.companyId === context.companyId && order.customerId === context.customerId &&
    order.conversationId === context.conversationId && phoneKey(order.phone) === phoneKey(context.phone ?? "");
  const isEligible = (order: FinancialOrder) =>
    order.date === context.today && !order.cancelled && order.state === "PENDENTE" &&
    !order.confirmed && order.paymentState === "NONE";
  let order: FinancialOrder | undefined;
  if (context.explicitOrderId !== null) {
    const explicit = context.orders.filter((item) => item.id === context.explicitOrderId);
    if (explicit.length !== 1) return reject("PEDIDO_EXPLICITO_NAO_IDENTIFICADO");
    order = explicit[0];
    if (!order || !matchesContext(order)) return reject("CONTEXTO_CONFLITANTE");
  } else {
    const current = context.orders.filter((item) => matchesContext(item) && item.date === context.today);
    // Unknown/partial allocations may affect every candidate: never assume a free order.
    if (current.some((item) => !item.cancelled && item.paymentState !== "NONE"))
      return reject("PAGAMENTO_PARCIAL_OU_NAO_RASTREAVEL");
    const eligible = current.filter(isEligible);
    if (eligible.length > 1) return reject("MULTIPLOS_PEDIDOS_ELEGIVEIS");
    order = eligible[0];
    if (!order) return reject("SEM_PEDIDO_ELEGIVEL");
  }
  result.cliente_identificado = true;
  result.pedido_identificado = true;
  result.pedido_id = order.id;
  result.data_pedido = order.date;
  result.status_atual = order.state;
  result.valor_pedido = Number.isFinite(order.total) && order.total > 0 ? order.total : null;
  if (order.date !== context.today) return reject("PEDIDO_FORA_DO_PERIODO_PERMITIDO");
  if (order.cancelled) return reject("PEDIDO_CANCELADO");
  if (order.confirmed || order.state !== "PENDENTE") return reject("PEDIDO_JA_CLASSIFICADO");
  if (order.paymentState !== "NONE") return reject("PAGAMENTO_PARCIAL_OU_NAO_RASTREAVEL");
  if (result.valor_pedido === null) return reject("VALOR_INVALIDO");
  return { ...result, status_solicitado: command === "OK" ? "PAGO" : "FIADO",
    acao_financeira: "SOLICITAR_CLASSIFICACAO", motivo: "CONFIRMACAO_VALIDADA" };
}