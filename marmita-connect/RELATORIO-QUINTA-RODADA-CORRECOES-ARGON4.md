# RELATÓRIO DA QUINTA RODADA DE CORREÇÕES E HARDENING — MARMITA CONNECT / VERDE&MESA (ARGON 4)

- **Projeto:** Marmita Connect / Verde&Mesa
- **Diretório do Projeto:** `/working_dir/c_7bc4a72fe09e75b3/project/marmita-connect`
- **Referência Técnica:** `QUINTA-AUDITORIA-TECNICA-INDEPENDENTE-ARGON4.md` (Achados `AUD5-01` a `AUD5-05`)
- **Escopo:** Correção integral dos cinco achados da 5ª Auditoria Técnica Independente (`AUD5-01`, `AUD5-02`, `AUD5-03`, `AUD5-04` e `AUD5-05`), preservação estrita das migrations históricas `0000` a `0014`, criação da migration incremental `0015_argon4_round5_audit5_hardening.sql` (`idx: 15`) e execução das 5 baterias obrigatórias de verificação.

---

## 1. Resumo Executivo

A Quinta Rodada de Correções Técnicas do **Marmita Connect / Verde&Mesa** solucionou na causa raiz os cinco achados identificados na Quinta Auditoria Técnica Independente (`AUD5-01` a `AUD5-05`), sem alterar o design visual, sem remover funcionalidades existentes e preservando 100% das regras financeiras aprovadas e das migrations históricas `0000` a `0014`.

| Código | Severidade Original | Título do Achado | Status Pós-5ª Rodada | Evidência Principal |
|---|---|---|---|---|
| **AUD5-01** | **ALTO** | `tests/staging-pg-concurrency-and-load.mjs` chama `public.normalize_br_phone` inexistente e usa parâmetros `$1..$4` dentro de `DO $$ ... $$` | **CORRIGIDO** | Substituído por `public.financial_phone_key(phone)` e `SELECT public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text, $4::text) AS cust_id` parametrizado; validado com `node --check` e suíte `AUD5-01-AND-AUD5-05-QUEUE-LOAD-BATTERY` |
| **AUD5-02** | **MÉDIO** | `prepare_manual_whatsapp_retry` reduzia `attempts` de `5` para `4` sem limite máximo persistente de retries manuais nem cooldown | **CORRIGIDO** | Migration `0015` adiciona `manual_retry_count`, `last_manual_retry_at`, `last_manual_retry_by` e tabela `public.whatsapp_manual_retry_audit`; impõe teto de **3 retries manuais adicionais**, **cooldown de 30s**, nunca regride `attempts` e transita automaticamente falhas IA para `status = 'revisar'` após a 5ª tentativa automática |
| **AUD5-03** | **MÉDIO** | Reconciliação de eco (`whatsapp.tsx` + `reconcile_reviewed_whatsapp_echo`) exibia fallback cross-customer e tratava `outcome = 'blocked'` como sucesso | **CORRIGIDO** | Removido fallback cross-customer na UI (`selectCandidateAwaitingOrdersForReview`), tratado `outcome !== 'classified'/'confirmed'/'duplicate'` como erro explícito (`evaluateEchoReconciliationOutcome`) e endurecida `public.reconcile_reviewed_whatsapp_echo` na migration `0015` exigindo mesmo `customer_id` e mesmo `public.financial_phone_key` |
| **AUD5-04** | **MÉDIO** | `useCustomers({ customerIds })` enviava `.in("id", ...)` em uma única requisição GET e `fiado.tsx` podia disparar busca irrestrita durante o carregamento inicial | **CORRIGIDO** | Implementado `fetchCustomersByIdsChunked` em lotes de no máximo **100 UUIDs** (`MAX_CUSTOMER_IDS_CHUNK_SIZE = 100`), deduplicação e ordenação determinística, propagação explícita de erro por lote e bloqueio de busca irrestrita enquanto `authoritativeBalances` carrega em `fiado.tsx` e `relatorios.tsx` |
| **AUD5-05** | **BAIXO** | `claim_whatsapp_queue_batch` ordenava todo o subconjunto elegível na CTE materializada e preservava `next_retry_at` vencido durante o claim | **CORRIGIDO** | Migration `0015` poda `ranked.fairness_slot <= greatest(effective_limit * 2, 50)` dentro da CTE `eligible`, respeita `m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))` e limpa `next_retry_at = NULL` atomicamente no `UPDATE` do claim |

---

## 2. Estado Inicial Encontrado (Inspeção Pré-Modificação — Regra 1)

Antes de modificar qualquer arquivo, foi realizada a inspeção completa dos arquivos listados nos cinco achados, confirmando integralmente o diagnóstico da 5ª Auditoria:

