import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useOrganization } from '@/hooks/useOrganization';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { useSharedStatus, type ShareEntityType } from '@/hooks/useSharedStatus';
import { useSaveShares } from '@/hooks/useSaveShares';

interface ShareConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityType: ShareEntityType;
  entityName: string;
  onSaved?: () => void;
}

// Who an action, tool or stock item is shared with. Reads and writes go through
// TanStack Query (ENGINEERING_GUIDE.md): saving is optimistic, so the dialog
// closes at once and the hook reports the outcome.
export function ShareConfigurationDialog({
  open,
  onOpenChange,
  entityId,
  entityType,
  entityName,
  onSaved,
}: ShareConfigurationDialogProps) {
  const { organizations: allOrganizations, loading: orgsLoading } = useOrganizations();
  const { organization } = useOrganization();
  const { shares, isLoading: sharesLoading } = useSharedStatus(entityId, entityType);
  const saveShares = useSaveShares({ entityType, entityId, entityName, onSaved });

  const organizations = allOrganizations.filter(o => o.id !== organization?.id);

  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  // Start from what it is shared with now, each time the dialog opens or that changes.
  const current = JSON.stringify(shares.map(s => [s.target_org_id, s.note || '']));
  useEffect(() => {
    if (!open) return;
    const saved = JSON.parse(current) as [string, string][];
    setSelectedOrgs(new Set(saved.map(([orgId]) => orgId)));
    setNote(saved[0]?.[1] ?? '');
  }, [open, current]);

  const handleToggle = (orgId: string) => {
    setSelectedOrgs((prev) => {
      const next = new Set(prev);
      next.has(orgId) ? next.delete(orgId) : next.add(orgId);
      return next;
    });
  };

  const handleSave = () => {
    saveShares.mutate({
      existing: shares,
      // An org it is already shared with stays, even if it isn't in the list shown here.
      targets: [...selectedOrgs].map(id => ({
        id,
        name: organizations.find(o => o.id === id)?.name ?? shares.find(sh => sh.target_org_id === id)?.target_org_name ?? '',
      })),
      note,
    });
    onOpenChange(false);
  };

  const isSubmitting = saveShares.isPending;
  const loading = sharesLoading || orgsLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Share "{entityName}"</DialogTitle>
          <DialogDescription>
            Select organizations to share with. All members of a selected organization will be able to view this {entityType}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          <div className="space-y-3">
            <Label>Organizations</Label>
            {loading ? (
              <div className="text-sm text-slate-500">Loading...</div>
            ) : organizations.length === 0 ? (
              <div className="text-sm text-slate-500">No other organizations found.</div>
            ) : (
              <div className="grid gap-2 max-h-48 overflow-y-auto pr-2">
                {organizations.map((org) => (
                  <div
                    key={org.id}
                    className="flex items-center space-x-2 border rounded-md p-3 hover:bg-slate-50 transition-colors dark:border-slate-800 dark:hover:bg-slate-800/50"
                  >
                    <Checkbox
                      id={`share-org-${org.id}`}
                      checked={selectedOrgs.has(org.id)}
                      onCheckedChange={() => handleToggle(org.id)}
                    />
                    <Label htmlFor={`share-org-${org.id}`} className="cursor-pointer flex-1">
                      {org.name}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <Label htmlFor="share-note">Note (optional)</Label>
            <Textarea
              id="share-note"
              placeholder="Why are you sharing this?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="resize-none"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSubmitting || loading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
