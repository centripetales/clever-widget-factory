import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { offlineQueryConfig, offlineMutationConfig } from "@/lib/queryConfig";
import { queryCachePersister, QUERY_CACHE_MAX_AGE } from "@/lib/queryPersistAdapter";
import { setQueryClient } from "@/lib/apiService";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { AuthProvider, useAuth } from "@/hooks/useCognitoAuth";
import { OrganizationProvider } from "@/hooks/useOrganization";
import { AppSettingsProvider } from "@/hooks/useAppSettings";
import { useSessionMonitor } from "@/hooks/useSessionMonitor";
import { useCacheInvalidation } from "@/hooks/useCacheInvalidation";
import { TokenRefreshIndicator } from "@/components/TokenRefreshIndicator";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminRoute from "@/components/AdminRoute";
import LeadershipRoute from "@/components/LeadershipRoute";
import SuperAdminRoute from "@/components/SuperAdminRoute";
import { GlobalMaxwellFAB } from "@/components/GlobalMaxwellFAB";
import { MaxwellRecordHighlightProvider } from "@/contexts/MaxwellRecordHighlightContext";
import { useTenantContext } from "@/lib/tenant";
import { PlatformLayout } from "@/components/platform/PlatformLayout";
import PlatformHome from "@/pages/platform/Home";
import PlatformAbout from "@/pages/platform/About";
import PlatformContact from "@/pages/platform/Contact";


import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";


import InventorySummary from "./pages/InventorySummary";
import CombinedAssets from "./pages/CombinedAssets";
import AddObservation from "./pages/AddObservation";
import Missions from "./pages/Missions";
import EditMission from "./pages/EditMission";
import Actions from "./pages/Actions";
import ActionPage from "./pages/ActionPage";
import Explorations from "./pages/Explorations";
import Audit from "./pages/Audit";
import AuditTool from "./pages/AuditTool";
import ScoringPrompts from "./pages/ScoringPrompts";
import Organization from "./pages/Organization";
import AdminOrganizations from "./pages/AdminOrganizations";
import NotFound from "./pages/NotFound";
import AnalyticsDashboard from "./pages/AnalyticsDashboard";
import AcceptInvite from "./pages/AcceptInvite";
import SettingsPage from "./pages/Settings";
import UploadDebug from "./pages/UploadDebug";
import UploadMobileTest from "./pages/UploadMobileTest";
import SariSariChat from "./pages/SariSariChat";
import StateSpacePage from "./pages/StateSpacePage";
import RecordFinancialRecord from "./pages/RecordFinancialRecord";
import FinancialRecordDetail from "./pages/FinancialRecordDetail";
import Finances from "./pages/Finances";
import QuizPage from "./pages/QuizPage";
import UserProfile from "./pages/UserProfile";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      ...offlineQueryConfig,
      retry: (failureCount, error) => {
        // Don't retry on 4xx errors, but retry on network errors
        if (error instanceof Error && error.message.includes('fetch')) {
          return failureCount < 3;
        }
        return false;
      },
    },
    mutations: {
      ...offlineMutationConfig,
      retry: (failureCount, error) => {
        // Retry mutations on network errors only
        if (error instanceof Error && error.message.includes('fetch')) {
          return failureCount < 3;
        }
        return false;
      },
    },
  },
});

// Initialize apiService with query client for automatic cache updates
setQueryClient(queryClient);

