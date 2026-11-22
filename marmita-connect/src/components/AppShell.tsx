import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutGrid,
  MessageCircle,
  ClipboardList,
  Users,
  Wallet,
  BarChart3,
  Moon,
  Sun,
  LogOut,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCompany, useWhatsAppConnection } from "@/lib/queries";
import { setupCompany } from "@/lib/company.functions";
import { getStoredTheme, toggleTheme, type Theme } from "@/lib/theme";
import { initials } from "@/lib/format";

const nav = [
  { to: "/painel", label: "Painel", icon: LayoutGrid },
  { to: "/whatsapp", label: "Mensagens", icon: MessageCircle },
  { to: "/pedidos", label: "Pedidos", icon: ClipboardList },
  { to: "/clientes", label: "Clientes", icon: Users },
  { to: "/fiado", label: "Fiado", icon: Wallet },
  { to: "/relatorios", label: "Relatórios", icon: BarChart3 },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { data: company, isFetched } = useCompany();
  const { data: waConn } = useWhatsAppConnection(company?.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  useEffect(() => setTheme(getStoredTheme()), []);

  // Contas criadas pelo Google não passam pelo formulário de cadastro:
  // garantimos aqui que a marmitaria exista antes de qualquer tela usar os dados.
  useEffect(() => {
    if (!isFetched || company) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const meta = (data.user?.user_metadata ?? {}) as { full_name?: string; name?: string };
      try {
        await setupCompany({
          data: {
            companyName: "Minha marmitaria",
            fullName: meta.full_name || meta.name || data.user?.email || "Responsável",
          },
        });
        if (!cancelled) queryClient.invalidateQueries();
      } catch {
        /* já existe ou sem sessão */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isFetched, company, queryClient]);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/", replace: true });
  }

  const isWhatsAppConnected = Boolean(
    company?.whatsapp_connected || (waConn && waConn.status === "ativo"),
  );

  return (
    <div className="min-h-screen bg-background pb-24 md:flex md:gap-0 md:pb-0">
      {/* Desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-ink px-4 py-6 text-background md:flex dark:text-foreground">
        <div className="font-display text-2xl leading-none tracking-tight">
          Verde<span className="italic text-gilt">&amp;</span>Mesa
        </div>
        <div className="mt-1.5 text-[10px] tracking-[0.22em] uppercase opacity-50">
          Marmitaria · SaaS
        </div>
        <nav className="mt-8 space-y-1">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] opacity-70 transition-colors hover:bg-background/10 hover:opacity-100"
              activeProps={{ className: "bg-background/15 opacity-100 font-medium" }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-1 pt-6">
          <button
            onClick={() => setTheme(toggleTheme())}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] opacity-70 transition-colors hover:bg-background/10 hover:opacity-100"
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {theme === "dark" ? "Tema claro" : "Tema escuro"}
          </button>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] opacity-70 transition-colors hover:bg-background/10 hover:opacity-100"
          >
            <LogOut className="size-4" /> Sair
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Mobile / top header */}
        <header className="no-print rounded-b-[1.75rem] bg-brand px-5 pt-5 pb-4 text-brand-foreground shadow-[0_10px_30px_-12px_oklch(0.22_0.042_263/0.55)] md:rounded-none md:shadow-none">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div className="md:hidden">
              <div className="font-display text-[27px] leading-none tracking-tight">
                Verde<span className="italic text-gilt">&amp;</span>Mesa
              </div>
              <div className="mt-1.5 text-[10px] tracking-[0.22em] uppercase opacity-55">
                Marmitaria · SaaS
              </div>
            </div>
            <div className="hidden md:block">
              <div className="font-display text-xl">{company?.name ?? "Sua marmitaria"}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTheme(toggleTheme())}
                aria-label="Alternar tema"
                className="grid size-11 place-items-center rounded-full bg-background/10 transition-opacity active:opacity-75 md:hidden"
              >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
              <button
                onClick={signOut}
                aria-label="Sair"
                className="grid size-11 place-items-center rounded-full bg-background/10 transition-opacity active:opacity-75 md:hidden"
              >
                <LogOut className="size-4" />
              </button>
              <span className="grid size-10 place-items-center rounded-full bg-background/10 text-xs font-semibold">
                {initials(company?.name ?? "VM")}
              </span>
            </div>
          </div>
          <div className="mx-auto mt-4 flex max-w-5xl items-center gap-2 rounded-full bg-background/10 px-3 py-2 text-[11px] opacity-85">
            <span
              className={`size-2 rounded-full ${isWhatsAppConnected ? "bg-good" : "bg-gilt"}`}
            />
            {isWhatsAppConnected
              ? `WhatsApp Business conectado${waConn?.display_phone_number ? ` · ${waConn.display_phone_number}` : ""}`
              : "WhatsApp Business não conectado"}
          </div>
        </header>

        <main className="mx-auto max-w-5xl">{children}</main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around rounded-t-2xl bg-ink px-2 pt-2 pb-4 text-background md:hidden dark:text-foreground">
        {nav.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex min-h-11 flex-1 flex-col items-center justify-center gap-1 opacity-60 transition-opacity"
            activeProps={{ className: "opacity-100 font-medium" }}
          >
            <item.icon className="size-[18px]" />
            <span className="text-[10px]">{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
