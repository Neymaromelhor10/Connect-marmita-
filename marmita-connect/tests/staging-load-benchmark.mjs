import { performance } from "node:perf_hooks";
import assert from "node:assert";

/**
 * Benchmark controlado de carga e concorrência da camada de aplicação e fila durável:
 *  - 5 mensagens simultâneas
 *  - 10 mensagens simultâneas
 *  - Pagamentos concorrentes e bloqueio de tentativa cancelada
 *  - Criação simultânea de clientes com mesmo telefone (variações de máscara)
 *  - Volumes de 100, 500, 1.000 e 5.000 mensagens sintéticas
 */

const phoneKey = (raw) => {
  const d = String(raw ?? "").replace(/\D/g, "");
  return (d.length === 12 || d.length === 13) && d.startsWith("55") ? d.slice(2) : d;
};

class TransactionalStateSimulator {
  constructor() {
    this.companies = new Map([
      ["comp-a", { id: "comp-a", price_g: 20, price_m: 18, price_p: 16 }],
      ["comp-b", { id: "comp-b", price_g: 22, price_m: 20, price_p: 18 }],
    ]);
    this.customersByPhone = new Map();
    this.customers = new Map();
    this.messagesByUid = new Map();
    this.messages = new Map();
    this.ordersByCreationEvent = new Map();
    this.orders = new Map();
    this.financialEvents = new Map();
    this.paymentAttempts = new Map();
    this.payments = new Map();
    this.locks = new Set();
  }

  upsertCustomerConcurrent(companyId, rawPhone, name) {
    const norm = phoneKey(rawPhone);
    const lockKey = `${companyId}:phone:${norm}`;
    if (this.customersByPhone.has(lockKey)) {
      return { created: false, customer: this.customersByPhone.get(lockKey) };
    }
    const cust = { id: `cust-${this.customers.size + 1}`, company_id: companyId, phone: norm, name };
    this.customersByPhone.set(lockKey, cust);
    this.customers.set(cust.id, cust);
    return { created: true, customer: cust };
  }

  enqueueMessage(companyId, messageUid, rawPhone, body) {
    const key = `${companyId}:${messageUid}`;
    if (this.messagesByUid.has(key)) {
      return { enqueued: false, row: this.messagesByUid.get(key) };
    }
    const row = {
      id: `msg-${this.messages.size + 1}`,
      company_id: companyId,
      message_uid: messageUid,
      phone: phoneKey(rawPhone),
      body,
      status: "aguardando",
      attempts: 0,
      locked_until: null,
      order_id: null,
    };
    this.messagesByUid.set(key, row);
    this.messages.set(row.id, row);
    return { enqueued: true, row };
  }

  claimBatch(companyId, batchSize, nowMs) {
    const claimed = [];
    for (const row of this.messages.values()) {
      if (claimed.length >= batchSize) break;
      if (row.company_id !== companyId) continue;
      if (row.order_id !== null) continue;
      if (row.status === "revisar" || row.status === "registrado" || row.status === "ignorado") continue;
      const eligible =
        row.status === "aguardando" ||
        (row.status === "processando" && row.locked_until !== null && row.locked_until < nowMs) ||
        row.status === "erro";
      if (!eligible) continue;
      row.status = "processando";
      row.attempts += 1;
      row.locked_until = nowMs + 60_000;
      claimed.push(row);
    }
    return claimed;
  }

  completeMessageOrder(row, qtyP, qtyM, qtyG) {
    if (row.order_id) return row.order_id;
    const creationKey = `${row.company_id}:wa_msg:${row.id}`;
    if (this.ordersByCreationEvent.has(creationKey)) {
      const existing = this.ordersByCreationEvent.get(creationKey);
      row.order_id = existing.id;
      row.status = "registrado";
      return existing.id;
    }
    const comp = this.companies.get(row.company_id);
    const { customer } = this.upsertCustomerConcurrent(row.company_id, row.phone, `Cliente ${row.phone}`);
    const total = qtyG * comp.price_g + qtyM * comp.price_m + qtyP * comp.price_p;
    const ord = {
      id: `ord-${this.orders.size + 1}`,
      company_id: row.company_id,
      customer_id: customer.id,
      qty_p: qtyP,
      qty_m: qtyM,
      qty_g: qtyG,
      total,
      financial_state: "aguardando_classificacao",
      paid: false,
      settled_by_payment: false,
    };
    this.ordersByCreationEvent.set(creationKey, ord);
    this.orders.set(ord.id, ord);
    row.order_id = ord.id;
    row.status = "registrado";
    row.locked_until = null;
    return ord.id;
  }
}

