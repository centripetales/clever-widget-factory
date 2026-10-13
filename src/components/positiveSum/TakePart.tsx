import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useTakePart } from '@/hooks/positiveSum/usePositiveSum';
import { errorMessage } from '@/lib/apiService';

// Join a proposed collaboration: you become a participant on its action, and
// an observation goes on it — what you write about your ideas and how you want
// to be involved, or a short note if you write nothing. Once you have joined,
// the same form adds another comment.
export function TakePart({ goalId, joined }: { goalId: string; joined: boolean }) {
  const { toast } = useToast();
  const takePart = useTakePart();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');

  const save = () =>
    takePart.mutate({ goalId, comment }, {
      onSuccess: () => {
        toast({ title: joined ? 'Comment added' : 'You joined' });
        setOpen(false);
        setComment('');
      },
      onError: error => toast({ title: 'Something went wrong', description: errorMessage(error), variant: 'destructive' }),
    });

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {joined ? 'Add a comment' : 'Join'}
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2">
      <Textarea
        rows={3}
        placeholder="Your ideas, and how you'd like to be involved"
        value={comment}
        onChange={e => setComment(e.target.value)}
        aria-label="Your ideas, and how you'd like to be involved"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" variant="outline" disabled={takePart.isPending || (joined && !comment.trim())} onClick={save}>
          {takePart.isPending ? 'Saving...' : joined ? 'Add comment' : 'Join'}
        </Button>
      </div>
    </div>
  );
}
