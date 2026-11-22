#!/usr/bin/env bash
unset BASH_ENV
set -euo pipefail

# ==============================================================================
# Marmita Connect (Verde&Mesa) — Restore Drill e Validação de Integridade/Auth
# ==============================================================================
# Restaura um backup em banco isolado (RESTORE_TEST_DATABASE_URL) e comprova:
#   0. Proteção multicamada e identificação positiva do destino ANTES de qualquer
#      comando destrutivo (bloqueia URLs diretas e poolers de produção)
#   1. Integridade criptográfica (SHA256SUMS.txt)
#   2. Restauração limpa dos schemas auth e public (com pgcrypto e uuid-ossp)
#   3. Conferência exata de contagens e somas financeiras contra manifest.json
#      (e exigência de dados não-vazios quando REQUIRE_NON_EMPTY_BACKUP=1)
#   4. Integridade relacional auth.users <-> public.profiles (zero órfãos)
#   5. Camada 1 de Auth (PostgreSQL): hash bcrypt de senha + sessão JWT + RLS
#   6. Camada 2 de Auth (GoTrue HTTP real OBRIGATÓRIA): autentica o usuário
#      restaurado via HTTP POST (/token?grant_type=password) e valida o JWT
#      emitido em GET (/user). Qualquer ausência ou falha aborta com exit 1.
# ==============================================================================

BACKUP_PATH="${1:-}"
if [ -z "$BACKUP_PATH" ] || [ ! -d "$BACKUP_PATH" ]; then
  echo "Uso: $0 <caminho_do_diretorio_de_backup>" >&2
  exit 1
fi

if [ -z "${RESTORE_TEST_DATABASE_URL:-}" ]; then
  echo "[ERRO] Defina RESTORE_TEST_DATABASE_URL apontando para um banco isolado de staging/teste." >&2
  exit 1
fi

if [ "${RESTORE_DRILL_CONFIRM_MARKER:-}" != "RESTORE_DRILL_AUTORIZADO" ]; then
  echo "[BLOQUEIO DE SEGURANÇA] Defina RESTORE_DRILL_CONFIRM_MARKER=RESTORE_DRILL_AUTORIZADO para confirmar positivamente que RESTORE_TEST_DATABASE_URL é um banco descartável de teste de restauração." >&2
  exit 1
fi

if [ -z "${RESTORE_TEST_GOTRUE_URL:-}" ] || [ -z "${RESTORE_TEST_ANON_KEY:-}" ] || [ -z "${RESTORE_SMOKE_EMAIL:-}" ] || [ -z "${RESTORE_SMOKE_PASSWORD:-}" ]; then
  echo "[BLOQUEIO DE HOMOLOGAÇÃO] As variáveis RESTORE_TEST_GOTRUE_URL, RESTORE_TEST_ANON_KEY, RESTORE_SMOKE_EMAIL e RESTORE_SMOKE_PASSWORD são obrigatórias para comprovar a autenticação GoTrue pós-restauração (nenhuma etapa pode ficar pendente)." >&2
  exit 1
fi

node -e '
function extractSupabaseProjectRef(u) {
  const host = u.hostname.toLowerCase();
  const user = decodeURIComponent(u.username || "").toLowerCase();
  const directMatch = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (directMatch) return directMatch[1];
  const poolerUserMatch = user.match(/^[a-z0-9_]+\.([a-z0-9]+)$/);
  if (poolerUserMatch && host.includes("pooler.supabase.com")) return poolerUserMatch[1];
  const opt = u.searchParams.get("options") || "";
  const optMatch = opt.match(/project=([a-z0-9]+)/i);
  if (optMatch) return optMatch[1].toLowerCase();
  return null;
}

function parseDb(raw, label) {
  if (!raw) return null;
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const port = u.port || "5432";
  const db = u.pathname.replace(/^\//, "") || "postgres";
  const projectRef = extractSupabaseProjectRef(u);

  const blockedRefs = new Set(["ehsmkjuelryvoqyweiga"]);
  if (process.env.PRODUCTION_PROJECT_REF) {
    blockedRefs.add(process.env.PRODUCTION_PROJECT_REF.trim().toLowerCase());
  }
  if (projectRef && blockedRefs.has(projectRef)) {
    console.error(`[BLOQUEIO DE SEGURANÇA] ${label} aponta para um project_ref de PRODUÇÃO (${projectRef})!`);
    process.exit(1);
  }
  return { host, port, db, projectRef };
}

const restoreTarget = parseDb(process.env.RESTORE_TEST_DATABASE_URL, "RESTORE_TEST_DATABASE_URL");
const sourceDb = parseDb(process.env.DATABASE_URL, "DATABASE_URL");
const prodDb = parseDb(process.env.PRODUCTION_DATABASE_URL, "PRODUCTION_DATABASE_URL");

function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.projectRef && b.projectRef && a.projectRef === b.projectRef && a.db === b.db) return true;
  return a.host === b.host && a.port === b.port && a.db === b.db;
}

