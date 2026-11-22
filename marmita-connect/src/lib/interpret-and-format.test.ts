import { describe, expect, it, vi, beforeEach } from "vitest";
import { brDateISO, brToday, formatSizes } from "./format";
import { extractBusinessEchoes, extractMessages } from "@/routes/api/public/whatsapp/meta-webhook";
import { callGeminiExtractOrder, phoneKey, processIncomingMessage } from "./interpret.server";

describe("format helpers & Brazil timezone (America/Sao_Paulo)", () => {
  it("converts late-night BRT UTC timestamps to the same Brazilian calendar day", () => {
    expect(brDateISO("2026-11-03T01:30:00.000Z")).toBe("2026-11-02");
    expect(brToday(new Date("2026-11-03T01:30:00.000Z"))).toBe("2026-11-02");
    expect(brDateISO("2026-11-03T03:05:00.000Z")).toBe("2026-11-03");
  });

  it("formats P / M / G sizes clearly", () => {
    expect(formatSizes(2, 1, 3)).toBe("2 G + 1 M + 3 P");
    expect(formatSizes(0, 2, 0)).toBe("2 M");
    expect(formatSizes(2, 0, 1)).toBe("2 G + 1 P");
    expect(formatSizes(0, 0, 0, 4)).toBe("4 marmitas");
  });

  it("normalizes Brazilian phone numbers consistently", () => {
    expect(phoneKey("+55 (11) 98765-4321")).toBe("11987654321");
    expect(phoneKey("5511987654321")).toBe("11987654321");
    expect(phoneKey("11987654321")).toBe("11987654321");
  });
});

