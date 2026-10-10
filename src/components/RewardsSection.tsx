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
import {
  advantage, advantageRows, balance, breakEvenRate, formatAmount, formatBalance, hasAny, netAtRate, nextBestOptions,
  nextBestStatement, noOtherOptionStatement, signFor, totalsByParty, type AdvantageRow, type Balance,
} from '@/lib/rewards';

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

const OPTION_KIND_LABELS: Record<NextBestOption['kind'], string> = {
  cost_another_way: 'Cost another way',
  had_otherwise: 'Would have had otherwise',
  no_other_option: 'No other option',
};

function NextBestOptionCard({ option, claims, orgNames }: {
  option: NextBestOption;
  claims: RewardClaim[];
  orgNames: Record<string, string>;
}) {
  const value = advantage(option, claims);
  const party = option.for_org_id ? orgNames[option.for_org_id] ?? option.for_name : option.for_name;
  return (
    <div className="space-y-1 rounded-md border border-dashed p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-words">Next-best option: {option.name}</span>
        {option.kind !== 'no_other_option' && <span className="font-medium">{formatAmount(option.php, option.hours)}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {party && <PartyChip id={option.for_org_id} name={option.for_name} orgNames={orgNames} />}
        <Badge variant="outline">{OPTION_KIND_LABELS[option.kind]}</Badge>
        {option.done_by && option.hours !== null && <span>Time: {option.done_by}</span>}
        {!!option.stated_by?.length && <span>Documented by {option.stated_by.join(', ')}</span>}
      </div>
      {value && (
        <p className="text-sm font-medium">Advantage{party ? ` for ${party}` : ''}: {formatBalance(value)}</p>
      )}
      <p className="text-sm text-muted-foreground break-words">{option.claim}</p>
      {option.replaces.length > 0 && (
        <p className="text-xs text-muted-foreground break-words">Instead of: {option.replaces.join(', ')}</p>
      )}
      {value && (
        <HourValue
          value={value}
          label={option.done_by ? `An hour of ${option.done_by}'s time is worth ₱` : 'An hour of that time is worth ₱'}
          netLabel="Advantage"
        />
      )}
    </div>
  );
}

// Converts hours to pesos at a value the viewer chooses, or finds the hourly
// value where money and time break even. Nothing is stored.
function HourValue({ value, label, netLabel }: { value: Balance; label: string; netLabel: string }) {
  const [rate, setRate] = useState('');
  const breakEven = breakEvenRate(value);
  if (breakEven === null) return null;

  const { hours } = value;
  const entered = Number(rate);
  const net = rate.trim() && Number.isFinite(entered) ? netAtRate(value, entered) : null;
  const peso = (n: number) => `${n < 0 ? '−' : '+'}₱${Math.abs(Math.round(n)).toLocaleString()}`;

  return (
    <div className="space-y-1 rounded-md bg-muted/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>{label}</span>
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
          {netLabel}:{' '}
          <span className={net < 0 ? 'font-medium text-destructive' : 'font-medium text-green-700 dark:text-green-400'}>{peso(net)}</span>
        </p>
      )}
      {breakEven < 0 && (
        <p className="text-muted-foreground">
          {hours < 0 ? 'Even with time valued at zero, this cost more money than it brought in.' : 'Gained time and money — no break-even to find.'}
        </p>
      )}
    </div>
  );
}

