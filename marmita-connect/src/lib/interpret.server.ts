import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { brToday, normalizePhone } from "./format";
import { evaluateFinancialCommand } from "./financial-command";
import {
  emitOperationalAlert,
  sanitizeFreeTextForOperationalLog,
} from "./operational-alerts.server";

export type MessageInput = {
  phone: string;
  body: string;
  externalId?: string | undefined;
  messageId?: string | undefined;
};

export const parsedMessageSchema = z.object({
  eh_pedido: z.boolean(),
  nome: z.string().nullable().optional().default(null),
  qtd_g: z.number().nullable().optional().default(null),
  qtd_m: z.number().nullable().optional().default(null),
  qtd_p: z.number().nullable().optional().default(null),
  data: z.string().nullable().optional().default(null),
  fiado: z.boolean().optional().default(false),
  qtd_pagar_depois: z.number().nullable().optional().default(null),
  motivo: z.string().nullable().optional().default(null),
});

export type ParsedMessage = z.infer<typeof parsedMessageSchema>;

export const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 10_000;
const GEMINI_MAX_ATTEMPTS = 3;

export const MAX_INBOUND_AUTO_ATTEMPTS = 5;
export const MAX_MANUAL_RETRIES = 3;
export const MANUAL_RETRY_COOLDOWN_SECONDS = 30;

export function computeInboundErrorBackoffMs(
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const normalizedAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
  const baseMs = Math.min(300_000, 15_000 * Math.pow(2, Math.max(0, normalizedAttempt - 1)));
  const jitterMs = Math.floor(Math.max(0, Math.min(1, randomFn())) * 2_500);
  return Math.min(300_000, baseMs + jitterMs);
}

/**
 * CORREÇÃO AUD6-01:
 * Delega para `normalizePhone` em `./format`, unificando a normalização de telefone
 * entre frontend, backend e a função SQL `public.financial_phone_key`.
 */
export const phoneKey = (raw: string | null | undefined): string => normalizePhone(raw);

async function sha(input: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deterministicUuid(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return input.toLowerCase();
  }
  const hex = await sha(input);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const parseQty = (val: unknown): number | null =>
  val !== null && val !== undefined && val !== "" && Number.isFinite(Number(val))
    ? Math.max(0, Math.trunc(Number(val)))
    : null;

async function loadCompanyCustomers(supabase: SupabaseClient<Database>, companyId: string) {
  const out: { id: string; name: string; phone: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const base = supabase
      .from("customers")
      .select("id, name, phone")
      .eq("company_id", companyId);

    const hasOrderAndRange =
      typeof (base as unknown as { order?: unknown }).order === "function";

    if (!hasOrderAndRange) {
      const res = await base;
      if (res.error) throw new Error(res.error.message);
      return res.data ?? [];
    }

    const res = await base.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (res.error) throw new Error(res.error.message);
    out.push(...(res.data ?? []));
    if (!res.data || res.data.length < PAGE) break;
  }
  return out;
}

async function lookupCustomerByPhoneFast(
  supabase: SupabaseClient<Database>,
  companyId: string,
  normalizedKey: string,
): Promise<{
  customer: { id: string; name: string; phone: string } | null;
  rpcAuthoritative: boolean;
}> {
  if (!normalizedKey) return { customer: null, rpcAuthoritative: true };
  const maybeRpc = (
    supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: { id: string; name: string; phone: string }[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    try {
      const rpcRes = await maybeRpc.call(supabase, "find_customer_by_phone", {
        _company_id: companyId,
        _phone: normalizedKey,
      });
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        return {
          customer: rpcRes.data[0] ?? null,
          rpcAuthoritative: true,
        };
      }
      if (rpcRes.error && rpcRes.error.code === "42501") {
        throw new Error(rpcRes.error.message);
      }
    } catch (err) {
      if (err instanceof Error && /Acesso negado/i.test(err.message)) {
        throw err;
      }
    }
  }
  return { customer: null, rpcAuthoritative: false };
}

export async function getOrCreateCustomerByPhoneAtomic(
  supabase: SupabaseClient<Database>,
  companyId: string,
  phone: string,
  name: string,
  normalizedKey?: string,
): Promise<{ id: string; name: string; phone: string }> {
  const normKey = phoneKey(normalizedKey || phone);
  if (!companyId || normKey.length < 8 || normKey.length > 15) {
    throw new Error("Telefone inválido para criação ou busca de cliente.");
  }

  const maybeRpc = (
    supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: { id: string; name: string; phone: string; created?: boolean }[] | null;
        error: { code?: string; message: string } | null;
      }>;
    }
  ).rpc;

  if (typeof maybeRpc === "function") {
    const rpcRes = await maybeRpc.call(supabase, "get_or_create_customer_by_phone", {
      _company_id: companyId,
      _phone: normKey,
      _name: name,
    });
    if (!rpcRes.error && Array.isArray(rpcRes.data) && rpcRes.data[0]) {
      return rpcRes.data[0];
    }
    if (
      rpcRes.error &&
      rpcRes.error.code !== "PGRST202" &&
      rpcRes.error.code !== "42883" &&
      rpcRes.error.code !== "23505"
    ) {
      throw new Error(rpcRes.error.message);
    }
  }

  const created = await supabase
    .from("customers")
    .insert({ company_id: companyId, phone: normKey, name })
    .select("id, name, phone")
    .single();

  if (!created.error && created.data) {
    return created.data;
  }

  const isUniqueConflict =
    created.error?.code === "23505" ||
    /duplicate key|unique|Já existe um cliente/i.test(created.error?.message ?? "");

  if (isUniqueConflict) {
    const retryLookup = await lookupCustomerByPhoneFast(supabase, companyId, normKey);
    if (retryLookup.customer) {
      return retryLookup.customer;
    }
    if (!retryLookup.rpcAuthoritative) {
      const again = await loadCompanyCustomers(supabase, companyId);
      const found = again.find((c) => phoneKey(c.phone) === normKey) ?? null;
      if (found) return found;
    }
  }

  throw new Error(created.error?.message ?? "Falha ao localizar ou criar cliente por telefone");
}

