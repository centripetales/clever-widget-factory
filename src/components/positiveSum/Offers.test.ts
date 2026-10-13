import { describe, expect, it } from 'vitest';
import { openOffers } from './Offers';
import type { Challenge, MyGoal, OfferedReward } from '@/types/positiveSum';

const reward = (over: Partial<OfferedReward> = {}): OfferedReward => ({
  id: 'r1', php: 5, cap_php_per_person: 500, payer_name: 'Stargazer Farm', terms: '', owner: 'u1',
  closed: false, accepted_by_me: false, tally: [], ...over,
});

const collaboration = (id: string, rewards?: OfferedReward[]) => ({
  id, title: `Proposal ${id}`, status: 'external_proposal', created_by: 'u1', created_by_name: null, participants: [], rewards,
});

const challenge = (collaborations: ReturnType<typeof collaboration>[]) =>
  ({ id: 'c1', text: 'Evidence is lacking', collaborations }) as unknown as Challenge;

describe('openOffers', () => {
  it('lists proposals with an open reward, under their situation', () => {
    const found = openOffers([challenge([collaboration('a', [reward()]), collaboration('b')])], []);
    expect(found).toEqual([{ id: 'a', title: 'Proposal a', situation: 'Evidence is lacking', rewards: [reward()] }]);
  });

  it('leaves out proposals whose rewards are all closed', () => {
    expect(openOffers([challenge([collaboration('a', [reward({ closed: true })])])], [])).toEqual([]);
  });

  it('lists a proposal once when it is also among the viewer\'s own', () => {
    const goals = [
      { id: 'a', title: 'Proposal a', rewards: [reward()] },
      { id: 'z', title: 'Unplaced', rewards: [reward({ id: 'r2' })] },
    ] as unknown as MyGoal[];
    const found = openOffers([challenge([collaboration('a', [reward()])])], goals);
    expect(found.map(o => o.id)).toEqual(['a', 'z']);
    expect(found[1].situation).toBeUndefined();
  });

  it('reads a saved copy of the list that has no rewards or collaborations', () => {
    expect(openOffers([{ id: 'c1', text: 'x' } as unknown as Challenge], [{ id: 'g' } as unknown as MyGoal])).toEqual([]);
  });
});
