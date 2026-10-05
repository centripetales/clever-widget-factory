import { useState } from 'react';
import { errorMessage } from '@/lib/apiService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useImageUpload } from '@/hooks/useImageUpload';
import { useCreateGoal } from '@/hooks/positiveSum/usePositiveSum';

// "What would you like to be different?" — stored as a goal (desired state)
// in the person's own words.
export function GoalForm({ organizationId }: { organizationId: string }) {
  const { toast } = useToast();
  const { uploadImages, isUploading } = useImageUpload();
  const createGoal = useCreateGoal();
  const [desiredState, setDesiredState] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const canSubmit = desiredState.trim();
  const busy = isUploading || createGoal.isPending;

  const submit = async () => {
    try {
      const uploaded = files.length ? await uploadImages(files) : [];
      const attachments = (Array.isArray(uploaded) ? uploaded : [uploaded]).map(r => r.url);
      await createGoal.mutateAsync({
        organization_id: organizationId,
        desired_state: desiredState.trim(),
        attachments,
      });
      setDesiredState('');
      setFiles([]);
      toast({ title: 'Shared with the network', description: 'Others can now suggest options.' });
    } catch (error) {
      toast({ title: 'Could not share', description: errorMessage(error), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="goal-desired">What would you like to be different?</Label>
        <Textarea
          id="goal-desired"
          placeholder="e.g. Better prices for my corn — only one buyer comes by"
          value={desiredState}
          onChange={e => setDesiredState(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="goal-photo">Photo (optional)</Label>
        <Input
          id="goal-photo"
          type="file"
          accept="image/*"
          multiple
          onChange={e => setFiles(Array.from(e.target.files ?? []))}
        />
      </div>
      <Button className="w-full" disabled={!canSubmit || busy} onClick={submit}>
        {busy ? 'Saving...' : 'Ask the network'}
      </Button>
    </div>
  );
}
