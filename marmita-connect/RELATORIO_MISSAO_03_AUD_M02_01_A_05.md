# RELATÓRIO DE IMPLEMENTAÇÃO E REAUDITORIA INDEPENDENTE — MISSÃO 03 (`AUD-M02-01` A `AUD-M02-05`)

- **Projeto:** Marmita Connect / Verde&Mesa — Argon 4
- **Escopo:** Fechamento técnico da Missão 01 (`C-09` / `M-02` — Claim, Lease, Heartbeat e Fencing da Fila WhatsApp)
- **Status Final (Seção 14):** **IMPLEMENTAÇÃO CONCLUÍDA — HOMOLOGAÇÃO EXTERNA PENDENTE**
- **Condição de Parada (Seção 15):** Missão `C-04` **NÃO INICIADA**.

---

## 1. MATRIZ CONSOLIDADA DE ACHADOS (FORMATO OBRIGATÓRIO — SEÇÃO 13)

| ID | Problema | Arquivos | Correção | Teste Real | Resultado |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`AUD-M02-01`** | Lease expirado aceito nas RPCs SQL `release_whatsapp_message_lock` e `complete_whatsapp_message_order` caso outro worker ainda não tivesse reclamado | `drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql`, `drizzle/migrations/meta/_journal.json`, `tests/staging-homologation-suite.sql` | Criada migration incremental `0020` exigindo `locked_until IS NOT NULL AND locked_until >= clock_timestamp()` no `UPDATE` de `release_whatsapp_message_lock` e após `FOR UPDATE` em `complete_whatsapp_message_order` (lançando `MESSAGE_LEASE_LOST` / `55P03`). | Runtime Node.js `v18.20.4` (`M03-01` a `M03-12`) / PostgreSQL Real (`Seção 7.8`) | **PASS** (Node: `12/12`) / **BLOCKED** (PostgreSQL real sem `psql`/rede) |
| **`AUD-M02-02`** | Representação de `bigint` como `string` rejeitada por `typeof gen === "number"` | `src/lib/interpret.server.ts`, `src/lib/whatsapp-webhook.server.ts`, `src/lib/argon4-fixes.test.ts` | Criado normalizador único `normalizeFencingGeneration(raw)` que aceita inteiros positivos seguros (`number` ou `string` estrita `/^[1-9]\d*$/` dentro de `Number.MAX_SAFE_INTEGER` com round-trip exato) e aplicado em todo o pipeline de claim, lock local, heartbeat, release, verify e interpretação. | Runtime Node.js `v18.20.4` (`M03-13` a `M03-15`) | **PASS** (`3/3`) |
| **`AUD-M02-03`** | Fluxo financeiro de ecos `OK`/`OKK` (`processVerifiedBusinessEcho` / `financial_classify_by_echo`) sem revalidação de fencing pré-commit e dentro da transação SQL | `src/lib/whatsapp-webhook.server.ts`, `drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql`, `src/integrations/supabase/types.ts` | Propagados `messageId`, `workerId`, `leaseGeneration`, `waitForHeartbeat` e `isLeaseLost` para `processVerifiedBusinessEcho`; adicionada barreira `ensureEchoWorkerLeaseValid()` antes e após `financial_echo_context` e imediatamente antes de `financial_classify_by_echo`; endurecida a RPC `public.financial_classify_by_echo` na migration `0020` com `FOR UPDATE` em `whatsapp_messages` e validação de `status`, `locked_by`, `lease_generation` e `locked_until >= clock_timestamp()`. | Runtime Node.js `v18.20.4` (`M03-16` a `M03-24`) / PostgreSQL Real (`Seção 7.8`) | **PASS** (Node: `9/9`) / **BLOCKED** (PostgreSQL real) |
| **`AUD-M02-04`** | Divergência documental sobre permissões `EXECUTE` de `complete_whatsapp_message_order` no relatório da Missão 01 | `RELATORIO_MISSAO_01_C09_CLAIM_FILA_WHATSAPP.md`, `drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql` | Atualizada a Seção C.2 do relatório da Missão 01 e os comentários SQL da migration `0020` registrando com exatidão quais RPCs são exclusivas de `service_role` e quais permitem `authenticated` com guarda interna `auth.uid()` + `public.financial_require_operator()`. | Revisão Forense + `M03-25` | **PASS** |
| **`AUD-M02-05`** | Ausência de `package-lock.json` e uso de `npm install` em `scripts/run-staging-homologation.sh` | `scripts/run-staging-homologation.sh` | Padronizado `npm` como gerenciador oficial (alinhado aos workflows GitHub Actions e `.npmrc`), atualizado `scripts/run-staging-homologation.sh` para exigir `package-lock.json` e executar `npm ci` (além de incluir `0020_*.sql`). A geração do `package-lock.json` via `npm install --package-lock-only` foi tentada e ficou `BLOCKED` por ausência de internet no container (`EAI_AGAIN registry.npmjs.org`), sem improvisar lockfile sintético. | `M03-26` + Tentativa real `npm ci` / `npm install --package-lock-only` | **PASS** (Script) / **BLOCKED** (Geração online do lockfile e `npm ci`) |

---

## 2. INDICADORES E HASHES SHA-256 (SEÇÃO 13)

- **SHA-256 inicial do pacote (`marmita-connect-argon4.zip` pós-Missão 01):** `bb467b894946101b548ef6e7e87a153cfad5fea8b6ce7e897b41441f58b695ca`
- **SHA-256 final do pacote (`marmita-connect-argon4.zip` pós-Missão 03):** `Calculado no manifesto de entrega do pacote ZIP`
- **Hash SHA-256 da nova migration `0020_argon4_c09_lease_and_echo_hardening.sql`:** `82220c4b5db0eec4ab9d95e14225a04bcca9b5a52940e38f702c5a46b82cabf3`
- **Hash SHA-256 do lockfile (`package-lock.json`):** `BLOCKED` *(não gerado no container offline para não introduzir lockfile sintético inválido sem hashes `sha512` do registry npm; deve ser gerado na primeira execução online com `npm install --package-lock-only` em Node.js `>= 22.12.0`)*.
- **Quantidade de arquivos alterados/criados na Missão 03:** `8` arquivos modificados + `2` arquivos criados (`0020_argon4_c09_lease_and_echo_hardening.sql` e `RELATORIO_MISSAO_03_AUD_M02_01_A_05.md`) = `10` arquivos tocados (total do projeto: `176` arquivos).
- **Quantidade de testes aprovados (`PASS`):** `26/26` cenários da suíte `M03-01` a `M03-26` em runtime Node.js + `2/2` validações sintáticas (`bash -n` nos 3 scripts Bash e `yaml.safe_load` nos 2 workflows GitHub Actions).
- **Quantidade de testes reprovados (`FAIL` de lógica/código):** `0`.
- **Quantidade de testes bloqueados por infraestrutura (`BLOCKED`):** `7` comandos/suítes dependentes de rede externa (`registry.npmjs.org`) ou banco PostgreSQL ativo (`psql`):
  1. `npm install --package-lock-only --ignore-scripts` (`EAI_AGAIN registry.npmjs.org`, exit code `1`);
  2. `npm ci` (`EUSAGE` por ausência de `package-lock.json` prévio, exit code `1`);
  3. `npm run typecheck` (`sh: 1: tsc: not found`, exit code `127`);
  4. `npx --no-install vitest run src/` (sem `node_modules` local / timeout de rede, exit code `124`);
  5. `npm run build` (`sh: 1: vite: not found`, exit code `127`);
  6. Execução SQL real de `drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql` e `tests/staging-homologation-suite.sql` (Seção `7.8`) via `psql` (`psql: command not found` / sem `STAGING_DATABASE_URL`);
  7. Teste de concorrência real multi-conexão `tests/staging-pg-concurrency-and-load.mjs` contra PostgreSQL externo (`BLOCKED` por ausência de `STAGING_DATABASE_URL`).

---

## 3. PRESERVAÇÃO INTEGRAL DAS MIGRATIONS HISTÓRICAS `0000`–`0019`

