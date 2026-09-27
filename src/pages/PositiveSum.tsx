import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useApproveOption, useMyPositiveSum } from '@/hooks/positiveSum/usePositiveSum';
import { GoalForm } from '@/components/positiveSum/GoalForm';
import { OfferForm } from '@/components/positiveSum/OfferForm';
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

// "Helped others N times" — sentences, not scores or rankings.
function helpedText(value?: number) {
  if (!value) return null;
  return `Offers accepted by others: ${value}`;
}

export default function PositiveSum() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading } = useMyPositiveSum();
  const approve = useApproveOption();

  const approveOption = async (optionId: string, goalId?: string) => {
    try {
      await approve.mutateAsync({ optionId, goalId });
      toast({ title: 'Approved' });
    } catch (error) {
      toast({ title: 'Could not approve', description: String(error), variant: 'destructive' });
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
          <p className="text-sm text-muted-foreground">Share what you can offer, ask for what you want to change.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Set a goal</CardTitle>
            <CardDescription>What you want to change, and where you want it to get to.</CardDescription>
          </CardHeader>
          <CardContent><GoalForm /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Offer something</CardTitle>
            <CardDescription>Something you can share or do, on your terms.</CardDescription>
          </CardHeader>
          <CardContent><OfferForm /></CardContent>
        </Card>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      )}

      {data && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Waiting on me</h2>
            {data.waiting.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting on you.</p>}
            {data.waiting.map(item => (
              <Card key={`${item.role}-${item.id}`}>
                <CardContent className="pt-4 space-y-2">
                  <p className="font-medium break-words">{item.title}</p>
                  <ItemText item={item} />
                  <p className="text-xs text-muted-foreground">
                    {item.role === 'implementor'
                      ? 'Someone wants to use your offer this way.'
                      : helpedText(item.value) ?? 'Suggested for your goal.'}
                  </p>
                  <Button size="sm" disabled={approve.isPending} onClick={() => approveOption(item.id)}>
                    Approve
                  </Button>
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">My goals</h2>
            {data.goals.length === 0 && <p className="text-sm text-muted-foreground">No goals yet.</p>}
            {data.goals.map(goal => (
              <Card key={goal.id}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium break-words">{goal.title}</p>
                    <StatusBadge status={goal.status} />
                  </div>
                  <ItemText item={goal} finalLabel="Desired state" />
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

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">My offers</h2>
            {data.policies.length === 0 && <p className="text-sm text-muted-foreground">No offers yet.</p>}
            {data.policies.map(policy => (
              <Card key={policy.id}>
                <CardContent className="pt-4 space-y-2">
                  <p className="font-medium break-words">{policy.title}</p>
                  <ItemText item={policy} />
                  <p className="text-xs text-muted-foreground">
                    Used {policy.times_used} {policy.times_used === 1 ? 'time' : 'times'}
                    {policy.accepted > 0 && `, accepted ${policy.accepted}`}
                  </p>
                  {policy.experiences.length > 0 && (
                    <ul className="text-sm list-disc pl-5 space-y-1">
                      {policy.experiences.map(e => (
                        <li key={e.id}>
                          <button className="text-left underline-offset-2 hover:underline"
                            onClick={() => navigate(`/actions/${e.id}`)}>
                            {e.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