/**
 * CORREÇÃO AUD-01, AUD5-02 & C-09 / M-02 (Seções 4.2 e 4.4 — Fail-Closed Ownership Check):
 * Verifica se o worker atual ainda detém a posse do lease da mensagem (`locked_by === workerId`,
 * `lease_generation === leaseGeneration`, `status === 'processando'` e `locked_until` válido)
 * antes de gravar efeitos colaterais.
 * - Quando `workerId` está presente (execução via worker da fila), a verificação é estritamente
 *   FAIL-CLOSED: se `leaseGeneration` for inválida (`< 1` ou `null`), se a consulta ao banco
 *   falhar ou retornar vazio, ou se `locked_by`/`lease_generation`/`locked_until` divergirem,
 *   retorna `false` imediatamente.
 */
/**
 * CORREÇÃO AUD-M02-02:
 * Normalizador central e estrito para `lease_generation` (PostgreSQL `bigint` / `INT8`):
 * - Aceita `number` somente quando finito, inteiro seguro (`Number.isSafeInteger`) e `>= 1`;
 * - Aceita `string` somente quando for representação decimal inteira positiva estrita (`/^[1-9]\d*$/`),
 *   sem espaços, sinais, decimais ou notação científica, e dentro de `Number.MAX_SAFE_INTEGER`
 *   com round-trip exato (`String(parsed) === raw`), evitando qualquer perda de precisão;
 * - Rejeita `0`, `"0"`, negativos, decimais, notação científica, string vazia, espaços, `null`,
 *   `undefined`, `NaN`, `Infinity` e valores acima de `Number.MAX_SAFE_INTEGER`.
 */
export function normalizeFencingGeneration(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (Number.isFinite(raw) && Number.isSafeInteger(raw) && raw >= 1) {
      return raw;
    }
    return null;
  }
  if (typeof raw === "string") {
    if (raw.length === 0 || raw !== raw.trim()) {
      return null;
    }
    if (!/^[1-9]\d*$/.test(raw)) {
      return null;
    }
    const parsed = Number(raw);
    if (
      Number.isFinite(parsed) &&
      Number.isSafeInteger(parsed) &&
      parsed >= 1 &&
      String(parsed) === raw
    ) {
      return parsed;
    }
    return null;
  }
  return null;
}

export function isValidFencingGeneration(gen: unknown): gen is number {
  return normalizeFencingGeneration(gen) !== null;
}

