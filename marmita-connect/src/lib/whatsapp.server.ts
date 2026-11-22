import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { verifyRemoteSupabaseSession } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

const schema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,32}$/),
  wabaId: z.string().trim().regex(/^\d{5,32}$/),
});

export type WhatsAppAuthContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
  token?: string;
};

export async function authorizeWhatsAppAdminOperation(
  context: WhatsAppAuthContext | null | undefined,
): Promise<{ companyId: string; userId: string }> {
  if (!context?.userId || !context?.supabase) {
    throw new Error("Acesso negado: autenticação obrigatória.");
  }

  if (context.supabase.auth && typeof context.supabase.auth.getUser === "function") {
    await verifyRemoteSupabaseSession(context.supabase, context.userId, context.token);
  }

  const profile = await context.supabase
    .from("profiles")
    .select("company_id")
    .eq("id", context.userId)
    .maybeSingle();

  if (profile.error || !profile.data?.company_id) {
    throw new Error("Empresa não encontrada.");
  }

  const companyId = profile.data.company_id;

  const maybeRpc = (
    context.supabase as unknown as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{ data: boolean | null; error: { code?: string; message?: string } | null }>;
    }
  ).rpc;

  if (typeof maybeRpc !== "function") {
    throw new Error("Permissão administrativa necessária para gerenciar a conexão do WhatsApp.");
  }

  let adminCheck: { data: boolean | null; error: { code?: string; message?: string } | null };
  try {
    adminCheck = await maybeRpc.call(context.supabase, "is_company_admin", {
      _company_id: companyId,
    });
  } catch {
    throw new Error("Permissão administrativa necessária para gerenciar a conexão do WhatsApp.");
  }

  if (adminCheck.error || adminCheck.data !== true) {
    throw new Error("Permissão administrativa necessária para gerenciar a conexão do WhatsApp.");
  }

  return { companyId, userId: context.userId };
}

export async function executeLinkWhatsAppNumber(
  context: WhatsAppAuthContext,
  data: z.infer<typeof schema>,
  deps?: {
    supabaseAdmin?: SupabaseClient<Database>;
    fetchImpl?: typeof fetch;
    whatsappAccessToken?: string;
  },
) {
  const { companyId } = await authorizeWhatsAppAdminOperation(context);

  const token = deps?.whatsappAccessToken ?? process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!token) throw new Error("Integração com a Meta não configurada.");

  const fetchFn = deps?.fetchImpl ?? fetch;
  const res = await fetchFn(
    `https://graph.facebook.com/v21.0/${data.wabaId}/phone_numbers?fields=id,display_phone_number`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json().catch(() => ({}))) as {
    data?: { id: string; display_phone_number?: string }[];
    error?: { code?: number };
  };
  if (!res.ok) {
    if (body.error?.code === 190) {
      throw new Error("O token de acesso da Meta expirou. Gere um token permanente e atualize-o.");
    }
    throw new Error("A Meta não confirmou esta conta do WhatsApp Business.");
  }
  const phone = body.data?.find((p) => p.id === data.phoneNumberId);
  if (!phone) {
    throw new Error("Este Phone Number ID não pertence à conta do WhatsApp Business informada.");
  }

  const supabaseAdmin =
    deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  const taken = await supabaseAdmin
    .from("whatsapp_connections")
    .select("company_id")
    .eq("phone_number_id", data.phoneNumberId)
    .maybeSingle();
  if (taken.data && taken.data.company_id !== companyId) {
    throw new Error("Este número já está vinculado a outra conta.");
  }

  const row = {
    company_id: companyId,
    phone_number_id: data.phoneNumberId,
    whatsapp_business_account_id: data.wabaId,
    status: "ativo",
    verified_at: new Date().toISOString(),
    display_phone_number: phone.display_phone_number ?? null,
  };

  const saved = await supabaseAdmin
    .from("whatsapp_connections")
    .upsert(row, { onConflict: "company_id" })
    .select("id, phone_number_id, whatsapp_business_account_id, status")
    .single();
  if (saved.error) {
    if (saved.error.code === "23505") {
      throw new Error("Este número já está vinculado a outra conta.");
    }
    throw new Error("Não foi possível salvar.");
  }

  await supabaseAdmin
    .from("companies")
    .update({ whatsapp_connected: true })
    .eq("id", companyId);

  return saved.data;
}

export async function executeDisconnectWhatsAppNumber(
  context: WhatsAppAuthContext,
  deps?: {
    supabaseAdmin?: SupabaseClient<Database>;
  },
) {
  const { companyId } = await authorizeWhatsAppAdminOperation(context);

  const supabaseAdmin =
    deps?.supabaseAdmin ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;

  const updated = await supabaseAdmin
    .from("whatsapp_connections")
    .update({ status: "desconectado" })
    .eq("company_id", companyId);

  if (updated.error) {
    throw new Error("Não foi possível desconectar o número do WhatsApp.");
  }

  await supabaseAdmin
    .from("companies")
    .update({ whatsapp_connected: false })
    .eq("id", companyId);

  return { companyId, status: "desconectado" as const };
}
