import { describe, expect, it } from 'vitest';
import { positiveSumBalance } from './positiveSumBalance';
import type { MyPositiveSum } from '@/types/positiveSum';

const reward = (id: string, tally: { id: string; php: number }[]) =>
  ({ id, tally: tally.map(t => ({ ...t, name: null, count: 1 })) });

// Only the fields the balance reads are filled in.
const data = (parts: Record<string, unknown>) => ({ goals: [], ready: [], ...parts }) as unknown as MyPositiveSum;

describe('positiveSumBalance', () => {
  it('is zero when the person has earned nothing', () => {
    expect(positiveSumBalance(data({}), 'me')).toBe(0);
    expect(positiveSumBalance(data({ offers: [{ rewards: [reward('r1', [{ id: 'other', php: 50 }])] }] }), 'me')).toBe(0);
  });

  it("adds the person's part of every reward, from offers, goals and challenges", () => {
    const d = data({
      offers: [{ rewards: [reward('r1', [{ id: 'me', php: 100 }, { id: 'other', php: 40 }])] }],
      goals: [{ rewards: [reward('r2', [{ id: 'me', php: 25 }])] }],
      challenges: [{ collaborations: [{ rewards: [reward('r3', [{ id: 'me', php: 10 }])] }] }],
    });
    expect(positiveSumBalance(d, 'me')).toBe(135);
  });

  it('counts a reward once when it is listed in more than one place', () => {
    const shared = reward('r1', [{ id: 'me', php: 100 }]);
    const d = data({ offers: [{ rewards: [shared] }], goals: [{ rewards: [shared] }] });
    expect(positiveSumBalance(d, 'me')).toBe(100);
  });
});