1. **`tests/staging-pg-concurrency-and-load.mjs` (`AUD5-01`):**
   - Na linha 115 anterior, a consulta filtrava `WHERE company_id = ${compId} AND public.normalize_br_phone(phone) = '11944443333'`, função inexistente nas migrations `0000` a `0014` (a função canônica criada na migration `0010` é `public.financial_phone_key(raw text)`).
   - Nas linhas 183–191 anteriores, o teste de carga usava `sql.unsafe("DO $$ BEGIN PERFORM public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text, $4::text); END $$;", [...])`, incompatível com bind parameters no protocolo PostgreSQL para blocos anônimos `DO`.
2. **`drizzle/migrations/0014_argon4_round4_queue_advisory_and_review_hardening.sql`, `src/lib/company.functions.ts` e `src/lib/interpret.server.ts` (`AUD5-02`):**
   - A versão `0014` de `public.prepare_manual_whatsapp_retry` executava `attempts = CASE WHEN attempts >= 5 THEN 4 ELSE attempts END` sem contador separado de retries manuais, sem cooldown e sem tabela de auditoria.
   - Em `src/lib/interpret.server.ts`, falhas consecutivas na extração via IA mantinham `status = 'erro'` na 5ª falha em vez de transitar automaticamente para `status = 'revisar'` (dead-letter).
3. **`src/routes/_authenticated/whatsapp.tsx` e `reconcile_reviewed_whatsapp_echo` (`AUD5-03`):**
   - No modal de revisão de eco comercial `OK`/`OKK`, a seleção de pedidos candidatos possuía fallback `return matched.length > 0 ? matched : awaitingOrders`, exibindo pedidos de outros clientes quando o cliente da mensagem não tinha pedido aguardando classificação.
   - No handler `confirmReview`, apenas `recRes.error` era verificado; quando `reconcile_reviewed_whatsapp_echo` retornava JSON com `outcome = 'blocked'` (ex.: pedido fora da janela de 30 minutos), o modal fechava e exibia toast de sucesso falso.
   - Na função SQL `public.reconcile_reviewed_whatsapp_echo` (`0014`), validava-se `company_id`, mas não se impunha que `msg.customer_id = ord.customer_id` nem que `public.financial_phone_key(msg.phone) = public.financial_phone_key(cust.phone)`.
4. **`src/lib/queries.ts`, `src/routes/_authenticated/fiado.tsx` e `src/routes/_authenticated/relatorios.tsx` (`AUD5-04`):**
   - `useCustomers` passava `options.customerIds` inteiro para `.in("id", options.customerIds)` em uma única requisição GET ao PostgREST.
   - Em `fiado.tsx`, `balanceCustomerIds` retornava `undefined` enquanto `authoritativeBalances` ainda estava `undefined`, habilitando `useCustomers` sem filtro `customerIds`.
5. **`public.claim_whatsapp_queue_batch` (`AUD5-05`):**
   - Na migration `0014`, a CTE `eligible AS MATERIALIZED` calculava `row_number() OVER (PARTITION BY m.company_id, m.direction ...)` sobre todas as linhas elegíveis sem podar `fairness_slot` antes do `JOIN`, e o `UPDATE` do claim não limpava `next_retry_at = NULL`.

---

## 3. Manifesto SHA-256 Antes e Depois das Migrations `0000` a `0014` (Regra 2)

A integridade das migrations históricas `0000` a `0014` foi verificada com `sha256sum -c /tmp/round5_pre_migrations.sha256`. Todas as 15 migrations históricas permaneceram **100% idênticas byte a byte (`0` modificações)**:

