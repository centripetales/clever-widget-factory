import { describe, it, expect } from 'vitest';
import {
  formatAmount, signFor, totalsByParty, advantage, advantageRows, nextBestStatement, noOtherOptionStatement, nextBestOptions,
  formatBalance, breakEvenRate, netAtRate, balance,
} from './rewards';
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

describe('advantage', () => {
  const option = (overrides: Partial<NextBestOption>): NextBestOption => ({
    name: 'Hire a truck', for_org_id: SG, for_name: 'Stargazer Farm', kind: 'cost_another_way', php: 6000, hours: null,
    replaces: ['Driving payment', 'Gas'], claim: 'text', source_state_ids: [], ...overrides,
  });

  it('is the cost another way minus the claims it replaces', () => {
    expect(advantage(option({}), trip)).toEqual({ money: 1500, hours: 0 });
  });

  it('is unknown when either side was not stated', () => {
    expect(advantage(option({ php: null }), trip)).toBeNull();
    expect(advantage(option({ replaces: ['Suckers'] }), trip)).toBeNull();
    expect(advantage(option({ replaces: [] }), trip)).toBeNull();
  });
});

// 6 banana suckers from Lester's parents for ₱200 (docs/design/POSITIVE_SUM.md §2.6)
describe('advantage on both sides of a purchase', () => {
  const LESTER = 'lester';
  const claims = [claim({ name: 'Paid for suckers', to_org_id: LESTER, to_name: "Lester's parents", php: 200 })];
  const options: NextBestOption[] = [
    {
      name: 'Asking around', for_org_id: SG, for_name: 'Stargazer Farm', kind: 'cost_another_way', php: null, hours: 2,
      replaces: ['Paid for suckers'], claim: 'text', source_state_ids: [],
    },
    {
      name: 'Left in the clump', for_org_id: LESTER, for_name: "Lester's parents", kind: 'had_otherwise', php: 10, hours: null,
      replaces: ['Paid for suckers'], claim: 'text', source_state_ids: [],
    },
  ];

  it('keeps hours as hours for the one who paid', () => {
    const ours = advantage(options[0], claims)!;
    expect(ours).toEqual({ money: -200, hours: 2 });
    expect(formatBalance(ours)).toBe('−₱200 · +2 hours');
    expect(breakEvenRate(ours)).toBe(100);
    expect(netAtRate(ours, 150)).toBe(100);
  });

  it('is what was received minus what they would have had otherwise', () => {
    expect(advantage(options[1], claims)).toEqual({ money: 190, hours: 0 });
  });

  it('counts the price once when the goods are also a claim at that price', () => {
    const both = [
      ...claims,
      claim({ name: 'Suckers', from_org_id: LESTER, from_name: "Lester's parents", to_org_id: SG, to_name: 'Stargazer Farm', php: 200 }),
    ];
    const replacing = (o: NextBestOption) => ({ ...o, replaces: ['Paid for suckers', 'Suckers'] });
    expect(advantage(replacing({ ...options[0], php: 200, hours: 1 }), both)).toEqual({ money: 0, hours: 1 });
    expect(advantage(replacing(options[1]), both)).toEqual({ money: 190, hours: 0 });
  });

  it('gives every party a row, documented or not', () => {
    expect(advantageRows(claims, [])).toMatchObject([
      { id: SG, name: 'Stargazer Farm', paid: true, options: [], value: null, noOtherOption: false },
      { id: LESTER, name: "Lester's parents", paid: false, options: [], value: null, noOtherOption: false },
    ]);
  });

  it('adds up each party\'s documented options', () => {
    expect(advantageRows(claims, options)).toMatchObject([
      { id: SG, paid: true, value: { money: -200, hours: 2 }, noOtherOption: false },
      { id: LESTER, paid: false, value: { money: 190, hours: 0 }, noOtherOption: false },
    ]);
  });

  it('does not evaluate a party that had no other option', () => {
    const none: NextBestOption = {
      name: 'No other source', for_org_id: SG, for_name: 'Stargazer Farm', kind: 'no_other_option', php: null, hours: null,
      replaces: [], claim: 'text', source_state_ids: [],
    };
    expect(advantageRows(claims, [none])[0]).toMatchObject({ value: null, noOtherOption: true });
  });
});

describe('next-best statements', () => {
  it('says what the other way would have cost the one who paid', () => {
    expect(nextBestStatement({ party: 'Stargazer Farm', paid: true, what: 'Asking around the community.', php: '200', hours: '1' }))
      .toBe('Next best option for Stargazer Farm: Asking around the community. Getting it that way would have cost ₱200 and 1 hours.');
  });

  it('says what the one who received would have had otherwise', () => {
    expect(nextBestStatement({ party: "Lester's parents", paid: false, what: 'Left in the clump', php: '10', hours: '' }))
      .toBe("Next best option for Lester's parents: Left in the clump. That would have been worth ₱10.");
  });

  it('keeps a next best with no amount, and states when there was none', () => {
    expect(nextBestStatement({ party: 'Stargazer Farm', paid: true, what: 'Another seller', php: '', hours: '' }))
      .toBe('Next best option for Stargazer Farm: Another seller.');
    expect(noOtherOptionStatement('Stargazer Farm')).toBe('There was no other option for Stargazer Farm to get this.');
  });
});

describe('nextBestOptions', () => {
  it('reads rewards built with a single option as a cost for whoever paid', () => {
    const old = { name: 'Hire a truck', php: 6000, hours: null, replaces: ['Gas'], claim: 'text', source_state_ids: [] };
    expect(nextBestOptions({ claims: trip, next_best_option: old })).toEqual([
      { ...old, kind: 'cost_another_way', for_org_id: SG, for_name: 'Stargazer Farm' },
    ]);
    expect(nextBestOptions({ claims: trip, next_best_option: null })).toEqual([]);
  });
});

describe('formatBalance', () => {
  it('signs money and time, and leaves out time when there is none', () => {
    expect(formatBalance({ money: 190, hours: 0 })).toBe('+₱190');
    expect(formatBalance({ money: 0, hours: 0 })).toBe('+₱0');
    expect(formatBalance({ money: 0, hours: -1 })).toBe('−1 hour');
  });
});

describe('break-even', () => {
  const stargazer = totalsByParty(trip).find(t => t.id === SG)!;

  it('finds the hourly value where the action nets to zero', () => {
    expect(balance(stargazer)).toEqual({ money: 19500, hours: -24 });
    expect(breakEvenRate(balance(stargazer))).toBe(812.5);
    expect(netAtRate(balance(stargazer), 812.5)).toBe(0);
    expect(netAtRate(balance(stargazer), 500)).toBe(7500);
  });

  it('is null when no time is involved', () => {
    expect(breakEvenRate(balance(totalsByParty(trip).find(t => t.id === PASTOR)!))).toBeNull();
  });
});
