import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

// Critical pages - loaded immediately
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";

// Lazy loaded pages - loaded on demand
const Setup = lazy(() => import("./pages/Setup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Settings = lazy(() => import("./pages/Settings"));
const SuperAdminDashboard = lazy(() => import("./pages/SuperAdminDashboard"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const Analytics = lazy(() => import("./pages/Analytics"));
const Attendance = lazy(() => import("./pages/Attendance"));
const Broadcasts = lazy(() => import("./pages/Broadcasts"));
const Automations = lazy(() => import("./pages/Automations"));
const FlowBuilderPage = lazy(() => import("./pages/FlowBuilderPage"));
// Painel oculto de operação: sem link na navegação, só pela URL
const Ops = lazy(() => import("./pages/Ops"));

import { ProtectedRoute } from "./components/ProtectedRoute";
import { OrganizationProvider } from "./contexts/OrganizationContext";
import { NotificationProvider } from "./contexts/NotificationContext";
import { VoiceCallProvider } from "./contexts/VoiceCallContext";
import VoiceCallHost from "./components/call/VoiceCallHost";
import { GlobalNotificationListener } from "./components/GlobalNotificationListener";
import { RouteSkeleton } from "./components/RouteSkeleton";
import { OfflineBanner } from "./components/OfflineBanner";
import { ReconnectingBanner } from "./components/ReconnectingBanner";
import { ChunkErrorBoundary } from "./components/ChunkErrorBoundary";
import { useTabNotification } from "./hooks/useTabNotification";
import { useLocalTheme } from "@/hooks/useLocalTheme";
import { useAccessibilityPrefs, useForcedReducedMotion } from "@/hooks/useAccessibilityPrefs";
import { supabase } from "@/integrations/supabase/client";

const TabNotificationMount = () => {
  useTabNotification();
  return null;
};

const UserThemeMount = () => {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useLocalTheme(userId);
  useAccessibilityPrefs(userId);
  return null;
};

// "Reduzir animações" das preferências força o framer-motion a parar mesmo sem
// o pedido do sistema ("user" já cobre o pedido do sistema).
const AppMotionConfig = ({ children }: { children: ReactNode }) => {
  const forced = useForcedReducedMotion();
  return <MotionConfig reducedMotion={forced ? "always" : "user"}>{children}</MotionConfig>;
};

// Fallback do ChunkErrorBoundary (chunk falhou e vai recarregar): spinner
// genérico serve — não há rota "carregando", há recuperação de erro.
const PageLoader = () => (
  <div className="min-h-dvh flex items-center justify-center bg-background">
    <Loader2 className="w-8 h-8 animate-spin text-primary" />
  </div>
);

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AppMotionConfig>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <OfflineBanner />
      <ReconnectingBanner />
      <BrowserRouter>
        <NotificationProvider>
          <GlobalNotificationListener />
          <TabNotificationMount />
          <UserThemeMount />
          {/* Ligação de voz: provider e card acima das rotas de propósito — quem
              está em ligação pode navegar sem que a ligação caia. */}
          <VoiceCallProvider>
          <VoiceCallHost />
          <OrganizationProvider>
            <ChunkErrorBoundary fallback={<PageLoader />}>
              <Suspense fallback={<RouteSkeleton />}>
                <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/auth" element={<Auth />} />
                {/* Primeiro acesso: pública, só funciona enquanto a instalação não tem administrador. */}
                <Route path="/setup" element={<Setup />} />
                <Route element={<ProtectedRoute />}>
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/dashboard/:conversationId" element={<Dashboard />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/analytics" element={<Analytics />} />
                  <Route path="/atendimentos" element={<Attendance />} />
                  <Route path="/broadcasts" element={<Broadcasts />} />
                  <Route path="/automations" element={<Automations />} />
                  <Route path="/automations/:id" element={<FlowBuilderPage />} />
                  <Route path="/super-admin" element={<SuperAdminDashboard />} />
                  <Route path="/ops" element={<Ops />} />
                </Route>
                {/* Doc pública, fora do ProtectedRoute. Cada endpoint tem URL
                    própria (/api-docs/:slug) para poder ser linkado e sobreviver
                    a um F5 — antes a navegação vivia só em useState. */}
                <Route path="/api-docs" element={<Navigate to="/api-docs/auth" replace />} />
                <Route path="/api-docs/:slug" element={<ApiDocs />} />
                <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </ChunkErrorBoundary>
          </OrganizationProvider>
          </VoiceCallProvider>
        </NotificationProvider>
      </BrowserRouter>
    </TooltipProvider>
    </AppMotionConfig>
  </QueryClientProvider>
);

export default App;