// One party's advantage, and the fields for documenting its next-best option.
// What is entered is saved as the person's observation, so it stays their
// claim and they are credited with documenting it.
function AdvantageRowView({ row, orgNames, onSave }: {
  row: AdvantageRow;
  orgNames: Record<string, string>;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [what, setWhat] = useState('');
  const [php, setPhp] = useState('');
  const [hours, setHours] = useState('');
  const [who, setWho] = useState('');
  const [saving, setSaving] = useState(false);

  const party = row.id ? orgNames[row.id] ?? row.name : row.name;
  const documentedBy = [...new Set(row.options.flatMap(o => o.stated_by ?? []))];

  const save = async (text: string) => {
    setSaving(true);
    const ok = await onSave(text);
    setSaving(false);
    if (ok) {
      setAdding(false);
      setWhat('');
      setPhp('');
      setHours('');
      setWho('');
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0"><PartyChip id={row.id} name={row.name} orgNames={orgNames} /></span>
        <span className={row.value ? 'font-medium' : 'text-muted-foreground'}>
          {row.value ? formatBalance(row.value) : row.noOtherOption ? 'Not evaluated' : row.options.length ? 'Not stated' : 'Next best not documented'}
        </span>
      </div>
      {row.noOtherOption && !row.value && (
        <p className="text-xs text-muted-foreground">No other option — this expanded what {party} can do, so there is nothing to compare it with.</p>
      )}
      {documentedBy.length > 0 && <p className="text-xs text-muted-foreground">Documented by {documentedBy.join(', ')}</p>}

      {adding ? (
        <div className="space-y-2 pt-1">
          <Textarea
            rows={2}
            placeholder={row.paid ? `What would ${party} have done otherwise to get this?` : `What would ${party} have had otherwise?`}
            value={what}
            onChange={e => setWhat(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Input className="w-32" type="number" inputMode="decimal" placeholder="₱, optional" value={php} onChange={e => setPhp(e.target.value)} />
            <Input className="w-32" type="number" inputMode="decimal" placeholder="Hours, optional" value={hours} onChange={e => setHours(e.target.value)} />
            {hours.trim() && (
              <Input className="w-40" placeholder="Whose hours?" value={who} onChange={e => setWho(e.target.value)} />
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {row.paid && (
              <Button variant="outline" size="sm" className="mr-auto" disabled={saving} onClick={() => save(noOtherOptionStatement(party))}>
                No other option
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={saving || !what.trim()}
              onClick={() => save(nextBestStatement({ party, paid: row.paid, what, php, hours, who }))}
            >
              {saving ? 'Saving...' : 'Save and rebuild'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdding(true)}>
            {row.options.length ? 'Add another next best' : 'Document next best'}
          </Button>
        </div>
      )}
    </div>
  );
}

// More about what happened, said in the person's own words; saved as an
// observation and followed by a rebuild.
function AddObservation({ onAdd }: { onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    if (await onAdd(text.trim())) setText('');
    setSaving(false);
  };

  return (
    <div className="space-y-2">
      <Textarea
        rows={2}
        placeholder="What happened, or what would you (or they) have done otherwise?"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className="flex justify-end">
        <Button size="sm" disabled={saving || !text.trim()} onClick={save}>
          {saving ? 'Saving...' : 'Add and rebuild'}
        </Button>
      </div>
    </div>
  );
}

type EntityLink = { entity_type: string; entity_id: string };

// Rewards of an action: claims derived from its observations by AI, rebuilt on
// request. Adjustments are saved as observations so a rebuild keeps them.
// For an action made from a transaction, `alsoLinkTo` is the transaction:
// people add observations here, linked to both; `justCreated` opens it while
// the first build, started with the action, is still running.
export function RewardsSection({ actionId, alsoLinkTo, justCreated = false }: {
  actionId: string;
  alsoLinkTo?: EntityLink;
  justCreated?: boolean;
}) {
  const [open, setOpen] = useState(justCreated);
  const { toast } = useToast();
  const { organization } = useOrganization();
  const { createState } = useStateMutations(organization?.id ?? '', { entity_type: 'action', entity_id: actionId });
  const { data, isLoading, rebuild, isBuilding } = useActionReward(actionId, open, justCreated);

  const orgNames = data?.org_names ?? {};
  const claims = data?.claims;
  const partyName = (id: string | null, name: string) => (id ? orgNames[id] ?? name : name);

  const startRebuild = () =>
    rebuild.mutate(undefined, {
      onError: error => toast({ title: 'Could not rebuild', description: errorMessage(error), variant: 'destructive' }),
    });

  const links: EntityLink[] = [{ entity_type: 'action', entity_id: actionId }, ...(alsoLinkTo ? [alsoLinkTo] : [])];

  const saveObservation = async (text: string, failure: string) => {
    try {
      await createState({ state_text: text, photos: [], links });
      startRebuild();
      return true;
    } catch (error) {
      toast({ title: failure, description: errorMessage(error), variant: 'destructive' });
      return false;
    }
  };

  const saveAdjustment = (c: RewardClaim, php: string, hours: string, note: string) => {
    const amounts = [php.trim() && `₱${php.trim()}`, hours.trim() && `${hours.trim()} hours`].filter(Boolean).join(' and ');
    const parts = [
      `Adjustment to "${c.name}" (${partyName(c.from_org_id, c.from_name)} → ${partyName(c.to_org_id, c.to_name)}):`,
      amounts && `the amount is ${amounts}.`,
      note.trim(),
    ].filter(Boolean);
    return saveObservation(parts.join(' '), 'Could not save the adjustment');
  };

  const totals = claims ? totalsByParty(claims) : [];
  const options = data && claims ? nextBestOptions(data) : [];
  const rows = claims ? advantageRows(claims, options) : [];
  const evaluated = rows.flatMap(r => (r.value ? [r.value] : []));
  const advantageTotal = evaluated.reduce<Balance>(
    (sum, v) => ({ money: sum.money + v.money, hours: sum.hours + v.hours }), { money: 0, hours: 0 }
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
          What moved between organizations in this action — money and time as people stated them. Built by AI from the
          observations; add or edit observations, or adjust a claim, then rebuild.
        </InfoBubble>
      </div>

      <CollapsibleContent className="space-y-3 px-3 pb-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && !data && (
          <p className="text-sm text-muted-foreground">
            {isBuilding ? 'Building the rewards...' : 'No rewards yet. Add observations about what happened, then rebuild.'}
          </p>
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

        {claims && options.map((o, i) => (
          <NextBestOptionCard key={`${o.name}-${i}`} option={o} claims={claims} orgNames={orgNames} />
        ))}

        {rows.length > 0 && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2 text-sm">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium text-muted-foreground">Advantage</span>
              <InfoBubble>
                How much better this was for each party than its next-best option — what it would otherwise have done
                or had. The next best never happened, so it is the claim of whoever documents it, and they are credited
                with documenting it.
              </InfoBubble>
            </div>
            {rows.map(row => (
              <AdvantageRowView
                key={row.id ?? row.name}
                row={row}
                orgNames={orgNames}
                onSave={text => saveObservation(text, 'Could not save the next best')}
              />
            ))}
            {evaluated.length > 1 && (
              <div className="flex items-center justify-between gap-2 border-t pt-2 font-medium">
                <span>Total</span>
                <span>{formatBalance(advantageTotal)}</span>
              </div>
            )}
          </div>
        )}

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
          return mine ? <HourValue value={balance(mine)} label="My hour is worth ₱" netLabel="Net for this action" /> : null;
        })()}

        {alsoLinkTo && <AddObservation onAdd={text => saveObservation(text, 'Could not save the observation')} />}

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
