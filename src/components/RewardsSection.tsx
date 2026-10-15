import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { InfoBubble } from '@/components/positiveSum/InfoBubble';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/hooks/useOrganization';
import { useStateMutations, useStates } from '@/hooks/useStates';
import { useActionReward } from '@/hooks/useActionReward';
import { errorMessage } from '@/lib/apiService';
import type { NextBestOption, RewardClaim } from '@/types/rewards';
import type { Observation } from '@/types/observations';
import {
  advantage, advantageRows, balance, breakEvenRate, formatAmount, formatBalance, netAtRate, nextBestOptions,
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

// A person, shown the same way as an organization in the app.
function NameChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground break-words">
      {name}
    </span>
  );
}

// What a party's time in its expected advantage is worth in pesos — a total the
// viewer enters, substituted for the hours. Time gained adds it; time spent
// takes it away. Nothing is stored.
const withTimeValued = ({ money, hours }: Balance, amount: number) => money + Math.sign(hours) * amount;

function OpportunityCost({ party, chip, value, amount, onChange, onDone }: {
  party: string;
  chip: ReactNode;
  value: Balance;
  amount: string;
  onChange: (amount: string) => void;
  onDone: () => void; // the person finished entering it: save
}) {
  if (!value.hours) return null;
  const entered = Number(amount);
  const net = amount.trim() && Number.isFinite(entered) ? withTimeValued(value, entered) : null;
  const peso = (n: number) => `${n < 0 ? '−' : '+'}₱${Math.abs(Math.round(n)).toLocaleString()}`;

  return (
    <div className="space-y-1 rounded-md bg-muted/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex flex-wrap items-center gap-1">Opportunity cost of {chip} time ({formatAmount(null, Math.abs(value.hours))}): ₱</span>
        <Input
          type="number"
          inputMode="decimal"
          className="h-8 w-24"
          value={amount}
          onChange={e => onChange(e.target.value)}
          onBlur={onDone}
          aria-label={`Opportunity cost of ${party} time in pesos`}
        />
      </div>
      {net !== null && (
        <p>
          Expected advantage:{' '}
          <span className={net < 0 ? 'font-medium text-destructive' : 'font-medium text-green-700 dark:text-green-400'}>{peso(net)}</span>
        </p>
      )}
    </div>
  );
}

