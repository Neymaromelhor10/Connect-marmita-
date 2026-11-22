import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Pencil, ShieldAlert } from "lucide-react";
import {
  saveCompanyCustomer,
  inspectCustomerLgpd,
  anonymizeCustomerLgpd,
  type LgpdCustomerInspectionResult,
} from "@/lib/company.functions";
import {
  useCustomers,
  useCompany,
  useCustomerBalances,
  DEFAULT_OPERATIONAL_PAGE_SIZE,
  type Customer,
} from "@/lib/queries";
import { brl, cycleLabel, normalizePhone, statusLabel } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/clientes")({
  head: () => ({
    meta: [
      { title: "Clientes · Verde&Mesa" },
      {
        name: "description",
        content: "Cadastro de clientes da marmitaria com endereço, ciclo de pagamento e status.",
      },
      { property: "og:title", content: "Clientes · Verde&Mesa" },
      { property: "og:description", content: "Gestão de clientes e ciclos de pagamento." },
    ],
  }),
  component: Clientes,
});

type Draft = {
  id?: string;
  name: string;
  phone: string;
  address: string;
  notes: string;
  payment_cycle: Customer["payment_cycle"];
  status: Customer["status"];
};

const empty: Draft = {
  name: "",
  phone: "",
  address: "",
  notes: "",
  payment_cycle: "semanal",
  status: "em_dia",
};

