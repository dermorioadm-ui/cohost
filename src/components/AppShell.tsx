import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BadgeCheck, CalendarDays, CalendarCheck, CreditCard, DoorOpen, FileText, Home, LayoutDashboard,
  LogOut, MessageSquare, MoreHorizontal, Sparkles, Target, Users, Wallet, X,
} from "lucide-react";
import { useAuth, type AppRole } from "@/hooks/useAuth";
import { Marca } from "@/components/Marca";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Casca do app: a pílula flutuante da página de vendas, agora com navegação.
 *
 * A página abre com uma pílula branca flutuando sobre o herói preto — marca à
 * esquerda, um estado à direita, sombra longa, cantos de 52px. O painel repete
 * exatamente esse objeto sobre o mesmo preto, porque é ele que diz "você
 * continua no mesmo lugar" para quem acabou de assinar. Por isso as cores de
 * dentro da pílula são literais: ela é branca mesmo com o app escuro. No desktop os itens de navegação moram dentro da pílula: o
 * ativo abre em pílula preta com o nome, os outros ficam só no ícone, com o
 * nome no hover. No celular a pílula de cima guarda a marca e a saída, e a
 * navegação vai para um dock branco, também flutuante, no rodapé.
 *
 * A barra some nas telas de trilho (onboarding) e nas públicas (chat do
 * hóspede, aceite da diarista), onde navegação lateral só atrapalharia.
 */

type NavItem = { label: string; short: string; icon: typeof CalendarDays; path: string };

const NAV: Record<AppRole, NavItem[]> = {
  // O admin tem barra própria. Cinco itens é o teto do Material para barra
  // inferior, e é exatamente o que cabe: mais do que isso no celular vira
  // coluna estreita demais para o dedo.
  admin: [
    { label: "Visão geral", short: "Geral", icon: LayoutDashboard, path: "/admin" },
    // O Pipeline entrou no lugar do Sistema. Sistema se olha quando algo
    // quebra; Pipeline é a fila de trabalho que a equipe abre toda manhã.
    // Sistema continua a um clique, pelo cartão de saúde na visão geral.
    { label: "Pipeline", short: "Vendas", icon: Target, path: "/admin/pipeline" },
    { label: "Financeiro", short: "Caixa", icon: Wallet, path: "/admin/financeiro" },
    { label: "Assinantes", short: "Clientes", icon: Users, path: "/admin/assinantes" },
    { label: "Diaristas", short: "Limpeza", icon: Sparkles, path: "/admin/diaristas" },
  ],
  owner: [
    // `short` encolhe no celular: o dock é um grid de colunas iguais, e com
    // sete itens um rótulo longo estoura a coluna em tela de 375px.
    { label: "Painel", short: "Painel", icon: CalendarCheck, path: "/painel" },
    { label: "Calendário", short: "Datas", icon: CalendarDays, path: "/calendario" },
    { label: "Imóveis", short: "Imóveis", icon: Home, path: "/imoveis" },
    { label: "Clientes", short: "Clientes", icon: Users, path: "/clientes" },
    { label: "Portaria", short: "Portaria", icon: DoorOpen, path: "/portaria" },
    { label: "Conversas", short: "Chat", icon: MessageSquare, path: "/conversas" },
    { label: "Financeiro", short: "Contas", icon: Wallet, path: "/financeiro" },
    { label: "Faturas da limpeza", short: "Faturas", icon: FileText, path: "/faturas" },
    // Fica por último de propósito: assinatura se olha uma vez por mês, e o
    // caminho até ela era só um link no fim da tela de Financeiro.
    { label: "Meu plano", short: "Plano", icon: CreditCard, path: "/plano" },
  ],
  // A diarista: o dia (agenda), o mês (calendário), o que ela precisa
  // responder (aprovações) e quanto ela recebe (ganhos). A ordem é a do uso.
  cleaner: [
    { label: "Minha agenda", short: "Agenda", icon: CalendarCheck, path: "/agenda" },
    { label: "Calendário", short: "Datas", icon: CalendarDays, path: "/calendario" },
    { label: "Aprovações", short: "Aprovar", icon: BadgeCheck, path: "/aprovacoes" },
    { label: "Ganhos", short: "Ganhos", icon: Wallet, path: "/ganhos" },
    { label: "Faturas", short: "Faturas", icon: FileText, path: "/faturas" },
  ],
};