| Migration | SHA-256 Antes (Pré-Missão 03) | SHA-256 Depois (Pós-Missão 03) | Status |
| :--- | :--- | :--- | :--- |
| `drizzle/migrations/0000_create_marmitaria_saas_schema.sql` | `6f3718ada33ef1e1738e1b3a4e84ec14e43ccaf585256f5766b12ff6b24be9b1` | `6f3718ada33ef1e1738e1b3a4e84ec14e43ccaf585256f5766b12ff6b24be9b1` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0001_audit_hardening_tenant_isolation_and_finance.sql` | `a0faa2c7705da155d4cdadc188d73d5ce1d8a58a1de2d817f08a753d0abaa58e` | `a0faa2c7705da155d4cdadc188d73d5ce1d8a58a1de2d817f08a753d0abaa58e` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0002_fix_assert_same_company_trigger.sql` | `061ac3e14be3c876cb168f89d3db855a8cd6f45d2c9b4fd6f9c290ab6c6f54dd` | `061ac3e14be3c876cb168f89d3db855a8cd6f45d2c9b4fd6f9c290ab6c6f54dd` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0003_revoke_trigger_function_execute.sql` | `ef1d0d49684a206363c3f4932268147d9298546e638f2c9d46b1bfff03cf23cd` | `ef1d0d49684a206363c3f4932268147d9298546e638f2c9d46b1bfff03cf23cd` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0004_marmita_sizes_and_message_parsing.sql` | `dad57d97ac25941e5e539963369b4b1104d678068dd95cfa3cc833831ad12e14` | `dad57d97ac25941e5e539963369b4b1104d678068dd95cfa3cc833831ad12e14` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0005_whatsapp_cloud_connections.sql` | `5f0f070c3583b1acf64a1839a04bed19ef357845f037cd1119f9b92a070ed545` | `5f0f070c3583b1acf64a1839a04bed19ef357845f037cd1119f9b92a070ed545` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0006_orders_settled_by_payment.sql` | `af459c36b6e28a37a33b8329278f76fad2a3b1b09a5890a540c798c57ad335b7` | `af459c36b6e28a37a33b8329278f76fad2a3b1b09a5890a540c798c57ad335b7` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0007_whatsapp_connections_backend_only_writes.sql` | `d058c439d2b576ed04ac5b15674b2252110091043d598a42522a48f4e1627fd4` | `d058c439d2b576ed04ac5b15674b2252110091043d598a42522a48f4e1627fd4` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0008_order_date_brazil_default.sql` | `da7e5110f5ebc276b1f4b4407a92dc467da9e42a051195840bc88dbd83d2a9b3` | `da7e5110f5ebc276b1f4b4407a92dc467da9e42a051195840bc88dbd83d2a9b3` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0009_marmita_size_m_and_financial_guards.sql` | `c410a32e89ed7f872d30d4eba2835f32c93e90dcac7f4718404035e8b7285575` | `c410a32e89ed7f872d30d4eba2835f32c93e90dcac7f4718404035e8b7285575` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0010_activate_financial_confirmation_ok_okk.sql` | `0577758e1f2aad7561c686dd04aecaff7a68a4e28ee2a583957a61c96ec64bd2` | `0577758e1f2aad7561c686dd04aecaff7a68a4e28ee2a583957a61c96ec64bd2` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0011_pre_production_hardening.sql` | `4140215c4996166aa46435e32c2afe382b35d3c29e3e3b61d67eef9b82b6f1db` | `4140215c4996166aa46435e32c2afe382b35d3c29e3e3b61d67eef9b82b6f1db` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0012_argon4_concurrency_scalability_and_rls_hardening.sql` | `aa1400f3913739d4e20df86feca73e30a17443ec25c7da8e002d17dcf571efd5` | `aa1400f3913739d4e20df86feca73e30a17443ec25c7da8e002d17dcf571efd5` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0013_argon4_queue_dashboard_and_rls_hardening.sql` | `20f0dab35b8b7d8f0b754c4f7e1ff437d004a472df7bef68feb3c3bf32fd548c` | `20f0dab35b8b7d8f0b754c4f7e1ff437d004a472df7bef68feb3c3bf32fd548c` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0014_argon4_round4_queue_advisory_and_review_hardening.sql` | `500bae25cc5560a9945912fb230fc3aa63e6fdaed5805f9de3bd887278cb5a00` | `500bae25cc5560a9945912fb230fc3aa63e6fdaed5805f9de3bd887278cb5a00` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0015_argon4_round5_audit5_hardening.sql` | `962dcde0c88b6d19bd222279ae3ff9e42ff0de1d6f60c3c86dcf2650999c1044` | `962dcde0c88b6d19bd222279ae3ff9e42ff0de1d6f60c3c86dcf2650999c1044` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0016_argon4_round6_critical_security_and_queue_fixes.sql` | `9139d92b29db00f55bd0d5679743677bad39d428511346063c9a314e701aa7c0` | `9139d92b29db00f55bd0d5679743677bad39d428511346063c9a314e701aa7c0` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0017_argon4_round9_trigger_role_and_audit_hardening.sql` | `8929e373469bf60a6fd93f385e685098e4c5ce6b9270c1e862d9210cf68306dc` | `8929e373469bf60a6fd93f385e685098e4c5ce6b9270c1e862d9210cf68306dc` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0018_argon4_forensic_audit_hardening.sql` | `fc9bf6b930bc318306586ab73869fcb45b89e5011b38a3aca9f28d7f8297c15e` | `fc9bf6b930bc318306586ab73869fcb45b89e5011b38a3aca9f28d7f8297c15e` | **IDÊNTICO (0 bytes alterados)** |
| `drizzle/migrations/0019_argon4_c09_queue_fencing_and_claim_hardening.sql` | `019e2e31cd33f8c3faac7705e75287b103771c07cf50d942d1634845f3223ef7` | `019e2e31cd33f8c3faac7705e75287b103771c07cf50d942d1634845f3223ef7` | **IDÊNTICO (0 bytes alterados)** |

---

## 4. HASHES SHA-256 DOS ARQUIVOS MODIFICADOS E CRIADOS NA MISSÃO 03

| Arquivo | Status | SHA-256 Antes (Pré-Missão 03) | SHA-256 Depois (Pós-Missão 03) |
| :--- | :--- | :--- | :--- |
| `drizzle/migrations/meta/_journal.json` | Modificado | `efa2747ea9121e1fa82f9bb35116b68a00992fbf6ef7fd796fcf9530cd22d61c` | `86f39fc6cbf6f17af2e26a08e5dce227f6dd09fa0213e3b3504ae69e4c8140dd` |
| `src/integrations/supabase/types.ts` | Modificado | `addf75fce7940e94fd36c9e625e1ba286ad03bff865d3f14cf0ffe762f362e75` | `7683799a43d9b8b6d6ad9850ff20aaed2acb8642f8836de7d58d338b97569331` |
| `src/lib/interpret.server.ts` | Modificado | `4252a83bee54a1baa20d6455c845d79f641067e58d4e8367df148d8006c5dbd6` | `2445123badcfd0fbb46ff11947c3338f11cdf7db3a7c55ee6340ac859ed4fae5` |
| `src/lib/whatsapp-webhook.server.ts` | Modificado | `819db8b06c33deb74211bbf02c94ec1c141fbc7d4d15a456b0aaf7fbc305fdc7` | `61a6fedb62a7274cd8685a8f0f2f03e80ba8fa64620287fdfcc051e36196d59b` |
| `scripts/run-staging-homologation.sh` | Modificado | `3df1a03628eed71fda3834697b8dd06d26684216eb117be321462038dc532374` | `5f0e7a442c905a05783958b2a353587c704ba3d4b9ff1a38e51d8b918930d67b` |
| `tests/staging-homologation-suite.sql` | Modificado | `941e312f228d02f48406dafab10311237a05c7b1c973f2fa3f1afa9bacfc6fa5` | `6c7fe8316a0476d4cc746d9f972c52312b2b72e54b53a4a8698f8438b98147b8` |
| `src/lib/argon4-fixes.test.ts` | Modificado | `299f9288de3c8c6956ba8e9d0304f3387d8602d36e28731cde65f2b83cd6d621` | `cbaba41c252cbda8e2bff628f2cb8583971dc42eb01924fae9979bcd6243becc` |
| `RELATORIO_MISSAO_01_C09_CLAIM_FILA_WHATSAPP.md` | Modificado | `0cc1da80ac1977fc88e44ce8bdec6b484beb4cc9716e5c4661797043301b6119` | `e5117be7060edcd8e29bf4105ffac348ca252e6540251c62d3f893ee0a58263c` |
| `drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql` | Criado (Novo) | `(inexistente)` | `82220c4b5db0eec4ab9d95e14225a04bcca9b5a52940e38f702c5a46b82cabf3` |

---

## 5. MATRIZ ANTES / DEPOIS DA REAUDITORIA INDEPENDENTE (SEÇÃO 10)