export async function verifyWorkerStillOwnsLease(
  supabase: SupabaseClient<Database>,
  messageId: string | null,
  workerId: string | null,
  leaseGeneration: number | string | null | undefined,
): Promise<boolean> {
  if (!workerId) return true;
  const expectedGen = normalizeFencingGeneration(leaseGeneration);
  if (!messageId || !workerId.trim() || expectedGen === null) {
    return false;
  }

  try {
    const check = await supabase
      .from("whatsapp_messages")
      .select("id, status, order_id, locked_by, lease_generation, locked_until")
      .eq("id", messageId)
      .maybeSingle();

    if (check.error || !check.data) {
      return false;
    }

    const row = check.data as {
      status?: string | null;
      order_id?: string | null;
      locked_by?: string | null;
      lease_generation?: number | string | null;
      locked_until?: string | null;
    };

    if (row.order_id) return false;
    if (!row.status || row.status !== "processando") return false;
    if (!row.locked_by || row.locked_by !== workerId) return false;
    const actualGen = normalizeFencingGeneration(row.lease_generation);
    if (actualGen === null || actualGen !== expectedGen) {
      return false;
    }
    if (!row.locked_until) {
      return false;
    }
    const expMs = Date.parse(row.locked_until);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function buildSystemInstruction(today: string): string {
  return (
    `Você lê mensagens de clientes de uma marmitaria brasileira e extrai APENAS cliente e quantidades do pedido. ` +
    `Hoje é ${today}. Marmitas têm três tamanhos: P (pequena), M (média) e G (grande). ` +
    `Responda SOMENTE com JSON: {"eh_pedido":bool,"nome":string|null,"qtd_g":number|null,"qtd_m":number|null,"qtd_p":number|null,"data":"YYYY-MM-DD"|null,"motivo":string|null}. ` +
    `Regras: entenda "3G", "3 grandes", "três grandes", "2M", "2 médias", "duas médias", "1P", "1 pequena", "uma pequena". ` +
    `NUNCA invente quantidades nem tamanhos: se a mensagem não disser o número ("manda umas grandes", "as de sempre") ou pedir marmita sem especificar tamanho ("manda 2 marmitas"), deixe as quantidades como null e explique em motivo. ` +
    `NUNCA decida se o pedido está pago ou fiado: ignore frases como "vou pagar agora", "coloca na conta" ou "depois eu pago", pois a confirmação financeira (OK ou OKK) é exclusiva da marmitaria. ` +
    `"nome" é o nome do CLIENTE que pede (não o do atendente a quem a mensagem é dirigida); se incerto, null. ` +
    `Saudações, dúvidas de preço, agradecimentos e avisos de pagamento têm eh_pedido=false. ` +
    `Nunca calcule valores em dinheiro.`
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function callGeminiExtractOrder(
  body: string,
  today: string,
  options?: { maxAttempts?: number; baseDelayMs?: number; timeoutMs?: number },
): Promise<ParsedMessage> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new Error("IA indisponível: configure a variável GEMINI_API_KEY no servidor.");
  }

  const maxAttempts = options?.maxAttempts ?? GEMINI_MAX_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? 300;
  const timeoutMs = options?.timeoutMs ?? GEMINI_TIMEOUT_MS;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: buildSystemInstruction(today) }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: body }],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                eh_pedido: { type: "BOOLEAN" },
                nome: { type: "STRING", nullable: true },
                qtd_g: { type: "INTEGER", nullable: true },
                qtd_m: { type: "INTEGER", nullable: true },
                qtd_p: { type: "INTEGER", nullable: true },
                data: { type: "STRING", nullable: true },
                motivo: { type: "STRING", nullable: true },
              },
              required: ["eh_pedido"],
            },
          },
        }),
      });

      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        const isRateLimit = res.status === 429;
        lastError = new Error(
          isRateLimit
            ? "Limite de requisições da API Gemini atingido. A mensagem foi salva para reprocessamento."
            : `Serviço Gemini temporariamente indisponível (HTTP ${res.status}).`,
        );
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw lastError;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error("Chave GEMINI_API_KEY inválida ou sem permissão na Google AI API.");
      }

      if (!res.ok) {
        throw new Error(`Não foi possível interpretar a mensagem no Gemini (HTTP ${res.status}).`);
      }

      const payload = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        choices?: { message?: { content?: string } }[];
      };

      const rawText =
        payload.candidates?.[0]?.content?.parts?.[0]?.text ??
        payload.choices?.[0]?.message?.content ??
        "";

      if (!rawText.trim()) {
        throw new Error("A IA retornou uma resposta vazia.");
      }

      let rawJson: unknown;
      try {
        rawJson = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      } catch {
        throw new Error("A IA respondeu em formato JSON inválido.");
      }

      const validated = parsedMessageSchema.safeParse(rawJson);
      if (!validated.success) {
        throw new Error("A resposta da IA não cumpriu o contrato esperado de pedido.");
      }

      return validated.data;
    } catch (err) {
      clearTimeout(timer);
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || /aborted|timeout/i.test(err.message));
      const isNetwork =
        err instanceof TypeError ||
        (err instanceof Error && /fetch|network|ECONNRESET|ETIMEDOUT/i.test(err.message));

      if ((isAbort || isNetwork) && attempt < maxAttempts) {
        lastError = isAbort
          ? new Error("Tempo limite excedido ao consultar a API Gemini.")
          : err instanceof Error
            ? err
            : new Error(String(err));
        await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        continue;
      }

      if (isAbort) {
        throw new Error(
          "Tempo limite excedido ao consultar a API Gemini. A mensagem foi salva para reprocessamento.",
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Falha ao consultar a API Gemini.");
}

export async function processIncomingMessage(
  supabase: SupabaseClient<Database>,
  companyId: string,
  data: MessageInput,
  extra?: Record<string, unknown>,
) {
  const rawPhoneDigits = data.phone.replace(/\D/g, "");
  const key = phoneKey(rawPhoneDigits);
  const phone = key || rawPhoneDigits;
  const body = data.body.trim();
  const today = brToday();

  const workerId =
    typeof extra?.["worker_id"] === "string" && extra["worker_id"].trim()
      ? extra["worker_id"].trim()
      : null;
  const leaseGeneration = normalizeFencingGeneration(extra?.["lease_generation"]);
  const manualRetryCount = Math.min(
    MAX_MANUAL_RETRIES,
    Math.max(0, Number(extra?.["manual_retry_count"] ?? 0) || 0),
  );

  // C-09: Quando chamado pelo worker da fila, exige obrigatoriamente leaseGeneration inteiro positivo >= 1
  if (
    workerId &&
    (leaseGeneration === null || !Number.isInteger(leaseGeneration) || leaseGeneration < 1)
  ) {
    throw new Error(
      "Falha segura de fencing: worker da fila deve informar lease_generation inteiro positivo (>= 1).",
    );
  }

  const dbExtra: Record<string, unknown> = { ...(extra ?? {}) };
  delete dbExtra["worker_id"];
  delete dbExtra["lease_generation"];
  delete dbExtra["manual_retry_count"];

  const uid = data.externalId?.trim() || (await sha(`${companyId}|${phone}|${body}|${today}`));
  const dup = await supabase
    .from("whatsapp_messages")
    .select("id, status, order_id")
    .eq("company_id", companyId)
    .eq("message_uid", uid)
    .maybeSingle();

  if (dup.data && dup.data.order_id) {
    return {
      duplicate: true,
      completedByRpc: false,
      status: dup.data.status,
      messageId: dup.data.id,
      orderId: dup.data.order_id,
      parsed: null,
    };
  }

  if (
    dup.data &&
    dup.data.status !== "erro" &&
    dup.data.status !== "processando" &&
    dup.data.status !== "aguardando"
  ) {
    return {
      duplicate: true,
      completedByRpc: false,
      status: dup.data.status,
      messageId: dup.data.id,
      parsed: null,
    };
  }

  let messageId = data.messageId ?? dup.data?.id ?? null;

  if (/^okk?$/i.test(body)) {
    const customerAttempt = evaluateFinancialCommand({
      body: body.toUpperCase(),
      eventId: uid,
      source: "customer",
      actorAuthorized: false,
      provenanceVerified: false,
      standalone: true,
      quoted: false,
      forwarded: false,
      companyId,
      customerId: null,
      conversationId: null,
      phone: phone || null,
      today,
      commandDate: today,
      explicitOrderId: null,
      processedEventIds: [],
      orders: [],
    });

    const ignoredParsed = {
      eh_pedido: false,
      nome: null,
      qtd_g: null,
      qtd_m: null,
      qtd_p: null,
      data: today,
      fiado: false,
      motivo: customerAttempt.motivo,
    };

    // C-09: Quando em execução pelo worker da fila (workerId presente), não executa UPDATE direto;
    // retorna para que drainWhatsAppQueue finalize exclusivamente via release_whatsapp_message_lock RPC
    if (workerId) {
      if (!(await verifyWorkerStillOwnsLease(supabase, messageId, workerId, leaseGeneration))) {
        return {
          duplicate: false,
          completedByRpc: false,
          leaseLost: true,
          status: "processando" as const,
          messageId,
          orderId: null,
          customerName: null,
          parsed: null,
        };
      }
      return {
        duplicate: false,
        completedByRpc: false,
        status: "ignorado" as const,
        messageId,
        orderId: null,
        customerName: null,
        parsed: ignoredParsed,
      };
    }

    const ignoredRecord = {
      company_id: companyId,
      customer_id: null,
      phone: phone || "sem-telefone",
      direction: "inbound",
      body,
      parsed: ignoredParsed,
      order_id: null,
      status: "ignorado" as const,
      qty_g: null,
      qty_p: null,
      fiado: false,
      order_date: today,
      locked_until: null,
      locked_by: null,
      ...(messageId && !data.externalId ? {} : { message_uid: uid }),
      ...dbExtra,
    };

    if (messageId) {
      await supabase.from("whatsapp_messages").update(ignoredRecord as never).eq("id", messageId);
    } else {
      const ins = await supabase
        .from("whatsapp_messages")
        .insert(ignoredRecord as never)
        .select("id")
        .single();
      messageId = ins.data?.id ?? null;
    }

    return {
      duplicate: false,
      completedByRpc: false,
      status: "ignorado" as const,
      messageId,
      orderId: null,
      customerName: null,
      parsed: ignoredParsed,
    };
  }

  if (!messageId && !workerId) {
    const manualLockUntilIso = new Date(Date.now() + 90_000).toISOString();
    const preClaim = await supabase
      .from("whatsapp_messages")
      .insert({
        company_id: companyId,
        phone: phone || "sem-telefone",
        direction: "inbound",
        body,
        status: "processando",
        message_uid: uid,
        order_date: today,
        locked_until: manualLockUntilIso,
        ...dbExtra,
      } as never)
      .select("id")
      .single();
    if (preClaim.data) {
      messageId = (preClaim.data as { id: string }).id;
    }
  }

  let parsed: ParsedMessage;
  try {
    parsed = await callGeminiExtractOrder(body, today);
  } catch (aiErr) {
    const rawErrMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
    const errMsg = sanitizeFreeTextForOperationalLog(rawErrMsg);
    const rawAttempts = Number(dbExtra["attempts"] ?? 0) || 0;
    const effectiveAttempts = rawAttempts > 0 ? rawAttempts : 1;
    const maxAllowedAttempts = MAX_INBOUND_AUTO_ATTEMPTS + manualRetryCount;
    const shouldMoveToReviewDeadLetter = effectiveAttempts >= maxAllowedAttempts;

    const backoffMs = computeInboundErrorBackoffMs(effectiveAttempts);
    const nextRetryAt = shouldMoveToReviewDeadLetter
      ? null
      : new Date(Date.now() + backoffMs).toISOString();
    const targetErrorStatus: "erro" | "revisar" = shouldMoveToReviewDeadLetter
      ? "revisar"
      : "erro";
    const parsedFailurePayload = shouldMoveToReviewDeadLetter
      ? {
          eh_pedido: false,
          motivo: "FALHA_IA_ENCAMINHADA_PARA_REVISAO",
          dead_letter: {
            reason: "FALHA_IA_APOS_LIMITE_DE_TENTATIVAS",
            attempts: effectiveAttempts,
            manual_retry_count: manualRetryCount,
            last_error: errMsg,
            transitioned_at: new Date().toISOString(),
          },
        }
      : { eh_pedido: false, motivo: `Falha IA: ${errMsg}` };

    if (messageId && (await verifyWorkerStillOwnsLease(supabase, messageId, workerId, leaseGeneration))) {
      if (workerId) {
        // C-09: No worker da fila, a liberação em falha usa exclusivamente a RPC oficial com fencing token
        const maybeRpc = (
          supabase as unknown as {
            rpc?: (
              fn: string,
              args: Record<string, unknown>,
            ) => PromiseLike<{ data: boolean | null; error: { code?: string; message: string } | null }>;
          }
        ).rpc;

        if (typeof maybeRpc === "function") {
          try {
            await maybeRpc.call(supabase, "release_whatsapp_message_lock", {
              _message_id: messageId,
              _worker_id: workerId,
              _final_status: targetErrorStatus,
              _last_error: errMsg,
              _next_retry_at: nextRetryAt,
              _lease_generation: leaseGeneration,
              _order_id: null,
              _parsed: parsedFailurePayload,
            });
          } catch {
            // drainWhatsAppQueue tratará a liberação via releaseWhatsAppMessageLockSafe no bloco catch
          }
        }
      } else {
        const errUpdate = await supabase
          .from("whatsapp_messages")
          .update({
            status: targetErrorStatus,
            locked_until: null,
            locked_by: null,
            next_retry_at: nextRetryAt,
            last_error: errMsg,
            parsed: parsedFailurePayload,
          } as never)
          .eq("id", messageId);

        if (errUpdate.error && /locked_until|locked_by|next_retry_at|last_error/i.test(errUpdate.error.message)) {
          await supabase
            .from("whatsapp_messages")
            .update({
              status: targetErrorStatus,
              parsed: parsedFailurePayload,
            } as never)
            .eq("id", messageId);
        }
      }
    }

    if (effectiveAttempts >= 3 || shouldMoveToReviewDeadLetter) {
      await emitOperationalAlert({
        code: shouldMoveToReviewDeadLetter
          ? "WHATSAPP_INBOUND_DEAD_LETTER_REVIEW"
          : "GEMINI_INTERPRETATION_FAILURE",
        severity: "warning",
        title: shouldMoveToReviewDeadLetter
          ? "Mensagem inbound encaminhada para revisão após esgotar tentativas automáticas da IA"
          : "Falhas consecutivas na interpretação Gemini",
        details: {
          companyId,
          messageId,
          attempts: effectiveAttempts,
          manualRetryCount,
          transitionedToReview: shouldMoveToReviewDeadLetter,
          error: errMsg,
        },
      });
    }
    throw aiErr;
  }

  // AUD-01 & C-09: Verifica obrigatoriamente que o lease ainda pertence a este worker após o retorno assíncrono do Gemini!
  if (!(await verifyWorkerStillOwnsLease(supabase, messageId, workerId, leaseGeneration))) {
    return {
      duplicate: false,
      completedByRpc: false,
      leaseLost: true,
      status: "processando" as const,
      messageId,
      orderId: null,
      customerName: null,
      parsed: null,
    };
  }

  const g = parseQty(parsed.qtd_g);
  const m = parseQty(parsed.qtd_m);
  const p = parseQty(parsed.qtd_p);
  const orderDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.data ?? "") ? parsed.data! : today;

  let customer: { id: string; name: string; phone?: string } | null = null;
  let rpcAuthoritative = false;
  if (key) {
    const fastLookup = await lookupCustomerByPhoneFast(supabase, companyId, key);
    customer = fastLookup.customer;
    rpcAuthoritative = fastLookup.rpcAuthoritative;
  }

  if (!customer && !rpcAuthoritative && key) {
    const list = await loadCompanyCustomers(supabase, companyId);
    customer = list.find((c) => phoneKey(c.phone) === key) ?? null;
  }

  if (!customer && !phone) {
    const list = await loadCompanyCustomers(supabase, companyId);
    if (parsed.nome?.trim()) {
      const target = norm(parsed.nome);
      customer = list.find((c) => norm(c.name) === target) ?? null;
    }
    if (!customer) {
      const text = norm(data.body);
      const hits = list.filter((c) => {
        const n = norm(c.name);
        const first = n.split(" ")[0] ?? "";
        const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return first.length >= 3 && new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(text);
      });
      if (hits.length === 1) customer = hits[0] ?? null;
    }
  }

  if (!customer && phone.length >= 8 && phone.length <= 15 && parsed.eh_pedido) {
    const profileName =
      typeof dbExtra["profile_name"] === "string" ? String(dbExtra["profile_name"]).trim() : "";
    const name = profileName || parsed.nome?.trim() || phone;
    customer = await getOrCreateCustomerByPhoneAtomic(supabase, companyId, phone, name, key);
  }

  const totalQty = (g ?? 0) + (m ?? 0) + (p ?? 0);
  const hasQty = totalQty > 0;
  const needsReview = parsed.eh_pedido && (!hasQty || !customer);
  const status: "registrado" | "revisar" | "ignorado" = !parsed.eh_pedido
    ? "ignorado"
    : needsReview
      ? "revisar"
      : "registrado";

  const parsedPayload = JSON.parse(
    JSON.stringify({
      eh_pedido: Boolean(parsed.eh_pedido),
      nome: parsed.nome ?? null,
      qtd_g: g,
      qtd_m: m,
      qtd_p: p,
      data: orderDate,
      fiado: false,
      motivo: parsed.motivo ?? null,
    }),
  );

  let orderId: string | null = null;
  let completedByRpc = false;

  if (status === "registrado" && customer) {
    if (!(await verifyWorkerStillOwnsLease(supabase, messageId, workerId, leaseGeneration))) {
      return {
        duplicate: false,
        completedByRpc: false,
        leaseLost: true,
        status: "processando" as const,
        messageId,
        orderId: null,
        customerName: null,
        parsed: null,
      };
    }

    const custPhoneKey = phoneKey(customer.phone || phone);
    const creationEventUuid = await deterministicUuid(
      `${companyId}:wa_msg:${messageId ?? uid}`,
    );
    const maybeRpc = (
      supabase as unknown as {
        rpc?: (
          fn: string,
          args: Record<string, unknown>,
        ) => PromiseLike<{
          data: string | null;
          error: { code?: string; message: string } | null;
        }>;
      }
    ).rpc;

    if (messageId && typeof maybeRpc === "function") {
      try {
        const rpcOrder = await maybeRpc.call(supabase, "complete_whatsapp_message_order", {
          _message_id: messageId,
          _company_id: companyId,
          _customer_id: customer.id,
          _qty_p: p ?? 0,
          _qty_m: m ?? 0,
          _qty_g: g ?? 0,
          _order_date: orderDate,
          _parsed: parsedPayload,
          _creation_event: creationEventUuid,
          _phone_key: custPhoneKey || "",
          _source: "mensagem",
          _worker_id: workerId,
          _lease_generation: leaseGeneration,
        });
        if (!rpcOrder.error && typeof rpcOrder.data === "string" && rpcOrder.data) {
          orderId = rpcOrder.data;
          completedByRpc = true;
        } else if (rpcOrder.error) {
          if (
            rpcOrder.error.code === "55P03" ||
            /LEASE_LOST/i.test(rpcOrder.error.message)
          ) {
            return {
              duplicate: false,
              completedByRpc: false,
              leaseLost: true,
              status: "processando" as const,
              messageId,
              orderId: null,
              customerName: null,
              parsed: null,
            };
          }
          if (workerId || (rpcOrder.error.code !== "PGRST202" && rpcOrder.error.code !== "42883")) {
            throw new Error(rpcOrder.error.message);
          }
        }
      } catch (err) {
        if (err instanceof Error && /LEASE_LOST/i.test(err.message)) {
          return {
            duplicate: false,
            completedByRpc: false,
            leaseLost: true,
            status: "processando" as const,
            messageId,
            orderId: null,
            customerName: null,
            parsed: null,
          };
        }
        if (workerId || (err instanceof Error && !/PGRST202|42883|not a function/i.test(err.message))) {
          throw err;
        }
      }
    }

    // C-09: Quando em execução pelo worker da fila (workerId presente), exige obrigatoriamente
    // que a criação do pedido e finalização da mensagem tenham ocorrido via complete_whatsapp_message_order RPC!
    if (workerId && (!completedByRpc || !orderId)) {
      throw new Error(
        "Falha segura de finalização: RPC complete_whatsapp_message_order não confirmou a conclusão com fencing token.",
      );
    }

    if (completedByRpc && orderId) {
      return {
        duplicate: false,
        completedByRpc: true,
        leaseLost: false,
        status: "registrado" as const,
        messageId,
        orderId,
        financialState: "aguardando_classificacao" as const,
        customerName: customer.name ?? parsed.nome ?? null,
        parsed: {
          eh_pedido: Boolean(parsed.eh_pedido),
          nome: parsed.nome ?? null,
          qtd_g: g,
          qtd_m: m,
          qtd_p: p,
          data: orderDate,
          fiado: false,
          motivo: parsed.motivo ?? null,
        },
      };
    }

    if (!orderId && !workerId) {
      const convId = `wa:${companyId}:${customer.id}`;
      const baseOrderPayload = {
        company_id: companyId,
        customer_id: customer.id,
        qty_g: g ?? 0,
        qty_p: p ?? 0,
        quantity: totalQty,
        unit_price: 0,
        order_date: orderDate,
        paid: false,
        settled_by_payment: false,
        source: "mensagem",
      };
      const fullOrderPayload = {
        ...baseOrderPayload,
        qty_m: m ?? 0,
        financial_state: "aguardando_classificacao",
        financial_conversation_id: convId,
        financial_phone: custPhoneKey || null,
        financial_creation_event: creationEventUuid,
      };

      let order = await supabase
        .from("orders")
        .insert(fullOrderPayload as never)
        .select("id")
        .single();
      if (order.error && /qty_m|financial_/i.test(order.error.message)) {
        order = await supabase.from("orders").insert(baseOrderPayload).select("id").single();
      }
      if (order.error) throw new Error(order.error.message);
      orderId = order.data.id;
    }
  }

  // C-09: Quando chamado pelo worker da fila (workerId presente), não realiza UPDATE direto em
  // whatsapp_messages; retorna para que drainWhatsAppQueue execute releaseWhatsAppMessageLockSafe
  if (workerId) {
    if (!(await verifyWorkerStillOwnsLease(supabase, messageId, workerId, leaseGeneration))) {
      return {
        duplicate: false,
        completedByRpc: false,
        leaseLost: true,
        status: "processando" as const,
        messageId,
        orderId,
        customerName: customer?.name ?? parsed.nome ?? null,
        parsed: null,
      };
    }
    return {
      duplicate: false,
      completedByRpc: false,
      leaseLost: false,
      status,
      messageId,
      orderId,
      financialState: orderId ? ("aguardando_classificacao" as const) : null,
      customerName: customer?.name ?? parsed.nome ?? null,
      parsed: parsedPayload,
    };
  }

  const baseRecord = {
    company_id: companyId,
    customer_id: customer?.id ?? null,
    phone: phone || "sem-telefone",
    direction: "inbound",
    body,
    parsed: parsedPayload,
    order_id: orderId,
    status,
    qty_g: g,
    qty_p: p,
    fiado: false,
    order_date: orderDate,
    locked_until: null,
    locked_by: null,
    next_retry_at: null,
    last_error: null,
    ...(messageId && !data.externalId ? {} : { message_uid: uid }),
    ...dbExtra,
  };

  if (messageId) {
    let upd = await supabase
      .from("whatsapp_messages")
      .update({ ...baseRecord, qty_m: m } as never)
      .eq("id", messageId);

    if (upd.error && /qty_m|locked_until|locked_by|next_retry_at|last_error/i.test(upd.error.message)) {
      const legacyRecord = {
        company_id: companyId,
        customer_id: customer?.id ?? null,
        phone: phone || "sem-telefone",
        direction: "inbound",
        body,
        parsed: parsedPayload,
        order_id: orderId,
        status,
        qty_g: g,
        qty_p: p,
        fiado: false,
        order_date: orderDate,
      };
      upd = await supabase.from("whatsapp_messages").update(legacyRecord).eq("id", messageId);
    }
    if (upd.error) {
      throw new Error(upd.error.message);
    }
  } else {
    let ins = await supabase
      .from("whatsapp_messages")
      .insert({ ...baseRecord, qty_m: m } as never)
      .select("id")
      .single();
    if (ins.error && /qty_m|locked_until|locked_by|next_retry_at|last_error/i.test(ins.error.message)) {
      ins = await supabase
        .from("whatsapp_messages")
        .insert({
          company_id: companyId,
          customer_id: customer?.id ?? null,
          phone: phone || "sem-telefone",
          direction: "inbound",
          body,
          parsed: parsedPayload,
          order_id: orderId,
          status,
          qty_g: g,
          qty_p: p,
          fiado: false,
          order_date: orderDate,
          message_uid: uid,
        })
        .select("id")
        .single();
    }
    if (ins.error) throw new Error(ins.error.message);
    messageId = ins.data.id;
  }

  return {
    duplicate: false,
    completedByRpc: false,
    leaseLost: false,
    status,
    messageId,
    orderId,
    financialState: orderId ? ("aguardando_classificacao" as const) : null,
    customerName: customer?.name ?? parsed.nome ?? null,
    parsed: {
      eh_pedido: Boolean(parsed.eh_pedido),
      nome: parsed.nome ?? null,
      qtd_g: g,
      qtd_m: m,
      qtd_p: p,
      data: orderDate,
      fiado: false,
      motivo: parsed.motivo ?? null,
    },
  };
}