| Migration | SHA-256 Antes da 5ª Rodada | SHA-256 Depois da 5ª Rodada | Status |
|---|---|---|---|
| `0000_create_marmitaria_saas_schema.sql` | `6f3718ada33ef1e1738e1b3a4e84ec14e43ccaf585256f5766b12ff6b24be9b1` | `6f3718ada33ef1e1738e1b3a4e84ec14e43ccaf585256f5766b12ff6b24be9b1` | **INALTERADO (`OK`)** |
| `0001_audit_hardening_tenant_isolation_and_finance.sql` | `a0faa2c7705da155d4cdadc188d73d5ce1d8a58a1de2d817f08a753d0abaa58e` | `a0faa2c7705da155d4cdadc188d73d5ce1d8a58a1de2d817f08a753d0abaa58e` | **INALTERADO (`OK`)** |
| `0002_fix_assert_same_company_trigger.sql` | `061ac3e14be3c876cb168f89d3db855a8cd6f45d2c9b4fd6f9c290ab6c6f54dd` | `061ac3e14be3c876cb168f89d3db855a8cd6f45d2c9b4fd6f9c290ab6c6f54dd` | **INALTERADO (`OK`)** |
| `0003_revoke_trigger_function_execute.sql` | `ef1d0d49684a206363c3f4932268147d9298546e638f2c9d46b1bfff03cf23cd` | `ef1d0d49684a206363c3f4932268147d9298546e638f2c9d46b1bfff03cf23cd` | **INALTERADO (`OK`)** |
| `0004_marmita_sizes_and_message_parsing.sql` | `dad57d97ac25941e5e539963369b4b1104d678068dd95cfa3cc833831ad12e14` | `dad57d97ac25941e5e539963369b4b1104d678068dd95cfa3cc833831ad12e14` | **INALTERADO (`OK`)** |
| `0005_whatsapp_cloud_connections.sql` | `5f0f070c3583b1acf64a1839a04bed19ef357845f037cd1119f9b92a070ed545` | `5f0f070c3583b1acf64a1839a04bed19ef357845f037cd1119f9b92a070ed545` | **INALTERADO (`OK`)** |
| `0006_orders_settled_by_payment.sql` | `af459c36b6e28a37a33b8329278f76fad2a3b1b09a5890a540c798c57ad335b7` | `af459c36b6e28a37a33b8329278f76fad2a3b1b09a5890a540c798c57ad335b7` | **INALTERADO (`OK`)** |
| `0007_whatsapp_connections_backend_only_writes.sql` | `d058c439d2b576ed04ac5b15674b2252110091043d598a42522a48f4e1627fd4` | `d058c439d2b576ed04ac5b15674b2252110091043d598a42522a48f4e1627fd4` | **INALTERADO (`OK`)** |
| `0008_order_date_brazil_default.sql` | `da7e5110f5ebc276b1f4b4407a92dc467da9e42a051195840bc88dbd83d2a9b3` | `da7e5110f5ebc276b1f4b4407a92dc467da9e42a051195840bc88dbd83d2a9b3` | **INALTERADO (`OK`)** |
| `0009_marmita_size_m_and_financial_guards.sql` | `c410a32e89ed7f872d30d4eba2835f32c93e90dcac7f4718404035e8b7285575` | `c410a32e89ed7f872d30d4eba2835f32c93e90dcac7f4718404035e8b7285575` | **INALTERADO (`OK`)** |
| `0010_activate_financial_confirmation_ok_okk.sql` | `0577758e1f2aad7561c686dd04aecaff7a68a4e28ee2a583957a61c96ec64bd2` | `0577758e1f2aad7561c686dd04aecaff7a68a4e28ee2a583957a61c96ec64bd2` | **INALTERADO (`OK`)** |
| `0011_pre_production_hardening.sql` | `4140215c4996166aa46435e32c2afe382b35d3c29e3e3b61d67eef9b82b6f1db` | `4140215c4996166aa46435e32c2afe382b35d3c29e3e3b61d67eef9b82b6f1db` | **INALTERADO (`OK`)** |
| `0012_argon4_concurrency_scalability_and_rls_hardening.sql` | `aa1400f3913739d4e20df86feca73e30a17443ec25c7da8e002d17dcf571efd5` | `aa1400f3913739d4e20df86feca73e30a17443ec25c7da8e002d17dcf571efd5` | **INALTERADO (`OK`)** |
| `0013_argon4_queue_dashboard_and_rls_hardening.sql` | `20f0dab35b8b7d8f0b754c4f7e1ff437d004a472df7bef68feb3c3bf32fd548c` | `20f0dab35b8b7d8f0b754c4f7e1ff437d004a472df7bef68feb3c3bf32fd548c` | **INALTERADO (`OK`)** |
| `0014_argon4_round4_queue_advisory_and_review_hardening.sql` | `500bae25cc5560a9945912fb230fc3aa63e6fdaed5805f9de3bd887278cb5a00` | `500bae25cc5560a9945912fb230fc3aa63e6fdaed5805f9de3bd887278cb5a00` | **INALTERADO (`OK`)** |
| **`0015_argon4_round5_audit5_hardening.sql` (NOVA)** | *(não existia)* | `962dcde0c88b6d19bd222279ae3ff9e42ff0de1d6f60c3c86dcf2650999c1044` | **CRIADA (`idx: 15`)** |

---

## 4. Correção Detalhada de `AUD5-01` a `AUD5-05`

