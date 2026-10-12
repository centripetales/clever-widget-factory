import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMyPositiveSum } from '@/hooks/positiveSum/usePositiveSum';
import { usePositiveSumOrgs } from '@/hooks/positiveSum/usePositiveSumOrgs';
import { GoalForm } from '@/components/positiveSum/GoalForm';
import { ConversationPanel } from '@/components/positiveSum/ConversationPanel';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChallengesSection } from '@/components/positiveSum/ChallengesSection';
import { PositiveSumIcon } from '@/components/icons/PositiveSumIcon';

export default function PositiveSum() {
  const navigate = useNavigate();
  const { orgId } = useParams<{ orgId: string }>();
  // Positive Sum works within one org at a time: the one this page is for.
  const org = usePositiveSumOrgs().find(o => o.id === orgId);
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

      {!org && (
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Positive Sum isn't turned on for this organization, or you're not a member of it.
          </CardContent>
        </Card>
      )}

      {org && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <ConversationPanel org={org} />
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 px-0 text-muted-foreground">
                  Or type it yourself <ChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <GoalForm organizationId={org.id} />
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      )}

      {data && (
        <>
          <ChallengesSection organizationId={org!.id} challenges={data.challenges ?? []} goals={data.goals} members={data.members}
            hasGivenInput={data.has_given_input !== false} />
        </>
      )}
    </div>
  );
}
