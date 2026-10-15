import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Coins, Info, MoreHorizontal } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useImageUpload } from '@/hooks/useImageUpload';
import { useAcceptReward, useAddReward, useCloseReward, useCreateGoal, useEditReward } from '@/hooks/positiveSum/usePositiveSum';
import { errorMessage } from '@/lib/apiService';
import { openImage } from '@/lib/imageUtils';
import type { OfferedReward } from '@/types/positiveSum';
import { SharedObservations } from './SharedObservations';

const peso = (n: number) => `₱${Math.round(n).toLocaleString()}`;
// The one filled button on an offer: how a person takes part. Positive Sum orange.
const PRIMARY = 'bg-orange-500 text-white hover:bg-orange-600';

function NameChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground break-words">
      {name}
    </span>
  );
}

// A person's own progress on an offer, together in one place: what they have
// shared and earned, how far that is toward the most it pays one person, and
// the picture they collect by reaching it. Gray until then; in color after.
function YourProgress({ joined, count, earned, cap, image, hint }: {
  joined: boolean; count: number; earned: number; cap: number | null; image?: string | null; hint?: string;
}) {
  const complete = cap !== null && earned >= cap;
  return (
    <div className="flex shrink-0 items-center gap-3 sm:justify-end">
      <div className="min-w-0 space-y-1 sm:text-right">
        {joined && (
          <p>
            You: {count} shared · <span className="font-medium">{peso(earned)}</span>
            {cap !== null && <span className="text-muted-foreground"> of {peso(cap)}</span>}
            {hint && <span className="text-muted-foreground"> · {hint}</span>}
          </p>
        )}
        {joined && cap !== null && (
          <div
            className="h-1.5 w-40 overflow-hidden rounded-full sm:ml-auto bg-amber-200 dark:bg-amber-900"
            role="progressbar" aria-label="Toward the most one person can earn" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(earned, cap)}
          >
            <div className="h-full rounded-full bg-green-600" style={{ width: `${Math.min(100, (earned / cap) * 100)}%` }} />
          </div>
        )}
        {/* The bar and the gray picture say how far there is to go; words only for what they cannot. */}
        {image && (complete || cap === null) && (
          <p className="text-xs text-muted-foreground">
            {complete ? <span className="font-medium text-green-700 dark:text-green-400">Collected</span> : 'Collected when you complete this offer'}
          </p>
        )}
      </div>
      {image && (
        <button type="button" onClick={() => openImage(image)} className="shrink-0" aria-label="Open the picture">
          <img
            src={image} alt={complete ? 'Collected' : 'Collected when you complete this offer'}
            className={`h-20 w-36 rounded-md border object-cover transition duration-700 ${complete ? '' : 'grayscale'}`}
          />
        </button>
      )}
    </div>
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
  const [menu, setMenu] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: errorMessage(error), variant: 'destructive' });
  const mine = reward.tally.find(person => person.id === userId);
  const shared = reward.tally.reduce((sum, person) => sum + person.count, 0);
  const earned = reward.tally.reduce((sum, person) => sum + person.php, 0);
  // A person taking part, not its owner, who keeps the full terms in view.
  const joined = !!reward.accepted_by_me && reward.owner !== userId;
  const fullTerms = (
    <>
      <span className="font-medium">
        {reward.ask ? `Up to ${peso(reward.php)} for each observation` : `${peso(reward.php)} for each photo with a description`}
      </span>
      {reward.cap_php_per_person ? `, up to ${peso(reward.cap_php_per_person)} per person` : ''}
      {reward.budget_php ? ` · ${peso(reward.spent_php ?? 0)} of ${peso(reward.budget_php)} used` : ''}
      {' · '}paid by {reward.payer_name}
    </>
  );

  if (editing) {
    return (
      <div className="rounded-md border border-amber-600/40 bg-amber-50 p-2 dark:border-amber-500/40 dark:bg-amber-950/30">
        <AddReward organizationId={organizationId} editing={reward} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-600/40 bg-amber-50 p-2 text-sm dark:border-amber-500/40 dark:bg-amber-950/30">
      {/* The offer on the left; in the top right, the person's own progress and what completing it earns,
          kept in view above the shares, however many there are. On a phone it goes under the buttons. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <Coins className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
              {/* Once a person has joined, the terms are decided: the header keeps what one share is worth and who pays,
                  their progress below shows the rest, and the full terms stay in the ⓘ. */}
              {joined ? (
                <span className="break-words">
                  <span className="font-medium">{reward.ask ? `Up to ${peso(reward.php)} each` : `${peso(reward.php)} per photo`}</span>
                  {' · '}{reward.payer_name}
                  {reward.closed && ' · closed'}
                </span>
              ) : (
                <span className="break-words">
                  {fullTerms}
                  {reward.closed && ' · closed'}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {!reward.closed && !reward.accepted_by_me && !reading && (
                <Button size="sm" className={PRIMARY} onClick={() => setReading(true)}>Earn this</Button>
              )}
              {/* Sharing from here is what makes it an observation made through Positive Sum. */}
              {!reward.closed && reward.accepted_by_me && reward.ask && reward.action_id && (
                <Button size="sm" className={PRIMARY} onClick={() => navigate(`/combined-assets/actions/${reward.action_id}/observation`)}>
                  Share an observation
                </Button>
              )}
              {/* Its owner's tools, set apart from taking part. Closing cannot be undone, so it asks first. */}
              {!reward.closed && reward.owner === userId && (
                <Popover open={menu} onOpenChange={setMenu}>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Offer options">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="flex w-44 flex-col p-1">
                    {reward.ask && (
                      <Button size="sm" variant="ghost" className="justify-start" onClick={() => { setMenu(false); setEditing(true); }}>Edit</Button>
                    )}
                    <Button size="sm" variant="ghost" className="justify-start text-destructive" onClick={() => { setMenu(false); setConfirmClose(true); }}>
                      Close offer…
                    </Button>
                  </PopoverContent>
                </Popover>
              )}
              {/* The payer's own words, in full: this is what the AI reads each observation against. */}
              {reward.ask && (
                <Popover>
                  <PopoverTrigger asChild>
                    {/* A full-size target for a thumb. */}
                    <Button size="sm" variant="ghost" className="h-11 w-11 p-0" aria-label="How it is valued">
                      <Info className="h-5 w-5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto text-sm">
                    {joined && <p className="mb-2 break-words text-muted-foreground">{fullTerms}</p>}
                    <p className="mb-1 font-medium">How it is valued</p>
                    {/* Payers often write it in Markdown (bold labels, lists): shown formatted. */}
                    <div className="prose prose-sm max-w-none break-words dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{reward.ask}</ReactMarkdown>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </span>
          </div>
        </div>
        {(reward.accepted_by_me || reward.image) && (
          <YourProgress
            joined={!!reward.accepted_by_me} count={mine?.count ?? 0} earned={mine?.php ?? 0}
            cap={reward.cap_php_per_person ?? null} image={reward.image}
            hint={!reward.closed && !reward.ask ? 'Open this to add a photo with a description.' : undefined}
          />
        )}
      </div>

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

      {/* Whose these are: its owner, who pays, sees everyone's; anyone else sees their own. */}
      {(reward.observations?.length ?? 0) > 0 && (
        <p className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {reward.owner === userId ? 'Everyone’s shares' : 'Your shares'}
        </p>
      )}
      {/* Nothing is credited until it has been read, so an amount never appears and then shrinks. */}
      <SharedObservations observations={reward.observations ?? []} payerName={reward.payer_name} />

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

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this offer?</AlertDialogTitle>
            <AlertDialogDescription>
              New observations stop earning from it. What people have already earned stays. It cannot be reopened.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => close.mutate({ organizationId, rewardId: reward.id }, { onError: failed('Could not close it') })}>
              Close it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const [image, setImage] = useState(editing?.image ?? '');
  const { uploadSingleImage, isUploading } = useImageUpload();

  if (!open) {
    return actionId ? (
      <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-muted-foreground" onClick={() => setOpen(true)}>
        <Coins className="h-4 w-4" />
        Add a proposal
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
  const saving = add.isPending || createGoal.isPending || change.isPending || isUploading;
  const pick = async (file?: File) => {
    if (!file) return;
    try {
      setImage((await uploadSingleImage(file, { maxSizeMB: 2, maxWidthOrHeight: 1920 })).url);
    } catch (error) {
      toast({ title: 'Could not add the picture', description: errorMessage(error), variant: 'destructive' });
    }
  };
  const close = () => {
    setOpen(false);
    onDone?.();
  };
  const failed = (error: unknown) =>
    toast({ title: actionId ? 'Could not add the reward' : 'Could not make the offer', description: errorMessage(error), variant: 'destructive' });
  const save = async () => {
    if (editing) {
      change.mutate({ organizationId, rewardId: editing.id, php: amount, capPerPerson: most, ask: ask.trim(), budget: total, image: image || null }, {
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
    add.mutate({ organizationId, actionId: target, php: amount, capPerPerson: most, ask: ask.trim() || undefined, budget: total ?? undefined, image: image || null }, {
      onSuccess: () => {
        setOpen(false);
        setWant('');
        setAsk('');
        setBudget('');
        setImage('');
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
      <div className="flex flex-wrap items-center gap-2">
        {image && <img src={image} alt="The picture people collect" className="h-12 w-20 rounded border object-cover" />}
        <label className="cursor-pointer text-xs underline">
          {isUploading ? 'Adding the picture...' : image ? 'Change the picture' : 'Add a picture people collect when they reach the most per person (optional)'}
          <input type="file" accept="image/*" className="hidden" disabled={isUploading} onChange={e => pick(e.target.files?.[0])} aria-label="Picture people collect" />
        </label>
        {image && <Button size="sm" variant="ghost" className="h-7 px-1 text-xs" onClick={() => setImage('')}>Remove</Button>}
      </div>
      <p className="text-xs text-muted-foreground">
        With this, an AI reads each observation against it and pays anything from nothing up to the amount. Say what is new for
        the person or for the network if that matters. Everyone sees exactly what you write here, so be as precise as you like, a
        formula included. Left empty, any photo with a description is paid the amount.
      </p>
      <p className="text-xs text-muted-foreground">
        Paid by the organization you are working as. With what you are looking for, you can change it at any time; what was
        already credited stays. Without it, the terms can't be changed afterwards; close it and add another.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
        <Button size="sm" variant="outline" disabled={!valid || saving} onClick={save}>
          {saving ? 'Saving...' : editing ? 'Save' : actionId ? 'Add proposal' : 'Make offer'}
        </Button>
      </div>
    </div>
  );
}
