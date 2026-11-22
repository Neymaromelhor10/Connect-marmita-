export const brl = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);

/** Fuso de negócio: todas as marmitarias são brasileiras (horário de Brasília). */
export const BUSINESS_TZ = "America/Sao_Paulo";

/** "YYYY-MM-DD" é data de calendário: não passa por new Date() (viraria UTC e voltaria um dia). */
const asDate = (d: string | Date) => {
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, dd] = d.split("-").map(Number);
    return { date: new Date(Date.UTC(y!, m! - 1, dd!, 12)), tz: "UTC" };
  }
  return { date: new Date(d), tz: BUSINESS_TZ };
};

export const shortDate = (d: string | Date) => {
  const { date, tz } = asDate(d);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: tz }).format(date);
};

export const fullDate = (d: string | Date) => {
  const { date, tz } = asDate(d);
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: tz,
  }).format(date);
};

export const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

export const onlyDigits = (s: string) => s.replace(/\D/g, "");

/**
 * CORREÇÃO AUD6-01:
 * Função canônica única de normalização telefônica brasileira no TypeScript,
 * 100% alinhada à função SQL `public.financial_phone_key(raw text)`:
 * - Trata `null`, `undefined`, booleanos e objetos com segurança (retorna `""`);
 * - Remove todos os caracteres não numéricos;
 * - Remove o prefixo internacional `55` quando o número possui 12 ou 13 dígitos
 *   iniciados por `55` (DDD de 2 dígitos + 8 ou 9 dígitos locais);
 * - Preserva números brasileiros com DDD (10 ou 11 dígitos) e sem DDD (8 ou 9 dígitos);
 * - Retorna `""` para entradas vazias ou sem dígitos.
 */
export function normalizePhone(raw: unknown): string {
  if (raw === null || raw === undefined || typeof raw === "boolean" || typeof raw === "object") {
    return "";
  }
  const d = String(raw).replace(/\D/g, "");
  if (!d) return "";
  return (d.length === 12 || d.length === 13) && d.startsWith("55") ? d.slice(2) : d;
}

/**
 * Verifica se um telefone normalizado é válido segundo a regra operacional e de banco
 * (entre 8 e 15 dígitos numéricos após normalização canônica).
 */
export function isValidNormalizedPhone(raw: unknown): boolean {
  const norm = normalizePhone(raw);
  return norm.length >= 8 && norm.length <= 15;
}

/**
 * Formata um telefone brasileiro para exibição amigável `(DD) 9XXXX-XXXX` ou `(DD) XXXX-XXXX`.
 */
export function formatPhone(raw: unknown): string {
  const d = normalizePhone(raw);
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return d;
}

function formatPartsISO(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** Dia de calendário no Brasil (YYYY-MM-DD), independente do fuso ou pacote ICU do navegador/servidor. */
export function brToday(now: Date = new Date()) {
  return formatPartsISO(now, BUSINESS_TZ);
}

/** Converte qualquer timestamp ISO/Date para a data local no Brasil (YYYY-MM-DD). */
export function brDateISO(value: string | Date) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(parsed.getTime())) return String(value).slice(0, 10);
  return formatPartsISO(parsed, BUSINESS_TZ);
}

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};

export function isoDay(offsetDays = 0) {
  return addDays(brToday(), offsetDays);
}

export function startOfWeekISO() {
  const today = brToday();
  const [y, m, d] = today.split("-").map(Number);
  const dow = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
  return addDays(today, -dow);
}

export function startOfMonthISO() {
  return brToday().slice(0, 8) + "01";
}

/** Formata resumo de tamanhos P / M / G de forma concisa e legível. */
export function formatSizes(
  qtyG: number | null | undefined,
  qtyM: number | null | undefined,
  qtyP: number | null | undefined,
  fallbackQty?: number,
): string {
  const g = qtyG ?? 0;
  const m = qtyM ?? 0;
  const p = qtyP ?? 0;
  if (g + m + p === 0) {
    return fallbackQty != null ? `${fallbackQty} marmitas` : "0 marmitas";
  }
  const parts: string[] = [];
  if (g > 0 || (m === 0 && p > 0)) parts.push(`${g} G`);
  if (m > 0) parts.push(`${m} M`);
  if (p > 0 || (m === 0 && g > 0)) parts.push(`${p} P`);
  return parts.join(" + ");
}

export const cycleLabel: Record<string, string> = {
  diario: "Diário",
  semanal: "Semanal",
  quinzenal: "Quinzenal",
  mensal: "Mensal",
};

export const statusLabel: Record<string, string> = {
  em_dia: "Em dia",
  pendente: "Pendente",
  atrasado: "Atrasado",
};

export const deliveryLabel: Record<string, string> = {
  pendente: "Pendente",
  preparando: "Preparando",
  em_rota: "Em rota",
  entregue: "Entregue",
  cancelado: "Cancelado",
};

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
    .join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
