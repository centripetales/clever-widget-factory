import { Fragment, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InfoBubble } from '@/components/positiveSum/InfoBubble';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/hooks/useOrganization';
import { useStateMutations } from '@/hooks/useStates';
import { useActionReward } from '@/hooks/useActionReward';
import { errorMessage } from '@/lib/apiService';
import type { NextBestOption, RewardClaim } from '@/types/rewards';

const COST_BASIS_LABELS: Record<NonNullable<RewardClaim['cost_basis_method']>, string> = {
  purchase_price: 'Purchase price',
  next_best_option_price: 'Next-best option price',
};

// A party on a claim: solid when it's an organization in the app, dashed with
// the name people used when it isn't (yet).
function PartyChip({ id, name, orgNames }: { id: string | null; name: string; orgNames: Record<string, string> }) {
  return id ? (
    <span className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground break-words">
      {orgNames[id] ?? name}
    </span>
  ) : (
    <span className="inline-flex max-w-full items-center rounded-full border border-dashed border-muted-foreground/50 px-2 py-0.5 text-xs text-muted-foreground break-words">
      {name}
    </span>
  );
}

// Amounts are only what people stated; null means not stated. Stored amounts
// are positive with the direction in from → to; `sign` shows them from one
// org's point of view.
function formatAmount(php: number | null, hours: number | null, sign: '+' | '−' | '' = '') {
  const parts = [
    php !== null && `${sign}₱${Math.round(php).toLocaleString()}`,
    hours !== null && `${sign}${Math.round(hours * 10) / 10} ${hours === 1 ? 'hour' : 'hours'}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Not stated';
}

// From the viewer's org: what it gives or spends is negative, what it receives
// positive; claims between other parties stay unsigned.
function signFor(claim: RewardClaim, orgId: string | undefined): '+' | '−' | '' {
  if (!orgId) return '';
  if (claim.from_org_id === orgId) return '−';
  if (claim.to_org_id === orgId) return '+';
  return '';
}

type Sums = { php: number | null; hours: number | null };
const NONE: Sums = { php: null, hours: null };
const add = (sums: Sums, c: RewardClaim): Sums => ({
  php: c.php === null ? sums.php : (sums.php ?? 0) + c.php,
  hours: c.hours === null ? sums.hours : (sums.hours ?? 0) + c.hours,
});
const hasAny = (s: Sums) => s.php !== null || s.hours !== null;

interface PartyTotals {
  id: string | null;
  name: string;
  costs: Sums;
  benefits: Sums;
}

// Per party (org id, or the name when it isn't an org): stated costs (what it
// gave, promised or spent itself) and benefits — shown as gained (what it
// received).
function totalsByParty(claims: RewardClaim[]): PartyTotals[] {
  const totals = new Map<string, PartyTotals>();
  const party = (id: string | null, name: string) => {
    const key = id ?? `name:${name}`;
    if (!totals.has(key)) totals.set(key, { id, name, costs: NONE, benefits: NONE });
    return totals.get(key)!;
  };
  for (const c of claims) {
    const from = party(c.from_org_id, c.from_name);
    from.costs = add(from.costs, c);
    if ((c.from_org_id ?? c.from_name) !== (c.to_org_id ?? c.to_name)) {
      const to = party(c.to_org_id, c.to_name);
      to.benefits = add(to.benefits, c);
    }
  }
  return [...totals.values()].filter(t => hasAny(t.costs) || hasAny(t.benefits));
}

// Saved = next-best option's price − the claims it replaces, per component,
// only when both sides were stated.
function savings(option: NextBestOption, claims: RewardClaim[]): Sums {
  const replaced = claims.filter(c => option.replaces.includes(c.name));
  const saved = (key: 'php' | 'hours') =>
    option[key] !== null && replaced.length && replaced.every(c => c[key] !== null)
      ? option[key]! - replaced.reduce((sum, c) => sum + (c[key] as number), 0)
      : null;
  return { php: saved('php'), hours: saved('hours') };
}

function NextBestOptionCard({ option, claims }: { option: NextBestOption; claims: RewardClaim[] }) {
  const saved = savings(option, claims);
  return (
    <div className="space-y-1 rounded-md border border-dashed p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-words">Next-best option: {option.name}</span>
        <span className="font-medium">{formatAmount(option.php, option.hours)}</span>
      </div>
      {hasAny(saved) && (
        <p className="text-sm font-medium">Saved {formatAmount(saved.php, saved.hours)}</p>
      )}
      <p className="text-sm text-muted-foreground break-words">{option.claim}</p>
      {option.replaces.length > 0 && (
        <p className="text-xs text-muted-foreground break-words">Instead of: {option.replaces.join(', ')}</p>
      )}
    </div>
  );
}

// Converts the viewer org's hours to pesos at a value it chooses, or finds the
// hourly value where the action breaks even. Nothing is stored.
function HourValue({ totals }: { totals: PartyTotals }) {
  const [rate, setRate] = useState('');
  const money = (totals.benefits.php ?? 0) - (totals.costs.php ?? 0);
  const hours = (totals.benefits.hours ?? 0) - (totals.costs.hours ?? 0); // negative = time spent
  if (!hours) return null;

  const breakEven = -money / hours;
  const value = Number(rate);
  const net = rate.trim() && Number.isFinite(value) ? money + value * hours : null;
  const peso = (n: number) => `${n < 0 ? '−' : '+'}₱${Math.abs(Math.round(n)).toLocaleString()}`;

  return (
    <div className="space-y-1 rounded-md bg-muted/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>My hour is worth ₱</span>
        <Input
          type="number"
          inputMode="decimal"
          className="h-8 w-24"
          value={rate}
          onChange={e => setRate(e.target.value)}
          aria-label="Value of an hour in pesos"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={breakEven < 0}
          onClick={() => setRate(String(Math.round(breakEven)))}
        >
          Calc my break-even
        </Button>
      </div>
      {net !== null && (
        <p>
          Net for this action:{' '}
          <span className={net < 0 ? 'font-medium text-destructive' : 'font-medium text-green-700 dark:text-green-400'}>{peso(net)}</span>
        </p>
      )}
      {breakEven < 0 && (
        <p className="text-muted-foreground">
          {hours < 0 ? 'Even with time valued at zero, this action cost more money than it brought in.' : 'Gained time and money — no break-even to find.'}
        </p>
      )}
    </div>
  );
}

// Rewards of an action: claims derived from its observations by AI, rebuilt on
// request. Adjustments are saved as observations so a rebuild keeps them.
export function RewardsSection({ actionId }: { actionId: string }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { organization } = useOrganization();
  const { createState } = useStateMutations(organization?.id ?? '', { entity_type: 'action', entity_id: actionId });
  const { data, isLoading, rebuild, isBuilding } = useActionReward(actionId, open);

  const orgNames = data?.org_names ?? {};
  const claims = data?.claims;
  const partyName = (id: string | null, name: string) => (id ? orgNames[id] ?? name : name);

  const startRebuild = () =>
    rebuild.mutate(undefined, {
      onError: error => toast({ title: 'Could not rebuild', description: errorMessage(error), variant: 'destructive' }),
    });

  const saveAdjustment = async (c: RewardClaim, php: string, hours: string, note: string) => {
    const amounts = [php.trim() && `₱${php.trim()}`, hours.trim() && `${hours.trim()} hours`].filter(Boolean).join(' and ');
    const parts = [
      `Adjustment to "${c.name}" (${partyName(c.from_org_id, c.from_name)} → ${partyName(c.to_org_id, c.to_name)}):`,
      amounts && `the amount is ${amounts}.`,
      note.trim(),
    ].filter(Boolean);
    try {
      await createState({ state_text: parts.join(' '), photos: [], links: [{ entity_type: 'action', entity_id: actionId }] });
      startRebuild();
      return true;
    } catch (error) {
      toast({ title: 'Could not save the adjustment', description: errorMessage(error), variant: 'destructive' });
      return false;
    }
  };

  const totals = claims ? totalsByParty(claims) : [];

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 rounded-md border">
      <div className="flex items-center gap-1 px-3 py-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1 px-1 font-medium">
            Rewards <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </Button>
        </CollapsibleTrigger>
        <InfoBubble>
          What moved between organizations in this action — money and time as people stated them. Built by AI from the
          observations; add or edit observations, or adjust a claim, then rebuild.
        </InfoBubble>
      </div>

      <CollapsibleContent className="space-y-3 px-3 pb-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && !data && (
          <p className="text-sm text-muted-foreground">No rewards yet. Add observations about what happened, then rebuild.</p>
        )}
        {data && !claims && (
          <p className="text-sm text-muted-foreground">These rewards were built in an older format. Rebuild to update them.</p>
        )}
        {data?.status === 'FAILED' && (
          <p className="text-sm text-destructive">The last rebuild failed: {data.error}</p>
        )}

        {claims?.map((c, i) => (
          <ClaimCard key={`${c.name}-${i}`} claim={c} orgNames={orgNames} sign={signFor(c, organization?.id)} onAdjust={saveAdjustment} />
        ))}

        {claims && data?.next_best_option && <NextBestOptionCard option={data.next_best_option} claims={claims} />}

        {totals.length > 0 && (
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 p-2 text-sm">
            <span />
            <span className="text-right text-xs font-medium text-muted-foreground">Gained</span>
            <span className="text-right text-xs font-medium text-muted-foreground">Cost</span>
            {totals.map(t => (
              <Fragment key={t.id ?? t.name}>
                <span className="min-w-0"><PartyChip id={t.id} name={t.name} orgNames={orgNames} /></span>
                <span className="text-right text-green-700 dark:text-green-400">
                  {hasAny(t.benefits) ? formatAmount(t.benefits.php, t.benefits.hours, '+') : '—'}
                </span>
                <span className="text-right text-destructive">
                  {hasAny(t.costs) ? formatAmount(t.costs.php, t.costs.hours, '−') : '—'}
                </span>
              </Fragment>
            ))}
          </div>
        )}

        {(() => {
          const mine = totals.find(t => t.id && t.id === organization?.id);
          return mine ? <HourValue totals={mine} /> : null;
        })()}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {data?.created_at && `Updated ${new Date(data.created_at).toLocaleString()}`}
          </span>
          <Button variant="outline" size="sm" className="gap-2" disabled={isBuilding} onClick={startRebuild}>
            <RefreshCw className={`h-4 w-4 ${isBuilding ? 'animate-spin' : ''}`} />
            {isBuilding ? 'Rebuilding...' : 'Rebuild'}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ClaimCard({ claim, orgNames, sign, onAdjust }: {
  claim: RewardClaim;
  orgNames: Record<string, string>;
  sign: '+' | '−' | '';
  onAdjust: (claim: RewardClaim, php: string, hours: string, note: string) => Promise<boolean>;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [php, setPhp] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const ok = await onAdjust(claim, php, hours, note);
    setSaving(false);
    if (ok) {
      setAdjusting(false);
      setPhp('');
      setHours('');
      setNote('');
    }
  };

  return (
    <div className="space-y-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-words">{claim.name}</span>
        <span className={`font-medium ${sign === '−' ? 'text-destructive' : ''}`}>{formatAmount(claim.php, claim.hours, sign)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PartyChip id={claim.from_org_id} name={claim.from_name} orgNames={orgNames} />
        <span aria-hidden>→</span>
        <PartyChip id={claim.to_org_id} name={claim.to_name} orgNames={orgNames} />
        {claim.cost_basis_method && <Badge variant="outline">{COST_BASIS_LABELS[claim.cost_basis_method]}</Badge>}
      </div>
      <p className="text-sm text-muted-foreground break-words">{claim.claim}</p>

      {adjusting ? (
        <div className="space-y-2 pt-1">
          <div className="flex gap-2">
            <Input type="number" inputMode="decimal" placeholder="₱, optional" value={php} onChange={e => setPhp(e.target.value)} />
            <Input type="number" inputMode="decimal" placeholder="Hours, optional" value={hours} onChange={e => setHours(e.target.value)} />
          </div>
          <Textarea
            rows={2}
            placeholder="What should change, and why?"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdjusting(false)}>Cancel</Button>
            <Button size="sm" disabled={saving || (!php.trim() && !hours.trim() && !note.trim())} onClick={save}>
              {saving ? 'Saving...' : 'Save and rebuild'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdjusting(true)}>Adjust</Button>
        </div>
      )}
    </div>
  );
}
