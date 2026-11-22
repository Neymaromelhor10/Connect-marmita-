import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { setupCompany } from "@/lib/company.functions";
import { authErrorMessage } from "@/lib/auth-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/PasswordInput";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Entrar · Verde&Mesa gestão de marmitarias" },
      {
        name: "description",
        content:
          "Acesse o painel da sua marmitaria: pedidos pelo WhatsApp, controle de fiado e cobrança automática.",
      },
      { property: "og:title", content: "Entrar · Verde&Mesa" },
      {
        property: "og:description",
        content: "Painel de gestão para marmitarias com integração ao WhatsApp.",
      },
    ],
  }),
  component: AuthPage,
});

type Mode = "login" | "signup" | "reset";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/painel" });
    });
  }, [navigate]);

  async function ensureCompany(options?: { strict?: boolean }) {
    try {
      const res = await setupCompany({
        data: {
          companyName: companyName.trim() || "Minha marmitaria",
          fullName: fullName.trim(),
        },
      });
      if (!res?.companyId) {
        throw new Error("SETUP_COMPANY_FAILED: identificador da empresa não retornado pelo servidor.");
      }
      return res;
    } catch (err) {
      console.error("[AuthPage] Falha ao configurar empresa no backend (setupCompany):", err);
      if (options?.strict) {
        const detail = err instanceof Error ? err.message : String(err ?? "");
        if (detail.toLowerCase().includes("failed to fetch") || detail.toLowerCase().includes("network")) {
          throw err;
        }
        throw new Error(`SETUP_COMPANY_FAILED: ${detail}`);
      }
      throw err;
    }
  }

  function validate(): string | null {
    if (!email.trim()) return "Preencha seu e-mail.";
    if (mode !== "reset" && !password) return "Digite sua senha.";
    if (mode === "signup" && password.length < 6)
      return "A senha precisa ter pelo menos 6 caracteres.";
    if (mode === "signup" && !companyName.trim()) return "Informe o nome da marmitaria.";
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }

    setBusy(true);
    try {
      if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("Se este e-mail estiver cadastrado, enviaremos um link de recuperação.");
        setMode("login");
        return;
      }

      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { full_name: fullName, company_name: companyName },
          },
        });
        if (error) throw error;

        let session = data.session;
        if (!session) {
          const signIn = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          session = signIn.data.session;
        }
        if (!session) {
          toast.success("Cadastro criado. Confirme seu e-mail para entrar.");
          setMode("login");
          return;
        }
        await ensureCompany({ strict: true });
        toast.success("Empresa cadastrada!");
        navigate({ to: "/painel" });
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      if (!data.session) throw new Error("no session");
      await ensureCompany({ strict: false });
      navigate({ to: "/painel" });
    } catch (err) {
      toast.error(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    if (busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/painel`,
        },
      });
      if (error) {
        const msg = error.message?.toLowerCase() ?? "";
        if (msg.includes("provider is not enabled") || msg.includes("unsupported provider")) {
          toast.error("Login com Google ainda não está habilitado no Supabase (Authentication > Providers > Google).");
        } else {
          toast.error(error.message || "Não foi possível entrar com o Google.");
        }
      } else if (data?.url && !data.url.startsWith("http")) {
        toast.error("URL de redirecionamento OAuth inválida.");
      }
    } catch {
      toast.error("Não foi possível entrar com o Google.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="rounded-b-[1.75rem] bg-brand px-5 pt-8 pb-10 text-brand-foreground shadow-[0_10px_30px_-12px_oklch(0.22_0.042_263/0.55)]">
        <div className="mx-auto max-w-md">
          <div className="font-display text-[32px] leading-none tracking-tight">
            Verde<span className="italic text-gilt">&amp;</span>Mesa
          </div>
          <div className="mt-2 text-[10px] tracking-[0.22em] uppercase opacity-60">
            Marmitaria · SaaS
          </div>
          <p className="mt-5 max-w-[26ch] text-sm opacity-80">
            Pedidos do WhatsApp, fiado semanal e cobrança automática em um só painel.
          </p>
        </div>
      </header>

      <main className="mx-auto -mt-6 max-w-md px-4 pb-16">
        <div className="panel p-5">
          <h1 className="font-display text-xl">
            {mode === "login" && "Entrar na sua conta"}
            {mode === "signup" && "Cadastrar marmitaria"}
            {mode === "reset" && "Recuperar senha"}
          </h1>

          <form onSubmit={submit} className="mt-4 space-y-3">
            {mode === "signup" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="company">Nome da marmitaria</Label>
                  <Input
                    id="company"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Marmitaria da Cecília"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Seu nome</Label>
                  <Input
                    id="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Cecília Martins"
                    required
                  />
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@marmitaria.com.br"
                required
              />
            </div>

            {mode !== "reset" && (
              <div className="space-y-1.5">
                <Label htmlFor="password">Senha</Label>
                <PasswordInput
                  id="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy && "Aguarde..."}
              {!busy && mode === "login" && "Entrar"}
              {!busy && mode === "signup" && "Criar conta da empresa"}
              {!busy && mode === "reset" && "Enviar link de recuperação"}
            </Button>
          </form>

          {mode !== "reset" && (
            <>
              <div className="my-4 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> ou{" "}
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button type="button" variant="outline" className="w-full" onClick={google}>
                Continuar com Google
              </Button>
            </>
          )}

          <div className="mt-5 space-y-2 text-[13px] text-muted-foreground">
            {mode !== "login" && (
              <button type="button" className="cursor-pointer underline" onClick={() => setMode("login")}>
                Já tenho conta · entrar
              </button>
            )}
            {mode !== "signup" && (
              <button type="button" className="block cursor-pointer underline" onClick={() => setMode("signup")}>
                Cadastrar minha marmitaria
              </button>
            )}
            {mode !== "reset" && (
              <button type="button" className="block cursor-pointer underline" onClick={() => setMode("reset")}>
                Esqueci minha senha
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