describe("Meta webhook message & business echo extraction", () => {
  it("extracts inbound text messages with WABA ID, phone number ID, sender and profile name", () => {
    const extracted = extractMessages(
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "1234567890",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "9876543210" },
                  contacts: [{ wa_id: "5511999998888", profile: { name: "Maria Silva" } }],
                  messages: [
                    {
                      id: "wamid.HBgM",
                      from: "5511999998888",
                      timestamp: "1730580000",
                      type: "text",
                      text: { body: "Oi, manda 2 G, 1 M e 1 P" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { nowMs: 1730580200_000 },
    );

    expect(extracted).toEqual([
      {
        messageId: "wamid.HBgM",
        from: "5511999998888",
        profileName: "Maria Silva",
        text: "Oi, manda 2 G, 1 M e 1 P",
        timestamp: "1730580000",
        phoneNumberId: "9876543210",
        wabaId: "1234567890",
      },
    ]);
  });

  it("extracts smb_message_echoes sent by the business", () => {
    const echoes = extractBusinessEchoes(
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "1234567890",
            changes: [
              {
                field: "smb_message_echoes",
                value: {
                  metadata: { phone_number_id: "9876543210" },
                  message_echoes: [
                    {
                      id: "wamid.ECHO1",
                      from: "551133334444",
                      to: "5511999998888",
                      timestamp: "1730580100",
                      type: "text",
                      text: { body: "OKK" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { nowMs: 1730580200_000 },
    );

    expect(echoes).toEqual([
      {
        messageId: "wamid.ECHO1",
        from: "551133334444",
        to: "5511999998888",
        text: "OKK",
        timestamp: "1730580100",
        phoneNumberId: "9876543210",
        wabaId: "1234567890",
        quoted: false,
        forwarded: false,
        standalone: true,
      },
    ]);
  });
});

describe("Direct Google Gemini API (gemini-2.5-flash) & Operational Resilience", () => {
  beforeEach(() => {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    vi.restoreAllMocks();
  });

  it("calls official Google Gemini API with temperature=0 and responseSchema and parses candidates[]", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      eh_pedido: true,
                      nome: "Carlos",
                      qtd_g: 2,
                      qtd_m: 3,
                      qtd_p: 1,
                      data: "2026-11-02",
                      motivo: null,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const parsed = await callGeminiExtractOrder("2G, 3M e 1P", "2026-11-02");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(String(calledUrl)).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((calledInit?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "test-gemini-key",
    );
    const reqBody = JSON.parse(String(calledInit?.body));
    expect(reqBody.generationConfig.temperature).toBe(0);
    expect(reqBody.generationConfig.responseMimeType).toBe("application/json");
    expect(parsed).toMatchObject({
      eh_pedido: true,
      nome: "Carlos",
      qtd_g: 2,
      qtd_m: 3,
      qtd_p: 1,
    });
  });

  it("retries with exponential backoff on 429/503 and succeeds on subsequent attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        eh_pedido: true,
                        nome: "Ana",
                        qtd_g: 1,
                        qtd_m: 2,
                        qtd_p: 0,
                        data: "2026-11-03",
                        motivo: null,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const parsed = await callGeminiExtractOrder("1G e 2M", "2026-11-03", {
      maxAttempts: 3,
      baseDelayMs: 5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(parsed.qtd_g).toBe(1);
    expect(parsed.qtd_m).toBe(2);
  });

  it("persists message durably with status='erro' when Gemini is completely unavailable and recovers on retry without duplicating order", async () => {
    // 1ª tentativa: Gemini falha nas 3 tentativas
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Rate limit exceeded", { status: 429 }),
    );

    const messagesDb = new Map<string, Record<string, unknown>>();
    const ordersDb: Record<string, unknown>[] = [];

    const mockSupabase = {
      from: (table: string) => {
        if (table === "whatsapp_messages") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => {
                    const found = [...messagesDb.values()][0] ?? null;
                    return { data: found, error: null };
                  },
                }),
              }),
            }),
            insert: (payload: Record<string, unknown>) => {
              const row = { ...payload, id: "msg-durable-1", order_id: payload["order_id"] ?? null };
              messagesDb.set("msg-durable-1", row);
              return {
                select: () => ({
                  single: async () => ({ data: { id: "msg-durable-1" }, error: null }),
                }),
              };
            },
            update: (patch: Record<string, unknown>) => ({
              eq: async (_col: string, id: string) => {
                const cur = messagesDb.get(id) ?? {};
                messagesDb.set(id, { ...cur, ...patch });
                return { error: null };
              },
            }),
          };
        }
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: async () => ({
                    data: [{ id: "cust-1", name: "Carlos", phone: "11988887777" }],
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
              ordersDb.push(payload);
              return {
                select: () => ({
                  single: async () => ({ data: { id: `ord-${ordersDb.length}` }, error: null }),
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    };

    await expect(
      processIncomingMessage(mockSupabase as never, "comp-1", {
        phone: "5511988887777",
        body: "3G e 2M pra hoje",
        externalId: "wa:wamid-resilient-1",
      }),
    ).rejects.toThrow(/Limite de requisições/);

    // A mensagem ficou salva de forma durável com status = 'erro' e sem pedido criado
    expect(messagesDb.get("msg-durable-1")?.["status"]).toBe("erro");
    expect(ordersDb).toHaveLength(0);

    // 2ª tentativa (recuperação após Gemini voltar):
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      eh_pedido: true,
                      nome: "Carlos",
                      qtd_g: 3,
                      qtd_m: 2,
                      qtd_p: 0,
                      data: "2026-11-03",
                      motivo: null,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const recovered = await processIncomingMessage(mockSupabase as never, "comp-1", {
      phone: "5511988887777",
      body: "3G e 2M pra hoje",
      externalId: "wa:wamid-resilient-1",
      messageId: "msg-durable-1",
    });

    expect(recovered.status).toBe("registrado");
    expect(recovered.orderId).toBe("ord-1");
    expect(ordersDb).toHaveLength(1);
    expect(messagesDb.get("msg-durable-1")?.["status"]).toBe("registrado");
    expect(messagesDb.get("msg-durable-1")?.["order_id"]).toBe("ord-1");

    // 3ª tentativa (idempotência: tentar reprocessar mensagem já recuperada não duplica pedido)
    const duplicateTry = await processIncomingMessage(mockSupabase as never, "comp-1", {
      phone: "5511988887777",
      body: "3G e 2M pra hoje",
      externalId: "wa:wamid-resilient-1",
      messageId: "msg-durable-1",
    });
    expect(duplicateTry.duplicate).toBe(true);
    expect(ordersDb).toHaveLength(1);
  });
});
