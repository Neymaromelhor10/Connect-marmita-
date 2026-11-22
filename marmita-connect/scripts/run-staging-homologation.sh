#!/usr/bin/env -S env -u BASH_ENV bash
unset BASH_ENV
set -euo pipefail

# ==============================================================================
# MARMITA CONNECT (VERDE&MESA) — EXECUTOR COMPLETO DE HOMOLOGAÇÃO TÉCNICA
# ==============================================================================
# Executa em sequência obrigatória (sem nunca imprimir valores de segredos nos logs
# e impedindo aprovação final se qualquer etapa ficar pendente ou ignorada):
#   1. Verificação completa de pré-requisitos (Node.js >= 22.12.0, psql, pg_dump,
#      pg_restore, curl), validação de todas as credenciais obrigatórias de
#      homologação + GoTrue e proteção multicamada contra conexão acidental com
#      produção (identifica URLs diretas e poolers do mesmo projeto, exige
#      PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF e marcadores de confirmação)
#   2. npm ci (instalação reproduzível via package-lock.json), npm run typecheck, npx vitest run src/ e npm run build
#   3. Inicialização segura e aplicação das 24 migrações (0000 a 0023) em staging
#   4. Execução DUPLA consecutiva de tests/staging-homologation-suite.sql para
#      comprovar idempotência e zero acumulação de registros entre execuções
#   5. Execução de Backup Coordenado (scripts/backup-database.sh) e Restore Drill
#      (scripts/verify-restore-drill.sh) com REQUIRE_NON_EMPTY_BACKUP=1 e login
#      HTTP real obrigatório no GoTrue pós-restauração
#   6. Execução dos testes reais de concorrência paralela (2, 5, 10 workers) e carga
#      até 10.000 msgs no PostgreSQL (tests/staging-pg-concurrency-and-load.mjs)
#   7. Execução dos testes integrados reais de WhatsApp Webhook + Worker +
#      Gemini 2.5 Flash + Classificação OK/OKK (RUN_LIVE_HOMOLOGATION=1)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_ROOT"

STAGE_1_OK=0
STAGE_2_OK=0
STAGE_3_OK=0
STAGE_4_OK=0
STAGE_5_OK=0
STAGE_6_OK=0
STAGE_7_OK=0

echo "=================================================================="
echo "1. VERIFICANDO PRÉ-REQUISITOS E PROTEÇÃO CONTRA AMBIENTE DE PRODUÇÃO"
echo "=================================================================="

PREFLIGHT_FAILED=0

for cmd in node npm psql pg_dump pg_restore sha256sum mkfifo curl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "[OK] Binário disponível: $cmd ($(command -v "$cmd"))"
  else
    echo "[ERRO] Binário obrigatório não encontrado no PATH: $cmd" >&2
    PREFLIGHT_FAILED=1
  fi
done

if ! node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`[ERRO] Node.js v${process.versions.node} detectado. O projeto exige Node.js >= 22.12.0 (conforme package.json).`);
  process.exit(1);
}
console.log(`[OK] Node.js v${process.versions.node} compatível (>= 22.12.0).`);
'; then
  PREFLIGHT_FAILED=1
fi

if [ "${STAGING_CONFIRM_MARKER:-}" != "HOMOLOGACAO_AUTORIZADA" ]; then
  echo "[BLOQUEIO CRÍTICO] STAGING_CONFIRM_MARKER não está definida como HOMOLOGACAO_AUTORIZADA." >&2
  PREFLIGHT_FAILED=1
else
  echo "[OK] STAGING_CONFIRM_MARKER=HOMOLOGACAO_AUTORIZADA confirmada."
fi

if [ "${RESTORE_DRILL_CONFIRM_MARKER:-}" != "RESTORE_DRILL_AUTORIZADO" ]; then
  echo "[BLOQUEIO CRÍTICO] RESTORE_DRILL_CONFIRM_MARKER não está definida como RESTORE_DRILL_AUTORIZADO." >&2
  PREFLIGHT_FAILED=1
else
  echo "[OK] RESTORE_DRILL_CONFIRM_MARKER=RESTORE_DRILL_AUTORIZADO confirmada."
