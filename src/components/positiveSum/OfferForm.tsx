import { useState } from 'react';
import { errorMessage } from '@/lib/apiService';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AssetSelector } from '@/components/AssetSelector';
import { useToast } from '@/hooks/use-toast';
import { useCreatePolicy } from '@/hooks/positiveSum/usePositiveSum';

// An offer is a policy: a standing suggestion others can build options from.
// It describes how it's done, not what anyone gets in return.
export function OfferForm({ organizationId }: { organizationId: string }) {
  const { toast } = useToast();
  const createPolicy = useCreatePolicy();
  const [policy, setPolicy] = useState('');
  const [conditions, setConditions] = useState('');
  const [tools, setTools] = useState<{ required_tools: string[] }>({ required_tools: [] });

  const canSubmit = policy.trim();

  const submit = async () => {
    try {
      await createPolicy.mutateAsync({
        organization_id: organizationId,
        policy: policy.trim(),
        conditions: conditions.trim() || undefined,
        required_tools: tools.required_tools,
      });
      setPolicy('');
      setConditions('');
      setTools({ required_tools: [] });
      toast({ title: 'Offer shared' });
    } catch (error) {
      toast({ title: 'Could not save offer', description: errorMessage(error), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="offer-policy">What you can offer, and how</Label>
        <Textarea
          id="offer-policy"
          placeholder="e.g. Borrow my fruit picker; return it clean within 3 days"
          value={policy}
          onChange={e => setPolicy(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="offer-conditions">What it's for / conditions (optional)</Label>
        <Textarea
          id="offer-conditions"
          placeholder="e.g. For picking fruit only; not lent onward"
          value={conditions}
          onChange={e => setConditions(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>Tool (optional)</Label>
        <AssetSelector formData={tools} setFormData={setTools} />
      </div>
      <Button className="w-full" disabled={!canSubmit || createPolicy.isPending} onClick={submit}>
        {createPolicy.isPending ? 'Saving...' : 'Share offer'}
      </Button>
    </div>
  );
}
