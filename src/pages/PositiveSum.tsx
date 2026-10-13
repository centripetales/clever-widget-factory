import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMyPositiveSum } from '@/hooks/positiveSum/usePositiveSum';
import { usePositiveSumOrgs } from '@/hooks/positiveSum/usePositiveSumOrgs';
import { useOrganization } from '@/hooks/useOrganization';
import { ChallengesSection } from '@/components/positiveSum/ChallengesSection';
import { Offers } from '@/components/positiveSum/Offers';
import { PositiveSumIcon } from '@/components/icons/PositiveSumIcon';

export default function PositiveSum() {
  const navigate = useNavigate();
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