fi

if ! node -e '
const requiredVars = [
  "STAGING_DATABASE_URL",
  "RESTORE_TEST_DATABASE_URL",
  "PRODUCTION_PROJECT_REF",
  "STAGING_PROJECT_REF",
  "GEMINI_API_KEY",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "CRON_SECRET",
  "RESTORE_TEST_GOTRUE_URL",
  "RESTORE_TEST_ANON_KEY",
  "RESTORE_SMOKE_EMAIL",
  "RESTORE_SMOKE_PASSWORD"
];
const missing = requiredVars.filter((k) => !process.env[k] || !process.env[k].trim());
const supaUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
const supaAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "").trim();
const supaServiceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
if (!supaUrl || supaUrl.includes("placeholder")) missing.push("SUPABASE_URL / VITE_SUPABASE_URL");
if (!supaAnonKey || supaAnonKey === "staging-anon-key") missing.push("SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY");
if (!supaServiceKey || supaServiceKey === "staging-service-role-key") missing.push("SUPABASE_SERVICE_ROLE_KEY");

if (missing.length > 0) {
  console.error(`[ERRO] Variáveis/credenciais obrigatórias de homologação ausentes: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("[OK] Todas as variáveis e credenciais obrigatórias de homologação e GoTrue estão presentes.");
'; then
  PREFLIGHT_FAILED=1
fi

if [ "$PREFLIGHT_FAILED" -ne 0 ]; then
  echo "==================================================================" >&2
  echo "[ABORTADO] Pré-requisitos de infraestrutura ou credenciais pendentes (exit code 1)." >&2
  echo "==================================================================" >&2
  exit 1
fi

# Camada 1: Análise estrutural de URLs diretas (db.<ref>.supabase.co) e poolers (postgres.<ref>@*.pooler.supabase.com)
node -e '
function extractSupabaseProjectRef(u) {
  const host = u.hostname.toLowerCase();
  const user = decodeURIComponent(u.username || "").toLowerCase();
  const directMatch = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (directMatch) return directMatch[1];
  const poolerUserMatch = user.match(/^[a-z0-9_]+\.([a-z0-9]+)$/);
  if (poolerUserMatch && host.includes("pooler.supabase.com")) return poolerUserMatch[1];
  const apiMatch = host.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (apiMatch) return apiMatch[1];
  const opt = u.searchParams.get("options") || "";
  const optMatch = opt.match(/project=([a-z0-9]+)/i);
  if (optMatch) return optMatch[1].toLowerCase();
  return null;
}

function parseDb(raw, label) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    console.error(`[ERRO] ${label} não é uma URL válida.`);
    process.exit(1);
  }
  const host = u.hostname.toLowerCase();
  const port = u.port || "5432";
  const db = u.pathname.replace(/^\//, "") || "postgres";
  const projectRef = extractSupabaseProjectRef(u);

  const prodRef = (process.env.PRODUCTION_PROJECT_REF || "").trim().toLowerCase();
  if (!prodRef) {
    console.error("[BLOQUEIO CRÍTICO] Defina obrigatoriamente PRODUCTION_PROJECT_REF para garantir bloqueio explícito do projeto de produção (mesmo se estiver vazio)!");
    process.exit(1);
  }

  const blockedRefs = new Set(["ehsmkjuelryvoqyweiga", prodRef]);
  if (projectRef && blockedRefs.has(projectRef)) {
    console.error(`[BLOQUEIO CRÍTICO] ${label} referencia um projeto de PRODUÇÃO bloqueado (${projectRef})!`);
    process.exit(1);
  }
  return { label, host, port, db, projectRef };
}

const staging = parseDb(process.env.STAGING_DATABASE_URL, "STAGING_DATABASE_URL");
const restore = parseDb(process.env.RESTORE_TEST_DATABASE_URL, "RESTORE_TEST_DATABASE_URL");
const prod = parseDb(process.env.PRODUCTION_DATABASE_URL, "PRODUCTION_DATABASE_URL");
const supaApi = parseDb(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, "SUPABASE_URL");
const gotrueApi = parseDb(process.env.RESTORE_TEST_GOTRUE_URL, "RESTORE_TEST_GOTRUE_URL");
const expectedStagingRef = (process.env.STAGING_PROJECT_REF || "").trim().toLowerCase();

if ((staging.projectRef || (supaApi && supaApi.projectRef)) && !expectedStagingRef) {
  console.error("[BLOQUEIO CRÍTICO] Defina obrigatoriamente STAGING_PROJECT_REF com o ID do projeto Supabase de homologação para identificação positiva!");
  process.exit(1);
}
if (expectedStagingRef && staging.projectRef && staging.projectRef !== expectedStagingRef) {
  console.error(`[BLOQUEIO CRÍTICO] project_ref de STAGING_DATABASE_URL (${staging.projectRef}) diverge de STAGING_PROJECT_REF (${expectedStagingRef})!`);
  process.exit(1);
}
if (expectedStagingRef && supaApi && supaApi.projectRef && supaApi.projectRef !== expectedStagingRef) {
  console.error(`[BLOQUEIO CRÍTICO] project_ref de SUPABASE_URL (${supaApi.projectRef}) diverge de STAGING_PROJECT_REF (${expectedStagingRef})!`);
  process.exit(1);
}
if (expectedStagingRef && expectedStagingRef === process.env.PRODUCTION_PROJECT_REF.trim().toLowerCase()) {
  console.error("[BLOQUEIO CRÍTICO] STAGING_PROJECT_REF jamais pode ser igual a PRODUCTION_PROJECT_REF!");
  process.exit(1);
}

function sameEndpoint(a, b) {
  if (!a || !b) return false;
  if (a.projectRef && b.projectRef && a.projectRef === b.projectRef && a.db === b.db) return true;
  return a.host === b.host && a.port === b.port && a.db === b.db;
}

if (sameEndpoint(staging, restore)) {
  console.error("[BLOQUEIO CRÍTICO] STAGING_DATABASE_URL e RESTORE_TEST_DATABASE_URL apontam para o mesmo projeto/banco (mesmo via pooler vs conexão direta)!");
  process.exit(1);
}
if (sameEndpoint(staging, prod) || sameEndpoint(restore, prod)) {
  console.error("[BLOQUEIO CRÍTICO] Uma das URLs de homologação coincide com o projeto/banco de PRODUCTION_DATABASE_URL!");
  process.exit(1);
}
console.log(`[OK] Análise estrutural de endpoints concluída (staging db=${staging.db}, restore db=${restore.db}, gotrue host=${gotrueApi ? gotrueApi.host : "n/a"}).`);
'

# Camada 2: Identificação positiva no catálogo PostgreSQL ANTES de qualquer migração ou escrita
psql "$STAGING_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  db_name text := current_database();
  db_comment text;
  real_companies int := 0;
BEGIN
  SELECT shobj_description(oid, 'pg_database') INTO db_comment
  FROM pg_database WHERE datname = db_name;

  IF coalesce(db_comment, '') ILIKE '%production%' OR coalesce(db_comment, '') ILIKE '%producao%' THEN
    RAISE EXCEPTION '[BLOQUEIO CRÍTICO] O banco STAGING_DATABASE_URL possui marcador de PRODUÇÃO (%)!', db_comment;
  END IF;

  IF db_name NOT ILIKE '%staging%' AND db_name NOT ILIKE '%homolog%' AND db_name NOT ILIKE '%test%'
     AND coalesce(db_comment, '') NOT ILIKE '%marmita_staging%' THEN
    RAISE EXCEPTION '[BLOQUEIO CRÍTICO] Identificação positiva ausente no banco STAGING_DATABASE_URL (database=%). Para autorizar um banco chamado postgres em um projeto Supabase de homologação, execute antes nele: COMMENT ON DATABASE postgres IS ''marmita_staging'';', db_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'companies'
  ) THEN
    SELECT count(*)::int INTO real_companies
    FROM public.companies
    WHERE name NOT LIKE 'Marmitaria Homologação%'
      AND name NOT LIKE 'Synthetic%'
      AND name NOT LIKE 'Load %'
      AND name NOT LIKE 'Marmitaria Benchmark%';

    IF real_companies > 0 THEN
      RAISE EXCEPTION '[BLOQUEIO CRÍTICO] STAGING_DATABASE_URL contém % empresa(s) real(is)/não-sintética(s). Abortando homologação para proteger os dados!', real_companies;
    END IF;
  END IF;
END $$;
SQL
STAGE_1_OK=1

echo "=================================================================="
echo "2. EXECUTANDO NPM CI (LOCKFILE REPRODUTÍVEL), TYPECHECK, VITEST E BUILD"
echo "=================================================================="
if [ -f "package-lock.json" ]; then
  echo " -> Executando instalação limpa e reproduzível via npm ci..."
  npm ci
else
  echo "[BLOQUEIO MISSÃO 08.1] package-lock.json ausente! Gere e versione package-lock.json (npm install --package-lock-only em Node >= 22.12.0 com acesso ao registry npm) antes de executar a homologação reproduzível." >&2
  exit 1
fi
npm run typecheck
npx --no-install vitest run
node tests/verify-missao07-af01-af11.mjs
npm run build
STAGE_2_OK=1

echo "=================================================================="
echo "3. PREPARANDO SCHEMA E APLICANDO MIGRAÇÕES (0000 a 0023) EM STAGING"
echo "=================================================================="
psql "$STAGING_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud varchar(255) DEFAULT 'authenticated',
  role varchar(255) DEFAULT 'authenticated',
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz DEFAULT now(),
  raw_app_meta_data jsonb DEFAULT '{"provider":"email","providers":["email"]}'::jsonb,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  is_super_admin boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  confirmation_token varchar(255) DEFAULT '',
  recovery_token varchar(255) DEFAULT '',
  email_change_token_new varchar(255) DEFAULT '',
  email_change varchar(255) DEFAULT ''
);
GRANT SELECT ON auth.users TO anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $body$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $body$;
    $fn$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'role'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $body$
        SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user);
      $body$;
    $fn$;
  END IF;
END $$;
SQL

HAS_COMPANIES="$(psql "$STAGING_DATABASE_URL" -X -q -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'companies';")"

if [ "$HAS_COMPANIES" = "0" ]; then
  for f in drizzle/migrations/0*.sql; do
    if [ -s "$f" ]; then
      echo " -> Aplicando $f..."
      psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
    fi
  done
else
  echo " -> Schema base detectado em staging; aplicando/atualizando migrações idempotentes 0009 a 0023..."
  for f in drizzle/migrations/0009_*.sql drizzle/migrations/0010_*.sql drizzle/migrations/0011_*.sql drizzle/migrations/0012_*.sql drizzle/migrations/0013_*.sql drizzle/migrations/0014_*.sql drizzle/migrations/0015_*.sql drizzle/migrations/0016_*.sql drizzle/migrations/0017_*.sql drizzle/migrations/0018_*.sql drizzle/migrations/0019_*.sql drizzle/migrations/0020_*.sql drizzle/migrations/0021_*.sql drizzle/migrations/0022_*.sql drizzle/migrations/0023_*.sql; do
    echo " -> Aplicando $f..."
    psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
  done
fi
STAGE_3_OK=1

echo "=================================================================="
echo "4. EXECUTANDO SUÍTE SQL REAL (2X CONSECUTIVAS PARA PROVAR IDEMPOTÊNCIA)"
echo "=================================================================="
echo " -> Execução #1 de tests/staging-homologation-suite.sql..."
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/staging-homologation-suite.sql

SNAPSHOT_RUN_1="$(psql "$STAGING_DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
SELECT json_build_object(
  'companies', (SELECT count(*) FROM public.companies),
  'profiles', (SELECT count(*) FROM public.profiles),
  'customers', (SELECT count(*) FROM public.customers),
  'orders', (SELECT count(*) FROM public.orders),
  'orders_sum', COALESCE((SELECT sum(total) FROM public.orders), 0),
  'payments', (SELECT count(*) FROM public.payments),
  'payments_sum', COALESCE((SELECT sum(amount) FROM public.payments), 0),
  'events', (SELECT count(*) FROM public.financial_events),
  'messages', (SELECT count(*) FROM public.whatsapp_messages)
);
SQL
)"

echo " -> Execução #2 consecutiva de tests/staging-homologation-suite.sql..."
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/staging-homologation-suite.sql

SNAPSHOT_RUN_2="$(psql "$STAGING_DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
SELECT json_build_object(
  'companies', (SELECT count(*) FROM public.companies),
  'profiles', (SELECT count(*) FROM public.profiles),
  'customers', (SELECT count(*) FROM public.customers),
  'orders', (SELECT count(*) FROM public.orders),
  'orders_sum', COALESCE((SELECT sum(total) FROM public.orders), 0),
  'payments', (SELECT count(*) FROM public.payments),
  'payments_sum', COALESCE((SELECT sum(amount) FROM public.payments), 0),
  'events', (SELECT count(*) FROM public.financial_events),
  'messages', (SELECT count(*) FROM public.whatsapp_messages)
);
SQL
)"

if [ "$SNAPSHOT_RUN_1" != "$SNAPSHOT_RUN_2" ]; then
  echo "[FALHA DE IDEMPOTÊNCIA] A segunda execução consecutiva produziu contagens/somas diferentes!" >&2
  echo "  Execução #1: $SNAPSHOT_RUN_1" >&2
  echo "  Execução #2: $SNAPSHOT_RUN_2" >&2
  exit 1
fi
echo "[OK] Idempotência comprovada nas 2 execuções consecutivas (ignorando timestamps variáveis): $SNAPSHOT_RUN_2"
STAGE_4_OK=1

echo "=================================================================="
echo "5. EXECUTANDO BACKUP COORDENADO E RESTORE DRILL EM BANCO ISOLADO"
echo "=================================================================="
BACKUP_DIR_TMP="$(mktemp -d "${TMPDIR:-/tmp}/marmita_homolog_backup.XXXXXX")"
DATABASE_URL="$STAGING_DATABASE_URL" BACKUP_DIR="$BACKUP_DIR_TMP" ./scripts/backup-database.sh
LATEST_SNAP_DIR="$(ls -td "${BACKUP_DIR_TMP}/"* | head -n 1)"
DATABASE_URL="$STAGING_DATABASE_URL" \
  RESTORE_TEST_DATABASE_URL="$RESTORE_TEST_DATABASE_URL" \
  RESTORE_DRILL_CONFIRM_MARKER="RESTORE_DRILL_AUTORIZADO" \
  REQUIRE_NON_EMPTY_BACKUP=1 \
  ./scripts/verify-restore-drill.sh "$LATEST_SNAP_DIR"
rm -rf "$BACKUP_DIR_TMP"
STAGE_5_OK=1

echo "=================================================================="
echo "6. EXECUTANDO TESTES REAIS DE CONCORRÊNCIA E CARGA NO POSTGRESQL"
echo "=================================================================="
STAGING_DATABASE_URL="$STAGING_DATABASE_URL" node tests/staging-pg-concurrency-and-load.mjs
STAGE_6_OK=1

echo "=================================================================="
echo "7. EXECUTANDO TESTE INTEGRADO REAL WHATSAPP WEBHOOK + GEMINI 2.5 FLASH"
echo "=================================================================="
RUN_LIVE_HOMOLOGATION=1 npx vitest run tests/staging-whatsapp-gemini-live.test.ts
STAGE_7_OK=1

if [ "$STAGE_1_OK" -ne 1 ] || [ "$STAGE_2_OK" -ne 1 ] || [ "$STAGE_3_OK" -ne 1 ] || \
   [ "$STAGE_4_OK" -ne 1 ] || [ "$STAGE_5_OK" -ne 1 ] || [ "$STAGE_6_OK" -ne 1 ] || \
   [ "$STAGE_7_OK" -ne 1 ]; then
  echo "[FALHA BLOQUEANTE] Nem todas as 7 etapas obrigatórias foram concluídas!" >&2
  exit 1
fi

echo "=================================================================="
echo "[SUCESSO] HOMOLOGAÇÃO TÉCNICA EXTERNA COMPLETA E APROVADA (7/7 ETAPAS APROVADAS, 0 PENDENTES)!"
echo "=================================================================="
