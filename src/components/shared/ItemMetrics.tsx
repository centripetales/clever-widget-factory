import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { GroupMetricsGrid } from '@/components/shared/GroupMetricsGrid';
import { useMetrics } from '@/hooks/metrics/useMetrics';
import { useOrganization } from '@/hooks/useOrganization';
import { itemContainer, type ItemObservation } from '@/lib/metricsChart';

// Charts of one tool or part's own metrics, from the observations in its history.
export function ItemMetrics({ itemId, itemName, observations, loading }: {
  itemId: string;
  itemName: string;
  observations: ItemObservation[];
  loading?: boolean;
}) {
  const { organization } = useOrganization();
  const { data: metrics, isLoading } = useMetrics(itemId);
  const organizationId = organization?.id;
  const containers = useMemo(
    () => (organizationId ? [itemContainer({ id: itemId, name: itemName, organizationId }, metrics ?? [], observations)] : []),
    [itemId, itemName, organizationId, metrics, observations]
  );

  if (loading || isLoading || !organizationId) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading metrics...
      </div>
    );
  }
  return <GroupMetricsGrid orgId={organizationId} containers={containers} hideContainerName />;
}