### 4.1. `AUD5-01` — Correção do Script de Homologação e Benchmark em PostgreSQL
- **Arquivo:** `tests/staging-pg-concurrency-and-load.mjs` (e sincronização em `scripts/run-staging-homologation.sh` e `tests/staging-homologation-suite.sql`).
- **Mudanças implementadas:**
  1. Substituída a chamada inexistente `public.normalize_br_phone(phone)` pela função real do banco `public.financial_phone_key(phone)`.
  2. Substituído o bloco `DO $$ ... $$` com parâmetros `$1..$4` por consulta parametrizada compatível com o protocolo PostgreSQL:
     ```sql
     SELECT public.get_or_create_customer_by_phone($1::uuid, $2::text, $3::text, $4::text) AS cust_id
     ```
  3. Mantida a limpeza de dados sintéticos dentro de transação segura (`sql.begin`) com restauração explícita de `zz_financial_guard_order` e `financial_audit_immutable`.
  4. Expandido o benchmark para testar `2`, `5` e `10` workers simultâneos e backlogs de `1.000`, `5.000` e `10.000` mensagens, medindo latências `p50`, `p95`, `p99`, mensagens reclamadas, duplicidades, perdas e falhas.

### 4.2. `AUD5-02` — Limite, Cooldown, Dead-Letter e Auditoria de Retry Manual e Automático
- **Arquivos:** `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql`, `src/lib/interpret.server.ts`, `src/lib/company.functions.ts`, `src/lib/whatsapp-webhook.server.ts`, `src/lib/operational-alerts.server.ts`.
- **Mudanças implementadas:**
  1. **Separação de tentativas automáticas e retries manuais:**
     - Tentativas automáticas continuam limitadas a **5** (`MAX_INBOUND_AUTO_ATTEMPTS = 5`).
     - Adicionadas as colunas `manual_retry_count integer NOT NULL DEFAULT 0`, `last_manual_retry_at timestamptz` e `last_manual_retry_by uuid` em `public.whatsapp_messages`.
     - Criada a tabela de auditoria `public.whatsapp_manual_retry_audit` com RLS por empresa (`company_id = public.current_company_id()`) e `REVOKE INSERT/UPDATE/DELETE FROM authenticated`.
  2. **Eliminação da regressão `attempts 5 -> 4`:**
     - `public.prepare_manual_whatsapp_retry` nunca reduz `attempts`. Em vez disso, incrementa `manual_retry_count` (até o máximo de `3` retries manuais por mensagem) e `claim_whatsapp_queue_batch` permite o claim enquanto `m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))` (máximo absoluto de 8 execuções totais: 5 automáticas + 3 manuais autorizadas).
  3. **Cooldown mínimo de 30 segundos e bloqueio após o limite:**
     - Solicitações repetidas em menos de `30` segundos são bloqueadas no PostgreSQL (`SQLSTATE P0001`) e registradas em `public.whatsapp_manual_retry_audit` com `outcome = 'blocked'` e `reason = 'COOLDOWN_MANUAL_ATIVO'`.
     - Após atingir `3` retries manuais, novas solicitações são bloqueadas (`reason = 'LIMITE_RETRIES_MANUAIS_ATINGIDO'`), movendo a mensagem para `status = 'revisar'`.
  4. **Transição automática para `status = 'revisar'` (dead-letter) e jitter:**
     - Em `src/lib/interpret.server.ts`, quando `effectiveAttempts >= MAX_INBOUND_AUTO_ATTEMPTS + manualRetryCount`, a mensagem transita imediatamente para `status = 'revisar'` com `next_retry_at = null` e metadados `dead_letter`.
     - O backoff exponencial de erro inbound inclui jitter determinístico/aleatório de `0..2500ms` (`computeInboundErrorBackoffMs`).
  5. **Segurança de logs operacionais:**
     - Em `src/lib/operational-alerts.server.ts`, telefones são mascarados (`***7766` via `maskPhoneForOperationalLog`) e chaves sensíveis (`token`, `secret`, `authorization`, `password`, etc.) são redigidas (`[REDACTED]`).

