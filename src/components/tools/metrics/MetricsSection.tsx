import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { useMetrics, useCreateMetric, useUpdateMetric, useDeleteMetric } from '@/hooks/metrics/useMetrics';
import { MetricCard } from './MetricCard';
import { MetricDialog, type MetricFormData } from './MetricDialog';
import type { Metric } from '@/lib/metricsApi';

interface MetricsSectionProps {
  toolId: string;
}

export function MetricsSection({ toolId }: MetricsSectionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMetric, setEditingMetric] = useState<Metric | undefined>();

  const { data: metrics, isLoading } = useMetrics(toolId);
  const createMetric = useCreateMetric(toolId);
  const updateMetric = useUpdateMetric(toolId);
  const deleteMetric = useDeleteMetric(toolId);

  const handleSave = (data: MetricFormData) => {
    if (editingMetric) {
      updateMetric.mutate(
        { metricId: editingMetric.metric_id, data },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingMetric(undefined);
          },
        }
      );
    } else {
      createMetric.mutate(data, {
        onSuccess: () => {
          setDialogOpen(false);
        },
      });
    }
  };

  const handleEdit = (metric: Metric) => {
    setEditingMetric(metric);
    setDialogOpen(true);
  };

  const handleDelete = (metricId: string) => {
    deleteMetric.mutate(metricId);
  };

  const handleAddNew = () => {
    setEditingMetric(undefined);
    setDialogOpen(true);
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading metrics...</div>;
  }

  const hasMetrics = metrics && metrics.length > 0;

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium mb-2">Metrics</h3>
        
        {!hasMetrics && (
          <p className="text-sm text-muted-foreground mb-2">
            No metrics defined for this tool yet
          </p>
        )}

        {hasMetrics && (
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            {metrics.map((metric) => (
              <MetricCard
                key={metric.metric_id}
                metric={metric}
                onEdit={() => handleEdit(metric)}
                onDelete={() => handleDelete(metric.metric_id)}
              />
            ))}
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddNew}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Metric
        </Button>
      </div>

      <MetricDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingMetric(undefined);
          }
        }}
        onSave={handleSave}
        metric={editingMetric}
        isSubmitting={createMetric.isPending || updateMetric.isPending}
      />
    </div>
  );
}