// A documented next-best option, shown under its party's advantage.
function NextBestOptionDetail({ option, value, added, onEdit, onDelete }: {
  option: NextBestOption;
  value: Balance | null;
  added: Observation[];
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div className="space-y-1 rounded-md border border-dashed bg-background p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-words">Next best: {option.name}</span>
        {option.kind !== 'no_other_option' && <span className="font-medium">{formatAmount(option.php, option.hours)}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{OPTION_KIND_LABELS[option.kind]}</Badge>
        {!!option.stated_by?.length && (
          <span className="inline-flex flex-wrap items-center gap-1">
            Documented by {option.stated_by.map(name => <NameChip key={name} name={name} />)}
          </span>
        )}
        {value && <span>Expected advantage against it: {formatBalance(value)}</span>}
      </div>
      <p className="text-sm text-muted-foreground break-words">{option.claim}</p>
      {option.replaces.length > 0 && (
        <p className="text-xs text-muted-foreground break-words">Instead of: {option.replaces.join(', ')}</p>
      )}
      <AddedSources sourceIds={option.source_state_ids} added={added} onEdit={onEdit} onDelete={onDelete} />
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

// One party's documented next-best options, and the fields for adding one.
// What is entered is saved as the person's observation, so it stays their
// claim and they are credited with documenting it.
function AdvantageRowView({ row, claims, orgNames, added, onSave, onEdit, onDelete }: {
  row: AdvantageRow;
  claims: RewardClaim[];
  orgNames: Record<string, string>;
  added: Observation[];
  onSave: (text: string) => Promise<boolean>;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [what, setWhat] = useState('');
  const [php, setPhp] = useState('');
  const [hours, setHours] = useState('');
  const [saving, setSaving] = useState(false);

  const party = row.id ? orgNames[row.id] ?? row.name : row.name;

  const save = async (text: string) => {
    setSaving(true);
    const ok = await onSave(text);
    setSaving(false);
    if (ok) {
      setAdding(false);
      setWhat('');
      setPhp('');
      setHours('');
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0"><PartyChip id={row.id} name={row.name} orgNames={orgNames} /></span>
        {!row.options.length && <span className="text-muted-foreground">Not documented</span>}
      </div>
      {row.noOtherOption && !row.value && (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          No other option — this expanded what <PartyChip id={row.id} name={row.name} orgNames={orgNames} /> can do, so there is nothing to compare it with.
        </p>
      )}
      {row.options.map((o, i) => (
        <NextBestOptionDetail
          key={`${o.name}-${i}`}
          option={o}
          value={row.options.length > 1 ? advantage(o, claims) : null}
          added={added}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}

      {adding ? (
        <div className="space-y-2 pt-1">
          <Textarea
            rows={2}
            placeholder={row.paid ? `What would ${party} have done otherwise to get this?` : `What would ${party} have had otherwise?`}
            value={what}
            onChange={e => setWhat(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Input className="w-36" type="number" inputMode="decimal" placeholder="Total ₱, optional" value={php} onChange={e => setPhp(e.target.value)} />
            <Input className="w-36" type="number" inputMode="decimal" placeholder="Hours, optional" value={hours} onChange={e => setHours(e.target.value)} />
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
              onClick={() => save(nextBestStatement({ party, paid: row.paid, what, php, hours }))}
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

// Something a person added here — an adjustment, a next-best option, another
// observation — with buttons to edit or remove it. Either changes that
// observation; the rewards are then rebuilt from what is left.
function AddedObservation({ observation: o, onEdit, onDelete }: {
  observation: Observation;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [text, setText] = useState<string | null>(null); // null: not editing
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    if (await onEdit(o.id, text!.trim())) setText(null);
    setSaving(false);
  };

  if (text !== null) {
    return (
      <div className="space-y-2 rounded-md border bg-background p-2 text-sm">
        <Textarea rows={3} value={text} onChange={e => setText(e.target.value)} aria-label="Observation" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setText(null)}>Cancel</Button>
          <Button size="sm" disabled={saving || !text.trim() || text.trim() === o.observation_text?.trim()} onClick={save}>
            {saving ? 'Saving...' : 'Save and rebuild'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-2 rounded-md border bg-background p-2 text-sm">
      <div className="min-w-0">
        <p className="break-words">{o.observation_text}</p>
        <p className="flex flex-wrap items-center gap-1 pt-1 text-xs text-muted-foreground">
          {o.captured_by_name && <NameChip name={o.captured_by_name} />}
          <span>{new Date(o.captured_at).toLocaleDateString()}</span>
        </p>
      </div>
      <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label="Edit this observation" onClick={() => setText(o.observation_text ?? '')}>
        <Pencil className="h-4 w-4" />
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label="Delete this observation">
            <Trash2 className="h-4 w-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this observation?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed for good and the rewards are rebuilt without it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDelete(o.id)}>Delete and rebuild</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// The added observations a claim or next best was built from, shown with it.
function AddedSources({ sourceIds, added, onEdit, onDelete }: {
  sourceIds: string[];
  added: Observation[];
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const sources = added.filter(o => sourceIds.includes(o.id));
  if (!sources.length) return null;
  return (
    <div className="space-y-1 pt-1">
      {sources.map(o => <AddedObservation key={o.id} observation={o} onEdit={onEdit} onDelete={onDelete} />)}
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
// people add observations here, linked to both, and can remove them again
// (all but `descriptionStateId`, the transaction's own description);
// `justCreated` opens it while the first build, started with the action, is
// still running.
export function RewardsSection({ actionId, alsoLinkTo, descriptionStateId, justCreated = false }: {
  actionId: string;
  alsoLinkTo?: EntityLink;
  descriptionStateId?: string;
  justCreated?: boolean;
}) {
  const [open, setOpen] = useState(justCreated);
  const { toast } = useToast();
  const { organization } = useOrganization();
  const actionFilter = { entity_type: 'action', entity_id: actionId };
  const { createState, updateState, deleteState } = useStateMutations(organization?.id ?? '', actionFilter);
  // Only an action made from a transaction lists them here; other actions show their observations in the dialog.
  const { data: observations = [] } = useStates(alsoLinkTo && open ? organization?.id ?? '' : '', actionFilter);
  const added = observations.filter(o => o.id !== descriptionStateId && o.observation_text?.trim());
  const { data, isLoading, rebuild, saveOpportunityCosts, isBuilding } = useActionReward(actionId, open, justCreated);

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

  // Shown with the claim or next best it led to; anything else is listed at the end.
  const shownIds = new Set([...(claims ?? []), ...(data && claims ? nextBestOptions(data) : [])].flatMap(x => x.source_state_ids));
  const unplaced = added.filter(o => !shownIds.has(o.id));

  const editObservation = async (id: string, text: string) => {
    try {
      await updateState({ id, data: { state_text: text } });
      startRebuild();
      return true;
    } catch (error) {
      toast({ title: 'Could not save the observation', description: errorMessage(error), variant: 'destructive' });
      return false;
    }
  };

  const removeObservation = async (id: string) => {
    try {
      await deleteState(id);
      startRebuild();
    } catch (error) {
      toast({ title: 'Could not delete the observation', description: errorMessage(error), variant: 'destructive' });
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
  // The opportunity cost entered for each party's time: a total in pesos that
  // stands in for its hours. Saved with the rewards when the person leaves the field.
  const [timeValues, setTimeValues] = useState<Record<string, string>>({});
  const savedCosts = JSON.stringify(data?.opportunity_costs ?? {});
  useEffect(() => {
    setTimeValues(Object.fromEntries(Object.entries(JSON.parse(savedCosts) as Record<string, number>).map(([k, v]) => [k, String(v)])));
  }, [savedCosts]);

  const saveTimeValues = () => {
    const costs = Object.fromEntries(Object.entries(timeValues)
      .filter(([, v]) => v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0)
      .map(([k, v]) => [k, Number(v)]));
    if (JSON.stringify(costs) === savedCosts) return;
    saveOpportunityCosts.mutate(costs, {
      onError: error => toast({ title: 'Could not save the opportunity cost', description: errorMessage(error), variant: 'destructive' }),
    });
  };
  const rowKey = (row: { id: string | null; name: string }) => row.id ?? `name:${row.name}`;
  const timeValueFor = (row: { id: string | null; name: string }) => {
    const entered = timeValues[rowKey(row)]?.trim();
    return entered && Number.isFinite(Number(entered)) ? Number(entered) : null;
  };
  const peso = (n: number) => `${n < 0 ? '−' : ''}₱${Math.abs(Math.round(n)).toLocaleString()}`;
  const signColor = (n: number) => (n > 0 ? 'text-green-700 dark:text-green-400' : n < 0 ? 'text-destructive' : '');

  const evaluated = rows.filter(r => r.value);
  const advantageTotal = evaluated.reduce<Balance>((sum, r) => {
    const timeValue = timeValueFor(r);
    return timeValue === null || !r.value!.hours
      ? { money: sum.money + r.value!.money, hours: sum.hours + r.value!.hours }
      : { money: sum.money + withTimeValued(r.value!, timeValue), hours: sum.hours };
  }, { money: 0, hours: 0 });

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
          <ClaimCard
            key={`${c.name}-${i}`}
            claim={c}
            orgNames={orgNames}
            sign={signFor(c, organization?.id)}
            added={added}
            onAdjust={saveAdjustment}
            onEdit={editObservation}
            onDelete={removeObservation}
          />
        ))}

        {rows.length > 0 && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2 text-sm">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium text-muted-foreground">Next-best options</span>
              <InfoBubble>
                What each party would otherwise have done or had. It never happened, so it is the view of whoever
                documents it, for their own side or the other party's, and they are credited with documenting it.
              </InfoBubble>
            </div>
            {rows.map(row => (
              <AdvantageRowView
                key={row.id ?? row.name}
                row={row}
                claims={claims ?? []}
                orgNames={orgNames}
                added={added}
                onEdit={editObservation}
                onDelete={removeObservation}
                onSave={text => saveObservation(text, 'Could not save the next best')}
              />
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2 text-sm">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium text-muted-foreground">Expected advantage</span>
              <InfoBubble>
                What each party gained from this option over its next best. Expected, not measured: the next best
                never happened. Time stays as hours unless you enter the opportunity cost of a party's time below;
                that amount then stands in for its hours and the Advantage column shows the working.
              </InfoBubble>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1">
              <span />
              <span className="text-right text-xs font-medium text-muted-foreground">Advantage</span>
              <span className="text-right text-xs font-medium text-muted-foreground">Time</span>
              {rows.map(row => (
                <Fragment key={row.id ?? row.name}>
                  <span className="min-w-0"><PartyChip id={row.id} name={row.name} orgNames={orgNames} /></span>
                  {row.value ? (
                    <>
                      <span className="text-right font-medium">
                        {timeValueFor(row) !== null && row.value.hours
                          ? `${peso(row.value.money)} ${row.value.hours < 0 ? '−' : '+'} ${peso(timeValueFor(row)!)}`
                          : formatBalance({ money: row.value.money, hours: 0 })}
                      </span>
                      <span className="text-right font-medium">{row.value.hours ? formatBalance({ money: 0, hours: row.value.hours }) : '—'}</span>
                    </>
                  ) : (
                    <span className="col-span-2 text-right text-muted-foreground">
                      {row.noOtherOption ? 'Not evaluated — no other option' : row.options.length ? 'No amount stated' : 'Next best not documented'}
                    </span>
                  )}
                </Fragment>
              ))}
              {evaluated.length > 1 && (
                <>
                  <span className="flex items-center gap-1 border-t pt-1 font-medium">
                    Value created
                    <InfoBubble>
                      The expected advantage of every party added together: what exists because this option was chosen
                      over each party's next best. It is separate from the money that changed hands — a trade creates
                      value when the parties together come out ahead of their alternatives.
                    </InfoBubble>
                  </span>
                  <span className={`border-t pt-1 text-right font-medium ${signColor(advantageTotal.money)}`}>
                    {formatBalance({ money: advantageTotal.money, hours: 0 })}
                  </span>
                  <span className={`border-t pt-1 text-right font-medium ${signColor(advantageTotal.hours)}`}>
                    {advantageTotal.hours ? formatBalance({ money: 0, hours: advantageTotal.hours }) : '—'}
                  </span>
                </>
              )}
            </div>
            {rows.map(row => row.value && (
              <OpportunityCost
                key={row.id ?? row.name}
                party={row.id ? orgNames[row.id] ?? row.name : row.name}
                chip={<PartyChip id={row.id} name={row.name} orgNames={orgNames} />}
                value={row.value}
                amount={timeValues[rowKey(row)] ?? ''}
                onChange={amount => setTimeValues(all => ({ ...all, [rowKey(row)]: amount }))}
                onDone={saveTimeValues}
              />
            ))}
          </div>
        )}

        {totals.length > 0 && (
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 p-2 text-sm">
            <span />
            <span className="text-right text-xs font-medium text-muted-foreground">Gained</span>
            <span className="text-right text-xs font-medium text-muted-foreground">Cost</span>
            <span className="text-right text-xs font-medium text-muted-foreground">Time</span>
            {totals.map(t => {
              // The party's own time in this action: spent is negative, received positive.
              const timed = t.benefits.hours !== null || t.costs.hours !== null;
              const { hours } = balance(t);
              return (
                <Fragment key={t.id ?? t.name}>
                  <span className="min-w-0"><PartyChip id={t.id} name={t.name} orgNames={orgNames} /></span>
                  <span className="text-right text-green-700 dark:text-green-400">
                    {t.benefits.php !== null ? formatAmount(t.benefits.php, null, '+') : '—'}
                  </span>
                  <span className="text-right text-destructive">
                    {t.costs.php !== null ? formatAmount(t.costs.php, null, '−') : '—'}
                  </span>
                  <span className="text-right">
                    {timed ? formatAmount(null, Math.abs(hours), hours < 0 ? '−' : '+') : '—'}
                  </span>
                </Fragment>
              );
            })}
          </div>
        )}

        {(() => {
          const mine = totals.find(t => t.id && t.id === organization?.id);
          return mine ? <HourValue value={balance(mine)} label="My hour is worth ₱" netLabel="Net for this action" /> : null;
        })()}

        {alsoLinkTo && <AddObservation onAdd={text => saveObservation(text, 'Could not save the observation')} />}
        {unplaced.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Also added here</p>
            {unplaced.map(o => <AddedObservation key={o.id} observation={o} onEdit={editObservation} onDelete={removeObservation} />)}
          </div>
        )}

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

function ClaimCard({ claim, orgNames, sign, added, onAdjust, onEdit, onDelete }: {
  claim: RewardClaim;
  orgNames: Record<string, string>;
  sign: '+' | '−' | '';
  added: Observation[];
  onAdjust: (claim: RewardClaim, php: string, hours: string, note: string) => Promise<boolean>;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [php, setPhp] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Start from what the claim says now, so an adjustment changes it rather than restating it.
  const startAdjusting = () => {
    setPhp(claim.php?.toString() ?? '');
    setHours(claim.hours?.toString() ?? '');
    setAdjusting(true);
  };

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
      <AddedSources sourceIds={claim.source_state_ids} added={added} onEdit={onEdit} onDelete={onDelete} />

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
            <Button size="sm" disabled={saving || (php === (claim.php?.toString() ?? '') && hours === (claim.hours?.toString() ?? '') && !note.trim())} onClick={save}>
              {saving ? 'Saving...' : 'Save and rebuild'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={startAdjusting}>Adjust</Button>
        </div>
      )}
    </div>
  );
}