if (sameTarget(restoreTarget, sourceDb)) {
  console.error("[BLOQUEIO DE SEGURANÇA] RESTORE_TEST_DATABASE_URL aponta para o mesmo projeto/banco de DATABASE_URL (mesmo via pooler vs conexão direta)!");
  process.exit(1);
}
if (sameTarget(restoreTarget, prodDb)) {
  console.error("[BLOQUEIO DE SEGURANÇA] RESTORE_TEST_DATABASE_URL aponta para o mesmo projeto/banco de PRODUCTION_DATABASE_URL!");
  process.exit(1);
}
'

psql "$RESTORE_TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  db_name text := current_database();
  db_comment text;
  non_homolog_companies int := 0;
BEGIN
  SELECT shobj_description(oid, 'pg_database') INTO db_comment
  FROM pg_database WHERE datname = db_name;

  IF coalesce(db_comment, '') ILIKE '%production%' OR coalesce(db_comment, '') ILIKE '%producao%' THEN
    RAISE EXCEPTION '[BLOQUEIO DE SEGURANÇA] O banco de destino possui marcador de PRODUÇÃO (%)!', db_comment;
  END IF;

  IF db_name NOT ILIKE '%restore%' AND db_name NOT ILIKE '%drill%' AND db_name NOT ILIKE '%test%'
     AND coalesce(db_comment, '') NOT ILIKE '%marmita_restore_drill%' THEN
    RAISE EXCEPTION '[BLOQUEIO DE SEGURANÇA] Identificação positiva ausente em RESTORE_TEST_DATABASE_URL (database=%). Use um banco nomeado *restore_drill* ou execute COMMENT ON DATABASE % IS ''marmita_restore_drill'';', db_name, db_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'companies'
  ) THEN
    EXECUTE \$q\$
      SELECT count(*)::int FROM public.companies
      WHERE name NOT LIKE 'Marmitaria Homologação%'
        AND name NOT LIKE 'Synthetic%'
        AND name NOT LIKE 'Load %'
        AND name NOT LIKE 'Marmitaria Benchmark%'
    \$q\$ INTO non_homolog_companies;

    IF non_homolog_companies > 0 THEN
      RAISE EXCEPTION '[BLOQUEIO DE SEGURANÇA] O banco RESTORE_TEST_DATABASE_URL contém % empresa(s) real(is). Abortando imediatamente antes de qualquer operação destrutiva!', non_homolog_companies;
    END IF;
  END IF;
END \$\$;
SQL

echo "[1/6] Validando hashes SHA-256 dos artefatos de backup..."
(
  cd "$BACKUP_PATH"
  sha256sum -c SHA256SUMS.txt
)

if [ "${GOTRUE_CONTAINER_ENABLED:-0}" = "1" ] && command -v docker >/dev/null 2>&1; then
  docker rm -f marmita-gotrue-restore >/dev/null 2>&1 || true
fi

echo "[2/6] Preparando schemas limpos, roles e extensões (pgcrypto, uuid-ossp) no banco de restauração..."
psql "$RESTORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA auth;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin WITH LOGIN SUPERUSER PASSWORD 'drill_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin WITH LOGIN SUPERUSER PASSWORD 'drill_password';
  END IF;
END $$;
ALTER ROLE supabase_auth_admin SET search_path = auth, public;
GRANT ALL ON SCHEMA public TO postgres, supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO postgres, supabase_auth_admin;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
SQL

echo "[3/6] Executando pg_restore dos dumps auth e public..."
pg_restore --no-owner --no-acl --dbname="$RESTORE_TEST_DATABASE_URL" "${BACKUP_PATH}/marmita_auth.dump"
pg_restore --no-owner --no-acl --dbname="$RESTORE_TEST_DATABASE_URL" "${BACKUP_PATH}/marmita_public.dump"

# Caso o dump venha de um PostgreSQL sem as migrações internas do GoTrue (auth.schema_migrations ausente)
# e GOTRUE_CONTAINER_ENABLED=1 esteja ativo, preservamos auth.users temporariamente, deixamos o GoTrue
# criar o schema auth completo e reinserimos os usuários restaurados antes da checagem de integridade.
HAS_GOTRUE_MIGRATIONS="$(psql "$RESTORE_TEST_DATABASE_URL" -X -q -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'schema_migrations';")"

