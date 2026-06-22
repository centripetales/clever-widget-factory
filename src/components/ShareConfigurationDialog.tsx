import React, { useState, useEffect } from 'react';
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
import { useToast } from '@/hooks/use-toast';
import { apiService } from '@/lib/apiService';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useQueryClient } from '@tanstack/react-query';

interface ShareConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityType: 'action' | 'part' | 'tool';
  entityName: string;
}

interface ExistingShare {
  state_id: string;
  target_org_id: string;
  target_org_name: string;
  note: string;
}

export function ShareConfigurationDialog({
  open,
  onOpenChange,
  entityId,
  entityType,
  entityName,
}: ShareConfigurationDialogProps) {
  const { getAllOrganizations, loading: orgsLoading } = useOrganizations();
  const { organization } = useOrganization();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [organizations, setOrganizations] = useState<Array<{ id: string; name: string }>>([]);
  const [existingShares, setExistingShares] = useState<ExistingShare[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    const load = async () => {
      setNote('');
      setIsLoading(true);
      try {
        const orgs = await getAllOrganizations();
        const otherOrgs = orgs.filter((o: any) => o.id !== organization?.id);
        setOrganizations(otherOrgs);
      } finally {
        setIsLoading(false);
      }
      // Load existing shares separately — don't block org list if this fails
      try {
        const sharesResp = await apiService.get(`/api/shares/${entityType}/${entityId}`);
        const shares: ExistingShare[] = (sharesResp as any)?.shares || [];
        setExistingShares(shares);
        setSelectedOrgs(new Set(shares.map((s) => s.target_org_id)));
        if (shares.length > 0) {
          setNote(shares[0].note || '');
        } else {
          setNote('');
        }
      } catch {
        // shares endpoint may not be deployed yet — start with empty selection
        setNote('');
      }
    };
    load();
  }, [open, organization?.id, entityId, entityType]);

  const handleToggle = (orgId: string) => {
    setSelectedOrgs((prev) => {
      const next = new Set(prev);
      next.has(orgId) ? next.delete(orgId) : next.add(orgId);
      return next;
    });
  };

  const handleSave = async () => {
    setIsSubmitting(true);
    try {
      const previously = new Set(existingShares.map((s) => s.target_org_id));
      const previousNotes = new Map(existingShares.map((s) => [s.target_org_id, s.note || '']));

      // Orgs to add (selected but not previously shared OR still selected but the note has changed)
      const toAdd = [...selectedOrgs].filter(
        (id) => !previously.has(id) || note.trim() !== (previousNotes.get(id) || '')
      );
      // Orgs to remove (previously shared but now deselected OR still selected but the note has changed)
      const toRemove = existingShares.filter(
        (s) => !selectedOrgs.has(s.target_org_id) || note.trim() !== (s.note || '')
      );

      await Promise.all([
        ...toAdd.map((targetOrgId) => {
          const targetOrg = organizations.find((o) => o.id === targetOrgId);
          return apiService.post('/api/shares', {
            entity_type: entityType,
            entity_id: entityId,
            target_org_id: targetOrgId,
            note: note.trim(),
            source_org_id: organization?.id,
            cognito_user_id: user?.userId,
            entity_name: entityName,
            target_org_name: targetOrg?.name,
          });
        }),
        ...toRemove.map((share) =>
          apiService.delete(`/api/shares/${share.state_id}`)
        ),
      ]);

      const added = toAdd.length;
      const removed = toRemove.length;
      const msg = [
        added > 0 && `Shared with ${added} org${added > 1 ? 's' : ''}`,
        removed > 0 && `Removed from ${removed} org${removed > 1 ? 's' : ''}`,
      ]
        .filter(Boolean)
        .join(', ');

      toast({ title: 'Saved', description: msg || 'No changes made.' });
      queryClient.invalidateQueries({ queryKey: ['shareStatus', entityType, entityId] });
      onOpenChange(false);
    } catch (error) {
      console.error('Share save error:', error);
      toast({ title: 'Error', description: 'Failed to save sharing settings.', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const loading = isLoading || orgsLoading;

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
