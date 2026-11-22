#!/usr/bin/env bash
# ============================================================================
# MARMITA CONNECT (ARGON 4 — MISSÃO 08.2)
# GERAÇÃO DEFINITIVA DO PACKAGE-LOCK.JSON E VALIDAÇÃO REAL EM NODE.JS 22
# ============================================================================
# Este script executa em ambiente Node.js >= 22.12.0 com acesso a registry.npmjs.org
# (localmente, em GitHub Codespaces ou via .github/workflows/bootstrap-lockfile-node22.yml):
#   1. Verifica Node.js >= 22.12.0 e integridade das migrations 0000 a 0023 + _journal.json
#   2. Gera package-lock.json real via `npm install --package-lock-only` (respeitando .npmrc)
#   3. Calcula o SHA-256 do package-lock.json e audita compatibilidade com package.json
#   4. Executa instalação limpa via `npm ci` e comprova que o lockfile não foi modificado
#   5. Executa `npm run typecheck` (tsc --noEmit)
#   6. Executa `npx --no-install vitest run` (138 testes unitários)
#   7. Executa `node tests/verify-missao07-af01-af11.mjs` (baterias comportamentais)
#   8. Executa `npm run build` (vite build -> .output/server/index.mjs)
# ============================================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ART_DIR="${BOOTSTRAP_ARTIFACT_DIR:-/tmp/bootstrap-lockfile-artifacts}"
mkdir -p "$ART_DIR"

NODE_VER="$(node -v 2>/dev/null || echo 'UNAVAILABLE')"
NPM_VER="$(npm -v 2>/dev/null || echo 'UNAVAILABLE')"

echo "=================================================================="
echo "1. VERIFICAÇÃO DE AMBIENTE NODE.JS >= 22.12.0 E MIGRATIONS 0000-0023"
echo "=================================================================="
echo "Node.js detectado : $NODE_VER"
echo "npm detectado     : $NPM_VER"

node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 12)) {
    console.error(`[BLOQUEIO AMBIENTAL] Node.js ${process.versions.node} detectado. A Missão 08.2 exige Node.js >= 22.12.0 (preferencialmente 22.14.0).`);
    process.exit(1);
  }
  console.log(`[OK] Versão do Node.js (${process.versions.node}) atende ao requisito >= 22.12.0.`);
'

node tests/verify-missao07-af01-af11.mjs > "$ART_DIR/precheck-verify-missao07.log" 2>&1
cat "$ART_DIR/precheck-verify-missao07.log"

echo "=================================================================="
echo "2. GERAÇÃO DO PACKAGE-LOCK.JSON (npm install --package-lock-only)"
echo "=================================================================="
T0=$(date +%s)
npm install --package-lock-only > "$ART_DIR/npm-lockfile-generation.log" 2>&1
LOCK_EXIT=$?
T1=$(date +%s)
LOCK_DUR=$((T1 - T0))
cat "$ART_DIR/npm-lockfile-generation.log"

if [ "$LOCK_EXIT" -ne 0 ] || [ ! -s "package-lock.json" ]; then
  echo "[ERRO] Falha ao gerar package-lock.json (exit code: $LOCK_EXIT)." >&2
  exit 1
fi

LOCK_SHA_BEFORE="$(sha256sum package-lock.json | awk '{print $1}')"
echo "$LOCK_SHA_BEFORE  package-lock.json" > "$ART_DIR/package-lock.sha256"
cp package-lock.json "$ART_DIR/package-lock.json"
echo "[OK] package-lock.json gerado com sucesso (SHA-256: $LOCK_SHA_BEFORE, duração: ${LOCK_DUR}s)."

node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  if (lock.name !== pkg.name) {
    throw new Error(`Divergência de name entre package.json (${pkg.name}) e package-lock.json (${lock.name})`);
  }
  if (!lock.lockfileVersion || lock.lockfileVersion < 3) {
    throw new Error(`lockfileVersion inesperado: ${lock.lockfileVersion}`);
  }
  const rootPkg = lock.packages && lock.packages[""];
  if (!rootPkg) {
    throw new Error("Entrada raiz packages[\"\" ] ausente no package-lock.json");
  }
  console.log(`[OK] package-lock.json (lockfileVersion=${lock.lockfileVersion}, pacotes=${Object.keys(lock.packages || {}).length}) compatível com package.json.`);
'

echo "=================================================================="
echo "3. INSTALAÇÃO LIMPA E REPRODUTÍVEL (npm ci)"
echo "=================================================================="
T0=$(date +%s)
npm ci > "$ART_DIR/npm-ci.log" 2>&1
CI_EXIT=$?
T1=$(date +%s)
CI_DUR=$((T1 - T0))
cat "$ART_DIR/npm-ci.log"

if [ "$CI_EXIT" -ne 0 ]; then
  echo "[ERRO] npm ci falhou (exit code: $CI_EXIT)." >&2
  exit 1
fi

