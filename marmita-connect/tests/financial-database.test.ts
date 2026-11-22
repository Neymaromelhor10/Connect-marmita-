import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { classifyWithPersistence, type FinancialCommit } from "../src/lib/financial-persistence";
import type { FinancialContext } from "../src/lib/financial-command";

// Deliberately no PG*/SUPABASE env fallback: tests can only use this local Unix socket.
const enabled = process.env["FINANCIAL_LOCAL_DB_TESTS"] === "1";
const sql = postgres({ host: "/tmp/financial-isolation/socket", port: 55439, database: "postgres", username: "nobody", max: 12, onnotice: () => {} });
const companyA = randomUUID(), companyB = randomUUID(), userA = randomUUID(), userB = randomUUID(), unauthorized = randomUUID();
let customer: string;
let legacySnapshot: unknown;
const now = () => new Date().toISOString();
async function asUser<T>(id: string, run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claim.sub', ${id}, true)`;
    await tx`SET LOCAL statement_timeout = '5s'`;
    return run(tx);
  });
  return result as T;
}
async function newCustomer(company = companyA) {
  const id = randomUUID();
  await sql`INSERT INTO customers(id,company_id,name,phone) VALUES(${id},${company},'Synthetic financial test',${'11'+Math.floor(100000000+Math.random()*899999999)})`;
  return id;
}
async function pending(cust = customer, event = randomUUID()) {
  return asUser(userA, async (tx) => {
    const [row] = await tx`SELECT financial_create_pending(${cust},6,3,${event}) AS data`;
    return row.data as { id: string; total: number; financial_state: string; paid: boolean; settled_by_payment: boolean };
  });
}
async function classify(orderId: string, command: "OK" | "OKK" = "OK", eventId = randomUUID(), actor = userA, receivedAt = now()) {
  return classifyWithPersistence({
    load: async () => asUser(actor, async (tx) => {
      const [row] = await tx`SELECT financial_command_context(${orderId},${eventId},${command},${receivedAt}) AS data`;
      return row.data as FinancialContext;
    }),
    commit: async (_request, decision) => asUser(actor, async (tx) => {
      const [row] = await tx`SELECT financial_classify_order(${orderId},${eventId},${command},${receivedAt},${decision.acao_financeira === 'SOLICITAR_CLASSIFICACAO'},${decision.motivo}) AS data`;
      return row.data as FinancialCommit;
    }),
  }, { orderId, command, eventId });
}
async function payment(cust: string, amount: number, idempotencyKey: string | null = null) {
  return asUser(userA, async (tx) => tx`SELECT financial_register_payment(${cust},${amount},'test',NULL,${idempotencyKey})`);
}
async function legacy(cust: string, total: number, paid = false, settled = false) {
  const id = randomUUID();
  await sql`INSERT INTO orders(id,company_id,customer_id,quantity,unit_price,paid,settled_by_payment,order_date)
    VALUES(${id},${companyA},${cust},1,${total},${paid},${settled},(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-1)`;
  return id;
}
async function row(id: string) { const [r] = await sql`SELECT * FROM orders WHERE id=${id}`; return r; }

