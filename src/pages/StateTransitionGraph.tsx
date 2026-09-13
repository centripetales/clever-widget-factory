import { useNavigate } from 'react-router-dom';
import { ArrowLeft, GitGraph } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/hooks/useOrganization';
import { StateTransitionGraphView } from '@/components/shared/StateTransitionGraphView';

// v1: graph/metric only (docs/specs/azolla-impact-power-model.md §9) — no
// experience_power scoring, no path-discovery credit/payment, no
// certificates. States are human-judged tags (scripts/azolla-tag-states.js),
// not AI-classified. URL-only for now, no nav entry, same as /group-coverage
// today.
export default function StateTransitionGraph() {
  const navigate = useNavigate();
  const { organization } = useOrganization();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/dashboard')}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Dashboard
        </Button>
      </div>

      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <GitGraph className="h-7 w-7" /> State Transition Graph
        </h1>
        <p className="text-muted-foreground">
          Observed states and the actions connecting them, across every container shared into{' '}
          {organization?.name || 'this organization'}. Drag nodes to explore; click a node or connection for detail.
        </p>
      </div>

      {organization?.id && <StateTransitionGraphView orgId={organization.id} />}
    </div>
  );
}