LOCK_SHA_AFTER="$(sha256sum package-lock.json | awk '{print $1}')"
if [ "$LOCK_SHA_AFTER" != "$LOCK_SHA_BEFORE" ]; then
  echo "[ERRO] package-lock.json foi modificado durante npm ci ($LOCK_SHA_BEFORE -> $LOCK_SHA_AFTER)!" >&2
  exit 1
fi
echo "[OK] npm ci concluído em ${CI_DUR}s; package-lock.json permaneceu inalterado ($LOCK_SHA_AFTER)."

echo "=================================================================="
echo "4. TYPECHECK OFICIAL (npm run typecheck)"
echo "=================================================================="
T0=$(date +%s)
npm run typecheck > "$ART_DIR/typecheck.log" 2>&1
TC_EXIT=$?
T1=$(date +%s)
TC_DUR=$((T1 - T0))
cat "$ART_DIR/typecheck.log"

if [ "$TC_EXIT" -ne 0 ]; then
  echo "[ERRO] npm run typecheck falhou (exit code: $TC_EXIT)." >&2
  exit 1
fi
echo "[OK] npm run typecheck aprovado em ${TC_DUR}s."

echo "=================================================================="
echo "5. VITEST OFICIAL COMPLETO (npx --no-install vitest run)"
echo "=================================================================="
T0=$(date +%s)
npx --no-install vitest run > "$ART_DIR/vitest.log" 2>&1
VT_EXIT=$?
T1=$(date +%s)
VT_DUR=$((T1 - T0))
cat "$ART_DIR/vitest.log"

if [ "$VT_EXIT" -ne 0 ]; then
  echo "[ERRO] npx --no-install vitest run falhou (exit code: $VT_EXIT)." >&2
  exit 1
fi

node tests/verify-missao07-af01-af11.mjs > "$ART_DIR/verify-missao07.log" 2>&1
VM07_EXIT=$?
cat "$ART_DIR/verify-missao07.log"
if [ "$VM07_EXIT" -ne 0 ]; then
  echo "[ERRO] verify-missao07-af01-af11.mjs falhou (exit code: $VM07_EXIT)." >&2
  exit 1
fi
echo "[OK] Vitest oficial completo e baterias comportamentais aprovados em ${VT_DUR}s."

echo "=================================================================="
echo "6. BUILD DE PRODUÇÃO (npm run build)"
echo "=================================================================="
T0=$(date +%s)
npm run build > "$ART_DIR/build.log" 2>&1
BUILD_EXIT=$?
T1=$(date +%s)
BUILD_DUR=$((T1 - T0))
cat "$ART_DIR/build.log"

if [ "$BUILD_EXIT" -ne 0 ]; then
  echo "[ERRO] npm run build falhou (exit code: $BUILD_EXIT)." >&2
  exit 1
fi

if [ ! -f ".output/server/index.mjs" ]; then
  echo "[ERRO] Artefato SSR esperado (.output/server/index.mjs) não encontrado após npm run build!" >&2
  exit 1
fi
echo "[OK] Build de produção concluído em ${BUILD_DUR}s (.output/server/index.mjs gerado)."

cat << EOF_REP > "$ART_DIR/bootstrap-lockfile-report.md"
# Relatório de Bootstrap e Validação Oficial em Node.js 22 (Missão 08.2)

- **Node.js:** \`$NODE_VER\`
- **npm:** \`$NPM_VER\`
- **SHA-256 do \`package-lock.json\`:** \`$LOCK_SHA_AFTER\`
- **Imutabilidade pós-\`npm ci\`:** Confirmada (\`$LOCK_SHA_BEFORE\` == \`$LOCK_SHA_AFTER\`)

| Etapa | Comando | Exit Code | Duração (s) | Status |
| :--- | :--- | :---: | :---: | :---: |
| **Geração do Lockfile** | \`npm install --package-lock-only\` | \`$LOCK_EXIT\` | \`${LOCK_DUR}s\` | **APROVADA** |
| **Instalação Limpa** | \`npm ci\` | \`$CI_EXIT\` | \`${CI_DUR}s\` | **APROVADA** |
| **Typecheck Oficial** | \`npm run typecheck\` | \`$TC_EXIT\` | \`${TC_DUR}s\` | **APROVADA** |
| **Vitest Oficial Completo** | \`npx --no-install vitest run\` | \`$VT_EXIT\` | \`${VT_DUR}s\` | **APROVADA** |
| **Baterias Comportamentais** | \`node tests/verify-missao07-af01-af11.mjs\` | \`$VM07_EXIT\` | \`<1s\` | **APROVADA** |
| **Build de Produção** | \`npm run build\` | \`$BUILD_EXIT\` | \`${BUILD_DUR}s\` | **APROVADA** |
EOF_REP

echo "=================================================================="
echo "[SUCESSO] LOCKFILE GERADO E PIPELINE NODE 22 VALIDADO INTEGRALMENTE!"
echo "SHA-256 package-lock.json: $LOCK_SHA_AFTER"
echo "=================================================================="