(enabled ? describe : describe.skip)("isolated PostgreSQL financial infrastructure (real SQL, synthetic auth)", () => {
  beforeAll(async () => {
    const [proof] = await sql`SELECT current_setting('data_directory') AS directory, inet_server_addr() AS address`;
    expect(proof.directory).toBe("/tmp/financial-isolation/pg");
    expect(proof.address).toBeNull();
    const [count] = await sql`SELECT count(*)::int AS n FROM companies`;
    expect(count.n).toBe(0);
    await sql`INSERT INTO companies(id,name,price_g,price_p) VALUES(${companyA},'Synthetic A',20,18),(${companyB},'Synthetic B',20,18)`;
    await sql`INSERT INTO profiles(id,company_id) VALUES(${userA},${companyA}),(${userB},${companyB}),(${unauthorized},${companyA})`;
    const c = await newCustomer();
    await legacy(c, 100); await legacy(c,60,true); await legacy(c,40,true,true);
    await sql`INSERT INTO payments(company_id,customer_id,amount) VALUES(${companyA},${c},40)`;
    const [before] = await sql`SELECT jsonb_agg(to_jsonb(o) ORDER BY id) AS data FROM orders o`;
    legacySnapshot = before.data;
    // Apply 0010 and 0011 migrations after historical synthetic rows exist, to prove no backfill.
    const proposal = await readFile(new URL('../docs/sql/financial-infrastructure.proposed.sql', import.meta.url), 'utf8');
    await sql.begin(tx => tx.unsafe(proposal.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')));
    const hardening = await readFile(new URL('../drizzle/migrations/0011_pre_production_hardening.sql', import.meta.url), 'utf8');
    await sql.begin(tx => tx.unsafe(hardening.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')));
    const [after] = await sql`SELECT jsonb_agg(to_jsonb(o)-'financial_state'-'financial_phone'-'financial_conversation_id'-'financial_creation_event'-'financial_last_audit_id' ORDER BY id) AS data FROM orders o`;
    expect(after.data).toEqual(legacySnapshot);
    await sql`INSERT INTO financial_permissions(company_id,user_id,can_classify) VALUES(${companyA},${userA},true),(${companyB},${userB},true)`;
  });
  afterAll(async () => { await sql.end(); });
  it("proposal leaves all synthetic historical fields and balances intact", async () => {
    const [check] = await sql`SELECT count(*)::int AS n FROM orders WHERE financial_state IS NOT NULL`;
    expect(check.n).toBe(0);
    const [balance] = await sql`SELECT sum(CASE WHEN NOT paid OR settled_by_payment THEN total ELSE 0 END)-(SELECT sum(amount) FROM payments) AS n FROM orders`;
    expect(Number(balance.n)).toBe(100);
  });
  it("creates pending 6G+3P for exactly R$174 without a payment", async () => {
    customer = await newCustomer(); const p = await pending();
    expect(p).toMatchObject({total:174,financial_state:'aguardando_classificacao',paid:false,settled_by_payment:false});
    const [count] = await sql`SELECT count(*)::int AS n FROM payments WHERE customer_id=${customer}`;
    expect(count.n).toBe(0);
  });
  it("pending creation is idempotent", async () => {
    const c = await newCustomer(), e = randomUUID();
    const [a,b] = await Promise.all([pending(c,e),pending(c,e)]); expect(a.id).toBe(b.id);
    const [count] = await sql`SELECT count(*)::int AS n FROM orders WHERE customer_id=${c}`; expect(count.n).toBe(1);
  });
  it.each(['OK','OKK'] as const)("%s traverses real evaluator and SQL transaction preserving one BRL174 sale", async command => {
    const c = await newCustomer(), p = await pending(c);
    const result = await classify(p.id,command);
    expect(result.validation.acao_financeira).toBe('SOLICITAR_CLASSIFICACAO');
    expect(result.result).toMatchObject({outcome:'classified',state:command==='OK'?'pago':'fiado',total:174});
    const [counts] = await sql`SELECT (SELECT count(*)::int FROM orders WHERE customer_id=${c}) AS orders,(SELECT count(*)::int FROM payments WHERE customer_id=${c}) AS payments`;
    expect(counts).toMatchObject({orders:1,payments:0});
  });
  it("same event returns persistent duplicate without a second audit or transition", async () => {
    const p = await pending(await newCustomer()), e = randomUUID();
    const first = await classify(p.id,'OK',e), second = await classify(p.id,'OK',e);
    expect(second.result.outcome).toBe('duplicate'); expect(second.result.audit_id).toBe(first.result.audit_id);
    const [count] = await sql`SELECT count(*)::int AS n FROM financial_events WHERE event_id=${e}`; expect(count.n).toBe(1);
  });
  it("same event with conflicting command never overwrites original", async () => {
    const p = await pending(await newCustomer()), e = randomUUID(); await classify(p.id,'OK',e);
    expect((await classify(p.id,'OKK',e)).result.outcome).toBe('conflict'); expect((await row(p.id)).financial_state).toBe('pago');
  });
  it("distinct event cannot classify an already classified order", async () => {
    const p = await pending(await newCustomer()); await classify(p.id,'OK');
    expect((await classify(p.id,'OKK')).result.reason).toBe('PEDIDO_JA_CLASSIFICADO');
  });
  it("concurrent OK/OKK has exactly one committed classification", async () => {
    const p = await pending(await newCustomer());
    const results = await Promise.all([classify(p.id,'OK'),classify(p.id,'OKK')]);
    expect(results.filter(r=>r.result.outcome==='classified')).toHaveLength(1);
    const [count] = await sql`SELECT count(*)::int AS n FROM financial_events WHERE order_id=${p.id} AND outcome='classified'`; expect(count.n).toBe(1);
  });
  it("concurrent same event has one classification and one duplicate", async () => {
    const p = await pending(await newCustomer()), e = randomUUID(); const results = await Promise.all([classify(p.id,'OK',e),classify(p.id,'OK',e)]);
    expect(results.map(r=>r.result.outcome).sort()).toEqual(['classified','duplicate']);
  });
  it("FIFO skips pending R$174 and settles only old R$100 debt", async () => {
    const c = await newCustomer(), p = await pending(c), old = await legacy(c,100); await payment(c,100);
    expect((await row(p.id)).paid).toBe(false); expect((await row(old)).settled_by_payment).toBe(true);
  });
  it("partial R$40 payment blocks pending classification and does not settle it", async () => {
    const c=await newCustomer(),p=await pending(c); await legacy(c,100); await payment(c,40);
    expect((await classify(p.id)).result.reason).toBe('PAGAMENTO_PARCIAL_OU_NAO_RASTREAVEL'); expect((await row(p.id)).paid).toBe(false);
  });
  it("new fiado participates in FIFO and settles without repricing", async () => {
    const c=await newCustomer(),p=await pending(c); await classify(p.id,'OKK'); await payment(c,174);
    expect(await row(p.id)).toMatchObject({financial_state:'fiado',paid:true,settled_by_payment:true,total:'174.00'});
  });
  it("concurrent payments preserve sum and leave pending untouched", async () => {
    const c=await newCustomer(),p=await pending(c),old=await legacy(c,100); await Promise.all([payment(c,40),payment(c,60)]);
    const [sum] = await sql`SELECT sum(amount) AS n FROM payments WHERE customer_id=${c}`;
    expect(Number(sum.n)).toBe(100); expect((await row(old)).paid).toBe(true); expect((await row(p.id)).paid).toBe(false);
  });
  it("idempotent register_payment with same _idempotency_key creates only 1 payment and reconciles safely", async () => {
    const c = await newCustomer(), p = await pending(c), key = randomUUID();
    await classify(p.id, 'OKK');
    const [a, b] = await Promise.all([payment(c, 174, key), payment(c, 174, key)]);
    expect(a[0].financial_register_payment).toBe(b[0].financial_register_payment);
    const [count] = await sql`SELECT count(*)::int AS n FROM payments WHERE customer_id=${c}`;
    expect(count.n).toBe(1);
  });
  it("zz_financial_require_audit_event blocks privileged direct classification without financial_events row", async () => {
    const c = await newCustomer(), p = await pending(c);
    await expect(sql`UPDATE orders SET financial_state='pago', paid=true WHERE id=${p.id}`).rejects.toThrow('Violação de integridade financeira');
  });
});
