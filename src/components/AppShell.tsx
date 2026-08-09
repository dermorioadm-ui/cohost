import { type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CalendarDays, CalendarCheck, DoorOpen, Home, LogOut, MessageSquare } from "lucide-react";
import { useAuth, type AppRole } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

/**
 * Casca do app: barra inferior no celular, menu lateral no desktop.
 *
 * O app novo nasceu sem navegação — dava para andar por ele só porque uma tela
 * empurrava a outra. Isso serve para o onboarding, que é um trilho, e não serve
 * para o uso diário, que é ir e voltar entre calendário, portaria e conversas.
 *
 * A barra some nas telas de trilho (onboarding) e nas públicas (chat do
 * hóspede, aceite da diarista), onde navegação lateral só atrapalharia.
 */

type NavItem = { label: string; short: string; icon: typeof CalendarDays; path: string };

const NAV: Record<Exclude<AppRole, "admin">, NavItem[]> = {
  owner: [
    { label: "Painel", short: "Painel", icon: CalendarCheck, path: "/painel" },
    { label: "Calendário", short: "Calendário", icon: CalendarDays, path: "/calendario" },
    { label: "Imóveis", short: "Imóveis", icon: Home, path: "/imoveis" },
    { label: "Portaria", short: "Portaria", icon: DoorOpen, path: "/portaria" },
    { label: "Conversas", short: "Conversas", icon: MessageSquare, path: "/conversas" },
  ],
  cleaner: [
    { label: "Minha agenda", short: "Agenda", icon: CalendarCheck, path: "/agenda" },
  ],
};

export function AppShell({ children }: { children: ReactNode }) {
  const { role, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Admin acompanha o produto pela visão de dono; não tem barra própria ainda.
  const items = NAV[role === "cleaner" ? "cleaner" : "owner"];
  const isActive = (path: string) => location.pathname.startsWith(path);

  return (
    <div className="min-h-screen bg-background">
      {/* Menu lateral — só no desktop */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-border bg-card">
        <div className="px-6 py-6">
          <span className="text-sm font-extrabold tracking-[0.2em] text-primary">HOSPEDEPAY</span>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {items.map((item) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                "w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive(item.path)
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              {item.label}
            </button>
          ))}
        </nav>

        <button
          onClick={signOut}
          className="m-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          Sair
        </button>
      </aside>

      {/* Cabeçalho — só no celular, onde não há menu lateral */}
      <header className="md:hidden sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <span className="text-sm font-extrabold tracking-[0.2em] text-primary">HOSPEDEPAY</span>
        <button
          onClick={signOut}
          aria-label="Sair"
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      {/* pb-24 no celular abre espaço para a barra inferior não cobrir conteúdo */}
      <main className="md:pl-56">
        <div className="mx-auto max-w-3xl px-4 py-5 pb-24 md:py-8 md:pb-8">{children}</div>
      </main>

      {/* Barra inferior — só no celular */}
      {items.length > 1 && (
        <nav
          className="md:hidden fixed inset-x-0 bottom-0 z-20 grid border-t border-border bg-card/95 backdrop-blur"
          style={{
            gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {items.map((item) => {
            const active = isActive(item.path);
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={cn(
                  "flex flex-col items-center gap-1 py-2.5 transition-colors",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <item.icon className={cn("h-5 w-5", active && "stroke-[2.5px]")} />
                <span className="text-[10px] font-medium">{item.short}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
