import { useState } from 'react';
import { errorMessage } from '@/lib/apiService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useImageUpload } from '@/hooks/useImageUpload';
import { useOrganization } from '@/hooks/useOrganization';
import { useAssociations } from '@/hooks/positiveSum/useAssociations';
import { useCreateGoal } from '@/hooks/positiveSum/usePositiveSum';
import { OrgPicker } from './OrgPicker';

// "What would you like to be different?" — stored as a goal: both how things
// are now and how the person would like them to be, stated explicitly.
export function GoalForm() {
  const { organization } = useOrganization();
  const { associations } = useAssociations();
  // Post to the association by default so other members can see it.
  const defaultOrgId = associations[0]?.id ?? organization?.id ?? '';
  const { toast } = useToast();
  const { uploadImages, isUploading } = useImageUpload();
  const createGoal = useCreateGoal();
  const [orgId, setOrgId] = useState('');
  const [initialState, setInitialState] = useState('');
  const [desiredState, setDesiredState] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const canSubmit = initialState.trim() && desiredState.trim() && (orgId || defaultOrgId);
  const busy = isUploading || createGoal.isPending;

  const submit = async () => {
    try {
      const uploaded = files.length ? await uploadImages(files) : [];
      const attachments = (Array.isArray(uploaded) ? uploaded : [uploaded]).map(r => r.url);
      await createGoal.mutateAsync({
        organization_id: orgId || defaultOrgId,
        initial_state: initialState.trim(),
        desired_state: desiredState.trim(),
        attachments,
      });
      setInitialState('');
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
        <Label htmlFor="goal-initial">How things are now</Label>
        <Textarea
          id="goal-initial"
          placeholder="e.g. I sell my corn to the one buyer who comes by"
          value={initialState}
          onChange={e => setInitialState(e.target.value)}
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
      <div className="space-y-1">
        <Label htmlFor="goal-desired">How you'd like it to be</Label>
        <Textarea
          id="goal-desired"
          placeholder="e.g. Better prices for my corn"
          value={desiredState}
          onChange={e => setDesiredState(e.target.value)}
        />
      </div>
      <OrgPicker value={orgId || defaultOrgId} onChange={setOrgId} />
      <Button className="w-full" disabled={!canSubmit || busy} onClick={submit}>
        {busy ? 'Saving...' : 'Ask the network'}
      </Button>
    </div>
  );
}