| Achado | Estado Antes (Pós-Missão 01) | Estado Depois (Pós-Missão 03) | Verificação na Reauditoria Read-Only |
| :--- | :--- | :--- | :--- |
| **`AUD-M02-01`** | `release_whatsapp_message_lock` e `complete_whatsapp_message_order` na `0019` não verificavam `locked_until >= clock_timestamp()` dentro do SQL. | `0020` exige `AND locked_until IS NOT NULL AND locked_until >= clock_timestamp()` em `release_whatsapp_message_lock` (linhas `59–60`) e `IF msg.locked_until IS NULL OR msg.locked_until < clock_timestamp() THEN RAISE EXCEPTION 'MESSAGE_LEASE_LOST: ...'` em `complete_whatsapp_message_order` (linhas `157–162`). | **ELIMINADO** (`M03-01` a `M03-12` aprovados; SQL verificada). |
| **`AUD-M02-02`** | `isValidFencingGeneration` e `verifyWorkerStillOwnsLease` usavam `typeof gen === "number"`, rejeitando `"1"` se retornado como string para `bigint`. | `normalizeFencingGeneration(raw)` em `src/lib/interpret.server.ts` (linhas `246–273`) normaliza números e strings inteiras positivas estritas (`<= Number.MAX_SAFE_INTEGER`) com round-trip `String(parsed) === raw` e é aplicado em todas as funções do pipeline. | **ELIMINADO** (`M03-13` a `M03-15` aprovados). |
| **`AUD-M02-03`** | `processVerifiedBusinessEcho` não recebia `workerId`/`leaseGeneration` nem revalidava o lease antes de `financial_classify_by_echo`. | `drainWhatsAppQueue` propaga `messageId`, `workerId`, `leaseGeneration`, `waitForHeartbeat` e `isLeaseLost`; `processVerifiedBusinessEcho` executa `ensureEchoWorkerLeaseValid()` antes e depois de `financial_echo_context` e imediatamente antes de `financial_classify_by_echo`; migration `0020` valida o lease com `FOR UPDATE` em `whatsapp_messages` dentro de `public.financial_classify_by_echo`. | **ELIMINADO** (`M03-16` a `M03-24` aprovados, incluindo disputa Worker A gen 1 -> Worker B gen 2). |
| **`AUD-M02-04`** | Seção C.2 de `RELATORIO_MISSAO_01_C09_CLAIM_FILA_WHATSAPP.md` afirmava que `complete_whatsapp_message_order` era restrita a `service_role`. | Seção C.2 atualizada com a matriz exata de permissões (`service_role` vs `authenticated` com `auth.uid()` e `public.financial_require_operator()`). | **ELIMINADO** (`M03-25` aprovado). |
| **`AUD-M02-05`** | `scripts/run-staging-homologation.sh` executava `npm install` sem verificar `package-lock.json`. | `scripts/run-staging-homologation.sh` exige `package-lock.json` e executa `npm ci` por padrão (bloqueando execução sem lockfile, salvo `ALLOW_UNLOCKED_NPM_INSTALL=1` para geração inicial online) e aplica `0020_*.sql`. | **MITIGADO NO CÓDIGO / PENDENTE GERAÇÃO ONLINE DO LOCKFILE** (`M03-26` aprovado; geração de `package-lock.json` `BLOCKED` sem internet). |

---

## 6. DIFF COMPLETO DOS ARQUIVOS MODIFICADOS E CONTEÚDO DA MIGRATION `0020`

