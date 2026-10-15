import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useCognitoAuth';
import type { Challenge, MyGoal, Offer, OfferedReward } from '@/types/positiveSum';
import { AddReward, RewardOffer } from './RewardOffer';

// Every proposed collaboration the viewer can see that has an open reward on
// it, once each: the ones under a situation, then the viewer's own unplaced
// ones. Only for a copy of the page data saved before the server listed offers.
export function openOffers(challenges: Challenge[], goals: MyGoal[]): Offer[] {
  const open = (rewards?: OfferedReward[]) => (rewards ?? []).filter(reward => !reward.closed);
  const found = [
    ...challenges.flatMap(challenge => (challenge.collaborations ?? []).map(c => (
      { id: c.id, title: c.title, situation: challenge.text, rewards: open(c.rewards) }
    ))),
    ...goals.map(g => ({ id: g.id, title: g.title, rewards: open(g.rewards) })),
  ];
  return found.filter((o, i) => o.rewards.length > 0 && found.findIndex(other => other.id === o.id) === i);
}

// What organizations offer to pay for, and where a person makes an offer of
// their own, below them. The page leads with this.
export function Offers({ organizationId, offers, challenges, goals = [] }: {
  organizationId: string;
  offers?: Offer[];
  challenges: Challenge[];
  goals?: MyGoal[];
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const opportunities = offers ?? openOffers(challenges, goals);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Offers</h2>
      <p className="text-sm text-muted-foreground">What organizations here are willing to pay for.</p>
      {opportunities.length === 0 && <p className="text-sm text-muted-foreground">No offers yet.</p>}
      {opportunities.map(opportunity => (
        <Card key={opportunity.id}>
          <CardContent className="pt-4 space-y-2">
            <button
              type="button"
              onClick={() => navigate(`/actions/${opportunity.id}`)}
              className="block rounded-sm text-left hover:underline"
            >
              <span className="font-semibold leading-snug break-words">{opportunity.title}</span>
            </button>
            {opportunity.situation && (
              <p className="text-sm text-muted-foreground break-words">For: {opportunity.situation}</p>
            )}
            {opportunity.rewards.map(reward => (
              <RewardOffer key={reward.id} reward={reward} organizationId={organizationId} userId={user?.userId} />
            ))}
          </CardContent>
        </Card>
      ))}
      <AddReward organizationId={organizationId} />
    </section>
  );
}