/**
 * Teto do dock no celular. Cinco é o limite físico: abaixo disso a coluna fica
 * estreita demais para o dedo. Acima do teto, os quatro primeiros ficam no
 * dock e o resto vai para "Mais"; a ordem do array é a ordem de prioridade.
 */
const MAX_BARRA = 5;

const CASA: Record<AppRole, string> = { admin: "/admin", cleaner: "/agenda", owner: "/painel" };
// No celular a pílula divide 340px entre marca, seletor e saída: os nomes
// curtos existem para o seletor caber sem cortar o botão de sair.
const NOME_PAPEL: Record<AppRole, { longo: string; curto: string }> = {
  admin: { longo: "Plataforma", curto: "Admin" },
  cleaner: { longo: "Limpeza", curto: "Limpeza" },
  owner: { longo: "Meus imóveis", curto: "Imóveis" },
};

export function AppShell({ children }: { children: ReactNode }) {
  const { role, roles, switchRole, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const items = NAV[role ?? "owner"];
  const [maisAberto, setMaisAberto] = useState(false);

  const naBarra = items.length <= MAX_BARRA ? items : items.slice(0, MAX_BARRA - 1);
  const emMais = items.length <= MAX_BARRA ? [] : items.slice(MAX_BARRA - 1);

  // Fecha a folha ao trocar de tela. Sem isto ela continuaria aberta por cima
  // da página nova, tapando justamente o que a pessoa acabou de escolher.
  useEffect(() => setMaisAberto(false), [location.pathname]);

  // Telas sem item próprio herdam o realce do item que leva até elas. Sem isto
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
    // de onde a pessoa veio, então nenhum acende.
    if (atual.startsWith("/admin/conta/")) return false;
    return path === "/admin" ? atual === "/admin" : atual.startsWith(path);
  };

  // Quem tem mais de um papel troca por um seletor em pílula: o ativo em
  // tinta, os outros em cinza. É o mesmo desenho das opções do formulário da
  // página ("1", "2 ou 3", "sim", "não").
  const alternador = roles.length > 1 && (
    <div
      role="group"
      aria-label="Alternar painel"
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-[#f0f0f0] p-1 sm:gap-1"
    >
      {roles.map((r) => (
        <button
          key={r}
          onClick={() => {
            switchRole(r);
            // Trocar de papel sem mudar de tela deixaria o admin olhando uma
            // rota que o papel novo não alcança. Cada papel entra na sua casa.
            navigate(CASA[r]);
          }}
          aria-pressed={role === r}
          className={cn(
            "h-8 rounded-full px-2.5 text-[12px] font-medium leading-none tracking-corpo transition-colors sm:px-3",
            role === r ? "bg-black text-white" : "text-[#8f8f8f] hover:text-black",
          )}
        >
          <span className="hidden sm:inline">{NOME_PAPEL[r].longo}</span>
          <span className="sm:hidden">{NOME_PAPEL[r].curto}</span>
        </button>
      ))}
    </div>
  );

  const largura = role === "admin" ? "max-w-6xl" : "max-w-3xl";

  return (
    <div className="min-h-screen bg-background">
      {/* A pílula de cima. Fixa, centrada, na largura da coluna de conteúdo. */}
      <header className="fixed inset-x-3 top-3 z-30 flex justify-center">
        <div
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-[52px] bg-white py-2 pl-4 pr-2 shadow-pill",
            largura,
          )}
        >
          <button
            type="button"
            onClick={() => navigate(CASA[role ?? "owner"])}
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Início"
          >
            {/* No celular, com o seletor de papel ao lado, só o símbolo cabe. */}
            <Marca size={32} className={cn(roles.length > 1 && "hidden sm:inline-flex")} />
            {roles.length > 1 && <Marca size={32} semNome className="sm:hidden" />}
          </button>

          {/* Itens de navegação — só no desktop, dentro da pílula. */}
          {items.length > 1 && (
            <nav className="hidden min-w-0 items-center gap-1 md:flex" aria-label="Principal">
              {items.map((item) => {
                const active = isActive(item.path);
                return (
                  <Tooltip key={item.path} delayDuration={200}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => navigate(item.path)}
                        aria-current={active ? "page" : undefined}
                        aria-label={item.label}
                        className={cn(
                          "flex h-10 items-center gap-2 rounded-full transition-[background-color,color,padding] duration-200 ease-page",
                          active
                            ? "bg-black px-4 text-white"
                            : "w-10 justify-center text-[#8f8f8f] hover:bg-[#f0f0f0] hover:text-black",
                        )}
                      >
                        <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2.25 : 1.75} />
                        {active && (
                          <span className="whitespace-nowrap text-[13px] font-medium tracking-corpo">
                            {item.label}
                          </span>
                        )}
                      </button>
                    </TooltipTrigger>
                    {!active && (
                      <TooltipContent side="bottom" sideOffset={8}>
                        {item.label}
                      </TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
            </nav>
          )}

          <div className="flex shrink-0 items-center gap-1.5">
            {alternador}
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  onClick={signOut}
                  aria-label="Sair"
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[#f0f0f0] text-[#8f8f8f] transition-colors hover:border-black hover:text-black"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                Sair
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      {/* pt abre espaço para a pílula; pb no celular, para o dock. */}
      <main>
        <div className={cn("mx-auto px-4 pb-32 pt-[88px] md:pb-12 md:pt-24", largura)}>
          {children}
        </div>
      </main>

      {/* Folha do "Mais" — sobe de baixo, por cima do dock, com o raio e a
          sombra da folha de formulário da página. O fundo escurecido devolve
          o toque de fechar em qualquer lugar da tela. */}
      {maisAberto && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Fechar"
            onClick={() => setMaisAberto(false)}
            className="absolute inset-0 bg-black/70"
          />

          <div
            className="absolute inset-x-0 bottom-0 rounded-t-[28px] bg-white p-4 shadow-sheet animate-in slide-in-from-bottom-4 fade-in-0 duration-300"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="rotulo">Mais</span>
              <button
                type="button"
                onClick={() => setMaisAberto(false)}
                aria-label="Fechar"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f0f0f0] text-black hover:bg-[#e6e6e6]"
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
                    "flex min-h-[52px] w-full items-center gap-3 rounded-2xl px-3 text-[15px] tracking-corpo transition-colors",
                    active ? "bg-black text-white" : "text-black hover:bg-[#f0f0f0]",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" strokeWidth={1.75} />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Dock inferior — só no celular. Flutua como a pílula de cima. */}
      {items.length > 1 && (
        <nav
          aria-label="Principal"
          className="fixed inset-x-3 z-30 md:hidden"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        >
          <div
            className="grid rounded-[30px] bg-white px-1 py-1 shadow-pill"
            style={{
              gridTemplateColumns: `repeat(${naBarra.length + (emMais.length ? 1 : 0)}, minmax(0, 1fr))`,
            }}
          >
            {naBarra.map((item) => {
              const active = isActive(item.path);
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1 rounded-[24px] py-2 transition-colors",
                    active ? "bg-black text-white" : "text-[#8f8f8f]",
                  )}
                >
                  <item.icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
                  <span className="truncate px-1 text-[10px] font-medium tracking-corpo">{item.short}</span>
                </button>
              );
            })}

            {emMais.length > 0 && (
              <button
                onClick={() => setMaisAberto((v) => !v)}
                aria-expanded={maisAberto}
                className={cn(
                  "flex min-w-0 flex-col items-center gap-1 rounded-[24px] py-2 transition-colors",
                  // Aceso também quando a tela atual mora dentro do "Mais".
                  maisAberto || emMais.some((i) => isActive(i.path))
                    ? "bg-black text-white"
                    : "text-[#8f8f8f]",
                )}
              >
                <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} />
                <span className="text-[10px] font-medium tracking-corpo">Mais</span>
              </button>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
