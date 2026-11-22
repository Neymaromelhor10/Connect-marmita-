import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import assert from "node:assert";

/**
 * Executa testes reais de concorrência paralela (múltiplas conexões simultâneas no PostgreSQL)
 * e carga de 5, 10, 100, 500, 1.000, 5.000 e 10.000 mensagens no banco de homologação (STAGING_DATABASE_URL).
 * Inclui as verificações de concorrência das rodadas anteriores e da Missão 07.4 (AUD-07.3-02, AUD-07.3-04 e Seção 9):
 *   - Normalização canônica de telefone via função real public.financial_phone_key(phone)
 *   - Chamada da RPC real public.get_or_create_customer_by_phone(_company_id, _phone, _name) com exatamente 3 argumentos (AUD6-03)
 *   - Concorrência financeira com a mesma _idempotency_key e com chaves diferentes disputando o mesmo pedido FIFO (Seção 4.3 item 7 & Seção 9)
 *   - Concorrência no rate limit distribuído public.check_whatsapp_webhook_rate_limit entre múltiplas conexões (Seção 9)
 *   - Concorrência no expurgo periódico LGPD public.lgpd_purge_expired_operational_data (Seção 9)
 *   - Testes com 2, 5 e 10 workers simultâneos em claim_whatsapp_queue_batch + validação de lease_generation
 *   - Backlogs de 1.000, 5.000 e 10.000 mensagens medindo p50, p95, p99, sobreposição, perdas, duplicatas e falhas
 * Toda limpeza de dados sintéticos ocorre dentro de transação segura (sql.begin), garantindo que
 * os triggers zz_financial_guard_order e financial_audit_immutable sejam sempre restaurados
 * automaticamente pelo PostgreSQL mesmo em caso de falha.
 */

const stagingUrl = process.env["STAGING_DATABASE_URL"];
if (!stagingUrl) {
  console.error("[ERRO] Defina STAGING_DATABASE_URL para executar os testes reais de concorrência e carga no PostgreSQL.");
  process.exit(1);
}

const { default: postgres } = await import("postgres");
const sql = postgres(stagingUrl, { max: 14, onnotice: () => {} });

const compId = randomUUID();
const compIdB = randomUUID();
const userId = randomUUID();
const custId = randomUUID();
const today = new Date().toISOString().slice(0, 10);

function computePercentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return Number(sortedValues[idx].toFixed(2));
}

async function asAuthenticated(uid, fn) {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claim.sub', ${uid}, true)`;
    await tx`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`;
    return fn(tx);
  });
}