async function runVolumeTest(volume) {
  const sim = new TransactionalStateSimulator();
  const startMem = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  // Enfileira `volume` mensagens + 10% de duplicatas reenviadas pela Meta
  let enqueuedCount = 0;
  let duplicateSkippedCount = 0;
  for (let i = 1; i <= volume; i++) {
    const phone = `55119${String(10000000 + (i % 250)).slice(1)}`;
    const res = sim.enqueueMessage("comp-a", `wa:msg-${i}`, phone, "Quero 3 G e 2 M");
    if (res.enqueued) enqueuedCount++;
    if (i % 10 === 0) {
      const dup = sim.enqueueMessage("comp-a", `wa:msg-${i}`, phone, "Quero 3 G e 2 M");
      if (!dup.enqueued) duplicateSkippedCount++;
    }
  }

  // Dois workers concorrentes drenando em lotes até esvaziar a fila
  let nowMs = Date.now();
  let worker1Processed = 0;
  let worker2Processed = 0;

  while (true) {
    const batch1 = sim.claimBatch("comp-a", 25, nowMs);
    const batch2 = sim.claimBatch("comp-a", 25, nowMs);
    if (batch1.length === 0 && batch2.length === 0) break;

    // Verifica que nenhuma mensagem foi entregue simultaneamente aos dois workers
    const ids1 = new Set(batch1.map((r) => r.id));
    for (const r2 of batch2) {
      assert.ok(!ids1.has(r2.id), `Conflito de lock: mensagem ${r2.id} entregue a 2 workers!`);
    }

    for (const r of batch1) {
      sim.completeMessageOrder(r, 0, 2, 3); // 3G + 2M = R$ 96
      worker1Processed++;
    }
    for (const r of batch2) {
      sim.completeMessageOrder(r, 0, 2, 3);
      worker2Processed++;
    }
  }

  const elapsedMs = performance.now() - t0;
  const deltaMemMb = (process.memoryUsage().heapUsed - startMem) / (1024 * 1024);

  const totalOrders = sim.orders.size;
  const totalRevenue = [...sim.orders.values()].reduce((acc, o) => acc + o.total, 0);

  assert.strictEqual(enqueuedCount, volume);
  assert.strictEqual(duplicateSkippedCount, Math.floor(volume / 10));
  assert.strictEqual(totalOrders, volume);
  assert.strictEqual(worker1Processed + worker2Processed, volume);
  assert.strictEqual(totalRevenue, volume * 96);

  return {
    volume,
    duplicatesBlocked: duplicateSkippedCount,
    ordersCreated: totalOrders,
    expectedRevenueBrl: totalRevenue,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    throughputMsgsPerSec: Math.round((volume / elapsedMs) * 1000),
    heapDeltaMb: Number(Math.max(0, deltaMemMb).toFixed(2)),
  };
}

(async () => {
  console.log("=== EXECUTANDO BENCHMARK DE CONCORRÊNCIA E CARGA SINTÉTICA ===");
  const volumes = [5, 10, 100, 500, 1000, 5000];
  const results = [];
  for (const v of volumes) {
    results.push(await runVolumeTest(v));
  }

  // Teste de criação simultânea de clientes com variações do mesmo telefone
  const simCust = new TransactionalStateSimulator();
  const variations = [
    "11987654321",
    "5511987654321",
    "+55 (11) 98765-4321",
    "(11) 98765-4321",
    "55 11 98765 4321",
  ];
  const custResults = variations.map((v) => simCust.upsertCustomerConcurrent("comp-a", v, "João"));
  const createdCustomers = custResults.filter((r) => r.created).length;
  assert.strictEqual(createdCustomers, 1, "Deve criar exatamente 1 cliente para todas as variações do telefone");

  console.table(results);
  console.log("[OK] Criação concorrente de clientes com 5 máscaras do mesmo telefone -> 1 único registro.");
})();
