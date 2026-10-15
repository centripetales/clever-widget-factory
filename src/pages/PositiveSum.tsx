import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMyPositiveSum } from '@/hooks/positiveSum/usePositiveSum';
import { usePositiveSumOrgs } from '@/hooks/positiveSum/usePositiveSumOrgs';
import { useOrganization } from '@/hooks/useOrganization';
import { useAuth } from '@/hooks/useCognitoAuth';
import { ChallengesSection } from '@/components/positiveSum/ChallengesSection';
import { Offers } from '@/components/positiveSum/Offers';
import { PositiveSumIcon } from '@/components/icons/PositiveSumIcon';
import type { MyPositiveSum } from '@/types/positiveSum';

// What a person has earned across every offer they can see, closed ones included: what they earned there stays.
function balance(data: MyPositiveSum, userId: string): number {
  const rewards = [
    ...(data.offers ?? []).flatMap(o => o.rewards),
    ...data.goals.flatMap(g => g.rewards ?? []),
    ...(data.challenges ?? []).flatMap(c => c.collaborations.flatMap(col => col.rewards ?? [])),
  ].filter((r, i, all) => all.findIndex(other => other.id === r.id) === i);
  return rewards.reduce((sum, r) => sum + (r.tally.find(person => person.id === userId)?.php ?? 0), 0);
}

// The action-value function, in MathML: browsers lay out the sum with its
// limits themselves. A fixed string; React's types have no MathML elements.
// A bracket as tall as the sum beside it. Stretching it the MathML way needs a
// math font most phones lack, so it is drawn taller instead.
const tall = (bracket: string) => `<mo stretchy="false" style="display:inline-block;transform:scale(1.2,2.3);margin:0 0.15em">${bracket}</mo>`;
const Q_PI = `<math display="block" displaystyle="true"><msub><mi>q</mi><mi>π</mi></msub><mo>(</mo><mi>s</mi><mo>,</mo><mi>a</mi><mo>)</mo><mo>=</mo><msub><mi>E</mi><mi>π</mi></msub><mrow>${tall('[')}<munderover><mo largeop="true" style="font-size:1.7em">∑</mo><mrow><mi>k</mi><mo>=</mo><mn>0</mn></mrow><mi>∞</mi></munderover><msup><mi>γ</mi><mi>k</mi></msup><msub><mi>R</mi><mrow><mi>t</mi><mo>+</mo><mi>k</mi><mo>+</mo><mn>1</mn></mrow></msub><mo>|</mo><msub><mi>S</mi><mi>t</mi></msub><mo>=</mo><mi>s</mi><mo>,</mo><msub><mi>A</mi><mi>t</mi></msub><mo>=</mo><mi>a</mi>${tall(']')}</mrow></math>`;

// How Positive Sum works, as the Bellman equation: an offer is the policy of
// whoever makes it, and its payments are the rewards participants earn.
function HowItWorks() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" aria-label="How Positive Sum works">
          <Info className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] space-y-3 text-sm">
        <p className="font-semibold">How this works</p>
        <div className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-base" dangerouslySetInnerHTML={{ __html: Q_PI }} />
        <p className="text-muted-foreground">
          The value of taking an action (<i>a</i>) where things are now (<i>s</i>) is what it is expected to
          bring under the policy (<i>π</i>): every reward (<i>R</i>) that follows, each discounted by <i>γ</i> for
          every step it lies ahead, because later counts a little less than now.
        </p>
        <p>
          <span className="font-medium">Making an offer:</span> your offer is modeled as your policy, what you choose to
          pay for to move things toward where you want them to be.
        </p>
        <p>
          <span className="font-medium">Taking part:</span> the payments operate as rewards (<i>R</i>). When you take an
          action and share it as an observation, the AI reads it against the prompt the offer's maker provided, and
          credits you what it is worth.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export default function PositiveSum() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { orgId } = useParams<{ orgId: string }>();
  // Positive Sum works within one org at a time: the one this page is for.
  const org = usePositiveSumOrgs().find(o => o.id === orgId);
  // On a refresh the person's orgs arrive after the page: wait for them before saying it isn't theirs.
  const { organizationsLoading } = useOrganization();
  const { data, isLoading } = useMyPositiveSum(org?.id);

  return (
    <div className="container mx-auto p-3 sm:p-6 max-w-4xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 shrink-0 rounded-full bg-orange-500 flex items-center justify-center">
          <PositiveSumIcon className="h-10 w-10 text-white" />
        </div>
        <h1 className="text-2xl font-bold">Positive Sum</h1>
        <HowItWorks />
        {data && user?.userId && (
          <span className="ml-auto text-right text-sm text-muted-foreground">
            Balance:{' '}
            <span className="text-xl font-bold text-green-600 dark:text-green-400">₱{Math.round(balance(data, user.userId)).toLocaleString()}</span>
          </span>
        )}
      </div>

      {!org && !organizationsLoading && (
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Positive Sum isn't turned on for this organization, or you're not a member of it.
          </CardContent>
        </Card>
      )}

      {(isLoading || (!org && organizationsLoading)) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      )}

      {data && (
        <>
          <Offers organizationId={org!.id} offers={data.offers} challenges={data.challenges ?? []} goals={data.goals ?? []} />
          <ChallengesSection organizationId={org!.id} challenges={data.challenges ?? []} goals={data.goals} members={data.members} />
        </>
      )}
    </div>
  );
}
