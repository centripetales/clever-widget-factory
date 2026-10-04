import { describe, it, expect } from 'vitest';
import { formatAmount, signFor, totalsByParty, savings, breakEvenRate, netAtRate, balance } from './rewards';
import type { NextBestOption, RewardClaim } from '@/types/rewards';

const SG = 'stargazer';
const PASTOR = 'pastor';
const DA = 'da';

const claim = (overrides: Partial<RewardClaim>): RewardClaim => ({
  name: 'claim', from_org_id: SG, from_name: 'Stargazer Farm', to_org_id: PASTOR, to_name: 'Pastor',
  php: null, hours: null, cost_basis_method: null, claim: 'text', source_state_ids: [], ...overrides,
});

const trip: RewardClaim[] = [
  claim({ name: 'Driving payment', php: 1500 }),
  claim({ name: 'Gas', php: 3000 }),
  claim({ name: 'Our day', to_org_id: SG, to_name: 'Stargazer Farm', hours: 24 }),
  claim({ name: 'Goats', from_org_id: DA, from_name: 'Department of Agriculture', to_org_id: SG, to_name: 'Stargazer Farm', php: 24000 }),
  claim({ name: 'Suckers', from_org_id: null, from_name: 'pineapple stand', to_org_id: SG, to_name: 'Stargazer Farm' }),
];

describe('formatAmount', () => {
  it('shows stated parts with an optional sign, or "Not stated"', () => {
    expect(formatAmount(1500, null)).toBe('₱1,500');
    expect(formatAmount(null, 1)).toBe('1 hour');
    expect(formatAmount(1500, 2.25, '−')).toBe('−₱1,500 · −2.3 hours');
    expect(formatAmount(null, null)).toBe('Not stated');
  });
});

describe('signFor', () => {
  it('is negative for what the viewer gives, positive for what it receives', () => {
    expect(signFor(trip[0], SG)).toBe('−');
    expect(signFor(trip[0], PASTOR)).toBe('+');
    expect(signFor(trip[0], DA)).toBe('');
    expect(signFor(trip[0], undefined)).toBe('');
  });
});

describe('totalsByParty', () => {
  const totals = totalsByParty(trip);
  const of = (name: string) => totals.find(t => t.name === name)!;

  it('adds what each party gave and received; own time is only a cost', () => {
    expect(of('Stargazer Farm')).toMatchObject({ costs: { php: 4500, hours: 24 }, benefits: { php: 24000, hours: null } });
    expect(of('Pastor')).toMatchObject({ costs: { php: null, hours: null }, benefits: { php: 4500, hours: null } });
    expect(of('Department of Agriculture').costs.php).toBe(24000);
  });

  it('leaves out parties with nothing stated', () => {
    expect(totals.find(t => t.name === 'pineapple stand')).toBeUndefined();
  });
});

describe('savings', () => {
  const option = (overrides: Partial<NextBestOption>): NextBestOption => ({
    name: 'Hire a truck', php: 6000, hours: null, replaces: ['Driving payment', 'Gas'], claim: 'text', source_state_ids: [], ...overrides,
  });

  it('is the next-best price minus the claims it replaces', () => {
    expect(savings(option({}), trip)).toEqual({ php: 1500, hours: null });
  });

  it('is unknown when either side was not stated', () => {
    expect(savings(option({ php: null }), trip).php).toBeNull();
    expect(savings(option({ replaces: ['Suckers'] }), trip).php).toBeNull();
    expect(savings(option({ replaces: [] }), trip).php).toBeNull();
  });
});

describe('break-even', () => {
  const stargazer = totalsByParty(trip).find(t => t.id === SG)!;

  it('finds the hourly value where the action nets to zero', () => {
    expect(balance(stargazer)).toEqual({ money: 19500, hours: -24 });
    expect(breakEvenRate(stargazer)).toBe(812.5);
    expect(netAtRate(stargazer, 812.5)).toBe(0);
    expect(netAtRate(stargazer, 500)).toBe(7500);
  });

  it('is null when no time is involved', () => {
    expect(breakEvenRate(totalsByParty(trip).find(t => t.id === PASTOR)!)).toBeNull();
  });
});
