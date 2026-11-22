import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { linkWhatsAppNumber } from "@/lib/whatsapp.functions";
import { useWhatsAppConnection } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Vincula o número do WhatsApp Cloud API (Meta) a esta empresa. Somente IDs públicos; nenhum token aqui. */
export function WhatsAppConnection({ companyId }: { companyId?: string | undefined }) {
  const { data: conn } = useWhatsAppConnection(companyId);
  const qc = useQueryClient();
  const [phoneId, setPhoneId] = useState("");
  const [waba, setWaba] = useState("");
  const [saving, setSaving] = useState(false);
  const link = useServerFn(linkWhatsAppNumber);

  useEffect(() => {
    if (conn) {
      setPhoneId(conn.phone_number_id);
      setWaba(conn.whatsapp_business_account_id);
    }
  }, [conn]);

  async function save() {
    if (!companyId) return;
    if (!/^\d{5,32}$/.test(phoneId.trim()) || !/^\d{5,32}$/.test(waba.trim())) {
      toast.error("Informe os IDs numéricos copiados do Meta Developers.");
      return;
    }
    setSaving(true);
    try {
      await link({ data: { phoneNumberId: phoneId.trim(), wabaId: waba.trim() } });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["whatsapp_connection"] }),
        qc.invalidateQueries({ queryKey: ["company"] }),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar.");
      return;
    } finally {
      setSaving(false);
    }
    toast.success("Número do WhatsApp vinculado");
  }

  return (
    <section className="panel p-4">
      <h2 className="font-display text-lg">WhatsApp Cloud API (Meta)</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {conn
          ? `Status: ${conn.status}${conn.display_phone_number ? ` (${conn.display_phone_number})` : ""}. `
          : "Não vinculado. "}
        Mensagens recebidas neste número são lidas automaticamente. Nada é enviado aos clientes.
      </p>
      <div className="mt-3 grid gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="wa-phone-id">Phone Number ID</Label>
          <Input
            id="wa-phone-id"
            inputMode="numeric"
            value={phoneId}
            onChange={(e) => setPhoneId(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wa-waba-id">WhatsApp Business Account ID</Label>
          <Input
            id="wa-waba-id"
            inputMode="numeric"
            value={waba}
            onChange={(e) => setWaba(e.target.value)}
          />
        </div>
      </div>
      <Button className="mt-3 w-full" variant="secondary" onClick={save} disabled={saving}>
        {saving ? "Salvando…" : "Salvar número"}
      </Button>
    </section>
  );
}
