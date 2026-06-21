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

interface ShareConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityType: 'action' | 'part' | 'tool';
  entityName: string;
}

export function ShareConfigurationDialog({
  open,
  onOpenChange,
  entityId,
  entityType,
  entityName,
}: ShareConfigurationDialogProps) {
  const { getAllOrganizations, loading: orgsLoading } = useOrganizations();
  const { currentOrganization } = useOrganization();
  const { user } = useAuth();
  const { toast } = useToast();
  
  const [organizations, setOrganizations] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [justification, setJustification] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      const fetchOrgs = async () => {
        const orgs = await getAllOrganizations();
        setOrganizations(orgs.filter(o => o.id !== currentOrganization?.id));
      };
      if (currentOrganization?.id) {
        fetchOrgs();
      }
      setSelectedOrgs([]);
      setJustification('');
    }
  }, [open, currentOrganization?.id]);

  const handleToggle = (orgId: string) => {
    setSelectedOrgs(prev => 
      prev.includes(orgId) ? prev.filter(id => id !== orgId) : [...prev, orgId]
    );
  };

  const handleShare = async () => {
    if (selectedOrgs.length === 0) {
      toast({
        title: "Selection Required",
        description: "Please select at least one organization to share with.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // Create a share state for each selected organization
      for (const targetOrgId of selectedOrgs) {
        await apiService.post('/api/shares', {
          entity_type: entityType,
          entity_id: entityId,
          target_org_id: targetOrgId,
          justification: justification.trim(),
          source_org_id: currentOrganization?.id,
          cognito_user_id: user?.userId,
        });
      }

      toast({
        title: "Success",
        description: `Shared ${entityName} successfully.`,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to share:', error);
      toast({
        title: "Error",
        description: "Failed to share the asset.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Share Configuration</DialogTitle>
          <DialogDescription>
            Share "{entityName}" with partner organizations.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          <div className="space-y-3">
            <Label>Select Organizations</Label>
            {orgsLoading ? (
              <div className="text-sm text-slate-500">Loading organizations...</div>
            ) : organizations.length === 0 ? (
              <div className="text-sm text-slate-500">No partner organizations found.</div>
            ) : (
              <div className="grid gap-2 max-h-48 overflow-y-auto pr-2">
                {organizations.map((org) => (
                  <div key={org.id} className="flex items-center space-x-2 border rounded-md p-3 hover:bg-slate-50 transition-colors dark:border-slate-800 dark:hover:bg-slate-800/50">
                    <Checkbox 
                      id={`share-org-${org.id}`} 
                      checked={selectedOrgs.includes(org.id)}
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
            <Label htmlFor="justification">Context / Justification (Optional)</Label>
            <Textarea 
              id="justification" 
              placeholder="Why are you sharing this? How can it help?"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              className="resize-none"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleShare} disabled={isSubmitting || selectedOrgs.length === 0} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {isSubmitting ? 'Sharing...' : 'Share'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