function AppContent() {
  useSessionMonitor();
  useCacheInvalidation(); // Subscribe to real-time cache invalidation via WebSocket
  const { user } = useAuth();
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    // Mark as hydrated after first render to prevent flash
    setIsHydrated(true);
  }, []);

  return (
    <div style={{ opacity: isHydrated ? 1 : 0, transition: 'opacity 0.1s' }}>
      <TokenRefreshIndicator />
      {user && (
        <div className="fixed bottom-4 left-4 z-50 rounded-full bg-background/80 backdrop-blur-sm border px-2.5 py-1.5 shadow-sm">
          <ConnectionStatusIndicator />
        </div>
      )}
      <MaxwellRecordHighlightProvider>
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/welcome"
          element={
            <ProtectedRoute>
              <Index />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tools"
          element={<Navigate to="/combined-assets" replace />}
        />
        <Route
          path="/tools/:toolId/edit"
          element={<Navigate to="/combined-assets" replace />}
        />
        <Route
          path="/combined-assets"
          element={
            <ProtectedRoute>
              <CombinedAssets />
            </ProtectedRoute>
          }
        />
        <Route
          path="/combined-assets/:assetType/:id/observation"
          element={
            <ProtectedRoute>
              <AddObservation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/combined-assets/:entityType/:entityId/state-space"
          element={
            <ProtectedRoute>
              <StateSpacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/observations/edit/:observationId"
          element={
            <ProtectedRoute>
              <AddObservation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/inventory"
          element={<Navigate to="/combined-assets?view=stock" replace />}
        />
        <Route
          path="/inventory/summary"
          element={
            <ProtectedRoute>
              <InventorySummary />
            </ProtectedRoute>
          }
        />
        <Route
          path="/missions"
          element={
            <ProtectedRoute>
              <Missions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/missions/:missionId/edit"
          element={
            <ProtectedRoute>
              <EditMission />
            </ProtectedRoute>
          }
        />
        <Route
          path="/actions"
          element={
            <ProtectedRoute>
              <Actions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/actions/new"
          element={
            <ProtectedRoute>
              <ActionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/actions/:actionId"
          element={
            <ProtectedRoute>
              <ActionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/explorations"
          element={
            <ProtectedRoute>
              <Explorations />
            </ProtectedRoute>
          }
        />
        <Route
          path="/issues"
          element={<Navigate to="/combined-assets" replace />}
        />
        <Route
          path="/audit"
          element={
            <ProtectedRoute>
              <Audit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/audit/tool/:toolId"
          element={
            <ProtectedRoute>
              <AuditTool />
            </ProtectedRoute>
          }
        />
        <Route
          path="/prompts"
          element={
            <ProtectedRoute>
              <ScoringPrompts />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/analytics"
          element={
            <LeadershipRoute>
              <AnalyticsDashboard />
            </LeadershipRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/organization"
          element={
            <LeadershipRoute>
              <Organization />
            </LeadershipRoute>
          }
        />
        <Route
          path="/organization/:organizationId"
          element={
            <LeadershipRoute>
              <Organization />
            </LeadershipRoute>
          }
        />
        <Route
          path="/admin/organizations"
          element={
            <SuperAdminRoute>
              <AdminOrganizations />
            </SuperAdminRoute>
          }
        />
        <Route
          path="/debug/upload"
          element={
            <ProtectedRoute>
              <UploadDebug />
            </ProtectedRoute>
          }
        />
        <Route
          path="/debug/upload-mobile-test"
          element={
            <ProtectedRoute>
              <UploadMobileTest />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sari-sari-chat"
          element={
            <ProtectedRoute>
              <SariSariChat />
            </ProtectedRoute>
          }
        />
        <Route
          path="/actions/:actionId/state-space"
          element={
            <ProtectedRoute>
              <StateSpacePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/finances"
          element={
            <ProtectedRoute>
              <Finances />
            </ProtectedRoute>
          }
        />
        <Route
          path="/financial-records/new"
          element={
            <ProtectedRoute>
              <RecordFinancialRecord />
            </ProtectedRoute>
          }
        />
        <Route
          path="/financial-records/:id"
          element={
            <ProtectedRoute>
              <FinancialRecordDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/actions/:actionId/quiz/:axisKey"
          element={
            <ProtectedRoute>
              <QuizPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/user/:userId"
          element={
            <ProtectedRoute>
              <UserProfile />
            </ProtectedRoute>
          }
        />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
      <GlobalMaxwellFAB />
      </MaxwellRecordHighlightProvider>
    </div>
  );
}

/**
 * Platform routes — rendered when useTenantContext() returns type === 'platform'.
 * These routes are public (no auth required) and use PlatformLayout.
 * Task 4.1: parallel branch to existing org routes.
 */
function PlatformRoutes() {
  return (
    <PlatformLayout>
      <Routes>
        <Route path="/" element={<PlatformHome />} />
        <Route path="/about" element={<PlatformAbout />} />
        <Route path="/contact" element={<PlatformContact />} />
        <Route path="*" element={<PlatformHome />} />
      </Routes>
    </PlatformLayout>
  );
}

/**
 * TenantRouter — reads tenant context once at mount and selects the appropriate
 * routing tree.
 *
 * Task 4.2: when type === 'platform', render platform routes.
 *           Otherwise, render existing org routes unchanged (Task 4.3).
 */
function TenantRouter() {
  const tenantContext = useTenantContext();

  if (tenantContext.type === 'platform') {
    return <PlatformRoutes />;
  }

  // Org context: render existing app routes completely unchanged.
  return <AppContent />;
}

const App = () => (
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{
      persister: queryCachePersister,
      maxAge: QUERY_CACHE_MAX_AGE,
    }}
  >
    <AuthProvider>
      <OrganizationProvider>
        <AppSettingsProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter basename={import.meta.env.VITE_BASE_PATH || "/"}>
              <TenantRouter />
            </BrowserRouter>
          </TooltipProvider>
        </AppSettingsProvider>
      </OrganizationProvider>
    </AuthProvider>
  </PersistQueryClientProvider>
);

export default App;