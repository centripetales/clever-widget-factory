// Calculations on the claims of an action's rewards (the REWARD perspective).
// Amounts are only what people stated; null means not stated. Stored amounts
// are positive, with the direction in from → to.
import type { NextBestOption, RewardClaim } from '@/types/rewards';

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

// Saved = next-best option's price − the claims it replaces, per component,
// only when both sides were stated.
export function savings(option: NextBestOption, claims: RewardClaim[]): Sums {
  const replaced = claims.filter(c => option.replaces.includes(c.name));
  const saved = (key: 'php' | 'hours') =>
    option[key] !== null && replaced.length && replaced.every(c => c[key] !== null)
      ? option[key]! - replaced.reduce((sum, c) => sum + (c[key] as number), 0)
      : null;
  return { php: saved('php'), hours: saved('hours') };
}

// A party's money and time balance; negative hours = time spent.
export function balance(totals: PartyTotals) {
  return {
    money: (totals.benefits.php ?? 0) - (totals.costs.php ?? 0),
    hours: (totals.benefits.hours ?? 0) - (totals.costs.hours ?? 0),
  };
}

// The hourly value at which the action nets to zero for this party, or null
// when no time is involved. Negative means there is no break-even (money was
// lost even with time free, or both time and money were gained).
export function breakEvenRate(totals: PartyTotals): number | null {
  const { money, hours } = balance(totals);
  return hours ? -money / hours : null;
}

// Net in pesos with time valued at `rate` per hour.
export function netAtRate(totals: PartyTotals, rate: number): number {
  const { money, hours } = balance(totals);
  return money + rate * hours;
}
