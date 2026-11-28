import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { PolicyChange } from '@/hooks/usePolicies';
import type { Policy } from '@/types/policies';

interface PolicyFormDialogProps {
  /** The policy being edited; none for a new one. */
  policy: Policy | null;
  saving: boolean;
  onSave: (change: PolicyChange) => void;
  onClose: () => void;
}

// Write a policy. Changing the text of one that actions follow asks whether it
// is a wording fix or a change of practice.
export function PolicyFormDialog({ policy, saving, onSave, onClose }: PolicyFormDialogProps) {
  const [title, setTitle] = useState(policy?.title ?? '');
  const [description, setDescription] = useState(policy?.description_text ?? '');
  const [reasoning, setReasoning] = useState(policy?.reasoning ?? '');
  const [asking, setAsking] = useState(false);

  const text = { title: title.trim(), description_text: description.trim(), reasoning: reasoning.trim() };
  const complete = !!text.title && !!text.description_text;

  const submit = () => {
    if (!policy) return onSave({ kind: 'create', text });
    const changesPractice = policy.status === 'active' && policy.action_count > 0
      && text.description_text !== policy.description_text.trim();
    if (changesPractice) return setAsking(true);
    onSave({ kind: 'edit', id: policy.id, text });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{policy ? 'Edit policy' : 'New policy'}</DialogTitle>
          <DialogDescription>
            {asking && policy
              ? `This policy is used by ${policy.action_count} ${policy.action_count === 1 ? 'action' : 'actions'}. Is this a wording fix?`
              : 'What to do and when it applies. Sharing the reasoning is optional.'}
          </DialogDescription>
        </DialogHeader>
        {asking && policy ? (
          <>
            <p className="text-sm text-muted-foreground">
              If the practice itself has changed, save it as a new policy so earlier results are not mixed with new ones.
              The new policy starts without sources.
            </p>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button variant="ghost" onClick={() => setAsking(false)} disabled={saving}>Back</Button>
              <Button variant="outline" onClick={() => onSave({ kind: 'edit', id: policy.id, text })} disabled={saving}>
                Save as wording fix
              </Button>
              <Button onClick={() => onSave({ kind: 'replace', id: policy.id, text })} disabled={saving}>
                Save as new policy and retire this one
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="policy-title">Title</Label>
                <Input id="policy-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="policy-text">Policy</Label>
                <Textarea id="policy-text" rows={10} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="policy-reasoning">Reasoning (optional)</Label>
                <Textarea id="policy-reasoning" rows={3} value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={submit} disabled={!complete || saving}>Save</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
