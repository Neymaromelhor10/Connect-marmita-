import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageCircle, BadgeDollarSign } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  useCompany,
  useCustomers,
  usePayments,
  useCustomerBalances,
  whatsappLink,
  type Customer,
} from "@/lib/queries";
import { brl, cycleLabel, fullDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const ACTIVE_ATTEMPT_STORAGE_KEY = "vm-active-payment-attempt";

type StoredPaymentAttempt = {
  id: string;
  name: string;
  balance: number;
  amount: string;
  key: string;
  uncertain: boolean;
};

function readStoredAttempt(): StoredPaymentAttempt | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_ATTEMPT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPaymentAttempt;
    if (parsed && parsed.id && parsed.key && parsed.amount) {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeStoredAttempt(attempt: StoredPaymentAttempt | null) {
  if (typeof window === "undefined") return;
  try {
    if (!attempt) {
      window.localStorage.removeItem(ACTIVE_ATTEMPT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(ACTIVE_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
    }
  } catch {
    // ignore storage errors
  }
}

export const Route = createFileRoute("/_authenticated/fiado")({
  head: () => ({
    meta: [
      { title: "Fiado · Verde&Mesa" },
      {
        name: "description",
        content: "Controle de fiado: saldo devedor por cliente, cobrança e baixa de pagamentos.",
      },
      { property: "og:title", content: "Fiado · Verde&Mesa" },
      { property: "og:description", content: "Quem deve, quanto deve e cobrança automática." },
    ],
  }),
  component: Fiado,
});

function Fiado() {
  const { data: company } = useCompany();
  const { data: authoritativeBalances, isLoading: loadingBalances } = useCustomerBalances(
    company?.id,
  );

  // CORREÇÃO AUD-07, AUD3-05 & AUD5-04:
  // 1. Nunca transforma ausência temporária de `authoritativeBalances` em consulta irrestrita (`customerIds: undefined`)!
  //    Enquanto `authoritativeBalances` está carregando, `balanceCustomerIds` é `[]` e `enabled` fica `false`.
  // 2. Quando `authoritativeBalances` resolve, `useCustomers` divide automaticamente `balanceCustomerIds`
  //    em lotes de no máximo 100 UUIDs (`fetchCustomersByIdsChunked`), evitando URLs longas no PostgREST
  //    mesmo com 300, 1.500, 5.000 ou 10.000+ clientes.
  const balanceCustomerIds = useMemo(
    () =>
      authoritativeBalances?.rows
        ? authoritativeBalances.rows
            .filter((r) => Math.abs(Number(r.balance)) > 0.009 || r.open_orders_count > 0)
            .map((r) => r.customer_id)
        : [],
    [authoritativeBalances?.rows],
  );

  const { data: pendingCustomers = [], isLoading: loadingPendingCustomers } = useCustomers({
    companyId: company?.id,
    status: ["pendente", "atrasado"],
    pageSize: 500,
    maxPages: 5,
    enabled: Boolean(company?.id),
  });

  const { data: balanceCustomers = [], isLoading: loadingBalanceCustomers } = useCustomers({
    companyId: company?.id,
    customerIds: balanceCustomerIds,
    enabled: Boolean(company?.id) && Boolean(authoritativeBalances),
  });

  const customers = useMemo(() => {
    const map = new Map<string, Customer>();
    for (const c of pendingCustomers) {
      map.set(c.id, c);
    }
    for (const c of balanceCustomers) {
      map.set(c.id, c);
    }
    return Array.from(map.values());
  }, [pendingCustomers, balanceCustomers]);

  const { data: payments = [], isLoading: loadingPayments } = usePayments({
    companyId: company?.id,
    page: 0,
    pageSize: 50,
    maxPages: 1,
  });

  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<{ id: string; name: string; balance: number } | null>(
    null,
  );
  const [amount, setAmount] = useState("");
  const [paymentKey, setPaymentKey] = useState<string | null>(null);
  const [uncertainAttempt, setUncertainAttempt] = useState(false);

  // Restaura tentativa pendente após recarregamento ou queda de conexão
  useEffect(() => {
    const saved = readStoredAttempt();
    if (saved && saved.uncertain) {
      setReceiving({ id: saved.id, name: saved.name, balance: saved.balance });
      setAmount(saved.amount);
      setPaymentKey(saved.key);
      setUncertainAttempt(true);
    }
  }, []);

  const isLoading =
    !authoritativeBalances ||
    loadingBalances ||
    loadingPendingCustomers ||
    loadingBalanceCustomers ||
    loadingPayments;
  const balances = authoritativeBalances?.balancesMap ?? new Map<string, number>();
  const debtors = customers
    .map((c) => ({ c, balance: balances.get(c.id) ?? 0 }))
    .filter((d) => d.balance > 0.009)
    .sort((a, b) => b.balance - a.balance);
  const credits = customers
    .map((c) => ({ c, credit: -(balances.get(c.id) ?? 0) }))
    .filter((d) => d.credit > 0.009);
  const total =
    authoritativeBalances?.totalOpenReceivable ??
    debtors.reduce((a, d) => a + d.balance, 0);

  function finishPaymentSuccess(customerBalance: number, paidValue: number, reconciled = false) {
    writeStoredAttempt(null);
    const left = customerBalance - paidValue;
    toast.success(
      reconciled
        ? "Pagamento reconciliado com sucesso (já estava registrado com segurança)."
        : left > 0.009
          ? `Pagamento registrado. Restam ${brl(left)}.`
          : left < -0.009
            ? `Pagamento registrado. Crédito de ${brl(-left)}.`
            : "Pagamento registrado. Cliente quitado!",
    );
    setUncertainAttempt(false);
    setPaymentKey(null);
    setReceiving(null);
    setAmount("");
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["payments"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customer_balances_authoritative"] });
  }

  async function settle() {
    if (!receiving) return;
    const value = Number(amount.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Informe um valor maior que zero.");
      return;
    }

    const activeKey = paymentKey ?? crypto.randomUUID();
    if (!paymentKey) {
      setPaymentKey(activeKey);
    }

    // Persiste a tentativa antes do envio para garantir reconciliação segura após timeout/reload
    writeStoredAttempt({
      id: receiving.id,
      name: receiving.name,
      balance: receiving.balance,
      amount: value.toFixed(2),
      key: activeKey,
      uncertain: true,
    });

    setBusy(receiving.id);

    // Registra início persistente da tentativa no banco (quando disponível)
    const beginRes = await supabase.rpc("begin_payment_attempt", {
      _customer_id: receiving.id,
      _amount: value,
      _idempotency_key: activeKey,
    });

    if (!beginRes.error && beginRes.data) {
      const info = beginRes.data as {
        status?: string;
        already_completed?: boolean;
        payment_id?: string | null;
      };
      if (info.already_completed && info.payment_id) {
        setBusy(null);
        finishPaymentSuccess(receiving.balance, value, true);
        return;
      }
      if (info.status === "cancelled") {
        setBusy(null);
        toast.error(
          "Esta chave de pagamento foi cancelada anteriormente. Cancele e inicie uma nova tentativa.",
        );
        return;
      }
    }

    const { error } = await supabase.rpc("financial_register_payment", {
      _customer_id: receiving.id,
      _amount: value,
      _method: "manual",
      _idempotency_key: activeKey,
    });

    if (!error) {
      setBusy(null);
      finishPaymentSuccess(receiving.balance, value, false);
      return;
    }

    // Em caso de falha/timeout, reconcilia com o banco antes de liberar qualquer alteração
    const checkRes = await supabase.rpc("reconcile_payment_attempt", {
      _idempotency_key: activeKey,
      _action: "check",
    });
    setBusy(null);

    if (!checkRes.error && checkRes.data) {
      const rec = checkRes.data as {
        found?: boolean;
        status?: string;
        amount?: number;
        can_release_new_key?: boolean;
      };
      if (rec.found) {
        finishPaymentSuccess(receiving.balance, Number(rec.amount ?? value), true);
        return;
      }
    }

    // found: false NÃO libera uma nova chave automaticamente enquanto a tentativa anterior puder concluir
    setUncertainAttempt(true);
    toast.error(
      "Resultado da tentativa ainda não confirmado. Repita com a mesma chave ou cancele explicitamente a tentativa antes de alterar o valor.",
    );
  }

  async function cancelPreviousAttempt() {
    if (!receiving || !paymentKey) return;
    const value = Number(amount.replace(",", ".")) || 0;
    setBusy(receiving.id);
    const cancelRes = await supabase.rpc("reconcile_payment_attempt", {
      _idempotency_key: paymentKey,
      _action: "cancel",
      _customer_id: receiving.id,
      _amount: value > 0 ? value : receiving.balance,
    });
    setBusy(null);

    if (cancelRes.error) {
      toast.error(
        "Não foi possível cancelar a tentativa no servidor. Verifique a conexão antes de liberar uma nova chave.",
      );
      return;
    }

    const rec = (cancelRes.data ?? {}) as {
      found?: boolean;
      status?: string;
      amount?: number;
      can_release_new_key?: boolean;
    };

    if (rec.found && rec.status === "succeeded") {
      finishPaymentSuccess(receiving.balance, Number(rec.amount ?? value), true);
      return;
    }

    if (rec.can_release_new_key) {
      const nextKey = crypto.randomUUID();
      setPaymentKey(nextKey);
      setUncertainAttempt(false);
      writeStoredAttempt({
        id: receiving.id,
        name: receiving.name,
        balance: receiving.balance,
        amount,
        key: nextKey,
        uncertain: false,
      });
      toast.info("Tentativa anterior cancelada com segurança. Você já pode ajustar o valor.");
    }
  }

  return (
    <div className="space-y-5 px-4 pt-5 pb-8">
      <section className="panel p-4">
        <div className="label-cap">Total em aberto</div>
        <div className="mt-1 font-display text-3xl text-accent">{brl(total)}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {debtors.length} clientes com saldo pendente
        </div>
      </section>

      <section className="space-y-2.5">
        <h2 className="font-display text-xl">Cobranças</h2>
        {isLoading && (
          <p className="panel p-4 text-sm text-muted-foreground">Carregando saldos…</p>
        )}
        {!isLoading && debtors.length === 0 && (
          <p className="panel p-4 text-sm text-muted-foreground">Tudo quitado por aqui.</p>
        )}
        {!isLoading &&
          debtors.map(({ c, balance }) => (
            <div key={c.id} className="panel p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-display text-[15px] leading-tight">{c.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {cycleLabel[c.payment_cycle]} · {c.phone}
                  </div>
                </div>
                <div className="font-display text-lg text-accent">{brl(balance)}</div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <a
                  href={whatsappLink(
                    c.phone,
                    `Olá ${c.name}! Fechamento das marmitas: ${brl(balance)}. Pode pagar quando puder, obrigado!`,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-10 items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-[13px] font-medium text-brand-foreground transition-opacity hover:opacity-95 active:opacity-85"
                >
                  <MessageCircle className="size-4" /> Cobrar
                </a>
                <Button
                  variant="secondary"
                  className="min-h-10"
                  disabled={busy === c.id}
                  onClick={() => {
                    const saved = readStoredAttempt();
                    if (saved && saved.id === c.id && saved.uncertain) {
                      setReceiving({ id: c.id, name: c.name, balance });
                      setAmount(saved.amount);
                      setPaymentKey(saved.key);
                      setUncertainAttempt(true);
                      return;
                    }
                    const freshKey = crypto.randomUUID();
                    setReceiving({ id: c.id, name: c.name, balance });
                    setAmount(balance.toFixed(2));
                    setPaymentKey(freshKey);
                    setUncertainAttempt(false);
                  }}
                >
                  <BadgeDollarSign className="size-4" /> Receber
                </Button>
              </div>
            </div>
          ))}
      </section>

      {!isLoading && credits.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="font-display text-xl">Créditos a favor do cliente</h2>
          {credits.map(({ c, credit }) => (
            <div key={c.id} className="panel flex items-center justify-between p-3">
              <div className="text-[13px] font-medium">{c.name}</div>
              <span className="font-display text-[15px] text-good">{brl(credit)}</span>
            </div>
          ))}
        </section>
      )}

      <Dialog
        open={receiving !== null}
        onOpenChange={(o) => {
          if (!o && !uncertainAttempt) {
            setReceiving(null);
            setPaymentKey(null);
          } else if (!o && uncertainAttempt) {
            setReceiving(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Receber de {receiving?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Saldo devedor: {brl(receiving?.balance ?? 0)}. Você pode receber o valor total ou
              apenas uma parte.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="payment-amount">Valor recebido</Label>
              <Input
                id="payment-amount"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                disabled={uncertainAttempt || busy !== null}
                value={amount}
                onChange={(e) => {
                  if (uncertainAttempt) return;
                  setAmount(e.target.value);
                }}
              />
            </div>
            {uncertainAttempt && (
              <p className="rounded-lg border border-accent/30 bg-accent/10 p-2.5 text-[12px] text-accent">
                A tentativa anterior falhou ou expirou sem confirmação final. O valor foi bloqueado
                para evitar cobrança duplicada. Repita com a mesma chave ou cancele explicitamente a
                tentativa anterior antes de alterar o valor.
              </p>
            )}
            <Button className="w-full" disabled={busy !== null} onClick={settle}>
              {busy
                ? "Registrando…"
                : uncertainAttempt
                  ? "Repetir confirmação com a mesma chave"
                  : "Registrar pagamento"}
            </Button>
            {uncertainAttempt && (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={busy !== null}
                onClick={cancelPreviousAttempt}
              >
                Cancelar tentativa anterior e alterar valor
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <section>
        <h2 className="font-display text-xl">Últimos recebimentos</h2>
        <div className="mt-3 space-y-2">
          {!isLoading && payments.length === 0 && (
            <p className="panel p-4 text-sm text-muted-foreground">Nenhum pagamento registrado.</p>
          )}
          {payments.map((p) => (
            <div key={p.id} className="panel flex items-center justify-between p-3">
              <div>
                <div className="text-[13px] font-medium">{p.customers?.name ?? "Cliente"}</div>
                <div className="text-[11px] text-muted-foreground">{fullDate(p.paid_at)}</div>
              </div>
              <span className="font-display text-[15px] text-good">{brl(Number(p.amount))}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