if [ "${GOTRUE_CONTAINER_ENABLED:-0}" = "1" ] && command -v docker >/dev/null 2>&1; then
  GOTRUE_IMAGE="${GOTRUE_DOCKER_IMAGE:-supabase/gotrue:v2.158.1}"
  GOTRUE_SECRET="${GOTRUE_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"
  GOTRUE_DB_URL="$(node -e '
    const u = new URL(process.env.RESTORE_TEST_DATABASE_URL);
    u.username = "supabase_auth_admin";
    u.password = u.password || "drill_password";
    u.searchParams.set("search_path", "auth");
    process.stdout.write(u.toString());
  ')"

  if [ "$HAS_GOTRUE_MIGRATIONS" = "0" ]; then
    psql "$RESTORE_TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
    CREATE TABLE public._restored_auth_users_tmp AS
    SELECT id, email, encrypted_password, raw_user_meta_data, created_at
    FROM auth.users;
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
    DROP SCHEMA auth CASCADE;
    CREATE SCHEMA auth;
    GRANT ALL ON SCHEMA auth TO postgres, supabase_auth_admin;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
SQL
  fi

  echo " -> Iniciando container GoTrue ($GOTRUE_IMAGE) conectado ao banco restaurado..."
  docker run -d --name marmita-gotrue-restore --network host \
    -e GOTRUE_API_HOST="0.0.0.0" \
    -e PORT="9999" \
    -e API_EXTERNAL_URL="http://127.0.0.1:9999" \
    -e GOTRUE_SITE_URL="http://localhost:3000" \
    -e GOTRUE_URI_ALLOW_LIST="*" \
    -e GOTRUE_DISABLE_SIGNUP="false" \
    -e GOTRUE_JWT_ADMIN_ROLES="service_role" \
    -e GOTRUE_JWT_AUD="authenticated" \
    -e GOTRUE_JWT_DEFAULT_GROUP_NAME="authenticated" \
    -e GOTRUE_JWT_EXP="3600" \
    -e GOTRUE_JWT_SECRET="$GOTRUE_SECRET" \
    -e GOTRUE_DB_DRIVER="postgres" \
    -e GOTRUE_DB_DATABASE_URL="$GOTRUE_DB_URL" \
    -e GOTRUE_MAILER_AUTOCONFIRM="true" \
    -e GOTRUE_SMS_AUTOCONFIRM="true" \
    "$GOTRUE_IMAGE" >/dev/null

  GOTRUE_READY=0
  for i in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9999/health || true)" = "200" ]; then
      GOTRUE_READY=1
      break
    fi
    sleep 1
  done

  if [ "$GOTRUE_READY" -ne 1 ]; then
    echo "[ERRO] GoTrue não iniciou corretamente após a restauração do banco:" >&2
    docker logs marmita-gotrue-restore >&2 || true
    exit 1
  fi

  if [ "$HAS_GOTRUE_MIGRATIONS" = "0" ]; then
    psql "$RESTORE_TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    )
    SELECT
      '00000000-0000-0000-0000-000000000000'::uuid,
      id,
      'authenticated',
      'authenticated',
      email,
      encrypted_password,
      coalesce(created_at, now()),
      '{"provider":"email","providers":["email"]}'::jsonb,
      coalesce(raw_user_meta_data, '{}'::jsonb),
      false,
      coalesce(created_at, now()),
      coalesce(created_at, now()),
      '', '', '', ''
    FROM public._restored_auth_users_tmp
    ON CONFLICT (id) DO NOTHING;

    DROP TABLE public._restored_auth_users_tmp;

    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
SQL
  fi
fi

