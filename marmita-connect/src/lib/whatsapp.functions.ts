import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,32}$/),
  wabaId: z.string().trim().regex(/^\d{5,32}$/),
});

export type { WhatsAppAuthContext } from "./whatsapp.server";

export const linkWhatsAppNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => schema.parse(d))
  .handler(async ({ data, context }) => {
    const { executeLinkWhatsAppNumber } = await import("./whatsapp.server");
    return executeLinkWhatsAppNumber(context, data);
  });

export const disconnectWhatsAppNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { executeDisconnectWhatsAppNumber } = await import("./whatsapp.server");
    return executeDisconnectWhatsAppNumber(context);
  });
