import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useCreateOption } from '@/hooks/positiveSum/usePositiveSum';

export interface OptionDraft {
  initial_state?: string | null;
  policy?: string | null;
  final_state?: string | null;
  capacity?: number | null;
}

interface SuggestOptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goalIds: string[];
  goalTitle: string;
  // Set when suggesting a change to an existing option (counterproposal).
  parentOptionId?: string;
  draft?: OptionDraft;
}

// An option: where it starts, how it's done, and what counts as done.
export function SuggestOptionDialog({
  open, onOpenChange, goalIds, goalTitle, parentOptionId, draft,
}: SuggestOptionDialogProps) {
  const { toast } = useToast();
  const createOption = useCreateOption();
  const [initialState, setInitialState] = useState('');
  const [policy, setPolicy] = useState('');
  const [finalState, setFinalState] = useState('');
  const [capacity, setCapacity] = useState(1);

  useEffect(() => {
    if (!open) return;
    setInitialState(draft?.initial_state ?? '');
    setPolicy(draft?.policy ?? '');
    setFinalState(draft?.final_state ?? '');
    setCapacity(draft?.capacity ?? 1);
  }, [open, draft]);

  const submit = async () => {
    try {
      await createOption.mutateAsync({
        goal_ids: goalIds,
        initial_state: initialState.trim(),
        policy: policy.trim(),
        final_state: finalState.trim(),
        capacity: Math.max(1, capacity),
        parent_option_id: parentOptionId ?? null,
      });
      onOpenChange(false);
      toast({ title: parentOptionId ? 'Change suggested' : 'Option suggested' });
    } catch (error) {
      toast({ title: 'Could not save option', description: String(error), variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{parentOptionId ? 'Suggest a change' : 'Suggest an option'}</DialogTitle>
          <DialogDescription>For: {goalTitle}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="option-initial">Starting point and conditions</Label>
            <Textarea
              id="option-initial"
              placeholder="e.g. 100 ripe trees; picker and crates provided"
              value={initialState}
              onChange={e => setInitialState(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="option-policy">How it's done</Label>
            <Textarea
              id="option-policy"
              placeholder="e.g. Saturday and Sunday; ripe fruit only, crate by variety"
              value={policy}
              onChange={e => setPolicy(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="option-final">Done when (and the photos that show it)</Label>
            <Textarea
              id="option-final"
              placeholder="e.g. Photos of the picked trees and full crates"
              value={finalState}
              onChange={e => setFinalState(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="option-capacity">People needed</Label>
            <Input
              id="option-capacity"
              type="number"
              min={1}
              value={capacity}
              onChange={e => setCapacity(Number(e.target.value) || 1)}
            />
          </div>
          <Button
            className="w-full"
            disabled={!policy.trim() || !finalState.trim() || createOption.isPending}
            onClick={submit}
          >
            {createOption.isPending ? 'Saving...' : 'Suggest'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