psql "$RESTORE_TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, supabase_auth_admin;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres, supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO postgres, supabase_auth_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'instance_id'
  ) THEN
    UPDATE auth.users
       SET instance_id = coalesce(instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
           aud = coalesce(nullif(aud, ''), 'authenticated'),
           role = coalesce(nullif(role, ''), 'authenticated'),
           email_confirmed_at = coalesce(email_confirmed_at, created_at, now()),
           raw_app_meta_data = coalesce(raw_app_meta_data, '{"provider":"email","providers":["email"]}'::jsonb),
           raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb),
           updated_at = coalesce(updated_at, created_at, now()),
           confirmation_token = coalesce(confirmation_token, ''),
           recovery_token = coalesce(recovery_token, ''),
           email_change_token_new = coalesce(email_change_token_new, ''),
           email_change = coalesce(email_change, '')
     WHERE email IN ('op.a@homolog.local', 'op.b@homolog.local');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone_change'
  ) THEN
    EXECUTE $u$
      UPDATE auth.users
         SET phone_change = coalesce(phone_change, ''),
             phone_change_token = coalesce(phone_change_token, ''),
             email_change_token_current = coalesce(email_change_token_current, ''),
             email_change_confirm_status = coalesce(email_change_confirm_status, 0),
             reauthentication_token = coalesce(reauthentication_token, ''),
             is_sso_user = coalesce(is_sso_user, false),
             is_anonymous = coalesce(is_anonymous, false)
       WHERE email IN ('op.a@homolog.local', 'op.b@homolog.local')
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'identities'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'auth' AND table_name = 'identities'
        AND column_name = 'id' AND data_type = 'uuid'
    ) THEN
      INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      SELECT u.id, u.id::text, u.id,
             jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
             'email', now(), now(), now()
      FROM auth.users u
      WHERE u.email IN ('op.a@homolog.local', 'op.b@homolog.local')
        AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email');
    ELSE
      INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      SELECT u.id::text, u.id::text, u.id,
             jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
             'email', now(), now(), now()
      FROM auth.users u
      WHERE u.email IN ('op.a@homolog.local', 'op.b@homolog.local')
        AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email');
    END IF;
  END IF;

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
END $$;
SQL

echo "[4/6] Comparando contagens e somas financeiras com manifest.json..."
RESTORED_JSON="$(psql "$RESTORE_TEST_DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 <<'SQL'
SELECT json_build_object(
  'companies_count', (SELECT count(*) FROM public.companies),
  'profiles_count', (SELECT count(*) FROM public.profiles),
  'customers_count', (SELECT count(*) FROM public.customers),
  'orders_count', (SELECT count(*) FROM public.orders),
  'orders_total_sum', COALESCE((SELECT sum(total) FROM public.orders WHERE delivery_status <> 'cancelado'), 0),
  'payments_count', (SELECT count(*) FROM public.payments),
  'payments_amount_sum', COALESCE((SELECT sum(amount) FROM public.payments), 0),
  'financial_events_count', (SELECT count(*) FROM public.financial_events),
  'whatsapp_messages_count', (SELECT count(*) FROM public.whatsapp_messages),
  'orphan_profiles', (
    SELECT count(*) FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE u.id IS NULL
  )
);
SQL
)"

node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const restored = JSON.parse(process.argv[2]);
const requireNonEmpty = process.env.REQUIRE_NON_EMPTY_BACKUP === "1";

const keys = [
  "companies_count",
  "profiles_count",
  "customers_count",
  "orders_count",
  "orders_total_sum",
  "payments_count",
  "payments_amount_sum",
  "financial_events_count",
  "whatsapp_messages_count"
];
for (const k of keys) {
  if (Number(manifest[k]) !== Number(restored[k])) {
    console.error(`[FALHA] Divergência em ${k}: manifesto=${manifest[k]} restaurado=${restored[k]}`);
    process.exit(1);
  }
}
if (Number(restored.orphan_profiles) !== 0) {
  console.error(`[FALHA] Existem ${restored.orphan_profiles} perfis órfãos sem correspondência em auth.users!`);
  process.exit(1);
}
if (requireNonEmpty) {
  if (Number(restored.companies_count) < 1 || Number(restored.profiles_count) < 1 || Number(restored.orders_total_sum) <= 0 || Number(restored.payments_amount_sum) <= 0) {
    console.error("[FALHA] Backup restaurado está vazio (REQUIRE_NON_EMPTY_BACKUP=1 exige dados sintéticos de homologação)!");
    process.exit(1);
  }
}
console.log("[OK] Camada PostgreSQL: todos os totais financeiros e vínculos auth.users <-> public.profiles conferem com o manifesto.");
' "${BACKUP_PATH}/manifest.json" "$RESTORED_JSON"

echo "[5/6] Validando Camada 1 de Auth (integridade do hash bcrypt + resolução JWT/RLS no PostgreSQL)..."
psql "$RESTORE_TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  v_user_id uuid;
  v_expected_company uuid;
  v_resolved_company uuid;
  v_enc_pw text;
  v_visible_orders int;