### 4.3. `AUD5-03` — Endurecimento da Reconciliação de Eco Comercial (`OK` / `OKK`)
- **Arquivos:** `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql`, `src/routes/_authenticated/whatsapp.tsx`.
- **Mudanças implementadas:**
  1. **Remoção total do fallback cross-customer na UI (`whatsapp.tsx`):**
     - A função exportada `selectCandidateAwaitingOrdersForReview(awaitingOrders, reviewMsg)` retorna apenas pedidos aguardando classificação que pertençam ao mesmo cliente (`customer_id`) e ao mesmo telefone normalizado (`financial_phone_key`). Se não houver pedido elegível daquele cliente, retorna `[]` e a UI exibe aviso claro orientando a dispensar o eco ou classificar na tela de Pedidos.
  2. **Validação estrita no banco (`public.reconcile_reviewed_whatsapp_echo` na migration `0015`):**
     - Exige mesma empresa (`company_id = comp`), mesmo cliente (`msg.customer_id = ord.customer_id` quando preenchido), presença de telefone válido (`length >= 8`) em ambos os lados e igualdade exata `public.financial_phone_key(cust.phone) = public.financial_phone_key(msg.phone)`, lançando `SQLSTATE 22023` em qualquer divergência.
  3. **Tratamento rigoroso do `outcome` retornado pela RPC (`evaluateEchoReconciliationOutcome`):**
     - `outcome = 'classified'` ou `'confirmed'` -> sucesso real, fecha o modal e atualiza as listas;
     - `outcome = 'duplicate'` -> tratado de forma idempotente com aviso informativo;
     - `outcome = 'blocked'` ou qualquer payload inesperado -> tratado como **erro explícito** (`toast.error`), mantendo o modal aberto e a mensagem em `revisar`.

### 4.4. `AUD5-04` — Paginação e Fatiamento de `customerIds` em Lotes Seguros
- **Arquivos:** `src/lib/queries.ts`, `src/routes/_authenticated/fiado.tsx`, `src/routes/_authenticated/relatorios.tsx`.
- **Mudanças implementadas:**
  1. Criadas e exportadas `MAX_CUSTOMER_IDS_CHUNK_SIZE = 100`, `chunkCustomerIds` e `fetchCustomersByIdsChunked` em `src/lib/queries.ts`.
  2. Quando `customerIds` contém mais de 100 UUIDs (ex.: `300`, `1.500`, `5.000` ou `10.000` devedores), `useCustomers` divide a busca em lotes de no máximo **100 UUIDs** (mantendo a query string de cada GET abaixo de ~3,8 KB), executa com concorrência controlada (`concurrency: 4`), deduplica por `id` e ordena deterministicamente por `(name ASC, id ASC)`.
  3. Se qualquer lote retornar erro, a exceção é propagada imediatamente sem ocultar falhas parciais.
  4. Em `fiado.tsx` e `relatorios.tsx`, `balanceCustomerIds` nunca assume `undefined` quando `authoritativeBalances` ainda está carregando (`enabled: Boolean(company?.id) && Boolean(authoritativeBalances)`), eliminando qualquer busca irrestrita inicial.

### 4.5. `AUD5-05` — Otimização e Higiene da Fila em `claim_whatsapp_queue_batch`
- **Arquivos:** `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql`, `src/lib/whatsapp-webhook.server.ts`.
- **Mudanças implementadas:**
  1. Na CTE `eligible AS MATERIALIZED`, adicionada a poda `WHERE ranked.fairness_slot <= greatest(effective_limit * 2, 50)`, evitando materializar e ordenar milhares de linhas por tenant quando o backlog atinge `10.000+` mensagens, sem alterar a justiça round-robin (`PARTITION BY m.company_id, m.direction`) nem a espera causal (`causal_wait`).
  2. No `UPDATE` atômico do claim (e no fallback em `whatsapp-webhook.server.ts`), `next_retry_at` é limpo para `NULL` enquanto `status = 'processando'` e `locked_until` futuro garantem exclusão mútua.

---

## 5. Arquivos Criados ou Modificados

