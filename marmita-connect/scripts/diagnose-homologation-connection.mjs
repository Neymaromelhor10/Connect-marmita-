#!/usr/bin/env node
/**
 * MARMITA CONNECT — DIAGNÓSTICO PONTA A PONTA DE CONEXÃO NA HOMOLOGAÇÃO
 * Uso:
 *   node scripts/diagnose-homologation-connection.mjs
 *   APP_URL=http://127.0.0.1:3000 node scripts/diagnose-homologation-connection.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOCAL_ENV = path.join(ROOT, ".env");
const PARENT_ENV = path.resolve(ROOT, "..", ".env");

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = parseEnvFile(LOCAL_ENV);
const env = { ...fileEnv, ...process.env };

console.log("==================================================================");
console.log("DIAGNÓSTICO DE CONEXÃO — MARMITA CONNECT (HOMOLOGAÇÃO)");
console.log("==================================================================");
console.log(`Diretório atual : ${ROOT}`);
console.log(`.env local      : ${fs.existsSync(LOCAL_ENV) ? "ENCONTRADO" : "AUSENTE"}`);
if (!fs.existsSync(LOCAL_ENV) && fs.existsSync(PARENT_ENV)) {
  console.error(
    `[CAUSA RAIZ DETECTADA] O arquivo .env está no diretório pai (${PARENT_ENV}) e NÃO em ${LOCAL_ENV}!`,
  );
  console.error(
    `O Vite carrega variáveis VITE_* exclusivamente de ${LOCAL_ENV}. Copie ou mova o .env para dentro de marmita-connect/.env e reinicie 'npm run dev'.`,
  );
}

const requiredKeys = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

let hasConfigIssue = false;
for (const key of requiredKeys) {
  const val = (env[key] || "").trim();
  const isPlaceholder =
    !val ||
    val.toLowerCase().includes("seu_projeto") ||
    val.toLowerCase().includes("sua_chave") ||
    val.toLowerCase().includes("placeholder");
  if (isPlaceholder) {
    console.error(`[ERRO CONFIG] ${key}: AUSENTE ou com valor de exemplo.`);
    hasConfigIssue = true;
  } else {
    const preview = key.includes("URL") ? val : `${val.slice(0, 10)}... (len=${val.length})`;
    console.log(`[OK CONFIG]   ${key}: ${preview}`);
  }
}

const supabaseUrl = (env["VITE_SUPABASE_URL"] || env["SUPABASE_URL"] || "").trim().replace(/\/$/, "");
const anonKey = (env["VITE_SUPABASE_ANON_KEY"] || env["SUPABASE_ANON_KEY"] || "").trim();
const appUrl = (env["APP_URL"] || "http://127.0.0.1:3000").trim().replace(/\/$/, "");

async function probe(label, url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers });
    const ms = Date.now() - t0;
    const text = await res.text();
    console.log(`[HTTP ${res.status}] ${label} (${ms}ms) -> ${url}`);
    if (!res.ok) {
      console.error(`   Body: ${text.slice(0, 240)}`);
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`[FALHA REDE] ${label} (${ms}ms) -> ${url}`);
    console.error(`   Erro técnico: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 0 };
  }
}

console.log("------------------------------------------------------------------");
let networkFailures = 0;

if (supabaseUrl && /^https?:\/\//.test(supabaseUrl) && !supabaseUrl.includes("SEU_PROJETO")) {
  const authHealth = await probe("Supabase Auth Health", `${supabaseUrl}/auth/v1/health`, {
    apikey: anonKey,
  });
  if (!authHealth.ok) networkFailures++;

  const restHealth = await probe("Supabase PostgREST", `${supabaseUrl}/rest/v1/`, {
    apikey: anonKey,
  });
  if (!restHealth.ok && restHealth.status !== 401) networkFailures++;
} else {
  console.error("[BLOQUEIO] URL do Supabase inválida; probes HTTP de Supabase ignorados.");
  networkFailures++;
}

const appHealth = await probe("App Backend Health", `${appUrl}/api/public/health`);
if (!appHealth.ok) networkFailures++;

console.log("==================================================================");
if (hasConfigIssue || networkFailures > 0) {
  console.error(
    `[REPROVADO] Encontrados problemas de configuração=${hasConfigIssue} ou conectividade=${networkFailures}.`,
  );
  process.exit(1);
}
console.log("[APROVADO] Configuração .env, Supabase Auth/REST e Backend respondendo normalmente.");
