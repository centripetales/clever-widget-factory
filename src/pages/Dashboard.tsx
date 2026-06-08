import { useAuth } from "@/hooks/useCognitoAuth";
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useNavigate } from 'react-router-dom';
import { LogOut, CheckCircle, XCircle, Wrench, Box, Flag, ClipboardCheck, Target, BarChart3, Building2, Settings, Bot, RefreshCw, DollarSign, Search, User, Camera } from 'lucide-react';
import { PrismIcon } from '@/components/icons/PrismIcon';
import { useToast } from '@/hooks/use-toast';
import { DebugModeToggle } from '@/components/DebugModeToggle';
import { useSuperAdmin } from '@/hooks/useSuperAdmin';
import { EditableDisplayName } from '@/components/EditableDisplayName';
import { useOrganization } from '@/hooks/useOrganization';
import { useProfile } from '@/hooks/useProfile';
import { OrganizationSwitcher } from '@/components/OrganizationSwitcher';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useQueryClient } from '@tanstack/react-query';
import { actionsQueryKey } from '@/lib/queryKeys';
import { apiService } from '@/lib/apiService';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { toolsQueryConfig, partsQueryConfig } from '@/lib/assetQueryConfigs';
import { useEffect, useRef } from 'react';

export default function Dashboard() {
  const { user, signOut, isAdmin, isLeadership } = useAuth();
  const { isSuperAdmin } = useSuperAdmin();
  const { organization, loading: orgLoading } = useOrganization();
  const { fullName } = useProfile();
  const firstName = fullName ? fullName.split(' ')[0] : '';

  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Prefetch high-traffic data so it's warm when user navigates
  // Gate on user being available to ensure auth token is ready
  useEffect(() => {
    if (!user) return;
    // Actions (unresolved)
    queryClient.prefetchQuery({
      queryKey: actionsQueryKey(),
      queryFn: async () => {
        const result = await apiService.get('/actions?status=unresolved');
        return result.data || [];
      },
      ...offlineQueryConfig,
    });
    // Tools
    queryClient.prefetchQuery({
      ...toolsQueryConfig,
      ...offlineQueryConfig,
    });
    // Parts
    queryClient.prefetchQuery({
      ...partsQueryConfig,
      ...offlineQueryConfig,
    });
  }, [queryClient, user]);

  const appTitle = organization 
    ? `${organization.name} Asset Tracker`
    : "Asset Tracker";

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: "Error signing out",
        description: error.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Signed out successfully",
        description: "You have been signed out.",
      });
    }
  };

  // Long-press handler for sign out — prevents accidental taps on mobile
  const signOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSignOutPointerDown = () => {
    signOutTimerRef.current = setTimeout(() => {
      handleSignOut();
    }, 500);
  };
  const handleSignOutPointerUp = () => {
    if (signOutTimerRef.current) {
      clearTimeout(signOutTimerRef.current);
      signOutTimerRef.current = null;
    }
  };

  const handleClearCache = async () => {
    // Clear TanStack Query cache
    queryClient.clear();
    
    // Clear API service token cache
    const { clearTokenCache } = await import('@/lib/apiService');
    clearTokenCache();
    
    // Clear IndexedDB persisted cache
    try {
      await indexedDB.deleteDatabase('CWFQueryCache');
    } catch (error) {
      console.warn('Failed to clear IndexedDB cache:', error);
    }
    
    toast({
      title: "Cache cleared",
      description: "All cached data has been cleared. Refreshing...",
    });
    setTimeout(() => window.location.reload(), 500);
  };

  const menuItems = [
    {
      title: "Observations",
      description: "Monitor, search, and record farm observations",
      icon: Camera,
      path: "/observations",
      color: "bg-teal-600"
    },
    {
      title: "Assets",
      description: "Unified view of assets and stock",
      icon: Box,
      path: "/combined-assets",
      color: "bg-green-500"
    },
    {
      title: "Actions",
      description: "Track and manage policy actions",
      icon: Target,
      path: "/actions",
      color: "bg-yellow-500"
    },
    {
      title: "Stargazer Projects",
      description: "Manage objectives and track progress",
      icon: Flag,
      path: "/missions",
      color: "bg-blue-500"
    },
    {
      title: "Sari Sari Store",
      description: "Chat with AI assistant for farm produce",
      icon: Bot,
      path: "/sari-sari-chat",
      color: "bg-orange-500"
    },
    {
      title: "Expenses",
      description: "Track petty cash and expenses",
      icon: DollarSign,
      path: "/finances",
      color: "bg-emerald-600"
    },
    {
      title: "Analytics",
      description: "View strategic attributes analytics",
      icon: BarChart3,
      path: "/dashboard/analytics",
      color: "bg-indigo-500"
    },
    {
      title: firstName || "My Profile",
      description: "View and manage your areas of focus",
      icon: User,
      path: `/user/${user?.userId}`,
      color: "bg-purple-500"
    },
    {
      title: "Organization Settings",
      description: "Manage organization members and settings",
      icon: Settings,
      path: "/organization",
      color: "bg-teal-500"
    },
    {
      title: "Organizations",
      description: "Manage all organizations (Super Admin)",
      icon: Building2,
      path: "/admin/organizations",
      color: "bg-emerald-500"
    }
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
          <h1 className="text-2xl font-bold truncate">{appTitle}</h1>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={() => window.dispatchEvent(new Event('open-maxwell'))} variant="outline" size="sm" className="gap-2">
                  <PrismIcon size={18} />
                  <span className="hidden sm:inline">Maxwell</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Ask Maxwell — unified search across all entities</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={handleClearCache} variant="outline" size="sm" className="p-2">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Clear Cache</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={() => navigate('/settings')} variant="outline" size="sm" className="p-2">
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Settings</p>
              </TooltipContent>
            </Tooltip>
            <DebugModeToggle />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onPointerDown={handleSignOutPointerDown}
                  onPointerUp={handleSignOutPointerUp}
                  onPointerLeave={handleSignOutPointerUp}
                  onClick={(e) => e.preventDefault()}
                  variant="outline"
                  size="sm"
                  className="p-2"
                  aria-label="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Hold to sign out</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Second row: name + org switcher — full width on mobile */}
        <div className="flex items-center gap-2 px-4 pb-3">
          <EditableDisplayName />
          <OrganizationSwitcher />
        </div>
      </header>

      {/* Main Content */}
      <main className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {menuItems.filter(item => {
            // Show items based on permissions, but show all basic items while permissions load
            const shouldShow = (() => {
              if (item.path === "/dashboard/analytics") return isLeadership;
              if (item.path === "/organization") return isLeadership;
              if (item.path === "/admin/organizations") return isSuperAdmin;
              return true; // Show all other items (Assets, Actions, Explorations, etc.)
            })();
            
            return shouldShow;
          }).map((item) => {
            const Icon = item.icon;
            return (
              <Card
                key={item.path}
                className="cursor-pointer transition-all hover:scale-105 hover:shadow-lg"
                onClick={() => navigate(item.path)}
              >
                <CardHeader className="text-center">
                  <div className={`w-16 h-16 rounded-full ${item.color} flex items-center justify-center mx-auto mb-4`}>
                    <Icon className="h-8 w-8 text-white" />
                  </div>
                  <CardTitle className="text-xl">{item.title}</CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" variant="outline">
                    Open
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

      </main>
    </div>
  );
}