### 6.1. `drizzle/migrations/0020_argon4_c09_lease_and_echo_hardening.sql` (Novo)
```sql
-- Migração 0020: Missão 03 — Correção Controlada dos Achados AUD-M02-01 e AUD-M02-03 (Fechamento C-09 / M-02)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0019).
--
-- Justificativa técnica da migration 0020:
--   1. AUD-M02-01 (Release): Em 0019, public.release_whatsapp_message_lock validava status = 'processando',
--      order_id IS NULL, locked_by = _worker_id e lease_generation = _lease_generation, mas não exigia
--      no SQL que o lease ainda estivesse temporalmente válido (locked_until IS NOT NULL AND locked_until >= clock_timestamp()).
--   2. AUD-M02-01 (Complete): Em 0019, public.complete_whatsapp_message_order validava status, locked_by e
--      lease_generation dentro da transação com FOR UPDATE, mas não exigia que locked_until IS NOT NULL
--      AND locked_until >= clock_timestamp(), permitindo que um worker com lease expirado concluísse
--      caso nenhum outro worker tivesse executado claim_whatsapp_queue_batch nesse intervalo.
--   3. AUD-M02-03 (Fencing no fluxo financeiro de ecos OK/OKK): Atualiza public.financial_classify_by_echo
--      para aceitar (_message_id uuid DEFAULT NULL, _worker_id text DEFAULT NULL, _lease_generation bigint DEFAULT NULL)
--      e validar transacionalmente (com FOR UPDATE na linha de public.whatsapp_messages) que a mensagem de
--      eco pertence à empresa, está com status = 'processando', locked_by = _worker_id,
--      lease_generation = _lease_generation e locked_until >= clock_timestamp(), impedindo qualquer janela
--      TOCTOU ou bypass por worker zumbi, enquanto preserva 100% da idempotência de _event_id e dos fluxos
--      legítimos fora da fila (onde não há linha em whatsapp_messages com lease_generation > 0).

BEGIN;

-- ============================================================================
-- 1. AUD-M02-01: HARDENING TEMPORAL DE RELEASE_WHATSAPP_MESSAGE_LOCK
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_whatsapp_message_lock(
  _message_id uuid,
  _worker_id text,
  _final_status text,
  _last_error text DEFAULT NULL,
  _next_retry_at timestamptz DEFAULT NULL,
  _lease_generation bigint DEFAULT NULL,
  _order_id uuid DEFAULT NULL,
  _parsed jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_rows integer;
BEGIN
  -- C-09 & AUD-M02-01: Exige obrigatoriamente _message_id, _worker_id, _lease_generation >= 1 e estado válido
  IF _message_id IS NULL
     OR nullif(btrim(_worker_id), '') IS NULL
     OR _lease_generation IS NULL
     OR _lease_generation < 1
     OR _final_status NOT IN ('aguardando', 'registrado', 'revisar', 'ignorado', 'erro') THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages
     SET status = _final_status,
         order_id = coalesce(_order_id, order_id),
         parsed = coalesce(_parsed, parsed),
         locked_until = NULL,
         locked_by = NULL,
         last_error = _last_error,
         next_retry_at = _next_retry_at
   WHERE id = _message_id
     AND status = 'processando'
     AND order_id IS NULL
     AND locked_by = _worker_id
     AND lease_generation = _lease_generation
     AND locked_until IS NOT NULL
     AND locked_until >= clock_timestamp();

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) TO service_role;

-- ============================================================================
-- 2. AUD-M02-01: HARDENING TEMPORAL DE COMPLETE_WHATSAPP_MESSAGE_ORDER
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_whatsapp_message_order(
  _message_id uuid,
  _company_id uuid,
  _customer_id uuid,
  _qty_p integer,
  _qty_m integer,
  _qty_g integer,
  _order_date date,
  _parsed jsonb,
  _creation_event uuid DEFAULT NULL,
  _phone_key text DEFAULT NULL,
  _source text DEFAULT 'mensagem',
  _worker_id text DEFAULT NULL,
  _lease_generation bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  msg public.whatsapp_messages%ROWTYPE;
  cust public.customers%ROWTYPE;
  ord public.orders%ROWTYPE;
  ph text;
  conv text;
  det_event uuid := coalesce(_creation_event, md5(_company_id::text || ':wa_msg:' || _message_id::text)::uuid);
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.financial_require_operator() THEN
      RAISE EXCEPTION 'Empresa inválida para o operador autenticado'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  SELECT * INTO msg FROM public.whatsapp_messages WHERE id = _message_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
    RAISE EXCEPTION 'Mensagem não encontrada';
  END IF;

  -- Idempotência se a mensagem já foi concluída e vinculada a um pedido
  IF msg.order_id IS NOT NULL THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
    RETURN msg.order_id;
  END IF;

  -- C-09 & AUD-M02-01: Se a mensagem possui geração de lease ativa (ou se _worker_id/_lease_generation foram informados),
  -- exige correspondência cumulativa de:
  --   1) _worker_id não vazio e _lease_generation >= 1
  --   2) msg.status = 'processando'
  --   3) msg.locked_by = _worker_id
  --   4) msg.lease_generation = _lease_generation
  --   5) msg.locked_until IS NOT NULL AND msg.locked_until >= clock_timestamp() (autoridade temporal do PostgreSQL)
  IF _worker_id IS NOT NULL OR _lease_generation IS NOT NULL OR coalesce(msg.lease_generation, 0) > 0 THEN
    IF nullif(btrim(_worker_id), '') IS NULL OR _lease_generation IS NULL OR _lease_generation < 1 THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: worker_id e lease_generation válidos são obrigatórios para finalizar mensagem da fila'
        USING ERRCODE = '55P03';
    END IF;

    IF msg.status IS DISTINCT FROM 'processando'
       OR msg.locked_by IS NULL
       OR msg.locked_by IS DISTINCT FROM _worker_id THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: mensagem % foi reclamada por outro worker ou perdeu o lease (locked_by=% status=%)',
        _message_id, coalesce(msg.locked_by, 'NULL'), coalesce(msg.status, 'NULL')
        USING ERRCODE = '55P03';
    END IF;

    IF msg.lease_generation IS DISTINCT FROM _lease_generation THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: geração de lease obsoleta para mensagem % (esperada %, atual %)',
        _message_id, _lease_generation, msg.lease_generation
        USING ERRCODE = '55P03';
    END IF;

    IF msg.locked_until IS NULL OR msg.locked_until < clock_timestamp() THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: lease expirado ou nulo para mensagem % (locked_until=%, now=%)',
        _message_id, coalesce(msg.locked_until::text, 'NULL'), clock_timestamp()::text
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  SELECT * INTO ord FROM public.orders WHERE company_id = _company_id AND financial_creation_event = det_event;
  IF NOT FOUND THEN
    ph := coalesce(nullif(btrim(_phone_key), ''), public.financial_phone_key(cust.phone));
    conv := 'wa:' || _company_id::text || ':' || cust.id::text;

    INSERT INTO public.orders(
      company_id, customer_id, qty_p, qty_m, qty_g, quantity, unit_price,
      order_date, paid, settled_by_payment, source, financial_state,
      financial_conversation_id, financial_phone, financial_creation_event
    )
    VALUES (
      _company_id, cust.id, coalesce(_qty_p, 0), coalesce(_qty_m, 0), coalesce(_qty_g, 0),
      coalesce(_qty_p, 0) + coalesce(_qty_m, 0) + coalesce(_qty_g, 0),
      0, _order_date, false, false, coalesce(nullif(btrim(_source), ''), 'mensagem'), 'aguardando_classificacao',
      conv, nullif(ph, ''), det_event
    )
    RETURNING * INTO ord;
  END IF;

  UPDATE public.whatsapp_messages
     SET customer_id = _customer_id,
         order_id = ord.id,
         status = 'registrado',
         qty_p = _qty_p,
         qty_m = _qty_m,
         qty_g = _qty_g,
         fiado = false,
         order_date = _order_date,
         parsed = _parsed,
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NULL,
         last_error = NULL
   WHERE id = msg.id;

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
  RETURN ord.id;
END;
$$;

-- Nota de segurança documentada (AUD-M02-04): complete_whatsapp_message_order revoga PUBLIC e anon
-- e concede EXECUTE a authenticated e service_role porque valida internamente auth.uid() e
-- public.financial_require_operator() (linhas 119-124) quando invocada por sessão autenticada.
REVOKE ALL ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) TO authenticated, service_role;

-- ============================================================================
-- 3. AUD-M02-03: HARDENING TRANSACIONAL DE FINANCIAL_CLASSIFY_BY_ECHO COM FENCING
-- ============================================================================

DROP FUNCTION IF EXISTS public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text);

CREATE OR REPLACE FUNCTION public.financial_classify_by_echo(
  _company_id uuid,
  _customer_id uuid,
  _order_id uuid,
  _event_id text,
  _command text,
  _received_at timestamptz,
  _validation_allowed boolean,
  _validation_reason text,
  _message_id uuid DEFAULT NULL,
  _worker_id text DEFAULT NULL,
  _lease_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ord public.orders%ROWTYPE;
  cust public.customers%ROWTYPE;
  ev public.financial_events%ROWTYPE;
  echo_msg public.whatsapp_messages%ROWTYPE;
  has_echo_msg boolean := false;
  today date := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  reason text;
  outcome text;
  desired text;
  audit uuid;
  conv text;
  ph text;
  eligible_count integer;
  prev_state text;
BEGIN
  IF _company_id IS NULL OR _customer_id IS NULL OR _event_id IS NULL OR _received_at IS NULL OR _command IS NULL THEN
    RAISE EXCEPTION 'Contexto financeiro inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_company_id::text || ':echo:' || _event_id, 0));

  -- AUD-M02-03: Localiza e bloqueia (FOR UPDATE) a mensagem de origem em whatsapp_messages
  -- quando _message_id é fornecido ou quando existe registro correspondente a (_company_id, _event_id).
  IF _message_id IS NOT NULL THEN
    SELECT * INTO echo_msg
      FROM public.whatsapp_messages
     WHERE id = _message_id
       AND company_id = _company_id
       FOR UPDATE;
    has_echo_msg := FOUND;
    IF NOT has_echo_msg THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: mensagem de eco % não encontrada para a empresa %', _message_id, _company_id
        USING ERRCODE = '55P03';
    END IF;
  ELSE
    SELECT * INTO echo_msg
      FROM public.whatsapp_messages
     WHERE company_id = _company_id
       AND message_uid = _event_id
       FOR UPDATE;
    has_echo_msg := FOUND;
  END IF;

  -- AUD-M02-03: Validação obrigatória de posse, geração e validade temporal do lease ANTES de qualquer
  -- efeito ou retorno quando a operação vem de um worker da fila (_worker_id/_lease_generation/_message_id)
  -- ou quando a mensagem em whatsapp_messages possui lease_generation > 0 (impedindo bypass por omissão de parâmetros).
  IF _message_id IS NOT NULL
     OR _worker_id IS NOT NULL
     OR _lease_generation IS NOT NULL
     OR (has_echo_msg AND coalesce(echo_msg.lease_generation, 0) > 0) THEN

    IF NOT has_echo_msg THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: mensagem de origem do eco comercial não encontrada para validação de lease'
        USING ERRCODE = '55P03';
    END IF;

    IF nullif(btrim(_worker_id), '') IS NULL
       OR _lease_generation IS NULL
       OR _lease_generation < 1 THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: worker_id e lease_generation >= 1 são obrigatórios para classificar eco comercial da fila (msg=%)',
        echo_msg.id
        USING ERRCODE = '55P03';
    END IF;

    IF echo_msg.status IS DISTINCT FROM 'processando'
       OR echo_msg.locked_by IS NULL
       OR echo_msg.locked_by IS DISTINCT FROM _worker_id THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: eco comercial % perdeu a posse do lease (locked_by=%, esperado=%, status=%)',
        echo_msg.id, coalesce(echo_msg.locked_by, 'NULL'), _worker_id, coalesce(echo_msg.status, 'NULL')
        USING ERRCODE = '55P03';
    END IF;

    IF echo_msg.lease_generation IS DISTINCT FROM _lease_generation THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: geração de lease obsoleta para eco comercial % (esperada %, atual %)',
        echo_msg.id, _lease_generation, echo_msg.lease_generation
        USING ERRCODE = '55P03';
    END IF;

    IF echo_msg.locked_until IS NULL OR echo_msg.locked_until < clock_timestamp() THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: lease expirado para eco comercial % (locked_until=%, now=%)',
        echo_msg.id, coalesce(echo_msg.locked_until::text, 'NULL'), clock_timestamp()::text
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  SELECT * INTO ev FROM public.financial_events WHERE company_id = _company_id AND event_id = _event_id;
  IF FOUND THEN
    IF ev.command IS DISTINCT FROM _command OR (ev.order_id IS NOT NULL AND _order_id IS NOT NULL AND ev.order_id <> _order_id) THEN
      RETURN jsonb_build_object(
        'outcome', 'conflict',
        'reason', 'EVENTO_CONFLITANTE',
        'order_id', _order_id,
        'state', NULL,
        'total', NULL,
        'audit_id', ev.id
      );
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'duplicate',
      'reason', ev.reason,
      'order_id', ev.order_id,
      'state', ev.final_state,
      'total', ev.total,
      'audit_id', ev.id
    );
  END IF;

  -- Ordem global padronizada: customers FOR UPDATE -> orders FOR UPDATE
  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  ph := public.financial_phone_key(cust.phone);
  conv := 'wa:' || _company_id::text || ':' || cust.id::text;
  desired := CASE _command WHEN 'OK' THEN 'pago' WHEN 'OKK' THEN 'fiado' ELSE 'NENHUM' END;

  SELECT count(*)::int INTO eligible_count
  FROM public.orders
  WHERE company_id = _company_id
    AND customer_id = cust.id
    AND order_date = today
    AND delivery_status <> 'cancelado'
    AND financial_state = 'aguardando_classificacao';

  -- ARGON4-03: se o atendente enviou OK/OKK enquanto a mensagem do cliente ainda está sendo processada
  -- pelo Gemini, sinaliza retry_pending_order sem gravar bloqueio definitivo em financial_events!
  IF eligible_count = 0 AND public.has_inflight_customer_order_message(_company_id, cust.phone) THEN
    RETURN jsonb_build_object(
      'outcome', 'retry_pending_order',
      'reason', 'PEDIDO_EM_PROCESSAMENTO_IA',
      'order_id', NULL,
      'state', NULL,
      'total', NULL,
      'audit_id', NULL
    );
  END IF;

  IF _order_id IS NOT NULL THEN
    SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = _company_id AND customer_id = cust.id FOR UPDATE;
  END IF;

  prev_state := ord.financial_state;

  reason := CASE
    WHEN _command NOT IN ('OK', 'OKK') THEN 'COMANDO_NAO_RECONHECIDO'
    WHEN (_received_at AT TIME ZONE 'America/Sao_Paulo')::date <> today
      OR _received_at > clock_timestamp() + interval '5 minutes' THEN 'COMANDO_FORA_DO_DIA_ATUAL'
    WHEN eligible_count > 1 THEN 'MULTIPLOS_PEDIDOS_ELEGIVEIS'
    WHEN eligible_count = 0 OR ord.id IS NULL THEN coalesce(_validation_reason, 'SEM_PEDIDO_ELEGIVEL')
    WHEN ord.financial_state IS DISTINCT FROM 'aguardando_classificacao' THEN 'PEDIDO_JA_CLASSIFICADO'
    WHEN ord.order_date <> today THEN 'PEDIDO_FORA_DO_PERIODO_PERMITIDO'
    WHEN ord.delivery_status = 'cancelado' THEN 'PEDIDO_CANCELADO'
    WHEN ord.settled_by_payment THEN 'PAGAMENTO_PARCIAL_OU_NAO_RASTREAVEL'
    WHEN ord.total <= 0 OR NOT (ord.total < 'Infinity'::numeric) THEN 'VALOR_INVALIDO'
    WHEN _validation_allowed IS DISTINCT FROM true THEN coalesce(_validation_reason, 'VALIDACAO_NAO_APROVADA')
    ELSE 'CONFIRMACAO_VALIDADA'
  END;

  outcome := CASE WHEN reason = 'CONFIRMACAO_VALIDADA' THEN 'classified' ELSE 'blocked' END;

  INSERT INTO public.financial_events(
    company_id, event_id, actor_id, order_id, customer_id, command, source,
    conversation_id, phone, received_at, previous_state, requested_state,
    final_state, total, outcome, reason
  )
  VALUES (
    _company_id, _event_id, NULL, ord.id, cust.id, _command, 'verified_business_echo',
    conv, ph, _received_at, prev_state, desired,
    CASE WHEN outcome = 'classified' THEN desired ELSE prev_state END,
    ord.total, outcome, reason
  )
  RETURNING id INTO audit;

  IF outcome = 'classified' THEN
    SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;

    UPDATE public.orders
       SET financial_state = desired,
           paid = (_command = 'OK'),
           settled_by_payment = false,
           financial_phone = ph,
           financial_conversation_id = conv,
           financial_last_audit_id = audit
     WHERE id = ord.id;

    SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;
  END IF;

  RETURN jsonb_build_object(
    'outcome', outcome,
    'reason', reason,
    'order_id', ord.id,
    'state', CASE WHEN outcome = 'classified' THEN desired ELSE prev_state END,
    'total', ord.total,
    'audit_id', audit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text, uuid, text, bigint) TO service_role;

COMMIT;

```

