import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function readRuntimeEnv(key: string): string {
  const viteEnv =
    typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env as Record<string, string | undefined>)[key]
      : undefined;
  if (typeof viteEnv === "string" && viteEnv.trim()) {
    return viteEnv.trim();
  }
  if (typeof process !== "undefined" && process.env) {
    const procEnv = process.env[key];
    if (typeof procEnv === "string" && procEnv.trim()) {
      return procEnv.trim();
    }
  }
  return "";
}

export function isPlaceholderEnvValue(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    !lower ||
    lower.includes("seu_projeto") ||
    lower.includes("sua_chave") ||
    lower.includes("placeholder") ||
    lower.includes("your_project") ||
    lower.includes("your-project")
  );
}

export function validateSupabaseClientConfig(url: string, anonKey: string): void {
  if (!url || !anonKey) {
    const missing = [
      ...(!url ? ["VITE_SUPABASE_URL / SUPABASE_URL"] : []),
      ...(!anonKey ? ["VITE_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY"] : []),
    ];
    throw new Error(
      `SUPABASE_CONFIG_MISSING: Variável(is) de ambiente ausente(s): ${missing.join(", ")}. Verifique se o arquivo .env está na pasta raiz do projeto (marmita-connect/.env).`,
    );
  }

  if (isPlaceholderEnvValue(url)) {
    throw new Error(
      `SUPABASE_URL_INVALID: VITE_SUPABASE_URL ainda contém um valor de exemplo ("${url}"). Configure a URL real do projeto Supabase no arquivo .env.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `SUPABASE_URL_INVALID: VITE_SUPABASE_URL não é uma URL válida ("${url}"). Use o formato https://SEU-REF.supabase.co.`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `SUPABASE_URL_INVALID: protocolo não suportado em VITE_SUPABASE_URL ("${parsed.protocol}").`,
    );
  }

  if (isPlaceholderEnvValue(anonKey)) {
    throw new Error(
      "SUPABASE_CONFIG_MISSING: VITE_SUPABASE_ANON_KEY ainda contém um valor de exemplo. Configure a chave pública real do Supabase no arquivo .env.",
    );
  }
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createSupabaseClient() {
  const SUPABASE_URL = readRuntimeEnv("VITE_SUPABASE_URL") || readRuntimeEnv("SUPABASE_URL");
  const SUPABASE_ANON_KEY =
    readRuntimeEnv("VITE_SUPABASE_ANON_KEY") ||
    readRuntimeEnv("VITE_SUPABASE_PUBLISHABLE_KEY") ||
    readRuntimeEnv("SUPABASE_ANON_KEY") ||
    readRuntimeEnv("SUPABASE_PUBLISHABLE_KEY");

  try {
    validateSupabaseClientConfig(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error(`[Supabase] ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      fetch: createSupabaseFetch(SUPABASE_ANON_KEY),
    },
    auth: {
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
