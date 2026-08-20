import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth, type AppRole } from "@/hooks/useAuth";
import { AppShell } from "@/components/AppShell";

const Auth = lazy(() => import("@/pages/Auth"));
const NovaSenha = lazy(() => import("@/pages/NovaSenha"));
const Confirmar = lazy(() => import("@/pages/Confirmar"));
const Landing = lazy(() => import("@/pages/Landing"));
const Onboarding = lazy(() => import("@/pages/Onboarding"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Calendario = lazy(() => import("@/pages/Calendario"));
const Imoveis = lazy(() => import("@/pages/Imoveis"));
const Imovel = lazy(() => import("@/pages/Imovel"));
const Portaria = lazy(() => import("@/pages/Portaria"));
const Conversas = lazy(() => import("@/pages/Conversas"));
const GuestChat = lazy(() => import("@/pages/GuestChat"));
const CleanerAccept = lazy(() => import("@/pages/CleanerAccept"));
const CleanerAgenda = lazy(() => import("@/pages/CleanerAgenda"));
const CleanerAprovacoes = lazy(() => import("@/pages/CleanerAprovacoes"));
const CleanerGanhos = lazy(() => import("@/pages/CleanerGanhos"));
const Financeiro = lazy(() => import("@/pages/Financeiro"));
const Hospedes = lazy(() => import("@/pages/Hospedes"));
const Plano = lazy(() => import("@/pages/Plano"));
const AdminVisaoGeral = lazy(() => import("@/pages/AdminVisaoGeral"));
const AdminFinanceiro = lazy(() => import("@/pages/AdminFinanceiro"));
const AdminDiaristas = lazy(() => import("@/pages/AdminDiaristas"));
const AdminAssinantes = lazy(() => import("@/pages/AdminAssinantes"));
const AdminSistema = lazy(() => import("@/pages/AdminSistema"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const Splash = () => (
  <div className="min-h-screen flex items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
);

/**
 * `shell` desligado só no onboarding: ali a tela é um trilho de uma saída só, e
 * uma barra de navegação convida a sair no meio do cadastro.
 */
function Protected({
  children,
  allow,
  shell = true,
}: {
  children: ReactNode;
  allow: AppRole[];
  shell?: boolean;
}) {
  const { user, role, loading } = useAuth();

  if (loading) return <Splash />;
  if (!user) return <Navigate to="/entrar" replace />;

  // Sem papel ainda (cadastro interrompido): manda concluir o onboarding.
  if (!role) return <Navigate to="/comecar" replace />;

  if (!allow.includes(role) && role !== "admin") {
    return <Navigate to={role === "cleaner" ? "/agenda" : "/painel"} replace />;
  }
  return shell ? <AppShell>{children}</AppShell> : <>{children}</>;
}

/**
 * Manda cada papel para a sua casa; visitante vê a página de vendas.
 *
 * Antes o visitante caía direto no formulário de cadastro — o que só funciona
 * para quem já foi convencido em outro lugar. Quem chega de anúncio ou de
 * indicação precisa primeiro saber o que é e quanto custa.
 */
function Home() {
  const { user, role, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Landing />;
  // Cada papel entra na sua casa. Sem o caso do admin aqui, quem alternasse
  // para "Plataforma" e clicasse no logo voltaria para o painel de host.
  return (
    <Navigate
      to={role === "admin" ? "/admin" : role === "cleaner" ? "/agenda" : "/painel"}
      replace
    />
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster position="top-center" richColors />
        <BrowserRouter>
          <Suspense fallback={<Splash />}>
            <Routes>
              {/* Públicas — fora do AuthProvider, carregam na hora */}
              <Route path="/c/:slug" element={<GuestChat />} />
              <Route path="/d/:token" element={<CleanerAccept />} />
              {/* Fora do AuthProvider: quem chega aqui está trocando a senha a
                  partir de um link, sem sessão de verdade ainda. O provider
                  redirecionaria para o login antes de a troca acontecer. */}
              <Route path="/nova-senha" element={<NovaSenha />} />
              <Route path="/confirmar" element={<Confirmar />} />

              <Route
                path="/*"
                element={
                  <AuthProvider>
                    <Routes>
                      <Route path="/" element={<Home />} />
                      <Route path="/entrar" element={<Auth />} />

                      <Route
                        path="/comecar"
                        element={
                          <Protected allow={["owner"]} shell={false}>
                            <Onboarding />
                          </Protected>
                        }
                      />
                      <Route
                        path="/painel"
                        element={
                          <Protected allow={["owner"]}>
                            <Dashboard />
                          </Protected>
                        }
                      />
                      {/* A mesma grade serve os dois papéis: a diarista vê o
                          mês dos imóveis dela, sem quem é o hóspede. Quem filtra
                          é a própria tela, pelas funções de leitura da 0035. */}
                      <Route
                        path="/calendario"
                        element={
                          <Protected allow={["owner", "cleaner"]}>
                            <Calendario />
                          </Protected>
                        }
                      />
                      <Route
                        path="/imoveis"
                        element={
                          <Protected allow={["owner"]}>
                            <Imoveis />
                          </Protected>
                        }
                      />
                      <Route
                        path="/imoveis/:id"
                        element={
                          <Protected allow={["owner"]}>
                            <Imovel />
                          </Protected>
                        }
                      />
                      <Route
                        path="/portaria"
                        element={
                          <Protected allow={["owner"]}>
                            <Portaria />
                          </Protected>
                        }
                      />
                      <Route
                        path="/conversas"
                        element={
                          <Protected allow={["owner"]}>
                            <Conversas />
                          </Protected>
                        }
                      />
                      <Route
                        path="/financeiro"
                        element={
                          <Protected allow={["owner"]}>
                            <Financeiro />
                          </Protected>
                        }
                      />
                      <Route
                        path="/clientes"
                        element={
                          <Protected allow={["owner"]}>
                            <Hospedes />
                          </Protected>
                        }
                      />
                      <Route
                        path="/plano"
                        element={
                          <Protected allow={["owner"]}>
                            <Plano />
                          </Protected>
                        }
                      />
                      <Route
                        path="/agenda"
                        element={
                          <Protected allow={["cleaner"]}>
                            <CleanerAgenda />
                          </Protected>
                        }
                      />
                      <Route
                        path="/aprovacoes"
                        element={
                          <Protected allow={["cleaner"]}>
                            <CleanerAprovacoes />
                          </Protected>
                        }
                      />
                      <Route
                        path="/ganhos"
                        element={
                          <Protected allow={["cleaner"]}>
                            <CleanerGanhos />
                          </Protected>
                        }
                      />

                      {/* Administração. `allow={["admin"]}` é conforto de
                          navegação: quem digitar a rota sem ser admin recebe
                          erro do Postgres, porque toda leitura passa por
                          assert_admin() no banco. */}
                      <Route
                        path="/admin"
                        element={
                          <Protected allow={["admin"]}>
                            <AdminVisaoGeral />
                          </Protected>
                        }
                      />
                      <Route
                        path="/admin/financeiro"
                        element={
                          <Protected allow={["admin"]}>
                            <AdminFinanceiro />
                          </Protected>
                        }
                      />
                      <Route
                        path="/admin/assinantes"
                        element={
                          <Protected allow={["admin"]}>
                            <AdminAssinantes />
                          </Protected>
                        }
                      />
                      <Route
                        path="/admin/sistema"
                        element={
                          <Protected allow={["admin"]}>
                            <AdminSistema />
                          </Protected>
                        }
                      />
                      <Route
                        path="/admin/diaristas"
                        element={
                          <Protected allow={["admin"]}>
                            <AdminDiaristas />
                          </Protected>
                        }
                      />

                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </AuthProvider>
                }
              />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