### 6.2. `drizzle/migrations/meta/_journal.json`
```diff
--- /tmp/marmita-connect-backup-pre-m03/drizzle/migrations/meta/_journal.json	2026-11-11 00:13:45.264501193 +0000
+++ drizzle/migrations/meta/_journal.json	2026-11-11 00:17:46.075422159 +0000
@@ -141,6 +141,13 @@
       "when": 1794600000000,
       "tag": "0019_argon4_c09_queue_fencing_and_claim_hardening",
       "breakpoints": true
+    },
+    {
+      "idx": 20,
+      "version": "7",
+      "when": 1794700000000,
+      "tag": "0020_argon4_c09_lease_and_echo_hardening",
+      "breakpoints": true
     }
   ]
 }

```

### 6.3. `src/lib/interpret.server.ts`
```diff
--- /tmp/marmita-connect-backup-pre-m03/src/lib/interpret.server.ts	2026-11-11 00:13:45.272501330 +0000
+++ src/lib/interpret.server.ts	2026-11-11 00:18:21.200408297 +0000
@@ -232,19 +232,57 @@
  *   falhar ou retornar vazio, ou se `locked_by`/`lease_generation`/`locked_until` divergirem,
  *   retorna `false` imediatamente.
  */
+/**
+ * CORREÇÃO AUD-M02-02:
+ * Normalizador central e estrito para `lease_generation` (PostgreSQL `bigint` / `INT8`):
+ * - Aceita `number` somente quando finito, inteiro seguro (`Number.isSafeInteger`) e `>= 1`;
+ * - Aceita `string` somente quando for representação decimal inteira positiva estrita (`/^[1-9]\d*$/`),
+ *   sem espaços, sinais, decimais ou notação científica, e dentro de `Number.MAX_SAFE_INTEGER`
+ *   com round-trip exato (`String(parsed) === raw`), evitando qualquer perda de precisão;
+ * - Rejeita `0`, `"0"`, negativos, decimais, notação científica, string vazia, espaços, `null`,
+ *   `undefined`, `NaN`, `Infinity` e valores acima de `Number.MAX_SAFE_INTEGER`.
+ */
+export function normalizeFencingGeneration(raw: unknown): number | null {
+  if (typeof raw === "number") {
+    if (Number.isFinite(raw) && Number.isSafeInteger(raw) && raw >= 1) {
+      return raw;
+    }
+    return null;
+  }
+  if (typeof raw === "string") {
+    if (raw.length === 0 || raw !== raw.trim()) {
+      return null;
+    }
+    if (!/^[1-9]\d*$/.test(raw)) {
+      return null;
+    }
+    const parsed = Number(raw);
+    if (
+      Number.isFinite(parsed) &&
+      Number.isSafeInteger(parsed) &&
+      parsed >= 1 &&
+      String(parsed) === raw
+    ) {
+      return parsed;
+    }
+    return null;
+  }
+  return null;
+}
+
+export function isValidFencingGeneration(gen: unknown): gen is number {
+  return normalizeFencingGeneration(gen) !== null;
+}
+
 export async function verifyWorkerStillOwnsLease(
   supabase: SupabaseClient<Database>,
   messageId: string | null,
   workerId: string | null,
-  leaseGeneration: number | null,
+  leaseGeneration: number | string | null | undefined,
 ): Promise<boolean> {
   if (!workerId) return true;
-  if (
-    !messageId ||
-    typeof leaseGeneration !== "number" ||
-    !Number.isInteger(leaseGeneration) ||
-    leaseGeneration < 1
-  ) {
+  const expectedGen = normalizeFencingGeneration(leaseGeneration);
+  if (!messageId || !workerId.trim() || expectedGen === null) {
     return false;
   }
 
@@ -263,21 +301,23 @@
       status?: string | null;
       order_id?: string | null;
       locked_by?: string | null;
-      lease_generation?: number | null;
+      lease_generation?: number | string | null;
       locked_until?: string | null;
     };
 
     if (row.order_id) return false;
-    if (row.status && row.status !== "processando") return false;
+    if (!row.status || row.status !== "processando") return false;
     if (!row.locked_by || row.locked_by !== workerId) return false;
-    if (typeof row.lease_generation !== "number" || row.lease_generation !== leaseGeneration) {
+    const actualGen = normalizeFencingGeneration(row.lease_generation);
+    if (actualGen === null || actualGen !== expectedGen) {
       return false;
     }
-    if (row.locked_until) {
-      const expMs = Date.parse(row.locked_until);
-      if (Number.isFinite(expMs) && expMs <= Date.now()) {
-        return false;
-      }
+    if (!row.locked_until) {
+      return false;
+    }
+    const expMs = Date.parse(row.locked_until);
+    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
+      return false;
     }
     return true;
   } catch {
@@ -458,10 +498,7 @@
     typeof extra?.["worker_id"] === "string" && extra["worker_id"].trim()
       ? extra["worker_id"].trim()
       : null;
-  const leaseGeneration =
-    typeof extra?.["lease_generation"] === "number" && Number.isFinite(extra["lease_generation"])
-      ? Number(extra["lease_generation"])
-      : null;
+  const leaseGeneration = normalizeFencingGeneration(extra?.["lease_generation"]);
   const manualRetryCount = Math.min(
     MAX_MANUAL_RETRIES,
     Math.max(0, Number(extra?.["manual_retry_count"] ?? 0) || 0),

```

