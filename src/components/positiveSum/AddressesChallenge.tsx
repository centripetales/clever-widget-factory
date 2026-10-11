import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useLinkChallenge } from '@/hooks/positiveSum/usePositiveSum';
import { errorMessage } from '@/lib/apiService';
import type { Challenge, MyGoal } from '@/types/positiveSum';

// Which challenges a proposed collaboration addresses: the ones it is linked
// to, each removable, and a list to pick another from. The link is made here,
// on the collaboration, so the challenge cards stay uncluttered.
export function AddressesChallenge({ goal, challenges }: { goal: MyGoal; challenges: Challenge[] }) {
  const { toast } = useToast();
  const link = useLinkChallenge();
  const addresses = goal.addresses ?? [];
  const others = challenges.filter(c => !addresses.some(a => a.id === c.id));
  if (!addresses.length && !others.length) return null;

  const change = (challengeId: string, remove?: boolean) =>
    link.mutate({ organizationId: goal.organization_id, goalId: goal.id, challengeId, remove }, {
      onError: error => toast({ title: 'Could not change the link', description: errorMessage(error), variant: 'destructive' }),
    });

  return (
    <div className="space-y-2">
      {addresses.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Addresses</p>
          {addresses.map(challenge => (
            <div key={challenge.id} className="flex items-center gap-1">
              <span className="inline-flex min-w-0 items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground break-words">
                {challenge.text}
              </span>
              <Button
                variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0" disabled={link.isPending}
                aria-label={`Remove the link to "${challenge.text}"`} onClick={() => change(challenge.id, true)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        // The value is always empty: picking one links it, and it then moves to the list above.
        <Select value="" onValueChange={challengeId => change(challengeId)} disabled={link.isPending}>
          <SelectTrigger className="h-9 w-full sm:w-80" aria-label="Which situation does this address?">
            <SelectValue placeholder="Which situation does this address?" />
          </SelectTrigger>
          <SelectContent>
            {others.map(challenge => (
              <SelectItem key={challenge.id} value={challenge.id}>{challenge.text}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
