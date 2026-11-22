#!/usr/bin/env bash
unset BASH_ENV
set -euo pipefail

# ==============================================================================
# Marmita Connect (Verde&Mesa) — Backup Consistente com Snapshot Coordenado
# ==============================================================================
# Exporta um único snapshot transacional (REPEATABLE READ READ ONLY) via
# pg_export_snapshot() mantido aberto em coprocesso psql com FIFO nomeado,
# garantindo consistência exata no mesmo instante lógico entre:
#   1. manifest.json (contagens e somas financeiras de controle)
#   2. marmita_public.dump (schema public)
#   3. marmita_auth.dump   (schema auth completo do Supabase/GoTrue)
# ==============================================================================

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[ERRO] Variável DATABASE_URL não definida." >&2
  exit 1
fi

BACKUP_ROOT="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$TARGET_DIR"

FIFO_IN="$(mktemp -u "${TMPDIR:-/tmp}/marmita_snap_in.XXXXXX")"
FIFO_OUT="$(mktemp -u "${TMPDIR:-/tmp}/marmita_snap_out.XXXXXX")"
mkfifo "$FIFO_IN" "$FIFO_OUT"

PSQL_PID=""
cleanup() {
  if [ -n "$PSQL_PID" ] && kill -0 "$PSQL_PID" 2>/dev/null; then
    echo "COMMIT; \\q" >&3 || true
    wait "$PSQL_PID" 2>/dev/null || true
  fi
  exec 3>&- 2>/dev/null || true
  exec 4<&- 2>/dev/null || true
  rm -f "$FIFO_IN" "$FIFO_OUT"
}
trap cleanup EXIT

psql "$DATABASE_URL" -X -q -t -A <"$FIFO_IN" >"$FIFO_OUT" &
PSQL_PID=$!

exec 3>"$FIFO_IN"
exec 4<"$FIFO_OUT"

echo "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;" >&3
echo "SELECT pg_export_snapshot();" >&3

SNAPSHOT_ID=""
while read -r -t 15 LINE <&4; do
  if [[ "$LINE" =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$ ]]; then
    SNAPSHOT_ID="$LINE"
    break
  fi
done

if [ -z "$SNAPSHOT_ID" ]; then
  echo "[ERRO] Não foi possível obter um SNAPSHOT_ID válido via pg_export_snapshot()." >&2
  exit 1
fi

echo "[INFO] Snapshot transacional coordenado exportado: $SNAPSHOT_ID"

psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 <<SQL > "${TARGET_DIR}/manifest.json"
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '${SNAPSHOT_ID}';
SELECT json_build_object(
  'timestamp', '${TIMESTAMP}',
  'snapshot_id', '${SNAPSHOT_ID}',
  'companies_count', (SELECT count(*) FROM public.companies),
  'profiles_count', (SELECT count(*) FROM public.profiles),
  'customers_count', (SELECT count(*) FROM public.customers),
  'orders_count', (SELECT count(*) FROM public.orders),
  'orders_total_sum', COALESCE((SELECT sum(total) FROM public.orders WHERE delivery_status <> 'cancelado'), 0),
  'payments_count', (SELECT count(*) FROM public.payments),
  'payments_amount_sum', COALESCE((SELECT sum(amount) FROM public.payments), 0),
  'financial_events_count', (SELECT count(*) FROM public.financial_events),
  'whatsapp_messages_count', (SELECT count(*) FROM public.whatsapp_messages)
);
COMMIT;
SQL

pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=public \
  --snapshot="$SNAPSHOT_ID" \
  --file="${TARGET_DIR}/marmita_public.dump"

pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=auth \
  --snapshot="$SNAPSHOT_ID" \
  --file="${TARGET_DIR}/marmita_auth.dump"

echo "COMMIT;" >&3
echo "\\q" >&3
wait "$PSQL_PID"
PSQL_PID=""

(
  cd "$TARGET_DIR"
  sha256sum marmita_public.dump marmita_auth.dump manifest.json > SHA256SUMS.txt
)

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

echo "[OK] Backup concluído com sucesso em ${TARGET_DIR}"
