import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Coins, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useAcceptReward, useAddReward, useCloseReward, useCreateGoal, useEditReward } from '@/hooks/positiveSum/usePositiveSum';
import { errorMessage } from '@/lib/apiService';
import type { OfferedReward } from '@/types/positiveSum';

const peso = (n: number) => `₱${Math.round(n).toLocaleString()}`;

function NameChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground break-words">
      {name}
    </span>
  );
}

// A reward on a proposed collaboration: what is paid and by whom, the terms a
// person accepts to earn it, and its tally, which everyone can see. Its owner
// can close it.
export function RewardOffer({ reward, organizationId, userId }: {
  reward: OfferedReward;
  organizationId: string;
  userId?: string;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const accept = useAcceptReward();
  const close = useCloseReward();
  const [reading, setReading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showTally, setShowTally] = useState(false);

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: errorMessage(error), variant: 'destructive' });
  const mine = reward.tally.find(person => person.id === userId);
  const shared = reward.tally.reduce((sum, person) => sum + person.count, 0);
  const earned = reward.tally.reduce((sum, person) => sum + person.php, 0);

  if (editing) {
    return (
      <div className="rounded-md border border-amber-600/40 bg-amber-50 p-2 dark:border-amber-500/40 dark:bg-amber-950/30">
        <AddReward organizationId={organizationId} editing={reward} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-600/40 bg-amber-50 p-2 text-sm dark:border-amber-500/40 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Coins className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
          <span className="break-words">
            <span className="font-medium">
              {reward.ask ? `Up to ${peso(reward.php)} for each observation` : `${peso(reward.php)} for each photo with a description`}
            </span>
            {reward.cap_php_per_person ? `, up to ${peso(reward.cap_php_per_person)} per person` : ''}
            {reward.budget_php ? ` · ${peso(reward.spent_php ?? 0)} of ${peso(reward.budget_php)} used` : ''}
            {' · '}paid by {reward.payer_name}
            {reward.closed && ' · closed'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {!reward.closed && !reward.accepted_by_me && !reading && (
            <Button size="sm" variant="outline" onClick={() => setReading(true)}>Earn this</Button>
          )}
          {/* Sharing from here is what makes it an observation made through Positive Sum. */}
          {!reward.closed && reward.accepted_by_me && reward.ask && reward.action_id && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/combined-assets/actions/${reward.action_id}/observation`)}>
              Share an observation
            </Button>
          )}
          {!reward.closed && reward.owner === userId && reward.ask && reward.editable && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          )}
          {!reward.closed && reward.owner === userId && (
            <Button
              size="sm" variant="ghost" disabled={close.isPending}
              onClick={() => close.mutate({ organizationId, rewardId: reward.id }, { onError: failed('Could not close it') })}
            >
              Close
            </Button>
          )}
        </span>
      </div>

      {/* The payer's own words, in full: this is what the AI reads each observation against. */}
      {reward.ask && <p className="whitespace-pre-wrap break-words">How it is valued: {reward.ask}</p>}

      {reading && (
        <div className="space-y-2">
          <p className="break-words text-muted-foreground">{reward.terms}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReading(false)}>Cancel</Button>
            <Button
              size="sm" variant="outline" disabled={accept.isPending}
              onClick={() => accept.mutate({ organizationId, rewardId: reward.id }, {
                onSuccess: () => setReading(false),
                onError: failed('Could not accept it'),
              })}
            >
              {accept.isPending ? 'Saving...' : 'I agree'}
            </Button>
          </div>
        </div>
      )}

      {reward.accepted_by_me && (
        <p>
          You: {mine?.count ?? 0} shared · <span className="font-medium">{peso(mine?.php ?? 0)}</span>
          {!reward.closed && !reward.ask && <span className="text-muted-foreground"> · Open this to add a photo with a description.</span>}
        </p>
      )}

      {/* Nothing is credited until it has been read, so an amount never appears and then shrinks. */}
      {!!reward.my_reading?.waiting && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          Reading {reward.my_reading.waiting === 1 ? 'your observation' : `${reward.my_reading.waiting} of your observations`}. The amount appears when it is done.
        </p>
      )}
      {!!reward.my_reading?.unread && (
        <p className="text-muted-foreground">
          {reward.my_reading.unread === 1 ? 'One of your observations has' : `${reward.my_reading.unread} of your observations have`} not been read yet. Nothing is lost; {reward.payer_name} can have it read again.
        </p>
      )}

      {reward.accepted_by_me && reward.my_latest && (
        <p className="break-words text-muted-foreground">
          Your last one: {reward.my_latest.shows}
          {' · '}{reward.my_latest.counts ? `counted, ${peso(reward.my_latest.php)}` : 'not counted'}
          {reward.my_latest.feedback && ` · ${reward.my_latest.feedback}`}
        </p>
      )}

      {reward.tally.length > 0 && (
        <div>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-1 text-xs text-muted-foreground" onClick={() => setShowTally(!showTally)}>
            {reward.tally.length} {reward.tally.length === 1 ? 'person' : 'people'} · {shared} shared · {peso(earned)}
            <ChevronDown className={`h-3 w-3 transition-transform ${showTally ? 'rotate-180' : ''}`} />
          </Button>
          {showTally && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 pt-1">
              {reward.tally.map(person => (
                <div key={person.id} className="contents">
                  <span className="min-w-0"><NameChip name={person.name || 'Someone'} /></span>
                  <span className="text-right text-muted-foreground">{person.count} shared</span>
                  <span className="text-right font-medium">{peso(person.php)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The author of a proposed collaboration attaches a reward to it: an amount
// for each observation, the most one person can earn, and what they are looking for.
// Without an `actionId` it makes an offer from scratch: the person says what
// they want, which becomes the proposed collaboration the reward sits on.
// With `editing`, it changes that offer instead: the same fields, filled in.
export function AddReward({ organizationId, actionId, editing, onDone }: {
  organizationId: string;
  actionId?: string;
  editing?: OfferedReward;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const add = useAddReward();
  const change = useEditReward();
  const createGoal = useCreateGoal();
  const [open, setOpen] = useState(!!editing);
  const [want, setWant] = useState('');
  const [php, setPhp] = useState(String(editing?.php ?? 5));
  const [cap, setCap] = useState(editing ? String(editing.cap_php_per_person ?? '') : '500');
  const [ask, setAsk] = useState(editing?.ask ?? '');
  const [budget, setBudget] = useState(String(editing?.budget_php ?? ''));

  if (!open) {
    return actionId ? (
      <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-muted-foreground" onClick={() => setOpen(true)}>
        <Coins className="h-4 w-4" />
        Add a reward
      </Button>
    ) : (
      <Button size="sm" className="gap-1 bg-orange-500 text-white hover:bg-orange-600" onClick={() => setOpen(true)}>
        <Coins className="h-4 w-4" />
        Make an offer
      </Button>
    );
  }

  const amount = Number(php);
  const most = cap.trim() ? Number(cap) : null;
  const total = ask.trim() && budget.trim() ? Number(budget) : null;
  const valid = amount > 0 && (most === null || most >= amount) && (total === null || total >= amount) &&
    (editing ? !!ask.trim() : !!actionId || !!want.trim());
  const saving = add.isPending || createGoal.isPending || change.isPending;
  const close = () => {
    setOpen(false);
    onDone?.();
  };
  const failed = (error: unknown) =>
    toast({ title: actionId ? 'Could not add the reward' : 'Could not make the offer', description: errorMessage(error), variant: 'destructive' });
  const save = async () => {
    if (editing) {
      change.mutate({ organizationId, rewardId: editing.id, php: amount, capPerPerson: most, ask: ask.trim(), budget: total }, {
        onSuccess: close,
        onError: error => toast({ title: 'Could not save the change', description: errorMessage(error), variant: 'destructive' }),
      });
      return;
    }
    let target = actionId;
    if (!target) {
      // What they want is saved first. If the reward then fails, it stays as their
      // proposed collaboration, where the reward can be added.
      try {
        target = (await createGoal.mutateAsync({ organization_id: organizationId, desired_state: want.trim() }) as { id: string }).id;
      } catch (error) {
        failed(error);
        return;
      }
    }
    add.mutate({ organizationId, actionId: target, php: amount, capPerPerson: most, ask: ask.trim() || undefined, budget: total ?? undefined }, {
      onSuccess: () => {
        setOpen(false);
        setWant('');
        setAsk('');
        setBudget('');
      },
      onError: failed,
    });
  };

  return (
    <div className="space-y-2 text-sm">
      {!actionId && !editing && (
        <Input
          value={want} onChange={e => setWant(e.target.value)}
          placeholder="What do you want? For example: photos of how you farm"
          aria-label="What do you want?"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span>₱</span>
        <Input className="h-8 w-20" type="number" inputMode="decimal" value={php} onChange={e => setPhp(e.target.value)} aria-label="Pesos for each observation" />
        <span>at most for one observation, up to ₱</span>
        <Input className="h-8 w-24" type="number" inputMode="decimal" value={cap} onChange={e => setCap(e.target.value)} aria-label="Most one person can earn, in pesos" />
        <span>per person</span>
      </div>
      <Textarea
        rows={2} value={ask} onChange={e => setAsk(e.target.value)}
        placeholder="What are you looking for, and how is one observation valued? Say what is worth the full amount and how that falls off."
        aria-label="What are you looking for, and how is it valued?"
      />
      {ask.trim() && (
        <div className="flex flex-wrap items-center gap-2">
          <span>Stop when ₱</span>
          <Input className="h-8 w-28" type="number" inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} aria-label="Most this offer pays in total, in pesos" />
          <span>has been paid in total (optional)</span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        With this, an AI reads each observation against it and pays anything from nothing up to the amount. Say what is new for
        the person or for the network if that matters. Everyone sees exactly what you write here, so be as precise as you like, a
        formula included. Left empty, any photo with a description is paid the amount.
      </p>
      <p className="text-xs text-muted-foreground">
        Paid by the organization you are working as. The terms can't be changed afterwards; close it and add another to change them.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
        <Button size="sm" variant="outline" disabled={!valid || saving} onClick={save}>
          {saving ? 'Saving...' : editing ? 'Save' : actionId ? 'Add reward' : 'Make offer'}
        </Button>
      </div>
    </div>
  );
}
