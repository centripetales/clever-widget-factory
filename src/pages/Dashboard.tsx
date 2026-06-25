import { useAuth } from "@/hooks/useCognitoAuth";
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useNavigate } from 'react-router-dom';
import { LogOut, CheckCircle, XCircle, Wrench, Box, Flag, ClipboardCheck, Target, BarChart3, Building2, Settings, Bot, RefreshCw, DollarSign, Search, User, Camera, Lock, ChevronDown } from 'lucide-react';
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
import { useEffect, useRef, useState } from 'react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';

export default function Dashboard() {
  const { user, signOut, isAdmin, isLeadership } = useAuth();
  const { isSuperAdmin } = useSuperAdmin();
  const { organization, loading: orgLoading } = useOrganization();
  const { fullName } = useProfile();
  const firstName = fullName ? fullName.split(' ')[0] : '';

  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { isFeatureEnabled } = useFeatureFlag();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [lockedFeatureName, setLockedFeatureName] = useState('');
  const [disabledSectionOpen, setDisabledSectionOpen] = useState(false);

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
      color: "bg-teal-600",
      featureKey: "observations"
    },
    {
      title: "Assets",
      description: "Unified view of assets and stock",
      icon: Box,
      path: "/combined-assets",
      color: "bg-green-500",
      featureKey: "assets"
    },
    {
      title: "Actions",
      description: "Track and manage policy actions",
      icon: Target,
      path: "/actions",
      color: "bg-yellow-500",
      featureKey: "actions"
    },
    {
      title: "Stargazer Projects",
      description: "Manage objectives and track progress",
      icon: Flag,
      path: "/missions",
      color: "bg-blue-500",
      featureKey: "missions"
    },
    {
      title: "Sari Sari Store",
      description: "Chat with AI assistant for farm produce",
      icon: Bot,
      path: "/sari-sari-chat",
      color: "bg-orange-500",
      featureKey: "sari-sari-chat"
    },
    {
      title: "Expenses",
      description: "Track petty cash and expenses",
      icon: DollarSign,
      path: "/finances",
      color: "bg-emerald-600",
      featureKey: "finances"
    },
    {
      title: "Analytics",
      description: "View strategic attributes analytics",
      icon: BarChart3,
      path: "/dashboard/analytics",
      color: "bg-indigo-500",
      featureKey: "analytics"
    },
    {
      title: firstName || "My Profile",
      description: "Track and direct your growth priorities",
      icon: User,
      path: `/user/${user?.userId}`,
      color: "bg-purple-500",
      featureKey: "profile"
    },
    {
      title: "Organization Settings",
      description: "Manage organization members and settings",
      icon: Settings,
      path: "/organization",
      color: "bg-teal-500",
      featureKey: "organization"
    },
    {
      title: "Organizations",
      description: "Manage all organizations (Super Admin)",
      icon: Building2,
      path: "/admin/organizations",
      color: "bg-emerald-500",
      featureKey: "organizations"
    }
  ];

  const visibleItems = menuItems.filter(item => {
    // Show items based on permissions, but show all basic items while permissions load
    const shouldShow = (() => {
      if (item.path === "/dashboard/analytics") return isLeadership;
      if (item.path === "/organization") return isLeadership;
      if (item.path === "/admin/organizations") return isSuperAdmin;
      return true; // Show all other items (Assets, Actions, Explorations, etc.)
    })();
    
    return shouldShow;
  });

  const enabledItems = visibleItems.filter(item => isFeatureEnabled(item.featureKey));
  const disabledItems = visibleItems.filter(item => !isFeatureEnabled(item.featureKey));

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
      <main className="p-6 space-y-8">
        <div>
          {disabledItems.length > 0 && (
            <h2 className="text-lg font-semibold mb-4 text-foreground">Active Modules</h2>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {enabledItems.map((item) => {
              const Icon = item.icon;
              return (
                <Card
                  key={item.path}
                  className="cursor-pointer transition-all hover:scale-105 hover:shadow-lg border border-border/50"
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
        </div>

        {disabledItems.length > 0 && (
          <Collapsible
            open={disabledSectionOpen}
            onOpenChange={setDisabledSectionOpen}
            className="space-y-4 pt-2 border-t border-border/40"
          >
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="flex items-center justify-between w-full p-0 hover:bg-transparent text-left focus-visible:ring-0 focus-visible:ring-offset-0 group"
              >
                <h2 className="text-lg font-semibold text-muted-foreground flex items-center gap-2">
                  <Lock className="h-4 w-4 text-muted-foreground/70" />
                  Disabled Features
                </h2>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground bg-muted group-hover:text-foreground px-2.5 py-1 rounded border border-border transition-all duration-200">
                    {disabledSectionOpen ? 'Hide' : `Show (${disabledItems.length})`}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${disabledSectionOpen ? 'rotate-180' : ''}`}
                  />
                </div>
              </Button>
            </CollapsibleTrigger>
            
            <CollapsibleContent className="animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
                {disabledItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Card
                      key={item.path}
                      className="cursor-pointer transition-all border border-dashed border-border bg-card/40 opacity-60 hover:opacity-85 group relative overflow-hidden"
                      onClick={() => {
                        setLockedFeatureName(item.title);
                        setUpgradeOpen(true);
                      }}
                    >
                      <CardHeader className="text-center pb-2">
                        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4 relative">
                          <Icon className="h-8 w-8 text-muted-foreground" />
                          <div className="absolute -bottom-1 -right-1 bg-background rounded-full p-1 border shadow-sm">
                            <Lock className="h-3.5 w-3.5 text-orange-500" />
                          </div>
                        </div>
                        <CardTitle className="text-xl text-muted-foreground flex items-center justify-center gap-2">
                          {item.title}
                        </CardTitle>
                        <CardDescription>{item.description}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button className="w-full gap-2 border-dashed text-muted-foreground hover:text-foreground" variant="outline">
                          <Lock className="h-3.5 w-3.5" />
                          Locked
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </main>

      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="text-center flex flex-col items-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-orange-500/10 border border-orange-500/30 flex items-center justify-center mb-3 text-orange-600 animate-pulse">
              <Lock className="h-6 w-6" />
            </div>
            <DialogTitle className="text-xl font-bold">Feature Locked</DialogTitle>
            <DialogDescription className="text-sm mt-1">
              Access Restricted
            </DialogDescription>
          </DialogHeader>
          <div className="text-center py-2 space-y-4">
            <p className="text-sm text-muted-foreground">
              The <strong>"{lockedFeatureName}"</strong> module is not enabled for this account.
            </p>
            <p className="text-xs text-muted-foreground italic bg-muted p-2.5 rounded border border-border">
              Contact Mae or Stefan discuss getting access.
            </p>
          </div>
          <DialogFooter className="sm:justify-center">
            <Button onClick={() => setUpgradeOpen(false)} className="w-full sm:w-auto">
              Dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