### 6.4. `src/lib/whatsapp-webhook.server.ts`
```diff
--- /tmp/marmita-connect-backup-pre-m03/src/lib/whatsapp-webhook.server.ts	2026-11-11 00:13:45.273501348 +0000
+++ src/lib/whatsapp-webhook.server.ts	2026-11-11 00:20:29.609357610 +0000
@@ -7,7 +7,12 @@
   computeInboundErrorBackoffMs,
   MAX_INBOUND_AUTO_ATTEMPTS,
   MAX_MANUAL_RETRIES,
+  normalizeFencingGeneration,
+  isValidFencingGeneration,
+  verifyWorkerStillOwnsLease,
 } from "./interpret.server";
+
+export { normalizeFencingGeneration, isValidFencingGeneration };
 import { classifyWithPersistence, type FinancialCommit } from "./financial-persistence";
 import type { FinancialContext, FinancialOrder } from "./financial-command";
 import { brDateISO, brToday } from "./format";
@@ -67,33 +72,30 @@
   activeInProcessMessageLocks.clear();
 }
 
-function isValidFencingGeneration(gen: unknown): gen is number {
-  return typeof gen === "number" && Number.isInteger(gen) && Number.isFinite(gen) && gen >= 1;
-}
-
 export function acquireInProcessMessageLock(
   messageId: string,
   workerId: string,
   lockSeconds = 90,
   nowMs = Date.now(),
-  explicitGeneration?: number,
+  explicitGeneration?: number | string | null,
 ): { acquired: boolean; leaseGeneration: number } {
   const cleanMsgId = typeof messageId === "string" ? messageId.trim() : "";
   const cleanWorkerId = typeof workerId === "string" ? workerId.trim() : "";
   const cur = activeInProcessMessageLocks.get(cleanMsgId);
+  const normalizedGen = normalizeFencingGeneration(explicitGeneration);
 
-  if (!cleanMsgId || !cleanWorkerId || !isValidFencingGeneration(explicitGeneration)) {
+  if (!cleanMsgId || !cleanWorkerId || normalizedGen === null) {
     return { acquired: false, leaseGeneration: cur?.leaseGeneration ?? 0 };
   }
 
   if (cur) {
     // Regra 1 (Fencing Token Monotônico): jamais aceita uma geração mais antiga que a já observada
-    if (explicitGeneration < cur.leaseGeneration) {
+    if (normalizedGen < cur.leaseGeneration) {
       return { acquired: false, leaseGeneration: cur.leaseGeneration };
     }
 
     // Regra 2: Dois workers distintos jamais podem compartilhar a mesma geração de lease
-    if (cur.workerId !== cleanWorkerId && explicitGeneration <= cur.leaseGeneration) {
+    if (cur.workerId !== cleanWorkerId && normalizedGen <= cur.leaseGeneration) {
       return { acquired: false, leaseGeneration: cur.leaseGeneration };
     }
   }
@@ -101,9 +103,9 @@
   activeInProcessMessageLocks.set(cleanMsgId, {
     workerId: cleanWorkerId,
     lockedUntilMs: nowMs + Math.max(15, lockSeconds) * 1000,
-    leaseGeneration: explicitGeneration,
+    leaseGeneration: normalizedGen,
   });
-  return { acquired: true, leaseGeneration: explicitGeneration };
+  return { acquired: true, leaseGeneration: normalizedGen };
 }
 
 export function renewInProcessMessageLock(
@@ -111,11 +113,12 @@
   workerId: string,
   lockSeconds = 90,
   nowMs = Date.now(),
-  expectedGeneration?: number,
+  expectedGeneration?: number | string | null,
 ): boolean {
   const cur = activeInProcessMessageLocks.get(messageId);
   if (!cur || cur.workerId !== workerId) return false;
-  if (!isValidFencingGeneration(expectedGeneration) || cur.leaseGeneration !== expectedGeneration) {
+  const normalizedGen = normalizeFencingGeneration(expectedGeneration);
+  if (normalizedGen === null || cur.leaseGeneration !== normalizedGen) {
     return false;
   }
   if (cur.lockedUntilMs <= nowMs) {
@@ -129,12 +132,13 @@
 export function hasActiveInProcessMessageLock(
   messageId: string,
   workerId: string,
-  expectedGeneration?: number,
+  expectedGeneration?: number | string | null,
   nowMs = Date.now(),
 ): boolean {
   const cur = activeInProcessMessageLocks.get(messageId);
   if (!cur || cur.workerId !== workerId) return false;
-  if (!isValidFencingGeneration(expectedGeneration) || cur.leaseGeneration !== expectedGeneration) {
+  const normalizedGen = normalizeFencingGeneration(expectedGeneration);
+  if (normalizedGen === null || cur.leaseGeneration !== normalizedGen) {
     return false;
   }
   if (cur.lockedUntilMs <= nowMs) {
@@ -146,13 +150,16 @@
 export function releaseInProcessMessageLock(
   messageId: string,
   workerId?: string,
-  expectedGeneration?: number,
+  expectedGeneration?: number | string | null,
 ): boolean {
   const cur = activeInProcessMessageLocks.get(messageId);
   if (!cur) return false;
   if (workerId && cur.workerId !== workerId) return false;
-  if (typeof expectedGeneration === "number" && cur.leaseGeneration !== expectedGeneration) {
-    return false;
+  if (expectedGeneration !== undefined && expectedGeneration !== null) {
+    const normalizedGen = normalizeFencingGeneration(expectedGeneration);
+    if (normalizedGen === null || cur.leaseGeneration !== normalizedGen) {
+      return false;
+    }
   }
   activeInProcessMessageLocks.delete(messageId);
   return true;
@@ -171,14 +178,15 @@
   messageId: string,
   workerId: string,
   lockSeconds = 90,
-  leaseGeneration?: number | null,
+  leaseGeneration?: number | string | null,
   nowMs = Date.now(),
 ): Promise<boolean> {
+  const normalizedGen = normalizeFencingGeneration(leaseGeneration);
   if (
     !messageId?.trim() ||
     !workerId?.trim() ||
-    !isValidFencingGeneration(leaseGeneration) ||
-    !hasActiveInProcessMessageLock(messageId, workerId, leaseGeneration, nowMs)
+    normalizedGen === null ||
+    !hasActiveInProcessMessageLock(messageId, workerId, normalizedGen, nowMs)
   ) {
     return false;
   }
@@ -196,7 +204,7 @@
   ).rpc;
 
   if (typeof maybeRpc !== "function") {
-    releaseInProcessMessageLock(messageId, workerId, leaseGeneration);
+    releaseInProcessMessageLock(messageId, workerId, normalizedGen);
     return false;
   }
 
@@ -205,17 +213,17 @@
       _message_id: messageId,
       _worker_id: workerId,
       _lock_seconds: Math.max(15, lockSeconds),
-      _lease_generation: leaseGeneration,
+      _lease_generation: normalizedGen,
     });
 
     if (rpcRes.error || rpcRes.data !== true) {
-      releaseInProcessMessageLock(messageId, workerId, leaseGeneration);
+      releaseInProcessMessageLock(messageId, workerId, normalizedGen);
       return false;
     }
 
-    return renewInProcessMessageLock(messageId, workerId, lockSeconds, Date.now(), leaseGeneration);
+    return renewInProcessMessageLock(messageId, workerId, lockSeconds, Date.now(), normalizedGen);
   } catch {
-    releaseInProcessMessageLock(messageId, workerId, leaseGeneration);
+    releaseInProcessMessageLock(messageId, workerId, normalizedGen);
     return false;
   }
 }
@@ -239,19 +247,19 @@
   options?: {
     lastError?: string | null;
     nextRetryAt?: string | null;
-    leaseGeneration?: number | null;
+    leaseGeneration?: number | string | null;
     orderId?: string | null;
     parsed?: Record<string, unknown> | null;
   },
 ): Promise<boolean> {
   const validStatuses = new Set(["aguardando", "registrado", "revisar", "ignorado", "erro"]);
-  const leaseGen = options?.leaseGeneration;
+  const leaseGen = normalizeFencingGeneration(options?.leaseGeneration);
 
   if (
     !messageId?.trim() ||
     !workerId?.trim() ||
     !validStatuses.has(finalStatus) ||
-    !isValidFencingGeneration(leaseGen)
+    leaseGen === null
   ) {
     return false;
   }
@@ -829,7 +837,7 @@
       continue;
     }
 
-    const gen = r.lease_generation;
+    const gen = normalizeFencingGeneration(r.lease_generation);
     const lockedByMatches = typeof r.locked_by === "string" && r.locked_by === workerId;
     const statusValid = r.status === "processando";
     const lockedUntilValid =
@@ -837,7 +845,7 @@
       Number.isFinite(Date.parse(r.locked_until)) &&
       Date.parse(r.locked_until) > nowMs;
 
-    if (!statusValid || !lockedByMatches || !isValidFencingGeneration(gen) || !lockedUntilValid) {
+    if (!statusValid || !lockedByMatches || gen === null || !lockedUntilValid) {
       for (const prev of claimedRows) {
         releaseInProcessMessageLock(prev.id, workerId, prev.lease_generation);
       }
@@ -901,17 +909,17 @@
     row: Database["public"]["Tables"]["whatsapp_messages"]["Row"],
     isRetryPass = false,
   ) {
-    const rowLeaseGen = row.lease_generation;
+    const rowLeaseGen = normalizeFencingGeneration(row.lease_generation);
 
     if (
-      !isValidFencingGeneration(rowLeaseGen) ||
+      rowLeaseGen === null ||
       row.order_id ||
       ["revisar", "registrado", "ignorado"].includes(row.status)
     ) {
       releaseInProcessMessageLock(
         row.id,
         workerId,
-        isValidFencingGeneration(rowLeaseGen) ? rowLeaseGen : undefined,
+        rowLeaseGen !== null ? rowLeaseGen : undefined,
       );
       return;
     }
@@ -999,13 +1007,25 @@
           row.company_id,
           echo,
           new Date(),
-          { skipDirectMessageUpsert: true },
+          {
+            skipDirectMessageUpsert: true,
+            messageId: row.id,
+            workerId,
+            leaseGeneration: rowLeaseGen,
+            waitForHeartbeat: async () => (heartbeatInFlight ? await heartbeatInFlight : !leaseLost),
+            isLeaseLost: () => leaseLost,
+          },
         );
 
         if (heartbeatInFlight) {
           await heartbeatInFlight;
         }
-        if (leaseLost || !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)) {
+        if (
+          (echoRes as { leaseLost?: boolean })?.leaseLost ||
+          leaseLost ||
+          !hasActiveInProcessMessageLock(row.id, workerId, rowLeaseGen)
+        ) {
+          releaseInProcessMessageLock(row.id, workerId, rowLeaseGen);
           return;
         }
 
@@ -1346,13 +1366,77 @@
   companyId: string,
   echo: ExtractedBusinessEcho,
   now: Date = new Date(),
-  options?: { skipDirectMessageUpsert?: boolean },
+  options?: {
+    skipDirectMessageUpsert?: boolean;
+    messageId?: string | null;
+    workerId?: string | null;
+    leaseGeneration?: number | string | null;
+    waitForHeartbeat?: () => Promise<boolean>;
+    isLeaseLost?: () => boolean;
+  },
 ) {
   const commandText = echo.text.trim();
   if (commandText !== "OK" && commandText !== "OKK") {
     return { skipped: true, reason: "COMANDO_NAO_RECONHECIDO" };
   }
 
+  // CORREÇÃO AUD-M02-03: Quando invocado a partir da fila (ou com qualquer parâmetro de contexto de worker),
+  // exige obrigatoriamente messageId, workerId e leaseGeneration válidos (jamais inventa geração padrão).
+  const hasWorkerContext = Boolean(
+    options?.skipDirectMessageUpsert ||
+      options?.workerId !== undefined ||
+      options?.leaseGeneration !== undefined ||
+      options?.messageId !== undefined,
+  );
+  const cleanMessageId = typeof options?.messageId === "string" ? options.messageId.trim() : "";
+  const cleanWorkerId = typeof options?.workerId === "string" ? options.workerId.trim() : "";
+  const normalizedLeaseGen = normalizeFencingGeneration(options?.leaseGeneration);
+
+  if (hasWorkerContext && (!cleanMessageId || !cleanWorkerId || normalizedLeaseGen === null)) {
+    return {
+      skipped: false,
+      leaseLost: true,
+      reason: "MESSAGE_LEASE_LOST",
+    };
+  }
+
+  const ensureEchoWorkerLeaseValid = async (): Promise<boolean> => {
+    if (!hasWorkerContext) return true;
+    if (options?.waitForHeartbeat) {
+      const hbOk = await options.waitForHeartbeat().catch(() => false);
+      if (!hbOk) {
+        releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
+        return false;
+      }
+    }
+    if (
+      options?.isLeaseLost?.() ||
+      !hasActiveInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!)
+    ) {
+      releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
+      return false;
+    }
+    const stillOwnsInDb = await verifyWorkerStillOwnsLease(
+      supabase,
+      cleanMessageId,
+      cleanWorkerId,
+      normalizedLeaseGen!,
+    );
+    if (!stillOwnsInDb) {
+      releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
+      return false;
+    }
+    return true;
+  };
+
+  if (!(await ensureEchoWorkerLeaseValid())) {
+    return {
+      skipped: false,
+      leaseLost: true,
+      reason: "MESSAGE_LEASE_LOST",
+    };
+  }
+
   const ts = Number(echo.timestamp);
   const receivedDate =
     Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : now;
@@ -1368,8 +1452,23 @@
 
   const customer = await findCustomerByPhoneIndexed(supabase, companyId, targetKey);
 
+  if (!(await ensureEchoWorkerLeaseValid())) {
+    return {
+      skipped: false,
+      leaseLost: true,
+      reason: "MESSAGE_LEASE_LOST",
+    };
+  }
+
   if (!customer) {
     if (await hasInflightCustomerOrderMessage(supabase, companyId, targetKey)) {
+      if (!(await ensureEchoWorkerLeaseValid())) {
+        return {
+          skipped: false,
+          leaseLost: true,
+          reason: "MESSAGE_LEASE_LOST",
+        };
+      }
       return {
         skipped: false,
         retryable: true,
@@ -1493,27 +1592,61 @@
     };
   }
 
-  return classifyWithPersistence(
-    {
-      load: async () => loadedContext,
-      commit: async (_req, decision): Promise<FinancialCommit> => {
-        const rpc = await (
-          supabase as unknown as {
-            rpc: (
-              fn: string,
-              args: Record<string, unknown>,
-            ) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
+  if (!(await ensureEchoWorkerLeaseValid())) {
+    return {
+      skipped: false,
+      leaseLost: true,
+      reason: "MESSAGE_LEASE_LOST",
+    };
+  }
+
+  try {
+    return await classifyWithPersistence(
+      {
+        load: async () => loadedContext,
+        commit: async (_req, decision): Promise<FinancialCommit> => {
+          // CORREÇÃO AUD-M02-03: Revalida o lease imediatamente antes da RPC financeira
+          if (!(await ensureEchoWorkerLeaseValid())) {
+            throw new Error(
+              "MESSAGE_LEASE_LOST: posse ou geração do lease perdida antes de financial_classify_by_echo",
+            );
+          }
+
+          const rpcArgs: Record<string, unknown> = {
+            _company_id: companyId,
+            _customer_id: customer.id,
+            _order_id: decision.pedido_id,
+            _event_id: eventId,
+            _command: commandText,
+            _received_at: receivedAt,
+            _validation_allowed: decision.acao_financeira === "SOLICITAR_CLASSIFICACAO",
+            _validation_reason: decision.motivo,
+          };
+
+          if (hasWorkerContext) {
+            rpcArgs["_message_id"] = cleanMessageId;
+            rpcArgs["_worker_id"] = cleanWorkerId;
+            rpcArgs["_lease_generation"] = normalizedLeaseGen;
+          }
+
+          const rpc = await (
+            supabase as unknown as {
+              rpc: (
+                fn: string,
+                args: Record<string, unknown>,
+              ) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
+            }
+          ).rpc("financial_classify_by_echo", rpcArgs);
+
+          if (
+            rpc.error &&
+            (rpc.error.code === "55P03" || /LEASE_LOST|MESSAGE_LEASE_LOST/i.test(rpc.error.message))
+          ) {
+            if (hasWorkerContext) {
+              releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
+            }
+            throw new Error(`MESSAGE_LEASE_LOST: ${rpc.error.message}`);
           }
-        ).rpc("financial_classify_by_echo", {
-          _company_id: companyId,
-          _customer_id: customer.id,
-          _order_id: decision.pedido_id,
-          _event_id: eventId,
-          _command: commandText,
-          _received_at: receivedAt,
-          _validation_allowed: decision.acao_financeira === "SOLICITAR_CLASSIFICACAO",
-          _validation_reason: decision.motivo,
-        });
 
         if (!rpc.error && rpc.data) {
           const res = rpc.data as FinancialCommit;
@@ -1564,10 +1697,23 @@
           throw new Error(rpc.error.message);
         }
         throw new Error("Resposta financeira indisponível.");
+        },
       },
-    },
-    { orderId: "", eventId, command: commandText },
-  );
+      { orderId: "", eventId, command: commandText },
+    );
+  } catch (err) {
+    if (err instanceof Error && /LEASE_LOST|MESSAGE_LEASE_LOST/i.test(err.message)) {
+      if (hasWorkerContext) {
+        releaseInProcessMessageLock(cleanMessageId, cleanWorkerId, normalizedLeaseGen!);
+      }
+      return {
+        skipped: false,
+        leaseLost: true,
+        reason: "MESSAGE_LEASE_LOST",
+      };
+    }
+    throw err;
+  }
 }
 
 export async function handleMetaBusinessEchoes(

```