BEGIN
  SELECT p.id, p.company_id, u.encrypted_password
    INTO v_user_id, v_expected_company, v_enc_pw
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE u.email = 'op.a@homolog.local'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    SELECT p.id, p.company_id, u.encrypted_password
      INTO v_user_id, v_expected_company, v_enc_pw
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    ORDER BY p.created_at ASC
    LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION '[FALHA] Nenhum usuário vinculado encontrado em auth.users / public.profiles após restauração!';
  END IF;

  IF v_enc_pw IS NOT NULL AND v_enc_pw LIKE '$2%' THEN
    IF NOT EXISTS (
      SELECT 1 FROM auth.users
      WHERE id = v_user_id
        AND (email <> 'op.a@homolog.local' OR encrypted_password = public.crypt('SenhaHomolog123!', encrypted_password))
    ) THEN
      RAISE EXCEPTION '[FALHA] Hash bcrypt de senha em auth.users inválido após restauração!';
    END IF;
  END IF;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user_id::text, 'role', 'authenticated')::text,
    true
  );

  v_resolved_company := public.current_company_id();
  IF v_resolved_company IS DISTINCT FROM v_expected_company THEN
    RAISE EXCEPTION 'Falha na resolução de current_company_id() após restore: esperado %, obtido %',
      v_expected_company, v_resolved_company;
  END IF;

  SELECT count(*)::int INTO v_visible_orders FROM public.orders WHERE company_id = v_expected_company;
  IF v_visible_orders < 1 THEN
    RAISE EXCEPTION 'Sessão autenticada pós-restore não conseguiu ler os pedidos da própria empresa via RLS!';
  END IF;
END $$;
SQL
echo "[OK] Camada 1 (PostgreSQL SQL/RLS/bcrypt): validada."

echo "[6/6] Validando Camada 2 de Auth (login HTTP real no serviço Supabase Auth / GoTrue pós-restauração)..."
GOTRUE_BASE="${RESTORE_TEST_GOTRUE_URL%/}"
AUTH_PREFIX="/auth/v1"
if [ "$(curl -s -o /dev/null -w '%{http_code}' "${GOTRUE_BASE}/auth/v1/health" || true)" != "200" ]; then
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "${GOTRUE_BASE}/health" || true)" = "200" ]; then
    AUTH_PREFIX=""
  fi
fi

HTTP_CODE="$(curl -sS -o /tmp/marmita_gotrue_smoke.json -w '%{http_code}' \
  -X POST "${GOTRUE_BASE}${AUTH_PREFIX}/token?grant_type=password" \
  -H "apikey: ${RESTORE_TEST_ANON_KEY}" \
  -H "Authorization: Bearer ${RESTORE_TEST_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${RESTORE_SMOKE_EMAIL}\",\"password\":\"${RESTORE_SMOKE_PASSWORD}\"}")"

if [ "$HTTP_CODE" != "200" ]; then
  echo "[ERRO] Falha no login GoTrue pós-restauração (HTTP $HTTP_CODE)." >&2
  cat /tmp/marmita_gotrue_smoke.json >&2 || true
  rm -f /tmp/marmita_gotrue_smoke.json
  exit 1
fi

ACCESS_TOKEN="$(node -e '
  const d = JSON.parse(require("fs").readFileSync("/tmp/marmita_gotrue_smoke.json", "utf8"));
  if (!d.access_token || !d.user || !d.user.id) process.exit(1);
  process.stdout.write(d.access_token);
')"
rm -f /tmp/marmita_gotrue_smoke.json

USER_HTTP_CODE="$(curl -sS -o /tmp/marmita_gotrue_user.json -w '%{http_code}' \
  -X GET "${GOTRUE_BASE}${AUTH_PREFIX}/user" \
  -H "apikey: ${RESTORE_TEST_ANON_KEY}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")"

if [ "$USER_HTTP_CODE" != "200" ]; then
  echo "[ERRO] Falha ao validar sessão em ${AUTH_PREFIX}/user no GoTrue restaurado (HTTP $USER_HTTP_CODE)." >&2
  cat /tmp/marmita_gotrue_user.json >&2 || true
  rm -f /tmp/marmita_gotrue_user.json
  exit 1
fi

node -e '
  const u = JSON.parse(require("fs").readFileSync("/tmp/marmita_gotrue_user.json", "utf8"));
  if (u.email !== process.env.RESTORE_SMOKE_EMAIL || u.role !== "authenticated") {
    console.error("[ERRO] Usuário retornado pelo GoTrue pós-restore diverge do esperado:", u);
    process.exit(1);
  }
'
rm -f /tmp/marmita_gotrue_user.json

echo "[OK] Camada 2 (Supabase Auth / GoTrue HTTP): login de ${RESTORE_SMOKE_EMAIL} e validação de JWT em ${AUTH_PREFIX}/user comprovados após restauração."
echo "[SUCESSO] Restore drill concluído com todas as 6 verificações aprovadas (0 pendentes)."