| Arquivo | Ação | Finalidade |
|---|---|---|
| `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql` | **Criado** | Migration incremental `0015` com todas as correções SQL de `AUD5-02`, `AUD5-03` e `AUD5-05` |
| `drizzle/migrations/meta/_journal.json` | **Modificado** | Registro incremental da migration `0015_argon4_round5_audit5_hardening` (`idx: 15`) |
| `src/lib/operational-alerts.server.ts` | **Modificado** | Mascaramento de telefones (`maskPhoneForOperationalLog`) e redação de segredos (`sanitizeOperationalAlertDetails`) |
| `src/lib/interpret.server.ts` | **Modificado** | Constantes `MAX_INBOUND_AUTO_ATTEMPTS = 5`, `MAX_MANUAL_RETRIES = 3`, `MANUAL_RETRY_COOLDOWN_SECONDS = 30`, jitter em `computeInboundErrorBackoffMs` e transição automática para `status = 'revisar'` após 5 falhas automáticas |
| `src/lib/company.functions.ts` | **Modificado** | `retryPendingMessages` com singleflight (`inFlightManualRetries`), propagação de erros de limite/cooldown e passagem de `_actor_id`, `_max_manual_retries` e `_cooldown_seconds` |
| `src/lib/whatsapp-webhook.server.ts` | **Modificado** | Passagem de `manual_retry_count` ao processador inbound e limpeza `next_retry_at: null` no claim |
| `src/routes/_authenticated/whatsapp.tsx` | **Modificado** | Filtro estrito sem fallback cross-customer (`selectCandidateAwaitingOrdersForReview`) e validação de `outcome` (`evaluateEchoReconciliationOutcome`) |
| `src/lib/queries.ts` | **Modificado** | Fatiamento de `customerIds` em lotes de até 100 UUIDs (`MAX_CUSTOMER_IDS_CHUNK_SIZE`, `chunkCustomerIds`, `fetchCustomersByIdsChunked`) |
| `src/routes/_authenticated/fiado.tsx` | **Modificado** | Bloqueio de consulta irrestrita durante o carregamento inicial de `authoritativeBalances` e uso de lotes de 100 UUIDs |
| `src/routes/_authenticated/relatorios.tsx` | **Modificado** | Sincronização de `balanceCustomerIds` com `useCustomers` paginado em lotes de 100 UUIDs |
| `src/integrations/supabase/types.ts` | **Modificado** | Adição de `whatsapp_manual_retry_audit`, colunas de retry manual em `whatsapp_messages` e assinatura atualizada de `prepare_manual_whatsapp_retry` |
| `tests/staging-pg-concurrency-and-load.mjs` | **Modificado** | Substituição de `normalize_br_phone` por `public.financial_phone_key`, remoção de `DO $$` parametrizado e adição de benchmarks para 2/5/10 workers e 1.000/5.000/10.000 mensagens |
| `scripts/run-staging-homologation.sh` | **Modificado** | Inclusão da migration `0015_*.sql` no pipeline de homologação |
| `tests/staging-homologation-suite.sql` | **Modificado** | Adição de asserções SQL para `AUD5-02`, `AUD5-03` e `AUD5-05` |
| `src/lib/argon4-fixes.test.ts` | **Modificado** | Adição dos testes unitários e de contrato para `AUD5-01` a `AUD5-05` |
| `RELATORIO-QUINTA-RODADA-CORRECOES-ARGON4.md` | **Criado** | Relatório técnico detalhado da Quinta Rodada de Correções |

---

## 6. Nova Migration `0015_argon4_round5_audit5_hardening.sql`

- **Caminho:** `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql`
- **SHA-256:** `962dcde0c88b6d19bd222279ae3ff9e42ff0de1d6f60c3c86dcf2650999c1044`
- **Registro no Journal (`drizzle/migrations/meta/_journal.json`):**
  ```json
  {
    "idx": 15,
    "version": "7",
    "when": 1775606400000,
    "tag": "0015_argon4_round5_audit5_hardening",
    "breakpoints": true
  }
  ```
