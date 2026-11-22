import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { authErrorMessage } from "@/lib/auth-errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/PasswordInput";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Nova senha · Verde&Mesa" },
      {
        name: "description",
        content: "Defina uma nova senha para acessar o painel da sua marmitaria.",
      },
      { property: "og:title", content: "Nova senha · Verde&Mesa" },
      { property: "og:description", content: "Redefina sua senha de acesso ao Verde&Mesa." },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setReady(Boolean(data.session)));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("A senha precisa ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirm) {
      toast.error("As senhas não são iguais.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Senha atualizada! Entre com a nova senha.");
      await supabase.auth.signOut();
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="rounded-b-[1.75rem] bg-brand px-5 pt-8 pb-10 text-brand-foreground">
        <div className="mx-auto max-w-md font-display text-[32px] leading-none tracking-tight">
          Verde<span className="italic text-gilt">&amp;</span>Mesa
        </div>
      </header>
      <main className="mx-auto -mt-6 max-w-md px-4 pb-16">
        <div className="panel p-5">
          <h1 className="font-display text-xl">Definir nova senha</h1>
          {!ready ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Abra esta página pelo link enviado no seu e-mail para redefinir a senha.
            </p>
          ) : (
            <form onSubmit={submit} className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-password">Nova senha</Label>
                <PasswordInput
                  id="new-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirmar nova senha</Label>
                <PasswordInput
                  id="confirm-password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Salvando..." : "Salvar nova senha"}
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
