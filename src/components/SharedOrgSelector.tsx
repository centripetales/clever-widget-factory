import React, { useEffect, useState } from 'react';
import { useSharedOrgs } from '@/hooks/useSharedOrgs';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useOrganization } from '@/hooks/useOrganization';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Network } from 'lucide-react';

export function SharedOrgSelector() {
  const { selectedOrgs, toggleOrg, isLoaded } = useSharedOrgs();
  const { getAllOrganizations, loading: orgsLoading } = useOrganizations();
  const { currentOrganization } = useOrganization();
  const [organizations, setOrganizations] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    const fetchOrgs = async () => {
      const orgs = await getAllOrganizations();
      // Filter out the current user's organization
      setOrganizations(orgs.filter(o => o.id !== currentOrganization?.id));
    };
    if (currentOrganization?.id) {
      fetchOrgs();
    }
  }, [currentOrganization?.id]);

  if (!isLoaded || orgsLoading) {
    return (
      <Card className="mb-6 border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm">
        <CardHeader className="pb-3">
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (organizations.length === 0) {
    return null; // No other organizations to share with or from
  }

  return (
    <Card className="mb-6 border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-slate-500 dark:text-slate-400 flex items-center gap-2">
          <Network className="w-4 h-4 text-emerald-500" />
          Shared Partner Data
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {organizations.map((org) => (
            <div key={org.id} className="flex items-center space-x-2 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-md border border-slate-100 dark:border-slate-800">
              <Checkbox
                id={`org-${org.id}`}
                checked={selectedOrgs.includes(org.id)}
                onCheckedChange={() => toggleOrg(org.id)}
                className="data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
              />
              <Label
                htmlFor={`org-${org.id}`}
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer select-none"
              >
                {org.name}
              </Label>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