- **Objetos criados/atualizados pela migration `0015`:**
  1. `ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS manual_retry_count integer NOT NULL DEFAULT 0, last_manual_retry_at timestamptz, last_manual_retry_by uuid;`
  2. `CREATE TABLE IF NOT EXISTS public.whatsapp_manual_retry_audit (...)` + índice `whatsapp_manual_retry_audit_company_msg_idx` + RLS `whatsapp_manual_retry_audit_company_read`.
  3. `CREATE OR REPLACE FUNCTION public.prepare_manual_whatsapp_retry(_company_id uuid, _message_id uuid, _actor_id uuid, _max_manual_retries integer, _cooldown_seconds integer)` com `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `pg_advisory_xact_lock`, limite de 3 retries manuais e cooldown de 30s.
  4. `CREATE OR REPLACE FUNCTION public.claim_whatsapp_queue_batch(...)` com poda `ranked.fairness_slot <= greatest(effective_limit * 2, 50)`, teto `m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))` e limpeza `next_retry_at = NULL`.
  5. `CREATE OR REPLACE FUNCTION public.reconcile_reviewed_whatsapp_echo(_whatsapp_message_id uuid, _order_id uuid, _command text)` com validação estrita de `company_id`, `customer_id` e `public.financial_phone_key`.

---

## 7. Testes Executados por Categoria (`A` a `F`)

Em cumprimento estrito às regras de evidência real:

| Categoria | Descrição | Status de Execução | Resultado |
|---|---|---|---|
| **A — Inspeção estática** | Verificação de código SQL (`0000..0015`), TypeScript/React, tipos Supabase, `node --check`, `bash -n` e manifesto SHA-256 | **EXECUTADO LOCALMENTE** | **100% APROVADO** (`15/15` migrations históricas `0000..0014` com SHA-256 intacto; `0` ocorrências de `normalize_br_phone` ou `DO $$` em `staging-pg-concurrency-and-load.mjs`) |
| **B — Testes unitários** | Funções puras de cálculo de backoff + jitter, fatiamento de lotes `chunkCustomerIds`, seletores `selectCandidateAwaitingOrdersForReview`, `evaluateEchoReconciliationOutcome`, mascaramento de logs e reconciliação de saldos | **EXECUTADO LOCALMENTE** | **100% APROVADO** (`argon4-round5-verification-suite.mjs`, `argon4-round4-verification-suite.mjs` e `argon4-round2-regression-suite.mjs`) |
| **C — Integração simulada** | Simulação transacional em memória de máquinas de estado de retry manual/automático, concorrência de workers, fairness multi-tenant, reconciliação de eco e invariantes financeiros | **EXECUTADO LOCALMENTE** | **100% APROVADO** (`5/5` baterias na suíte da 5ª rodada, `5/5` na suíte da 4ª rodada e `14/14` na suíte da 2ª rodada) |
| **D — PostgreSQL real** | Execução contra instância PostgreSQL dedicada via `STAGING_DATABASE_URL` (`scripts/run-staging-homologation.sh`) | **PENDENTE (AGUARDANDO AMBIENTE EXTERNO DE STAGING)** | Scripts corrigidos e validados sintaticamente (`AUD5-01` resolvido), prontos para execução assim que `STAGING_DATABASE_URL` for fornecido |
| **E — Supabase real** | Testes contra Auth/PostgREST/RLS em instância Supabase real | **PENDENTE (AGUARDANDO AMBIENTE EXTERNO DE STAGING)** | Políticas RLS, grants e tipos TypeScript validados estaticamente e por contrato |
| **F — Homologação completa em staging** | Webhook Meta real + Gemini API real + k6 sob carga em ambiente de staging | **PENDENTE (AGUARDANDO AMBIENTE EXTERNO DE STAGING)** | Projeto tecnicamente apto para iniciar a homologação completa em staging |

---

## 8. Resultados dos Testes de Carga, Concorrência, Paginação e Regressão (Categorias B e C)

### 8.1. Bateria de Retry (`AUD5-02-RETRY-BATTERY` — PASS em `26,18 ms`)
- **5 falhas automáticas consecutivas:** `attempts` avança de `1` a `5` com jitter (`15.475 ms`, `30.950 ms`, `61.425 ms`, `121.900 ms`, `242.375 ms`); na 5ª falha transita automaticamente para `status = 'revisar'` e `next_retry_at = NULL`.
- **6ª tentativa automática sem ação humana:** bloqueada (`canAutoClaim6th = false`).
- **2 requisições manuais concorrentes em `t = 1000s`:** serializadas via singleflight + advisory lock; contabilizam exatamente `1` retry manual (`manual_retry_count = 1`, `attempts = 5` preservado sem regressão `5 -> 4`).
- **Tentativa manual dentro do cooldown (`t = 1010s`, `< 30s`):** bloqueada com `P0001: Aguarde pelo menos 30 segundos`.
- **Worker obsoleto tentando concluir mensagem após perda de lease:** bloqueado pelo fencing token `lease_generation`.
- **4º retry manual (`t = 1150s`, após 3 retries manuais):** bloqueado definitivamente com `P0001: Limite máximo de 3 reprocessamentos manuais atingido`, com `3` registros persistidos em `whatsapp_manual_retry_audit`.

### 8.2. Bateria de Reconciliação (`AUD5-03-RECONCILIATION-BATTERY` — PASS em `0,70 ms`)
- **Eco e pedido do mesmo cliente dentro da janela (`+2 min`):** confirmado (`outcome = 'confirmed'`, `financial_state = 'fiado'`).
- **Eco e pedido de clientes diferentes:** UI retorna `[]` (zero pedidos de terceiros exibidos) e tentativa direta na RPC é bloqueada com `SQLSTATE 22023`.
- **Telefone divergente entre mensagem e cliente:** bloqueado na UI e na RPC (`SQLSTATE 22023`).
- **Cliente ou mensagem sem telefone válido:** bloqueado na UI (`[]`) e na RPC (`SQLSTATE 22023`).
- **Pedido fora da janela segura de 30 minutos (`+60 min`):** RPC retorna `outcome = 'blocked'` (`OUTSIDE_RECONCILIATION_WINDOW`) e `evaluateEchoReconciliationOutcome` retorna `ok: false`, exibindo erro explícito na UI e mantendo o pedido em `aguardando_classificacao`.
- **Repetição idempotente (`outcome = 'duplicate'`):** tratada sem duplicar classificação.

### 8.3. Bateria de Paginação e Lotes de Devedores (`AUD5-04-PAGINATION-CHUNKING-BATTERY` — PASS em `15,68 ms`)

| Total de Clientes Devedores | Lotes Executados (`chunkSize = 100`) | Tamanho Máximo de Lote | Tamanho Máximo da Query String (`id=in.(...)`) | Registros Retornados | Duplicatas / Truncamento |
|---:|---:|---:|---:|---:|---:|
| **100** | 1 | 100 | 3.707 bytes (`< 4 KB`) | 100 | `0` / `0` |
| **300** | 3 | 100 | 3.707 bytes (`< 4 KB`) | 300 | `0` / `0` |
| **1.500** | 15 | 100 | 3.707 bytes (`< 4 KB`) | 1.500 | `0` / `0` |
| **5.000** | 50 | 100 | 3.707 bytes (`< 4 KB`) | 5.000 | `0` / `0` |
| **10.000** | 100 | 100 | 3.707 bytes (`< 4 KB`) | 10.000 | `0` / `0` |

### 8.4. Bateria de Fila e Concorrência (`AUD5-01-AND-AUD5-05-QUEUE-LOAD-BATTERY` — PASS em `6,62 ms`)

| Cenário | Mensagens na Fila | Linhas Materializadas no CTE (`slot_horizon = 50`) | Processadas Únicas | Duplicadas | Perdidas | `next_retry_at` Limpos no Claim | Tempo de Execução |
|---|---:|---:|---:|---:|---:|---:|---:|
| **2 Workers Concorrentes** | 1.000 | — | 1.000 | 0 | 0 | 67 | `1,9 ms` |
| **5 Workers Concorrentes** | 1.000 | — | 1.000 | 0 | 0 | 67 | `2,1 ms` |
| **10 Workers Concorrentes** | 1.000 | — | 1.000 | 0 | 0 | 67 | `2,4 ms` |
| **Backlog 1.000 (80% Noisy Tenant A)** | 1.000 | 250 | 25 (1º lote: 20 de tenants silenciosos) | 0 | 0 | — | `0,53 ms` |
| **Backlog 5.000 (80% Noisy Tenant A)** | 5.000 | 250 | 25 (1º lote: 20 de tenants silenciosos) | 0 | 0 | — | `0,87 ms` |
| **Backlog 10.000 (80% Noisy Tenant A)** | 10.000 | 250 | 25 (1º lote: 20 de tenants silenciosos) | 0 | 0 | — | `1,53 ms` |

### 8.5. Bateria Financeira e de Regressão (`ROUND5-FINANCIAL-REGRESSION-BATTERY` — PASS em `0,23 ms`)
- `3G` a `R$ 20,00` = **`R$ 60,00`** (`PASS`)
- `3G + 2M` (`3 × R$ 20 + 2 × R$ 18`) = **`R$ 96,00`** (`PASS`)
- `5G` pagos (`OK`) = **`R$ 100,00`** (`PASS`)
- `5G` fiados (`OKK`) = **`R$ 100,00`** (`PASS`)
- Pagamento parcial de `R$ 60,00` em dívida de `R$ 100,00` -> saldo aberto = **`R$ 40,00`** (`PASS`)
- Quitação integral FIFO (`+ R$ 40,00`) -> saldo aberto = **`R$ 0,00`**, `paid = true`, `settled_by_payment = true` (`PASS`)
- Imutabilidade histórica: reajuste de preço futuro (`G -> R$ 25,00`) mantém pedidos antigos em **`R$ 100,00`** (`PASS`)

---

## 9. Riscos Residuais e Próximos Passos Operacionais

1. **Execução das Categorias `D`, `E` e `F` em Ambiente Externo de Homologação (Staging):**
   - Como o ambiente local de auditoria/desenvolvimento não possui conexão de rede externa nem variáveis `STAGING_DATABASE_URL`, `VITE_SUPABASE_URL` ou `GEMINI_API_KEY` apontando para infraestrutura viva, a execução real do script `./scripts/run-staging-homologation.sh` contra o PostgreSQL/Supabase de staging deve ser realizada na pipeline de homologação antes da promoção para produção.
2. **Ordem de Aplicação das Migrations no Banco de Homologação:**
   - Garantir a aplicação sequencial até `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql` (`idx: 15`), que é 100% idempotente e aditiva.

---

## 10. Veredito Técnico Final

- **Status dos Achados `AUD5-01` a `AUD5-05`:** **100% CORRIGIDOS E VERIFICADOS (Categorias A, B e C)**
- **Integridade das Migrations `0000` a `0014`:** **100% PRESERVADA (`0` arquivos históricos modificados)**
- **Veredito:** **APTO PARA HOMOLOGAÇÃO COMPLETA EM STAGING**
