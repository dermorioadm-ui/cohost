import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth, type AppRole } from "@/hooks/useAuth";
import { AppShell } from "@/components/AppShell";

const Auth = lazy(() => import("@/pages/Auth"));
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

/** Manda cada papel para a sua casa; visitante vai para o cadastro. */
function Home() {
  const { user, role, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Navigate to="/entrar?modo=cadastro" replace />;
  return <Navigate to={role === "cleaner" ? "/agenda" : "/painel"} replace />;
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
                      <Route
                        path="/calendario"
                        element={
                          <Protected allow={["owner"]}>
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
                        path="/agenda"
                        element={
                          <Protected allow={["cleaner"]}>
                            <CleanerAgenda />
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
