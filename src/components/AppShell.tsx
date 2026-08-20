import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BadgeCheck, CalendarDays, CalendarCheck, DoorOpen, FileText, Home, LayoutDashboard,
  LogOut, MessageSquare, MoreHorizontal, Sparkles, Target, Users, Wallet, X,
} from "lucide-react";
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

const NAV: Record<AppRole, NavItem[]> = {
  // O admin tem barra própria desde agora. Antes ele "acompanhava o produto
  // pela visão de dono", o que na prática significava não ter para onde ir:
  // o backend do painel existia desde a 0013 e nenhuma rota levava a ele.
  //
  // Cinco itens é o teto do Material para barra inferior, e é exatamente o que
  // cabe: mais do que isso no celular vira coluna estreita demais para o dedo.
  admin: [
    { label: "Visão geral", short: "Geral", icon: LayoutDashboard, path: "/admin" },
    // O Pipeline entrou no lugar do Sistema. Sistema se olha quando algo
    // quebra; Pipeline é a fila de trabalho que a equipe abre toda manhã, e
    // trabalho diário não pode estar dois cliques mais fundo que diagnóstico.
    // Sistema continua a um clique, pelo cartão de saúde na visão geral.
    { label: "Pipeline", short: "Vendas", icon: Target, path: "/admin/pipeline" },
    { label: "Financeiro", short: "Caixa", icon: Wallet, path: "/admin/financeiro" },
    { label: "Assinantes", short: "Clientes", icon: Users, path: "/admin/assinantes" },
    { label: "Diaristas", short: "Limpeza", icon: Sparkles, path: "/admin/diaristas" },
  ],
  owner: [
    // `short` encolhe no celular: a barra é um grid de colunas iguais, e com
    // sete itens um rótulo longo estoura a coluna em tela de 375px.
    { label: "Painel", short: "Painel", icon: CalendarCheck, path: "/painel" },
    { label: "Calendário", short: "Datas", icon: CalendarDays, path: "/calendario" },
    { label: "Imóveis", short: "Imóveis", icon: Home, path: "/imoveis" },
    { label: "Clientes", short: "Clientes", icon: Users, path: "/clientes" },
    { label: "Portaria", short: "Portaria", icon: DoorOpen, path: "/portaria" },
    { label: "Conversas", short: "Chat", icon: MessageSquare, path: "/conversas" },
    { label: "Financeiro", short: "Contas", icon: Wallet, path: "/financeiro" },
    { label: "Faturas da limpeza", short: "Faturas", icon: FileText, path: "/faturas" },
  ],
  // A diarista tinha uma tela só e nenhuma barra. Agora tem quatro: o dia
  // (agenda), o mês (calendário), o que ela precisa responder (aprovações) e
  // quanto ela recebe (ganhos). A ordem é a do uso — o dia primeiro, porque é
  // com o app aberto no corredor do prédio que ela passa quase todo o tempo.
  cleaner: [
    { label: "Minha agenda", short: "Agenda", icon: CalendarCheck, path: "/agenda" },
    { label: "Calendário", short: "Datas", icon: CalendarDays, path: "/calendario" },
    { label: "Aprovações", short: "Aprovar", icon: BadgeCheck, path: "/aprovacoes" },
    { label: "Ganhos", short: "Ganhos", icon: Wallet, path: "/ganhos" },
    { label: "Faturas", short: "Faturas", icon: FileText, path: "/faturas" },
  ],
};

/**
 * Teto da barra inferior no celular.
 *
 * Cinco é o limite do Material, e o motivo é físico: abaixo disso a coluna
 * fica estreita demais para o dedo e o rótulo encolhe até deixar de ser lido.
 * O painel do dono passou de sete itens, e o resultado foi o que se vê no
 * celular — ícones espremidos com texto de 10px que ninguém distingue.
 *
 * Acima do teto, os quatro primeiros ficam na barra e o resto vai para "Mais".
 * A ordem do array é a ordem de prioridade: quem está no fim é quem se abre
 * por um toque a mais.
 */
const MAX_BARRA = 5;

