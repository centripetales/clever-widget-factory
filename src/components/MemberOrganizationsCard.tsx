import { useState } from 'react';
import { Building2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InfoBubble } from '@/components/positiveSum/InfoBubble';
import { useToast } from '@/hooks/use-toast';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useMemberOrganizations } from '@/hooks/useMemberOrganizations';
import { errorMessage } from '@/lib/apiService';

// Orgs that belong to this org (e.g. farms in Positive Sum). Assets shared with
// this org flow to them; their own data stays private.
export function MemberOrganizationsCard({ organizationId, canEdit }: { organizationId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { organizations } = useOrganizations();
  const { data: members = [], isLoading, add, remove } = useMemberOrganizations(organizationId);
  const [selected, setSelected] = useState('');

  const memberIds = new Set(members.map(m => m.member_organization_id));
  const candidates = organizations
    .filter(o => o.id !== organizationId && !memberIds.has(o.id) && o.is_active && o.settings?.deleted !== true)
    .sort((a, b) => a.name.localeCompare(b.name));

  const onError = (title: string) => (error: unknown) =>
    toast({ title, description: errorMessage(error), variant: 'destructive' });

  const addSelected = () =>
    add.mutate(selected, { onSuccess: () => setSelected(''), onError: onError('Could not add the organization') });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="w-5 h-5" />
          Member organizations ({members.length})
          <InfoBubble>
            Organizations that belong to this one. Assets shared with this organization are available to every member
            organization; each member's own observations and actions stay private unless it shares them.
          </InfoBubble>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && members.length === 0 && (
          <p className="text-sm text-muted-foreground">No member organizations yet.</p>
        )}
        {members.map(m => (
          <div key={m.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
            <span className="font-medium break-words">{m.name}</span>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                aria-label={`Remove ${m.name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(m.member_organization_id, { onError: onError('Could not remove the organization') })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger className="min-w-[200px] flex-1">
                <SelectValue placeholder="Add an organization" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map(o => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button disabled={!selected || add.isPending} onClick={addSelected}>
              {add.isPending ? 'Adding...' : 'Add'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