function Clientes() {
  const { data: company } = useCompany();
  const [page, setPage] = useState(0);
  // CORREÇÃO AUD-07: Paginação server-side e uso de useCustomerBalances sem baixar histórico de pedidos/pagamentos
  const { data: customers = [], isLoading } = useCustomers({
    companyId: company?.id,
    page,
    pageSize: DEFAULT_OPERATIONAL_PAGE_SIZE,
    maxPages: 1,
  });
  const { data: authoritativeBalances } = useCustomerBalances(company?.id);
  const qc = useQueryClient();
  const saveCustomerFn = useServerFn(saveCompanyCustomer);
  const inspectLgpdFn = useServerFn(inspectCustomerLgpd);
  const anonymizeLgpdFn = useServerFn(anonymizeCustomerLgpd);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(empty);
  const [saving, setSaving] = useState(false);

  // AF-10: Estado do fluxo transacional de inspeção e anonimização LGPD
  const [lgpdTarget, setLgpdTarget] = useState<Customer | null>(null);
  const [lgpdDiag, setLgpdDiag] = useState<LgpdCustomerInspectionResult | null>(null);
  const [lgpdScope, setLgpdScope] = useState<"dados_complementares" | "anonimizacao_completa">(
    "dados_complementares",
  );
  const [lgpdProtocol, setLgpdProtocol] = useState("");
  const [lgpdConfirmToken, setLgpdConfirmToken] = useState("");
  const [lgpdBusy, setLgpdBusy] = useState(false);

  const balances = authoritativeBalances?.balancesMap ?? new Map<string, number>();

  async function save() {
    if (!company || saving) return;
    const name = draft.name.trim();
    const digits = normalizePhone(draft.phone);
    if (name.length < 2) {
      toast.error("Informe o nome do cliente.");
      return;
    }
    if (digits.length < 10 || digits.length > 15) {
      toast.error("Telefone inválido. Use DDD + número, ex.: 11987654321.");
      return;
    }

    setSaving(true);
    try {
      await saveCustomerFn({
        data: {
          id: draft.id,
          name,
          phone: digits,
          address: draft.address || null,
          notes: draft.notes || null,
          payment_cycle: draft.payment_cycle,
        },
      });
      toast.success(draft.id ? "Cliente atualizado" : "Cliente cadastrado");
      setOpen(false);
      setDraft(empty);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer_balances_authoritative"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(msg || "Não foi possível salvar o cliente. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  async function openLgpdDialog(customer: Customer) {
    setLgpdTarget(customer);
    setLgpdDiag(null);
    setLgpdProtocol("");
    setLgpdConfirmToken("");
    setLgpdScope("dados_complementares");
    setLgpdBusy(true);
    try {
      const diag = await inspectLgpdFn({ data: { customerId: customer.id } });
      setLgpdDiag(diag);
      if (diag.allowed_scopes.includes("anonimizacao_completa")) {
        setLgpdScope("anonimizacao_completa");
      } else {
        setLgpdScope("dados_complementares");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(
        msg || "Permissão administrativa necessária para inspecionar elegibilidade LGPD.",
      );
      setLgpdTarget(null);
    } finally {
      setLgpdBusy(false);
    }
  }

  async function submitLgpdAnonymization() {
    if (!lgpdTarget || lgpdBusy) return;
    const expectedToken = `LGPD_CONFIRM_${lgpdTarget.id}`;
    if (lgpdConfirmToken.trim() !== expectedToken) {
      toast.error(`Confirmação inválida. Digite exatamente ${expectedToken}`);
      return;
    }
    if (lgpdProtocol.trim().length < 3) {
      toast.error("Informe o protocolo ou justificativa da solicitação do titular (mín. 3 caracteres).");
      return;
    }

    setLgpdBusy(true);
    try {
      const res = await anonymizeLgpdFn({
        data: {
          customerId: lgpdTarget.id,
          scope: lgpdScope,
          confirmToken: lgpdConfirmToken.trim(),
          protocol: lgpdProtocol.trim(),
        },
      });
      toast.success(
        res.scope_executed === "anonimizacao_completa"
          ? "Dados pessoais anonimizados com sucesso (registros financeiros preservados)."
          : "Dados complementares e textos de mensagens removidos com sucesso.",
      );
      setLgpdTarget(null);
      setLgpdDiag(null);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(msg || "Não foi possível executar a anonimização LGPD.");
    } finally {
      setLgpdBusy(false);
    }
  }

  return (
    <div className="space-y-4 px-4 pt-5 pb-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl">Clientes</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="min-h-10 px-3.5" onClick={() => setDraft(empty)}>
              <Plus className="size-4" /> Novo
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display">
                {draft.id ? "Editar cliente" : "Novo cliente"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Field htmlFor="cust-name" label="Nome">
                <Input
                  id="cust-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field htmlFor="cust-phone" label="Telefone">
                <Input
                  id="cust-phone"
                  inputMode="tel"
                  value={draft.phone}
                  placeholder="11987654321"
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                />
              </Field>
              <Field htmlFor="cust-address" label="Endereço">
                <Input
                  id="cust-address"
                  value={draft.address}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                />
              </Field>
              <Field htmlFor="cust-notes" label="Observações">
                <Textarea
                  id="cust-notes"
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field htmlFor="cust-cycle" label="Pagamento">
                  <Select
                    value={draft.payment_cycle}
                    onValueChange={(v) =>
                      setDraft({ ...draft, payment_cycle: v as Draft["payment_cycle"] })
                    }
                  >
                    <SelectTrigger id="cust-cycle">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(cycleLabel).map(([v, l]) => (
                        <SelectItem key={v} value={v}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field htmlFor="cust-status" label="Status">
                  <Select
                    value={draft.status}
                    disabled
                  >
                    <SelectTrigger id="cust-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(statusLabel).map(([v, l]) => (
                        <SelectItem key={v} value={v}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Button className="w-full" onClick={save} disabled={saving}>
                {saving ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog
        open={Boolean(lgpdTarget)}
        onOpenChange={(next) => {
          if (!next) {
            setLgpdTarget(null);
            setLgpdDiag(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">
              Privacidade e Anonimização LGPD
            </DialogTitle>
          </DialogHeader>
          {lgpdTarget && (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Titular: <strong>{lgpdTarget.name}</strong> ({lgpdTarget.phone})
              </p>
              {lgpdDiag ? (
                <>
                  <div className="rounded-md bg-secondary/60 p-3 text-xs">
                    <p>{lgpdDiag.legal_basis_summary}</p>
                    <p className="mt-1.5 text-muted-foreground">
                      Pedidos vinculados: {lgpdDiag.orders_count} · Pagamentos: {lgpdDiag.payments_count} · Mensagens: {lgpdDiag.messages_count}
                    </p>
                  </div>
                  <Field htmlFor="lgpd-scope" label="Escopo permitido">
                    <Select
                      value={lgpdScope}
                      onValueChange={(v) =>
                        setLgpdScope(v as "dados_complementares" | "anonimizacao_completa")
                      }
                    >
                      <SelectTrigger id="lgpd-scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dados_complementares">
                          Dados complementares (endereço, observações e textos WhatsApp)
                        </SelectItem>
                        {lgpdDiag.allowed_scopes.includes("anonimizacao_completa") && (
                          <SelectItem value="anonimizacao_completa">
                            Anonimização completa irreversível (preserva valores contábeis)
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field htmlFor="lgpd-protocol" label="Protocolo / Justificativa da Solicitação">
                    <Input
                      id="lgpd-protocol"
                      placeholder="Ex.: Solicitação do titular via WhatsApp em 13/11/2026"
                      value={lgpdProtocol}
                      onChange={(e) => setLgpdProtocol(e.target.value)}
                    />
                  </Field>
                  <Field
                    htmlFor="lgpd-token"
                    label={`Digite LGPD_CONFIRM_${lgpdTarget.id} para confirmar`}
                  >
                    <Input
                      id="lgpd-token"
                      value={lgpdConfirmToken}
                      onChange={(e) => setLgpdConfirmToken(e.target.value)}
                    />
                  </Field>
                  <Button
                    className="w-full"
                    variant="destructive"
                    onClick={submitLgpdAnonymization}
                    disabled={lgpdBusy}
                  >
                    {lgpdBusy ? "Processando…" : "Confirmar Anonimização Auditada"}
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Verificando pendências financeiras e elegibilidade legal…
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="space-y-2.5">
        {isLoading && (
          <p className="panel p-4 text-sm text-muted-foreground">Carregando clientes…</p>
        )}
        {!isLoading && customers.length === 0 && (
          <p className="panel p-4 text-sm text-muted-foreground">
            Nenhum cliente ainda. Cadastre manualmente ou deixe o WhatsApp cadastrar sozinho.
          </p>
        )}
        {customers.map((c) => (
          <div key={c.id} className="panel p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-display text-[15px] leading-tight">{c.name}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {cycleLabel[c.payment_cycle]} · {c.phone}
                </div>
                {c.address && (
                  <div className="mt-1 truncate text-[11px] text-muted-foreground">{c.address}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                    c.status === "atrasado"
                      ? "bg-accent/10 text-accent"
                      : c.status === "pendente"
                        ? "bg-gilt/15 text-gilt"
                        : "bg-good/10 text-good"
                  }`}
                >
                  {statusLabel[c.status]}
                </span>
                <button
                  aria-label={`LGPD ${c.name}`}
                  title="Privacidade e Anonimização LGPD"
                  onClick={() => openLgpdDialog(c)}
                  className="grid size-10 place-items-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80"
                >
                  <ShieldAlert className="size-4" />
                </button>
                <button
                  aria-label={`Editar ${c.name}`}
                  onClick={() => {
                    setDraft({
                      id: c.id,
                      name: c.name,
                      phone: c.phone,
                      address: c.address ?? "",
                      notes: c.notes ?? "",
                      payment_cycle: c.payment_cycle,
                      status: c.status,
                    });
                    setOpen(true);
                  }}
                  className="grid size-10 place-items-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80"
                >
                  <Pencil className="size-4" />
                </button>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
              <span className="text-[12px] text-muted-foreground">Saldo em aberto</span>
              <span className="font-display text-[15px]">{brl(balances.get(c.id) ?? 0)}</span>
            </div>
          </div>
        ))}
      </div>

      {(page > 0 || customers.length >= DEFAULT_OPERATIONAL_PAGE_SIZE) && (
        <div className="no-print flex items-center justify-between pt-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Página anterior
          </Button>
          <span className="text-[11px] text-muted-foreground">Página {page + 1}</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={customers.length < DEFAULT_OPERATIONAL_PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima página
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({
  htmlFor,
  label,
  children,
}: {
  htmlFor: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
