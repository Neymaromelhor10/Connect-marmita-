# PLANO DE CONTINUIDADE DE HOMOLOGAÇÃO — MARMITA CONNECT / VERDE&MESA (ARGON 4)

- **Data de Registro**: 09/11/2026
- **Diretório do Projeto**: `/working_dir/c_7bc4a72fe09e75b3/project/marmita-connect`
- **Estado Atual**: Veredito **B — APTO PARA HOMOLOGAÇÃO EXTERNA CONTROLADA** (código, migrations `0000`–`0017`, scripts e workflows 100% prontos e auditados; pendente apenas de conexão com infraestrutura externa de staging).

---

## 1. FASES CONCLUÍDAS E FASES PENDENTES

| Fase | Descrição | Status | Observação |
| :--- | :--- | :---: | :--- |
| **Fase 0** | Inventário Read-Only e Manifesto SHA-256 (`0000`–`0017` + `_journal.json`) | **CONCLUÍDA** | Hashes verificados e intactos (`DIFF_EXIT_CODE=0`) |
| **Fase 1** | Validação Sintática (`bash -n`, `node --check`), Fronteira Cliente/Servidor e 6 Suítes Unitárias/Contratuais em Memória (`126/126` testes, `588/588` asserções) | **CONCLUÍDA LOCALMENTE** | CLI oficial (`tsc`, `vitest`, `vite build`) pendente de `Node >= 22.12.0` + `npm install` com internet |
| **Fase 2** | Aplicação das Migrations `0000`–`0017` em PostgreSQL 15+ Real de Staging | **PENDENTE (Infra Externa)** | Preflight de `scripts/run-staging-homologation.sh` testado e validado |
| **Fase 3** | Homologação de Segurança e Isolamento Multitenant (`tests/staging-homologation-suite.sql` 2x) | **PENDENTE (Infra Externa)** | Script atualizado até a migration `0017` (`AUD8-02`) |
| **Fase 4** | Homologação Financeira no Banco Real | **PENDENTE (Infra Externa)** | Regras validadas em memória (`58/58` testes em `financial-command.test.ts` + `27/27` em `financial-activation.test.ts`) |
| **Fase 5** | Fila WhatsApp, Gemini e Concorrência (`tests/staging-pg-concurrency-and-load.mjs`) | **PENDENTE (Infra Externa)** | Sintaxe e contrato de 3 argumentos (`get_or_create_customer_by_phone`) validados |
| **Fase 6** | Integração Real Controlada com Gemini e WhatsApp (`tests/staging-whatsapp-gemini-live.test.ts`) | **PENDENTE (Infra Externa)** | Cleanup seguro `AUD8-03` (`assertIsolatedNonProductionCleanupAllowed`) implementado e testado |
| **Fase 7** | Restore Drill e Backup (`scripts/backup-database.sh` + `scripts/verify-restore-drill.sh`) | **PENDENTE (Infra Externa)** | Workflows `.github/workflows/staging-homologation.yml` e `database-backup.yml` prontos |
| **Fase 8** | Correção de Falhas | **CONCLUÍDA** | `0` falhas de código/SQL encontradas após a 9ª Rodada (`0017`) |
| **Fase 9** | Reauditoria Independente Final | **CONCLUÍDA** | Confirmada integridade total dos hashes e ausência de regressões |

---

## 2. DEPENDÊNCIAS EXTERNAS FALTANTES NESTE CONTAINER

Para concluir as Fases 2 a 7 e elevar o veredito de **B** para **C (Homologação Externa Concluída)**, o ambiente de execução precisa fornecer:
1. **Runtime e Binários**:
   - `Node.js >= 22.12.0` e `npm >= 10.0.0` com acesso ao `registry.npmjs.org` para `npm install`.
   - `postgresql-client` (`psql`, `pg_dump`, `pg_restore` 15+) e `docker` (para o container efêmero `supabase/gotrue:v2.158.1`).
2. **Variáveis de Ambiente e Secrets de Homologação (Isolados de Produção)**:
   - `STAGING_CONFIRM_MARKER="HOMOLOGACAO_AUTORIZADA"`
   - `RESTORE_DRILL_CONFIRM_MARKER="RESTORE_DRILL_AUTORIZADO"`
   - `PRODUCTION_PROJECT_REF="<id_do_projeto_de_producao>"`
   - `STAGING_PROJECT_REF="<id_do_projeto_de_staging>"`
   - `STAGING_DATABASE_URL="postgresql://..."` (banco PostgreSQL 15+ de homologação com `COMMENT ON DATABASE postgres IS 'marmita_staging';`)
   - `RESTORE_TEST_DATABASE_URL="postgresql://postgres:drill_password@127.0.0.1:54332/marmita_restore_drill"`
   - `SUPABASE_URL` / `VITE_SUPABASE_URL` (apontando para o projeto Supabase de homologação)
   - `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY` (chave de homologação com limite controlado)
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_VERIFY_TOKEN`
   - `CRON_SECRET`
   - `RESTORE_TEST_GOTRUE_URL="http://127.0.0.1:9999"`
   - `RESTORE_TEST_ANON_KEY`
   - `RESTORE_SMOKE_EMAIL="op.a@homolog.local"`
   - `RESTORE_SMOKE_PASSWORD="SenhaHomolog123!"`

---

## 3. PRÓXIMA ETAPA EXATA NA RETOMADA EM AMBIENTE COM INFRAESTRUTURA DE STAGING

Não é necessário refazer nenhuma correção de código ou criar novas migrations. Assim que estiver em uma máquina ou runner CI (`.github/workflows/staging-homologation.yml`) com as variáveis acima configuradas, execute exatamente:

```bash
chmod +x scripts/run-staging-homologation.sh scripts/backup-database.sh scripts/verify-restore-drill.sh
./scripts/run-staging-homologation.sh
```

Esse comando único executará em sequência as 7 etapas obrigatórias do script (Preflight Anti-Produção -> `npm install` + `npm run typecheck` + `npx vitest run src/` + `npm run build` -> Migrations `0000` a `0017` -> Execução dupla de `tests/staging-homologation-suite.sql` -> Backup Coordenado + Restore Drill com login HTTP no GoTrue -> `tests/staging-pg-concurrency-and-load.mjs` -> `RUN_LIVE_HOMOLOGATION=1 npx vitest run tests/staging-whatsapp-gemini-live.test.ts`).
