import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/hooks/useOrganization';
import { orgHasFeature } from '@/hooks/useFeatureFlag';
import { useOpportunities } from '@/hooks/positiveSum/usePositiveSum';
import { useSaveConversation, type ReviewedAsset } from '@/hooks/positiveSum/useSaveConversation';
import { copyToClipboard } from '@/lib/urlUtils';
import { buildConversationPrompt, parseConversationResult, type ConversationDesiredState } from '@/lib/positiveSumConversation';

interface Review {
  desiredStates: ConversationDesiredState[];
  humanCapital: string[];
  assets: ReviewedAsset[];
}

// Positive Sum as a conversation held in the person's own AI: copy the prompt,
// talk it through there, paste the JSON back, review, save.
export function ConversationPanel({ org }: { org: { id: string; name: string } }) {
  const { toast } = useToast();
  const { accessibleOrganizations } = useOrganization();
  const { data: opportunities = [] } = useOpportunities(true, [org.id]);
  const save = useSaveConversation();
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  // Assets belong to the person's own org by default, not the Positive Sum org.
  const ownOrgs = accessibleOrganizations.filter(o => !orgHasFeature(o, 'positive_sum'));
  const assetOrgs = ownOrgs.length ? ownOrgs : accessibleOrganizations;
  const defaultAssetOrgId = assetOrgs[0]?.id ?? org.id;

  const copyPrompt = async () => {
    const prompt = buildConversationPrompt({
      orgName: org.name,
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }),
      opportunities,
    });
    setCopied(await copyToClipboard(prompt));
  };

  const reviewPasted = () => {
    const result = parseConversationResult(pasted);
    if ('error' in result) {
      setParseError(result.error);
      setReview(null);
      return;
    }
    setParseError(null);
    setReview({
      desiredStates: result.desiredStates,
      humanCapital: result.humanCapital,
      assets: result.assets.map(a => ({ ...a, kind: 'tool', organizationId: defaultAssetOrgId })),
    });
  };

  const update = (change: (r: Review) => Review) => setReview(r => (r ? change(r) : r));
  const count = review ? review.desiredStates.length + review.humanCapital.length + review.assets.length : 0;

  const saveReview = async () => {
    if (!review) return;
    const outcome = await save.mutateAsync({ organizationId: org.id, ...review });
    if (outcome.failed.length) {
      toast({
        title: `Saved ${outcome.saved}, ${outcome.failed.length} not saved`,
        description: outcome.failed.map(f => `${f.label}: ${f.message}`).join('\n'),
        variant: 'destructive',
      });
    } else {
      toast({ title: `Saved ${outcome.saved} ${outcome.saved === 1 ? 'item' : 'items'}` });
      setReview(null);
      setPasted('');
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Talk it through with your own AI — Gemini, ChatGPT or Claude. It's free, and you can use your voice and your own language.
        </p>
        <Button onClick={copyPrompt} className="gap-2">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Prompt copied' : 'Copy the conversation prompt'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Open your AI app, paste the prompt, and talk. At the end it gives you a block of text to copy back here.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="conversation-result">Paste what your AI gave you</Label>
        <Textarea
          id="conversation-result"
          rows={4}
          value={pasted}
          onChange={e => setPasted(e.target.value)}
          placeholder="Paste the whole block here"
        />
        {parseError && <p className="text-sm text-destructive">{parseError}</p>}
        <Button variant="outline" disabled={!pasted.trim()} onClick={reviewPasted}>Review</Button>
      </div>

      {review && (
        <div className="space-y-4 rounded-md border p-3">
          {review.desiredStates.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">What you'd like to be different</h3>
              {review.desiredStates.map((d, i) => (
                <div key={i} className="space-y-1 rounded-md bg-muted/40 p-2">
                  <div className="flex justify-end">
                    <RemoveButton onClick={() => update(r => ({ ...r, desiredStates: r.desiredStates.filter((_, j) => j !== i) }))} />
                  </div>
                  <Label className="text-xs">How things are now</Label>
                  <Textarea value={d.now} onChange={e => update(r => ({ ...r, desiredStates: r.desiredStates.map((x, j) => j === i ? { ...x, now: e.target.value } : x) }))} />
                  <Label className="text-xs">How you'd like it to be</Label>
                  <Textarea value={d.would_like} onChange={e => update(r => ({ ...r, desiredStates: r.desiredStates.map((x, j) => j === i ? { ...x, would_like: e.target.value } : x) }))} />
                </div>
              ))}
            </section>
          )}

          {review.humanCapital.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Your capabilities: skills and experience</h3>
              {review.humanCapital.map((narrative, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Textarea value={narrative} onChange={e => update(r => ({ ...r, humanCapital: r.humanCapital.map((x, j) => j === i ? e.target.value : x) }))} />
                  <RemoveButton onClick={() => update(r => ({ ...r, humanCapital: r.humanCapital.filter((_, j) => j !== i) }))} />
                </div>
              ))}
            </section>
          )}

          {review.assets.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Your capabilities: assets to track</h3>
              {review.assets.map((a, i) => {
                const set = (patch: Partial<ReviewedAsset>) =>
                  update(r => ({ ...r, assets: r.assets.map((x, j) => j === i ? { ...x, ...patch } : x) }));
                return (
                  <div key={i} className="space-y-2 rounded-md bg-muted/40 p-2">
                    <div className="flex items-center gap-2">
                      <Input value={a.name} onChange={e => set({ name: e.target.value })} />
                      <RemoveButton onClick={() => update(r => ({ ...r, assets: r.assets.filter((_, j) => j !== i) }))} />
                    </div>
                    <Textarea value={a.narrative} onChange={e => set({ narrative: e.target.value })} />
                    <div className="flex flex-wrap gap-2">
                      <Select value={a.kind} onValueChange={v => set({ kind: v as ReviewedAsset['kind'] })}>
                        <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tool">Tool / equipment</SelectItem>
                          <SelectItem value="stock">Stock / supplies</SelectItem>
                        </SelectContent>
                      </Select>
                      {assetOrgs.length > 1 && (
                        <Select value={a.organizationId} onValueChange={v => set({ organizationId: v })}>
                          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {assetOrgs.map(o => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <Button className="w-full" disabled={count === 0 || save.isPending} onClick={saveReview}>
            {save.isPending ? 'Saving...' : `Save ${count} ${count === 1 ? 'item' : 'items'}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={onClick} aria-label="Remove">
      <X className="h-4 w-4" />
    </Button>
  );
}