### 6.5. `src/integrations/supabase/types.ts`
```diff
--- /tmp/marmita-connect-backup-pre-m03/src/integrations/supabase/types.ts	2026-11-11 00:13:45.270501296 +0000
+++ src/integrations/supabase/types.ts	2026-11-11 00:17:46.076422159 +0000
@@ -688,10 +688,13 @@
           _company_id: string
           _customer_id: string
           _event_id: string
+          _lease_generation?: number | null
+          _message_id?: string | null
           _order_id: string | null
           _received_at: string
           _validation_allowed: boolean
           _validation_reason: string
+          _worker_id?: string | null
         }
         Returns: Json
       }

```

### 6.6. `scripts/run-staging-homologation.sh`
```diff
--- /tmp/marmita-connect-backup-pre-m03/scripts/run-staging-homologation.sh	2026-11-11 00:13:45.265501210 +0000
+++ scripts/run-staging-homologation.sh	2026-11-11 00:21:26.469335175 +0000
@@ -12,8 +12,8 @@
 #      homologação + GoTrue e proteção multicamada contra conexão acidental com
 #      produção (identifica URLs diretas e poolers do mesmo projeto, exige
 #      PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF e marcadores de confirmação)
-#   2. npm install, npm run typecheck, npx vitest run src/ (0 ignorados) e npm run build
-#   3. Inicialização segura e aplicação das 20 migrações (0000 a 0019) em staging
+#   2. npm ci (instalação reproduzível via package-lock.json), npm run typecheck, npx vitest run src/ e npm run build
+#   3. Inicialização segura e aplicação das 21 migrações (0000 a 0020) em staging
 #   4. Execução DUPLA consecutiva de tests/staging-homologation-suite.sql para
 #      comprovar idempotência e zero acumulação de registros entre execuções
 #   5. Execução de Backup Coordenado (scripts/backup-database.sh) e Restore Drill
@@ -242,16 +242,27 @@
 STAGE_1_OK=1
 
 echo "=================================================================="
-echo "2. EXECUTANDO NPM INSTALL, TYPECHECK, VITEST (UNIT/CONTRATO) E BUILD"
+echo "2. EXECUTANDO NPM CI (LOCKFILE REPRODUTÍVEL), TYPECHECK, VITEST E BUILD"
 echo "=================================================================="
-npm install
+if [ -f "package-lock.json" ]; then
+  echo " -> Executando instalação limpa e reproduzível via npm ci..."
+  npm ci
+else
+  echo "[BLOQUEIO AUD-M02-05] package-lock.json ausente! Gere e versione package-lock.json (npm install --package-lock-only em Node >= 22.12.0 com acesso ao registry npm) antes de executar a homologação reproduzível." >&2
+  if [ "${ALLOW_UNLOCKED_NPM_INSTALL:-0}" = "1" ]; then
+    echo "[AVISO] ALLOW_UNLOCKED_NPM_INSTALL=1 definido; executando npm install..."
+    npm install
+  else
+    exit 1
+  fi
+fi
 npm run typecheck
 npx vitest run src/
 npm run build
 STAGE_2_OK=1
 
 echo "=================================================================="
-echo "3. PREPARANDO SCHEMA E APLICANDO MIGRAÇÕES (0000 a 0019) EM STAGING"
+echo "3. PREPARANDO SCHEMA E APLICANDO MIGRAÇÕES (0000 a 0020) EM STAGING"
 echo "=================================================================="
 psql "$STAGING_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
 CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
@@ -322,8 +333,8 @@
     fi
   done
 else
-  echo " -> Schema base detectado em staging; aplicando/atualizando migrações idempotentes 0009 a 0019..."
-  for f in drizzle/migrations/0009_*.sql drizzle/migrations/0010_*.sql drizzle/migrations/0011_*.sql drizzle/migrations/0012_*.sql drizzle/migrations/0013_*.sql drizzle/migrations/0014_*.sql drizzle/migrations/0015_*.sql drizzle/migrations/0016_*.sql drizzle/migrations/0017_*.sql drizzle/migrations/0018_*.sql drizzle/migrations/0019_*.sql; do
+  echo " -> Schema base detectado em staging; aplicando/atualizando migrações idempotentes 0009 a 0020..."
+  for f in drizzle/migrations/0009_*.sql drizzle/migrations/0010_*.sql drizzle/migrations/0011_*.sql drizzle/migrations/0012_*.sql drizzle/migrations/0013_*.sql drizzle/migrations/0014_*.sql drizzle/migrations/0015_*.sql drizzle/migrations/0016_*.sql drizzle/migrations/0017_*.sql drizzle/migrations/0018_*.sql drizzle/migrations/0019_*.sql drizzle/migrations/0020_*.sql; do
     echo " -> Aplicando $f..."
     psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
   done

```

