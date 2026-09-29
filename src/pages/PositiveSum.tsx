import { useNavigate, useParams } from 'react-router-dom';
import { errorMessage } from '@/lib/apiService';
import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useApproveOption, useMyPositiveSum } from '@/hooks/positiveSum/usePositiveSum';
import { usePositiveSumOrgs } from '@/hooks/positiveSum/usePositiveSumOrgs';
import { GoalForm } from '@/components/positiveSum/GoalForm';
import { ConversationPanel } from '@/components/positiveSum/ConversationPanel';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { OpportunitiesSection } from '@/components/positiveSum/OpportunitiesSection';
import { StatusBadge } from '@/components/positiveSum/StatusBadge';
import { PositiveSumIcon } from '@/components/icons/PositiveSumIcon';
import type { PositiveSumItem } from '@/types/positiveSum';

function ItemText({ item, finalLabel = 'Done when' }: { item: PositiveSumItem; finalLabel?: string }) {
  return (
    <div className="text-sm text-muted-foreground space-y-1 break-words">
      {item.initial_state && <p>Now: {item.initial_state}</p>}
      {item.policy && <p>How: {item.policy}</p>}
      {item.desired_state && <p>{finalLabel}: {item.desired_state}</p>}
    </div>
  );
}

// Sentences, not scores or rankings.
function helpedText(value?: number) {
  if (!value) return null;
  return `Their options were accepted by others ${value} ${value === 1 ? 'time' : 'times'}`;
}

export default function PositiveSum() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { orgId } = useParams<{ orgId: string }>();
  // Positive Sum works within one org at a time: the one this page is for.
  const org = usePositiveSumOrgs().find(o => o.id === orgId);
  const { data, isLoading } = useMyPositiveSum(org?.id);
  const approve = useApproveOption();

  const approveOption = async (optionId: string, goalId?: string) => {
    try {
      await approve.mutateAsync({ optionId, goalId });
      toast({ title: 'Approved' });
    } catch (error) {
      toast({ title: 'Could not approve', description: errorMessage(error), variant: 'destructive' });
    }
  };

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
        <div>
          <h1 className="text-2xl font-bold">Positive Sum</h1>
          <p className="text-sm text-muted-foreground">
            {org ? `${org.name} · ` : ''}Ask for what you'd like to be different, and help others with theirs.
          </p>
        </div>
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
          <CardHeader>
            <CardTitle className="text-lg">What would you like to be different?</CardTitle>
            <CardDescription>Share what you'd like to change, and what you're able to do.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Ready for you</h2>
            {data.ready.length === 0 && <p className="text-sm text-muted-foreground">Nothing right now.</p>}
            {data.ready.map(item => (
              <Card key={`${item.role}-${item.id}`}>
                <CardContent className="pt-4 space-y-2">
                  <p className="font-medium break-words">{item.title}</p>
                  <ItemText item={item} />
                  <p className="text-xs text-muted-foreground">
                    {item.role === 'implementor'
                      ? 'Someone would like to build on your option this way.'
                      : helpedText(item.value) ?? 'Suggested for something you would like to be different.'}
                  </p>
                  <Button size="sm" disabled={approve.isPending} onClick={() => approveOption(item.id)}>
                    Approve
                  </Button>
                </CardContent>
              </Card>
            ))}
          </section>

          <OpportunitiesSection orgIds={[org!.id]} />

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">What I'd like to be different</h2>
            {data.goals.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
            {data.goals.map(goal => (
              <Card key={goal.id}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium break-words">{goal.title}</p>
                    <StatusBadge status={goal.status} />
                  </div>
                  <ItemText item={goal} finalLabel="Would like" />
                  {goal.status === 'external_proposal' && (
                    <Button size="sm" variant="outline" onClick={() => navigate(`/actions/${goal.id}?maxwell=1`)}>
                      Plan with Maxwell
                    </Button>
                  )}
                  {goal.options.length === 0 && (
                    <p className="text-xs text-muted-foreground">No options suggested yet.</p>
                  )}
                  {goal.options.map(option => (
                    <div key={option.id} className="rounded-md border p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium break-words">{option.title}</p>
                        <StatusBadge status={option.status} />
                      </div>
                      <ItemText item={option} />
                      {helpedText(option.value) && (
                        <p className="text-xs text-muted-foreground">{helpedText(option.value)}</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {!option.approved_by_me && goal.status === 'external_proposal' && (
                          <Button size="sm" disabled={approve.isPending}
                            onClick={() => approveOption(option.id, goal.id)}>
                            Approve
                          </Button>
                        )}
                        {option.status !== 'external_proposal' && (
                          <Button size="sm" variant="outline" onClick={() => navigate(`/actions/${option.id}`)}>
                            Open action
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
