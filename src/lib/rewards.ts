// Calculations on the claims of an action's rewards (the REWARD perspective).
// Amounts are only what people stated; null means not stated. Stored amounts
// are positive, with the direction in from → to.
import type { ActionRewards, NextBestOption, RewardClaim } from '@/types/rewards';

export type Sign = '+' | '−' | '';
export type Sums = { php: number | null; hours: number | null };

export interface PartyTotals {
  id: string | null; // org id, or null when the party isn't an org
  name: string;
  costs: Sums; // what it gave, promised or spent itself
  benefits: Sums; // what it received
}

const NONE: Sums = { php: null, hours: null };

export const hasAny = (s: Sums) => s.php !== null || s.hours !== null;

const add = (sums: Sums, c: RewardClaim): Sums => ({
  php: c.php === null ? sums.php : (sums.php ?? 0) + c.php,
  hours: c.hours === null ? sums.hours : (sums.hours ?? 0) + c.hours,
});

export function formatAmount(php: number | null, hours: number | null, sign: Sign = '') {
  const parts = [
    php !== null && `${sign}₱${Math.round(php).toLocaleString()}`,
    hours !== null && `${sign}${Math.round(hours * 10) / 10} ${hours === 1 ? 'hour' : 'hours'}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Not stated';
}

// From the viewer's org: what it gives or spends is negative, what it receives
// positive; claims between other parties stay unsigned.
export function signFor(claim: RewardClaim, orgId: string | undefined): Sign {
  if (!orgId) return '';
  if (claim.from_org_id === orgId) return '−';
  if (claim.to_org_id === orgId) return '+';
  return '';
}

// Per party (org id, or the name when it isn't an org). A claim from a party to
// itself (its own time or money) is only a cost.
export function totalsByParty(claims: RewardClaim[]): PartyTotals[] {
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

// The next-best options of an action's rewards. Rewards built before several
// options have one, which was always a cost for whoever paid the claims it replaces.
export function nextBestOptions(data: Pick<ActionRewards, 'claims' | 'next_best_options' | 'next_best_option'>): NextBestOption[] {
  if (data.next_best_options) return data.next_best_options;
  const old = data.next_best_option;
  if (!old) return [];
  const payer = (data.claims ?? []).find(c => old.replaces.includes(c.name));
  return [{
    ...old, kind: 'cost_another_way', done_by: null,
    for_org_id: payer?.from_org_id ?? null, for_name: payer?.from_name ?? '',
  }];
}

export interface Balance { money: number; hours: number }

// A party's advantage from one next-best option, against the claims it stands
// in place of: what the alternative would have cost minus what was paid, or
// what was received minus what the party would have had otherwise. Null when
// the option or any claim it replaces has no stated amount.
export function advantage(option: NextBestOption, claims: RewardClaim[]): Balance | null {
  const replaced = claims.filter(c => option.replaces.includes(c.name));
  const stated = (s: Sums) => s.php !== null || s.hours !== null;
  if (!stated(option) || !replaced.length || !replaced.every(stated)) return null;
  const sign = option.kind === 'had_otherwise' ? -1 : 1;
  const diff = (key: 'php' | 'hours') =>
    sign * ((option[key] ?? 0) - replaced.reduce((sum, c) => sum + (c[key] ?? 0), 0)) || 0;
  return { money: diff('php'), hours: diff('hours') };
}

export interface AdvantageRow {
  id: string | null; // org id, or null when the party isn't an org
  name: string;
  paid: boolean; // it paid someone else money in this action; otherwise it received
  options: NextBestOption[]; // its documented next-best options
  value: Balance | null; // null: nothing documented yet, or nothing that can be worked out
  noOtherOption: boolean; // it had no other way to get this: capability expanding, not evaluated
}

// One row per party in the action, whether or not its next best has been
// documented. Hours stay hours: pesos only when the viewer values them (netAtRate).
export function advantageRows(claims: RewardClaim[], options: NextBestOption[]): AdvantageRow[] {
  const rows = new Map<string, AdvantageRow>();
  const row = (id: string | null, name: string) => {
    const key = id ?? `name:${name}`;
    if (!rows.has(key)) rows.set(key, { id, name, paid: false, options: [], value: null, noOtherOption: false });
    return rows.get(key)!;
  };
  for (const c of claims) {
    const from = row(c.from_org_id, c.from_name);
    const to = row(c.to_org_id, c.to_name);
    if (from !== to && c.php !== null) from.paid = true;
  }
  for (const option of options) {
    const party = row(option.for_org_id, option.for_name);
    party.options.push(option);
    if (option.kind === 'no_other_option') party.noOtherOption = true;
    const value = advantage(option, claims);
    if (value) {
      party.value = { money: (party.value?.money ?? 0) + value.money, hours: (party.value?.hours ?? 0) + value.hours };
    }
  }
  return [...rows.values()];
}

// A documented next best, in a sentence the rewards build reads back the same
// way; saved as the person's observation so it stays their claim.
export function nextBestStatement({ party, paid, what, php, hours, who }: {
  party: string; paid: boolean; what: string; php: string; hours: string; who: string;
}) {
  const amounts = [
    php.trim() && `₱${php.trim()}`,
    hours.trim() && `${hours.trim()} hours${who.trim() ? ` of ${who.trim()}'s time` : ''}`,
  ].filter(Boolean).join(' and ');
  const worth = paid ? `Getting it that way would have cost ${amounts}.` : `That would have been worth ${amounts}.`;
  return [`Next best option for ${party}: ${what.trim().replace(/\.$/, '')}.`, amounts && worth].filter(Boolean).join(' ');
}

export const noOtherOptionStatement = (party: string) => `There was no other option for ${party} to get this.`;

// Money and time, signed: "+₱190", "−₱200 · +2 hours".
export function formatBalance({ money, hours }: Balance) {
  const signed = (n: number) => (n < 0 ? '−' : '+');
  const parts = [
    (money !== 0 || hours === 0) && `${signed(money)}₱${Math.abs(Math.round(money)).toLocaleString()}`,
    hours !== 0 && `${signed(hours)}${Math.abs(Math.round(hours * 10) / 10)} ${Math.abs(hours) === 1 ? 'hour' : 'hours'}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

// A party's money and time balance; negative hours = time spent.
export function balance(totals: PartyTotals): Balance {
  return {
    money: (totals.benefits.php ?? 0) - (totals.costs.php ?? 0),
    hours: (totals.benefits.hours ?? 0) - (totals.costs.hours ?? 0),
  };
}

// The hourly value at which the balance nets to zero, or null when no time is
// involved. Negative means there is no break-even (money was lost even with
// time free, or both time and money were gained).
export function breakEvenRate({ money, hours }: Balance): number | null {
  return hours ? -money / hours : null;
}

// Net in pesos with time valued at `rate` per hour.
export function netAtRate({ money, hours }: Balance, rate: number): number {
  return money + rate * hours;
}
