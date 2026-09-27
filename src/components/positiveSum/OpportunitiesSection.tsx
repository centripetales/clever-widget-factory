import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useJoinOption, useOpportunities, usePass } from '@/hooks/positiveSum/usePositiveSum';
import type { Opportunity } from '@/types/positiveSum';
import { SuggestOptionDialog } from './SuggestOptionDialog';

// Goals that need options and options that need people, across every org
// the person belongs to. Fetched only when asked; refreshed once a day.
export function OpportunitiesSection() {
  const [requested, setRequested] = useState(false);
  const { data: items = [], isFetching } = useOpportunities(requested);
  const [suggesting, setSuggesting] = useState<{ item: Opportunity; change: boolean } | null>(null);
  const join = useJoinOption();
  const pass = usePass();
  const { toast } = useToast();

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast({ title: label });
    } catch (error) {
      toast({ title: 'Something went wrong', description: String(error), variant: 'destructive' });
    }
  };

  return (
    <section className="space-y-4 pt-2 border-t border-border/40">
      <div className="flex items-center justify-between gap-2 pt-4">
        <h2 className="text-lg font-semibold text-foreground">Opportunities</h2>
        {!requested && (
          <Button variant="outline" size="sm" onClick={() => setRequested(true)}>
            Show my opportunities
          </Button>
        )}
      </div>

      {requested && isFetching && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Finding opportunities...
        </div>
      )}

      {requested && !isFetching && items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing open right now. Check back tomorrow.</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map(item => {
          const isGoal = item.kind === 'goal';
          const taken = item.implementors.length;
          return (
            <Card key={item.id} className="border border-border/50">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  {!isGoal && <Badge variant="secondary">Option</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {isGoal
                      ? `${item.created_by_name || 'Someone'} would like this to be different`
                      : [item.created_by_name, item.organization_name].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <CardTitle className="text-base break-words">{item.title}</CardTitle>
                <CardDescription className="space-y-1 break-words">
                  {item.initial_state && <span className="block">Now: {item.initial_state}</span>}
                  {item.policy && <span className="block">How: {item.policy}</span>}
                  {item.desired_state && (
                    <span className="block">{isGoal ? 'Would like' : 'Done when'}: {item.desired_state}</span>
                  )}
                  {!isGoal && item.capacity && (
                    <span className="block">{taken} of {item.capacity} people</span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {isGoal ? (
                  <Button size="sm" onClick={() => setSuggesting({ item, change: false })}>
                    Suggest an option
                  </Button>
                ) : (
                  <>
                    <Button size="sm" disabled={join.isPending}
                      onClick={() => run('You joined', () => join.mutateAsync(item.id))}>
                      Join
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSuggesting({ item, change: true })}>
                      Suggest a change
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" disabled={pass.isPending}
                  onClick={() => run('Passed', () => pass.mutateAsync(item.id))}>
                  Pass
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {suggesting && (
        <SuggestOptionDialog
          open
          onOpenChange={open => !open && setSuggesting(null)}
          goalIds={suggesting.item.kind === 'goal' ? [suggesting.item.id] : suggesting.item.goal_ids}
          goalTitle={suggesting.item.title}
          parentOptionId={suggesting.change ? suggesting.item.id : undefined}
          draft={suggesting.change ? {
            initial_state: suggesting.item.initial_state,
            policy: suggesting.item.policy,
            final_state: suggesting.item.desired_state,
            capacity: suggesting.item.capacity,
          } : undefined}
        />
      )}
    </section>
  );
}
