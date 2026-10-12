import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useSaveConversation } from '@/hooks/positiveSum/useSaveConversation';
import { copyToClipboard } from '@/lib/urlUtils';
import { InfoBubble } from '@/components/positiveSum/InfoBubble';
import { buildConversationPrompt, parseConversationResult } from '@/lib/positiveSumConversation';

interface Review {
  typicalDay: string;
  humanCapital: string[];
  situations: string[];
}

// Positive Sum as a conversation held in the person's own AI: copy the prompt,
// talk it through there, paste the JSON back, review, save. The conversation
// gets to know the person and asks for their own view of where we could
// improve; proposed collaborations are added on the page, not here.
export function ConversationPanel({ org }: { org: { id: string; name: string } }) {
  const { toast } = useToast();
  const save = useSaveConversation();
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  const copyPrompt = async () => {
    const prompt = buildConversationPrompt({
      orgName: org.name,
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }),
      hour: Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', hourCycle: 'h23' })),
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
      typicalDay: result.typicalDay,
      humanCapital: result.humanCapital,
      situations: result.situations,
    });
  };

  const update = (change: (r: Review) => Review) => setReview(r => (r ? change(r) : r));
  const count = review
    ? (review.typicalDay.trim() ? 1 : 0) + review.humanCapital.length + review.situations.length
    : 0;

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
        <div className="flex items-center gap-1">
          <Button onClick={copyPrompt} className="gap-2">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Prompt copied' : 'Copy the conversation prompt'}
          </Button>
          <InfoBubble>
            Talk it through with your own AI — Gemini, ChatGPT or Claude. It's free, and you can use your voice and your own language.
            Open your AI app, paste the prompt, and talk. At the end it gives you a block of text to copy back here.
          </InfoBubble>
        </div>
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
          {review.typicalDay && (
            <section className="space-y-2">
              <h3 className="font-medium">A typical day</h3>
              <div className="flex items-start gap-2">
                <Textarea value={review.typicalDay} onChange={e => update(r => ({ ...r, typicalDay: e.target.value }))} />
                <RemoveButton onClick={() => update(r => ({ ...r, typicalDay: '' }))} />
              </div>
            </section>
          )}

          {review.humanCapital.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">What people come to you for</h3>
              {review.humanCapital.map((narrative, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Textarea value={narrative} onChange={e => update(r => ({ ...r, humanCapital: r.humanCapital.map((x, j) => j === i ? e.target.value : x) }))} />
                  <RemoveButton onClick={() => update(r => ({ ...r, humanCapital: r.humanCapital.filter((_, j) => j !== i) }))} />
                </div>
              ))}
            </section>
          )}

          {review.situations.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Where we could improve</h3>
              {review.situations.map((situation, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Textarea value={situation} onChange={e => update(r => ({ ...r, situations: r.situations.map((x, j) => j === i ? e.target.value : x) }))} />
                  <RemoveButton onClick={() => update(r => ({ ...r, situations: r.situations.filter((_, j) => j !== i) }))} />
                </div>
              ))}
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
