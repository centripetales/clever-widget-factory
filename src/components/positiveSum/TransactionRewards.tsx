import { useEffect, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InfoBubble } from '@/components/positiveSum/InfoBubble';
import { RewardsSection } from '@/components/RewardsSection';
import { useToast } from '@/hooks/use-toast';
import { useSimilarOrganizations, useTransactionAction } from '@/hooks/positiveSum/useTransactionAction';
import { errorMessage } from '@/lib/apiService';
import type { NamedOrganization } from '@/types/positiveSum';

// The other organization in a transaction: pick one with a similar name from
// all organizations (names only), or create it when it isn't there.
function OrganizationPicker({ initialName, ownOrgId, selected, onSelect }: {
  initialName: string;
  ownOrgId: string;
  selected: NamedOrganization | null;
  onSelect: (org: NamedOrganization | null) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [searched, setSearched] = useState(initialName);
  const { data: similar = [], isFetching, create } = useSimilarOrganizations(searched);

  useEffect(() => {
    const timer = setTimeout(() => setSearched(name), 400);
    return () => clearTimeout(timer);
  }, [name]);

  if (selected) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-sm font-medium text-secondary-foreground break-words">
          {selected.name}
        </span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onSelect(null)}>Change</Button>
      </div>
    );
  }

  const others = similar.filter(o => o.id !== ownOrgId);
  const wanted = name.trim();
  const createNew = () =>
    create.mutate(wanted, {
      onSuccess: onSelect,
      onError: error => toast({ title: 'Could not create the organization', description: errorMessage(error), variant: 'destructive' }),
    });

  return (
    <div className="space-y-2">
      <Input value={name} onChange={e => setName(e.target.value)} placeholder="Who was paid?" aria-label="Other organization" />
      {wanted.length >= 3 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {isFetching ? 'Looking for similar names...' : others.length ? 'Already in the app — pick one if it is the same:' : 'No similar names in the app.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {others.map(o => (
              <Button key={o.id} variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal break-words text-left" onClick={() => onSelect(o)}>
                {o.name}
              </Button>
            ))}
            <Button variant="outline" size="sm" className="h-auto min-h-8 gap-1 whitespace-normal break-words text-left" disabled={create.isPending || isFetching || wanted !== searched.trim()} onClick={createNew}>
              <Plus className="h-4 w-4 shrink-0" />
              {create.isPending ? 'Creating...' : `Create "${wanted}" as a new organization`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Rewards of a transaction. Rewards belong to an action, so the first build
// makes one from the transaction once the person confirms who was paid (an AI
// draft they review). Until then nothing is created.
export function TransactionRewards({ recordId, organizationId }: { recordId: string; organizationId: string }) {
  const { toast } = useToast();
  const { data: link, isLoading, draft, create } = useTransactionAction(recordId);
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [draftedName, setDraftedName] = useState('');
  const [otherOrg, setOtherOrg] = useState<NamedOrganization | null>(null);

  if (link) {
    return <RewardsSection actionId={link.action_id} alsoLinkTo={{ entity_type: 'financial_record', entity_id: recordId }} justCreated={create.isSuccess} />;
  }

  // The draft is only a starting point: if it fails, the person fills the review in themselves.
  const startDraft = () =>
    draft.mutate(undefined, {
      onSuccess: d => {
        setDraftedName(d.other_org.name);
        setOtherOrg(d.other_org.id ? { id: d.other_org.id, name: d.other_org.name } : null);
      },
      onError: error => toast({ title: 'Could not draft it — fill it in below', description: errorMessage(error), variant: 'destructive' }),
      onSettled: () => setReviewing(true),
    });

  const save = () =>
    otherOrg && create.mutate(
      { other_org_id: otherOrg.id, llm_generation_config_id: draft.data?.llm_generation_config_id },
      { onError: error => toast({ title: 'Could not save', description: errorMessage(error), variant: 'destructive' }) }
    );

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 rounded-md border">
      <div className="flex items-center gap-1 px-3 py-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1 px-1 font-medium">
            Rewards <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </Button>
        </CollapsibleTrigger>
        <InfoBubble>
          What moved between organizations in this transaction, and what each would have done otherwise. Rewards belong
          to an action, so the first build makes one from this transaction; it is reached only from here.
        </InfoBubble>
      </div>

      <CollapsibleContent className="space-y-3 px-3 pb-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {!isLoading && !reviewing && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">No rewards yet. AI drafts who was paid; you confirm it before anything is saved.</p>
            <Button variant="outline" size="sm" disabled={draft.isPending} onClick={startDraft}>
              {draft.isPending ? 'Drafting...' : 'Draft'}
            </Button>
          </div>
        )}

        {reviewing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-sm text-muted-foreground">Other organization</Label>
              <OrganizationPicker
                key={draftedName}
                initialName={draftedName}
                ownOrgId={organizationId}
                selected={otherOrg}
                onSelect={setOtherOrg}
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!otherOrg && <span className="text-xs text-muted-foreground">Pick or create the other organization first.</span>}
              <Button variant="ghost" size="sm" onClick={() => setReviewing(false)}>Cancel</Button>
              <Button size="sm" disabled={!otherOrg || create.isPending} onClick={save}>
                {create.isPending ? 'Saving...' : 'Save and build rewards'}
              </Button>
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