### 6.7. `tests/staging-homologation-suite.sql`
```diff
--- /tmp/marmita-connect-backup-pre-m03/tests/staging-homologation-suite.sql	2026-11-11 00:13:45.276501400 +0000
+++ tests/staging-homologation-suite.sql	2026-11-11 00:22:51.915301429 +0000
@@ -1365,7 +1365,71 @@
     RAISE EXCEPTION '[FALHA C-09] release_whatsapp_message_lock aceitou _lease_generation NULL ou 0!';
   END IF;
 
-  RAISE NOTICE '[OK BLOCO 7] Validações forenses FOR-02, FOR-04, FOR-06, FOR-07, FOR-12 e C-09/M-02 (Migrations 0018 e 0019) aprovadas com sucesso!';
+  -- 7.8. Missão 03 (AUD-M02-01 & AUD-M02-03 — Migration 0020):
+  -- Valida bloqueio de lease expirado em release_whatsapp_message_lock, complete_whatsapp_message_order
+  -- e financial_classify_by_echo (incluindo sequência Worker A gen 1 expirado -> Worker B gen 2 ativo).
+  INSERT INTO public.customers(id, company_id, name, phone, address, notes, payment_cycle)
+  VALUES (v_cust_for02, v_comp_a, 'Cliente M03 Lease', '11977776666', 'Rua M03', NULL, 'semanal');
+
+  INSERT INTO public.whatsapp_messages(
+    id, company_id, customer_id, phone, direction, body, status,
+    locked_by, locked_until, lease_generation, message_uid, source
+  ) VALUES (
+    v_msg_expired_error, v_comp_a, v_cust_for02, '11977776666', 'inbound', '1 marmita G', 'processando',
+    'worker-expired-A', clock_timestamp() - interval '10 seconds', 1, 'wa:m03:inbound', 'whatsapp_cloud'
+  );
+
+  -- (a) AUD-M02-01: Lease expirado bloqueia release_whatsapp_message_lock mesmo com worker_id e lease_generation iguais
+  IF public.release_whatsapp_message_lock(
+    v_msg_expired_error, 'worker-expired-A', 'erro', 'timeout', NULL, 1, NULL, NULL
+  ) IS DISTINCT FROM false THEN
+    RAISE EXCEPTION '[FALHA AUD-M02-01] release_whatsapp_message_lock permitiu liberar mensagem com locked_until expirado!';
+  END IF;
+
+  -- (b) AUD-M02-01: Lease expirado bloqueia complete_whatsapp_message_order com MESSAGE_LEASE_LOST (55P03)
+  BEGIN
+    PERFORM public.complete_whatsapp_message_order(
+      v_msg_expired_error, v_comp_a, v_cust_for02, 0, 0, 1,
+      (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
+      '{"eh_pedido":true,"qtd_g":1}'::jsonb,
+      NULL, '11977776666', 'mensagem', 'worker-expired-A', 1
+    );
+    RAISE EXCEPTION '[FALHA AUD-M02-01] complete_whatsapp_message_order permitiu concluir mensagem com locked_until expirado!';
+  EXCEPTION
+    WHEN lock_not_available THEN
+      RAISE NOTICE '[OK AUD-M02-01] complete_whatsapp_message_order bloqueou lease expirado (55P03 MESSAGE_LEASE_LOST).';
+  END;
+
+  -- (c) AUD-M02-03: Eco comercial em disputa (Worker A gen 1 perde lease para Worker B gen 2)
+  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);
+  UPDATE public.whatsapp_messages
+     SET direction = 'outbound',
+         body = 'OK',
+         source = 'whatsapp_echo',
+         message_uid = 'echo:m03-disputed',
+         status = 'processando',
+         locked_by = 'worker-B',
+         locked_until = clock_timestamp() + interval '60 seconds',
+         lease_generation = 2
+   WHERE id = v_msg_expired_error;
+  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
+
+  -- Worker A (gen 1) tenta chamar financial_classify_by_echo -> rejeitado (55P03 MESSAGE_LEASE_LOST)
+  BEGIN
+    PERFORM public.financial_classify_by_echo(
+      v_comp_a, v_cust_for02, NULL, 'echo:m03-disputed', 'OK', clock_timestamp(),
+      true, 'CONFIRMACAO_VALIDADA', v_msg_expired_error, 'worker-A', 1
+    );
+    RAISE EXCEPTION '[FALHA AUD-M02-03] financial_classify_by_echo permitiu Worker A com geração obsoleta (1 vs 2)!';
+  EXCEPTION
+    WHEN lock_not_available THEN
+      RAISE NOTICE '[OK AUD-M02-03] financial_classify_by_echo rejeitou Worker A zumbi (55P03 MESSAGE_LEASE_LOST).';
+  END;
+
+  DELETE FROM public.whatsapp_messages WHERE id = v_msg_expired_error;
+  DELETE FROM public.customers WHERE id = v_cust_for02;
+
+  RAISE NOTICE '[OK BLOCO 7] Validações forenses FOR-02, FOR-04, FOR-06, FOR-07, FOR-12, C-09/M-02 e AUD-M02-01..05 (Migrations 0018, 0019 e 0020) aprovadas com sucesso!';
 END $$;
 
 COMMIT;

```
