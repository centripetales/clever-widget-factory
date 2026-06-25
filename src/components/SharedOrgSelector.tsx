import React from 'react';
import { useSharedOrgs } from '@/hooks/useSharedOrgs';
import { useOrganization } from '@/hooks/useOrganization';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Users } from 'lucide-react';
import { apiService } from '@/lib/apiService';
import { BaseAction } from '@/types/actions';
import { useQuery } from '@tanstack/react-query';

interface SharedOrgSelectorProps {
  actions?: BaseAction[];
}

export function SharedOrgSelector({ actions = [] }: SharedOrgSelectorProps) {
  const { selectedOrgs, toggleOrg, isLoaded } = useSharedOrgs();
  const { organization: currentOrg } = useOrganization();

  const { data: partnerOrgs = [] } = useQuery({
    queryKey: ['shared_with_me', currentOrg?.id],
    queryFn: async () => {
      const resp: any = await apiService.get('/shared-with-me');
      const shared: Array<{ entity_type: string; source_org_id: string; source_org_name: string }> =
        resp?.shared || [];
      // Unique orgs that have shared actions with us
      const seen = new Set<string>();
      const orgs: Array<{ id: string; name: string }> = [];
      shared.filter(s => s.entity_type === 'action').forEach(s => {
        if (!seen.has(s.source_org_id)) {
          seen.add(s.source_org_id);
          orgs.push({ id: s.source_org_id, name: s.source_org_name });
        }
      });
      return orgs;
    },
    enabled: !!currentOrg?.id,
    staleTime: 5 * 60 * 1000, // 5 minutes cache
    gcTime: 10 * 60 * 1000,
  });

  if (!isLoaded || !currentOrg) return null;

  // Count per org from currently loaded actions
  const countForOrg = (orgId: string): number => {
    if (orgId === currentOrg.id) return actions.filter(a => !a.is_shared_inbound).length;
    return actions.filter(a => a.is_shared_inbound && (a as any).organization_id === orgId).length;
  };

  const allOrgs = [
    { id: currentOrg.id, name: currentOrg.name, isOwn: true },
    ...partnerOrgs.map(o => ({ ...o, isOwn: false })),
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400">
        <Users className="w-4 h-4 text-emerald-500" />
        Show data from
      </div>
      <div className="flex flex-wrap gap-3">
        {allOrgs.map((org) => {
          return (
            <div
              key={org.id}
              className="flex items-center space-x-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 rounded-md border border-slate-100 dark:border-slate-800"
            >
              <Checkbox
                id={`org-${org.id}`}
                checked={selectedOrgs.includes(org.id)}
                onCheckedChange={() => toggleOrg(org.id)}
                className="data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
              />
              <Label htmlFor={`org-${org.id}`} className="cursor-pointer select-none text-sm">
                {org.name}{org.isOwn && <span className="ml-1 text-xs text-muted-foreground">(You)</span>}
                <span className="ml-1 text-xs text-muted-foreground">({countForOrg(org.id)})</span>
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