async function cleanupSyntheticCompanyAtomic(targetCompanyId, targetUserId = null) {
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE public.orders DISABLE TRIGGER zz_financial_guard_order`;
    await tx`ALTER TABLE public.financial_events DISABLE TRIGGER financial_audit_immutable`;
    await tx`SET LOCAL app.allow_audit_cleanup = 'on'`;

    await tx`UPDATE public.orders SET financial_last_audit_id = NULL WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.financial_events WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.payment_attempts WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.payments WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.lgpd_lifecycle_audit WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.operational_scheduler_state WHERE task_key = ${`lgpd_retention_purge:${targetCompanyId}`}`;
    await tx`DELETE FROM public.whatsapp_manual_retry_audit WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.whatsapp_messages WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.orders WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.customers WHERE company_id = ${targetCompanyId}`;
    await tx`DELETE FROM public.financial_permissions WHERE company_id = ${targetCompanyId}`;
    if (targetUserId) {
      await tx`DELETE FROM public.user_roles WHERE user_id = ${targetUserId}`;
      await tx`DELETE FROM public.profiles WHERE id = ${targetUserId}`;
    }
    await tx`DELETE FROM public.companies WHERE id = ${targetCompanyId}`;
    if (targetUserId) {
      await tx`DELETE FROM auth.users WHERE id = ${targetUserId}`;
    }

    await tx`ALTER TABLE public.financial_events ENABLE TRIGGER financial_audit_immutable`;
    await tx`ALTER TABLE public.orders ENABLE TRIGGER zz_financial_guard_order`;
  });
}

try {
  console.log("=== [1/8] Preparando empresas isoladas para benchmark de concorrência no PostgreSQL ===");
  await sql`
    INSERT INTO auth.users(id, email, encrypted_password)
    VALUES (${userId}, ${`load.${userId}@homolog.local`}, 'hash')
  `;
  await sql`
    INSERT INTO public.companies(id, name, price_g, price_m, price_p)
    VALUES
      (${compId}, 'Marmitaria Benchmark Concorrência A', 20.00, 18.00, 16.00),
      (${compIdB}, 'Marmitaria Benchmark Concorrência B', 21.00, 19.00, 17.00)
  `;
  await sql`
    INSERT INTO public.profiles(id, company_id, full_name, email)
    VALUES (${userId}, ${compId}, 'Operador Load', ${`load.${userId}@homolog.local`})
  `;
  await sql`INSERT INTO public.user_roles(user_id, role) VALUES (${userId}, 'admin')`;
  await sql`INSERT INTO public.financial_permissions(company_id, user_id, can_classify) VALUES (${compId}, ${userId}, true)`;
  await sql`
    INSERT INTO public.customers(id, company_id, name, phone)
    VALUES (${custId}, ${compId}, 'Cliente Concorrência', '11966665555')
  `;

  console.log("=== [2/8] Testando concorrência real: 5 inserções diretas simultâneas do mesmo telefone com máscaras distintas ===");
  const phoneMasks = [
    "11955554444",
    "5511955554444",
    "+55 (11) 95555-4444",
    "(11) 95555-4444",
    "55 11 95555-4444",
  ];
  const phoneOutcomes = await Promise.allSettled(
    phoneMasks.map((mask, idx) =>
      asAuthenticated(userId, (tx) =>
        tx`INSERT INTO public.customers(company_id, name, phone) VALUES (${compId}, ${`Concorrente ${idx}`}, ${mask})`,
      ),
    ),
  );
  const phoneSuccesses = phoneOutcomes.filter((o) => o.status === "fulfilled").length;
  const phoneRejections = phoneOutcomes.filter((o) => o.status === "rejected").length;
  assert.strictEqual(phoneSuccesses, 1, `Esperado exatamente 1 cliente criado, obtido: ${phoneSuccesses}`);
  assert.strictEqual(phoneRejections, 4, `Esperadas 4 rejeições por duplicidade (23505), obtido: ${phoneRejections}`);
  console.log("  -> [OK] 1 inserção aceita e 4 bloqueadas por pg_advisory_xact_lock (23505).");

  console.log("=== [3/8] Testando AUD3-02, AUD5-01 & AUD6-03: Concorrência mista entre get_or_create_customer_by_phone (3 args) e INSERT direto ===");
  const mixedMasks = [
    "+55 (11) 94444-3333",
    "11944443333",
    "5511944443333",
    "(11) 94444-3333",
  ];
  const mixedOutcomes = await Promise.allSettled([
    sql.unsafe(
      "SELECT id AS cust_id FROM public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text)",
      [compId, mixedMasks[0], "RPC 1"],
    ),
    sql.unsafe(
      "SELECT id AS cust_id FROM public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text)",
      [compId, mixedMasks[1], "RPC 2"],
    ),
    asAuthenticated(userId, (tx) =>
      tx`INSERT INTO public.customers(company_id, name, phone) VALUES (${compId}, 'Direct 1', ${mixedMasks[2]}) RETURNING id`,
    ),
    sql.unsafe(
      "SELECT id AS cust_id FROM public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text)",
      [compId, mixedMasks[3], "RPC 3"],
    ),
  ]);
  const rpcFulfilled = mixedOutcomes.filter((o, i) => i !== 2 && o.status === "fulfilled");
  assert.strictEqual(rpcFulfilled.length, 3, "Todas as 3 chamadas a get_or_create_customer_by_phone devem concluir sem falha 42883 ou 23505");
  const [mixedCustCount] = await sql`
    SELECT count(*)::int AS n FROM public.customers
    WHERE company_id = ${compId} AND public.financial_phone_key(phone) = '11944443333'
  `;
  assert.strictEqual(mixedCustCount.n, 1, "Deve existir exatamente 1 cliente para o telefone 11944443333");
  console.log("  -> [OK AUD3-02, AUD5-01 & AUD6-03] get_or_create_customer_by_phone(3 args) + public.financial_phone_key garantiram 1 único cliente.");

  console.log("=== [4/8] Testando concorrência financeira: mesma _idempotency_key e chaves diferentes disputando o mesmo pedido FIFO ===");
  await asAuthenticated(userId, async (tx) => {
    const [row] = await tx`
      SELECT public.create_manual_or_reviewed_order(
        ${custId}::uuid, 0, 0, 5, ${today}::date, 'fiado', 'manual', ${randomUUID()}::uuid
      ) AS data
    `;
    return row.data;
  });
  const sharedPayKey = `concurrent-pay-${randomUUID()}`;
  const [payA, payB] = await Promise.all([
    asAuthenticated(userId, (tx) =>
      tx`SELECT public.financial_register_payment(${custId}::uuid, 100.00, 'pix', 'Concorrente A', ${sharedPayKey}) AS id`,
    ),
    asAuthenticated(userId, (tx) =>
      tx`SELECT public.financial_register_payment(${custId}::uuid, 100.00, 'pix', 'Concorrente B', ${sharedPayKey}) AS id`,
    ),
  ]);
  assert.strictEqual(payA[0].id, payB[0].id, "Duas conexões simultâneas com mesma chave devem retornar o mesmo payment_id");
  const [payCount] = await sql`SELECT count(*)::int AS n FROM public.payments WHERE customer_id = ${custId}`;
  assert.strictEqual(payCount.n, 1, "Deve existir exatamente 1 pagamento registrado");
  console.log(`  -> [OK] Pagamento único criado (${payA[0].id}) para mesma chave sob concorrência real.`);

  // Missão 07.4 (Seção 4.3 item 7 & Seção 9): Duas chamadas simultâneas com chaves DIFERENTES disputando o mesmo pedido
  const custFifoRace = randomUUID();
  await sql`
    INSERT INTO public.customers(id, company_id, name, phone)
    VALUES (${custFifoRace}, ${compId}, 'Cliente Disputa FIFO', '11966664444')
  `;
  const [fifoOrderRow] = await asAuthenticated(userId, async (tx) => {
    return tx`
      SELECT public.create_manual_or_reviewed_order(
        ${custFifoRace}::uuid, 0, 0, 5, ${today}::date, 'fiado', 'manual', ${randomUUID()}::uuid
      ) AS data
    `;
  });
  const fifoOrderId = fifoOrderRow.data.id;
  const [racePay1, racePay2] = await Promise.all([
    asAuthenticated(userId, (tx) =>
      tx`SELECT public.financial_register_payment(${custFifoRace}::uuid, 100.00, 'pix', 'Chave Distinta 1', ${`fifo-race-1-${randomUUID()}`}) AS id`,
    ),
    asAuthenticated(userId, (tx) =>
      tx`SELECT public.financial_register_payment(${custFifoRace}::uuid, 100.00, 'pix', 'Chave Distinta 2', ${`fifo-race-2-${randomUUID()}`}) AS id`,
    ),
  ]);
  assert.notStrictEqual(racePay1[0].id, racePay2[0].id, "Chaves distintas devem produzir payment_ids distintos");
  const [fifoOrderState] = await sql`
    SELECT paid, settled_by_payment, total FROM public.orders WHERE id = ${fifoOrderId}
  `;
  assert.strictEqual(fifoOrderState.paid, true, "Pedido disputado deve estar pago");
  assert.strictEqual(fifoOrderState.settled_by_payment, true, "Pedido disputado deve estar settled_by_payment=true");
  const [fifoPaymentsState] = await sql`
    SELECT count(*)::int AS cnt, coalesce(sum(amount), 0)::numeric AS total_paid
    FROM public.payments WHERE customer_id = ${custFifoRace} AND company_id = ${compId}
  `;
  assert.strictEqual(fifoPaymentsState.cnt, 2, "Ambas as chaves distintas devem estar registradas sem perda");
  assert.strictEqual(Number(fifoPaymentsState.total_paid), 200, "Soma dos pagamentos distintos deve ser R$ 200,00 (R$ 100 quitado + R$ 100 crédito)");
  console.log("  -> [OK Missão 07.4] Duas chamadas simultâneas com chaves distintas serializadas via FOR UPDATE sem inconsistência FIFO.");

  console.log("=== [5/8] Testando concorrência real no Rate Limit Distribuído (check_whatsapp_webhook_rate_limit) ===");
  const rlKey = `ip:concurrent-${randomUUID()}`;
  const rlNowIso = new Date().toISOString();
  const rlCalls = await Promise.all(
    Array.from({ length: 10 }, () =>
      sql`SELECT public.check_whatsapp_webhook_rate_limit(${rlKey}, 5, 60, ${rlNowIso}::timestamptz) AS res`,
    ),
  );
  const rlAllowed = rlCalls.filter((r) => r[0].res.allowed === true).length;
  const rlBlocked = rlCalls.filter((r) => r[0].res.allowed === false).length;
  assert.strictEqual(rlAllowed, 5, `Esperadas exatamente 5 requisições permitidas no bucket de limite 5, obtido: ${rlAllowed}`);
  assert.strictEqual(rlBlocked, 5, `Esperadas exatamente 5 requisições bloqueadas (429), obtido: ${rlBlocked}`);
  await sql`DELETE FROM public.whatsapp_webhook_rate_limits WHERE bucket_key = ${rlKey}`;
  console.log("  -> [OK Missão 07.4] 10 chamadas simultâneas ao rate limit distribuído (max=5) -> 5 permitidas e 5 bloqueadas atomicamente.");

  console.log("=== [6/8] Testando concorrência real no Expurgo Periódico LGPD (lgpd_purge_expired_operational_data) ===");
  await sql`DELETE FROM public.operational_scheduler_state WHERE task_key = ${`lgpd_retention_purge:${compId}`}`;
  const purgeCalls = await Promise.all(
    Array.from({ length: 4 }, () =>
      asAuthenticated(userId, (tx) =>
        tx`SELECT public.lgpd_purge_expired_operational_data(180, false) AS res`,
      ),
    ),
  );
  const purgeExecuted = purgeCalls.filter((r) => r[0].res.skipped_by_schedule === false).length;
  const purgeSkipped = purgeCalls.filter((r) => r[0].res.skipped_by_schedule === true).length;
  assert.strictEqual(purgeExecuted, 1, `Esperada exatamente 1 execução ativa do expurgo sob concorrência, obtido: ${purgeExecuted}`);
  assert.strictEqual(purgeSkipped, 3, `Esperadas 3 execuções puladas pela janela de 24h, obtido: ${purgeSkipped}`);
  console.log("  -> [OK Missão 07.4] 4 chamadas simultâneas a lgpd_purge_expired_operational_data -> 1 executada e 3 puladas via advisory lock.");

  console.log("=== [7/8] Testando AUD3-01 & AUD5-01: Concorrência em claim_whatsapp_queue_batch com 2, 5 e 10 workers simultâneos + fencing token ===");
  const workerScenarios = [2, 5, 10];
  const workerMetrics = [];

  for (const workerCount of workerScenarios) {
    const totalMessages = workerCount * 10;
    await sql`
      INSERT INTO public.whatsapp_messages(company_id, phone, direction, body, status, message_uid, source, next_retry_at)
      SELECT
        CASE WHEN g % 2 = 0 THEN ${compId}::uuid ELSE ${compIdB}::uuid END,
        '11966665555',
        'inbound',
        'Pedido Concorrente ' || g::text,
        'aguardando',
        'wa:w' || ${workerCount}::text || '-' || g::text,
        'whatsapp_cloud',
        clock_timestamp()
      FROM generate_series(1, ${totalMessages}) AS g
    `;

    const latencies = [];
    let failures = 0;
    const batches = await Promise.all(
      Array.from({ length: workerCount }, async (_, idx) => {
        const wId = `worker-${workerCount}-${idx + 1}`;
        const t0 = performance.now();
        try {
          const rows = await sql`
            SELECT id, company_id, locked_by, lease_generation, next_retry_at
            FROM public.claim_whatsapp_queue_batch(10, 60, NULL, NULL, 10, ${wId})
          `;
          latencies.push(performance.now() - t0);
          return rows;
        } catch (err) {
          failures++;
          throw err;
        }
      }),
    );

    const allClaimedIds = [];
    let overlapCount = 0;
    const seenIds = new Set();
    for (const batch of batches) {
      for (const row of batch) {
        allClaimedIds.push(row.id);
        assert.strictEqual(row.next_retry_at, null, "AUD5-05: next_retry_at deve ser limpo (NULL) no momento do claim");
        assert.strictEqual(Number(row.lease_generation), 1, "Primeira reclamação deve ter lease_generation = 1");
        if (seenIds.has(row.id)) {
          overlapCount++;
        }
        seenIds.add(row.id);
      }
    }

    assert.strictEqual(overlapCount, 0, `Sobreposição detectada com ${workerCount} workers!`);
    assert.strictEqual(seenIds.size, totalMessages, `Esperado reclamar todas as ${totalMessages} mensagens com ${workerCount} workers, obtido: ${seenIds.size}`);

    // Testa fencing token: um worker antigo (lease_generation = 0) é bloqueado em release_whatsapp_message_lock
    const sampleRow = batches[0][0];
    const [fencingCheck] = await sql`
      SELECT public.release_whatsapp_message_lock(
        ${sampleRow.id}::uuid,
        'worker-impostor',
        'erro',
        'Tentativa inválida',
        NULL,
        0,
        NULL,
        NULL
      ) AS released
    `;
    assert.strictEqual(fencingCheck.released, false, "Worker sem posse do lease deve ser bloqueado pelo fencing token");

    const sortedLat = [...latencies].sort((a, b) => a - b);
    workerMetrics.push({
      workers: workerCount,
      totalMessages,
      claimed: allClaimedIds.length,
      duplicates: overlapCount,
      lost: totalMessages - seenIds.size,
      failures,
      p50Ms: computePercentile(sortedLat, 50),
      p95Ms: computePercentile(sortedLat, 95),
      p99Ms: computePercentile(sortedLat, 99),
    });

    await sql`DELETE FROM public.whatsapp_messages WHERE company_id IN (${compId}, ${compIdB})`;
  }
  console.table(workerMetrics);

  console.log("=== [8/8] Executando teste de carga parametrizado em PostgreSQL (1.000, 5.000 e 10.000 mensagens sintéticas via SELECT) ===");
  const volumes = [5, 10, 100, 500, 1000, 5.0e3, 10000];
  const loadSummary = [];

  for (const volume of volumes) {
    const subCompId = randomUUID();
    const subCustId = randomUUID();
    await sql`INSERT INTO public.companies(id, name, price_g, price_m, price_p) VALUES (${subCompId}, ${`Load ${volume}`}, 20.00, 18.00, 16.00)`;
    await sql`INSERT INTO public.customers(id, company_id, name, phone) VALUES (${subCustId}, ${subCompId}, 'Cliente Load', '11966665555')`;

    const t0 = performance.now();
    await sql`
      INSERT INTO public.whatsapp_messages(company_id, phone, direction, body, status, message_uid, source)
      SELECT ${subCompId}::uuid, '11966665555', 'inbound', 'Quero 3 G e 2 M', 'aguardando', 'wa:load-' || g::text, 'whatsapp_cloud'
      FROM generate_series(1, ${volume}) AS g
    `;

    const batchLatencies = [];
    let totalClaimedInVolume = 0;
    let batchFailures = 0;

    while (totalClaimedInVolume < volume) {
      const bStart = performance.now();
      try {
        const completedBatch = await sql`
          WITH claimed AS (
            SELECT *
            FROM public.claim_whatsapp_queue_batch(
              100,
              60,
              ${subCompId}::uuid,
              NULL,
              100,
              'load-worker-1'
            )
          )
          SELECT
            c.id AS message_id,
            public.complete_whatsapp_message_order(
              c.id,
              c.company_id,
              ${subCustId}::uuid,
              0,
              2,
              3,
              ${today}::date,
              '{"eh_pedido":true,"qtd_g":3,"qtd_m":2,"qtd_p":0}'::jsonb,
              NULL,
              '11966665555',
              'mensagem',
              c.locked_by,
              c.lease_generation
            ) AS order_id
          FROM claimed c
        `;
        batchLatencies.push(performance.now() - bStart);
        if (completedBatch.length === 0) break;
        totalClaimedInVolume += completedBatch.length;
      } catch (err) {
        batchFailures++;
        throw err;
      }
    }

    const elapsedMs = performance.now() - t0;

    const [stats] = await sql`
      SELECT
        (SELECT count(*)::int FROM public.orders WHERE company_id = ${subCompId}) AS orders_count,
        coalesce((SELECT sum(total) FROM public.orders WHERE company_id = ${subCompId}), 0) AS total_sum,
        (SELECT count(*)::int FROM public.whatsapp_messages WHERE company_id = ${subCompId} AND status = 'registrado') AS registered_msgs
    `;

    assert.strictEqual(stats.orders_count, volume, `Pedidos criados (${stats.orders_count}) divergem do volume (${volume})`);
    assert.strictEqual(stats.registered_msgs, volume, `Mensagens registradas (${stats.registered_msgs}) divergem do volume (${volume})`);
    assert.strictEqual(Number(stats.total_sum), volume * 96, `Soma financeira divergiu de ${volume * 96}`);

    const sortedBatchLat = [...batchLatencies].sort((a, b) => a - b);
    loadSummary.push({
      volume,
      claimed: totalClaimedInVolume,
      ordersCreated: stats.orders_count,
      duplicates: stats.orders_count - volume,
      lost: volume - stats.registered_msgs,
      failures: batchFailures,
      totalBrl: Number(stats.total_sum),
      elapsedMs: Number(elapsedMs.toFixed(1)),
      p50BatchMs: computePercentile(sortedBatchLat, 50),
      p95BatchMs: computePercentile(sortedBatchLat, 95),
      p99BatchMs: computePercentile(sortedBatchLat, 99),
      msgsPerSec: Math.round((volume / elapsedMs) * 1000),
    });

    await cleanupSyntheticCompanyAtomic(subCompId, null);
  }

  console.table(loadSummary);
} finally {
  await cleanupSyntheticCompanyAtomic(compIdB, null);
  await cleanupSyntheticCompanyAtomic(compId, userId);
  await sql.end();
}
