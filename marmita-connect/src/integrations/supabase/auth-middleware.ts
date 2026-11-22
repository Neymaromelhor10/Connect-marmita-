import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
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

/**
 * CORREÇÃO FOR-08:
 * Valida remotamente a sessão junto ao Supabase Auth (`supabase.auth.getUser`)
 * antes de executar operações privilegiadas que utilizam `supabaseAdmin` (`service_role`).
 * - Rejeita imediatamente usuários excluídos, sessões revogadas, tokens inválidos
 *   ou usuários banidos (`banned_until` no futuro).
 * - Nega por padrão caso o serviço de autenticação esteja indisponível ou retorne erro.
 */
export async function verifyRemoteSupabaseSession(
  supabase: Pick<SupabaseClient<Database>, "auth">,
  expectedUserId: string,
  token?: string,
): Promise<{ userId: string; email: string | null; userMetadata: Record<string, unknown> }> {
  if (!expectedUserId || !supabase?.auth || typeof supabase.auth.getUser !== "function") {
    throw new Error("Acesso negado: validação remota de sessão indisponível.");
  }

  let userData: {
    user?: {
      id?: string;
      email?: string | null;
      user_metadata?: Record<string, unknown>;
      banned_until?: string | null;
    } | null;
  } | null = null;
  let userError: unknown = null;

  try {
    const res = token
      ? await supabase.auth.getUser(token)
      : await supabase.auth.getUser();
    userData = res.data as typeof userData;
    userError = res.error;
  } catch {
    throw new Error("Acesso negado: não foi possível validar a sessão no servidor de autenticação.");
  }

  if (userError || !userData?.user?.id || userData.user.id !== expectedUserId) {
    throw new Error("Acesso negado: sessão inválida, expirada ou revogada.");
  }

  const bannedUntil = userData.user.banned_until;
  if (typeof bannedUntil === "string" && bannedUntil.trim()) {
    const bannedMs = Date.parse(bannedUntil);
    if (Number.isFinite(bannedMs) && bannedMs > Date.now()) {
      throw new Error("Acesso negado: conta de usuário suspensa ou revogada.");
    }
  }

  return {
    userId: userData.user.id,
    email: userData.user.email ?? null,
    userMetadata: (userData.user.user_metadata ?? {}) as Record<string, unknown>,
  };
}

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
    const SUPABASE_ANON_KEY =
      process.env["SUPABASE_ANON_KEY"] ||
      process.env["SUPABASE_PUBLISHABLE_KEY"] ||
      process.env["VITE_SUPABASE_ANON_KEY"] ||
      process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      const missing = [
        ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
        ...(!SUPABASE_ANON_KEY ? ["SUPABASE_ANON_KEY"] : []),
      ];
      const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Configure your Supabase project credentials in .env.`;
      console.error(`[Supabase] ${message}`);
      throw new Error(message);
    }

    const request = getRequest();

    if (!request?.headers) {
      throw new Error("Unauthorized: No request headers available");
    }

    const authHeader = request.headers.get("authorization");

    if (!authHeader) {
      throw new Error("Unauthorized: No authorization header provided");
    }

    if (!authHeader.startsWith("Bearer ")) {
      throw new Error("Unauthorized: Only Bearer tokens are supported");
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      throw new Error("Unauthorized: No token provided");
    }

    if (token.split(".").length !== 3) {
      throw new Error("Unauthorized: Invalid token");
    }

    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        fetch: createSupabaseFetch(SUPABASE_ANON_KEY),
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        storage: undefined,
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    let userId: string | undefined;
    let claims: Record<string, unknown> | undefined;

    const authAny = supabase.auth as unknown as {
      getClaims?: (jwt: string) => Promise<{
        data: { claims?: Record<string, unknown> } | null;
        error: unknown;
      }>;
    };

    if (typeof authAny.getClaims === "function") {
      const claimsRes = await authAny.getClaims(token).catch(() => null);
      if (claimsRes && !claimsRes.error && claimsRes.data?.claims?.["sub"]) {
        userId = String(claimsRes.data.claims["sub"]);
        claims = claimsRes.data.claims;
      }
    }

    // Fallback compatível com qualquer projeto Supabase independente (HS256 ou RS256/ES256)
    if (!userId) {
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData?.user?.id) {
        throw new Error("Unauthorized: Invalid token");
      }
      userId = userData.user.id;
      claims = {
        sub: userData.user.id,
        email: userData.user.email ?? null,
        user_metadata: userData.user.user_metadata ?? {},
      };
    }

    return next({
      context: {
        supabase,
        userId,
        token,
        claims: claims ?? { sub: userId },
      },
    });
  },
);
