import type { MyPositiveSum } from '@/types/positiveSum';

// What a person has earned across every offer they can see, closed ones included: what they earned there stays.
export function positiveSumBalance(data: MyPositiveSum, userId: string): number {
  const rewards = [
    ...(data.offers ?? []).flatMap(o => o.rewards),
    ...data.goals.flatMap(g => g.rewards ?? []),
    ...(data.challenges ?? []).flatMap(c => c.collaborations.flatMap(col => col.rewards ?? [])),
  ].filter((r, i, all) => all.findIndex(other => other.id === r.id) === i);
  return rewards.reduce((sum, r) => sum + (r.tally.find(person => person.id === userId)?.php ?? 0), 0);
}