export function AppShell({ children }: { children: ReactNode }) {
  const { role, roles, switchRole, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const items = NAV[role ?? "owner"];
  const [maisAberto, setMaisAberto] = useState(false);

  const naBarra = items.length <= MAX_BARRA ? items : items.slice(0, MAX_BARRA - 1);
  const emMais = items.length <= MAX_BARRA ? [] : items.slice(MAX_BARRA - 1);

  // Fecha o painel ao trocar de tela. Sem isto ele continuaria aberto por cima
  // da página nova, tapando justamente o que a pessoa acabou de escolher.
  useEffect(() => setMaisAberto(false), [location.pathname]);

  // `/admin` casa com `/admin/financeiro` num startsWith. Sem a exatidão aqui,
  // "Visão geral" ficaria aceso em todas as telas do admin ao mesmo tempo.
  //
  // `/admin/portaria` não tem item próprio — cinco é o teto da barra no celular
  // e ela se entra pelo financeiro. Sem este apelido a barra ficaria toda apagada
  // lá dentro, e "não estou em lugar nenhum" é como o usuário lê isso.
  // Telas sem item proprio herdam o realce do item que leva ate elas. Sem isto
  // a barra fica toda apagada lá dentro, e "não estou em lugar nenhum" é como
  // o usuário lê isso.
  const APELIDO: Record<string, string> = {
    "/admin/portaria": "/admin/financeiro",
    "/admin/sistema": "/admin",
  };

  const atual = APELIDO[location.pathname] ?? location.pathname;

  const isActive = (path: string) => {
    // A ficha de uma conta (/admin/conta/<id>) se abre tanto por Assinantes
    // quanto por Diaristas ou Pipeline. Realçar um deles a esmo mentiria sobre
    // de onde a pessoa veio, entao nenhum acende.
    if (atual.startsWith("/admin/conta/")) return false;
    return path === "/admin" ? atual === "/admin" : atual.startsWith(path);
  };

  const alternador = roles.length > 1 && (
    <div
      role="group"
      aria-label="Alternar painel"
      className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-1"
    >
      {roles.map((r) => (
        <button
          key={r}
          onClick={() => {
            switchRole(r);
            // Trocar de papel sem mudar de tela deixaria o admin olhando uma
            // rota que o papel novo não alcança. Cada papel entra na sua casa.
            navigate(r === "admin" ? "/admin" : r === "cleaner" ? "/agenda" : "/painel");
          }}
          aria-pressed={role === r}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
            role === r
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r === "admin" ? "Plataforma" : r === "cleaner" ? "Limpeza" : "Meus imóveis"}
        </button>
      ))}
    </div>
  );

  return (
    // mesh-gradient posiciona os borrões de cor em `fixed`, atrás de tudo. É o
    // que dá o que refratar: vidro sobre fundo chapado não parece vidro.
    <div className="mesh-gradient min-h-screen">
      <div className="mesh-blob-3 animate-blob" aria-hidden />

      {/* Menu lateral — só no desktop */}
      <aside className="glass-sidebar hidden md:flex fixed inset-y-0 left-0 w-56 flex-col">
        <div className="space-y-3 px-6 py-6">
          <span className="block text-sm font-extrabold tracking-[0.2em] text-primary">
            HOSPEDEPAY
          </span>
          {alternador}
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
      <header className="glass-nav md:hidden sticky top-0 z-20 flex items-center justify-between gap-2 px-4 py-3">
        {alternador || (
          <span className="text-sm font-extrabold tracking-[0.2em] text-primary">HOSPEDEPAY</span>
        )}
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
        <div
          className={cn(
            "mx-auto px-4 py-5 pb-24 md:py-8 md:pb-8",
            // O painel do admin é feito de tabelas e séries; 3xl espremeria
            // colunas que precisam ser lidas de relance.
            role === "admin" ? "max-w-6xl" : "max-w-3xl",
          )}
        >
          {children}
        </div>
      </main>

      {/* Painel do "Mais" — sobe de baixo, por cima da barra.
          O fundo escuro não é enfeite: é ele que devolve o toque de fechar em
          qualquer lugar da tela, que é como se sai de uma folha assim no
          celular sem procurar o X. */}
      {maisAberto && (
        <div className="md:hidden fixed inset-0 z-30" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Fechar"
            onClick={() => setMaisAberto(false)}
            className="absolute inset-0 bg-black/60"
          />

          <div
            className="glass-nav absolute inset-x-0 bottom-0 rounded-t-2xl p-3"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
          >
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Mais
              </span>
              <button
                type="button"
                onClick={() => setMaisAberto(false)}
                aria-label="Fechar"
                className="rounded-lg p-2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {emMais.map((item) => {
              const active = isActive(item.path);
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={cn(
                    "flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                    active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-white/[0.05]",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Barra inferior — só no celular */}
      {items.length > 1 && (
        <nav
          className="glass-nav md:hidden fixed inset-x-0 bottom-0 z-20 grid"
          style={{
            gridTemplateColumns: `repeat(${naBarra.length + (emMais.length ? 1 : 0)}, minmax(0, 1fr))`,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {naBarra.map((item) => {
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

          {emMais.length > 0 && (
            <button
              onClick={() => setMaisAberto((v) => !v)}
              aria-expanded={maisAberto}
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 transition-colors",
                // Aceso também quando a tela atual mora dentro do "Mais": sem
                // isso a barra fica toda apagada em Faturas, e "não estou em
                // lugar nenhum" é como o usuário lê isso.
                maisAberto || emMais.some((i) => isActive(i.path))
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
            >
              <MoreHorizontal className="h-5 w-5" />
              <span className="text-[10px] font-medium">Mais</span>
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
