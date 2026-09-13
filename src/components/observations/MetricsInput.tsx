import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { X, Info } from 'lucide-react';
import { useMetrics } from '@/hooks/metrics/useMetrics';

interface MetricsInputProps {
  toolId: string;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function MetricsInput({ toolId, values, onChange }: MetricsInputProps) {
  const { data: allMetrics, isLoading } = useMetrics(toolId);
  const metrics = allMetrics?.filter((metric) => metric.active !== false);

  const handleChange = (metricId: string, value: string) => {
    onChange({
      ...values,
      [metricId]: value,
    });
  };

  const handleDelete = (metricId: string) => {
    const newValues = { ...values };
    delete newValues[metricId];
    onChange(newValues);
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading metrics...</div>;
  }

  if (!metrics || metrics.length === 0) {
    return <div className="text-sm text-muted-foreground">No metrics defined for this tool.</div>;
  }

  return (
    <TooltipProvider>
      <div className="space-y-2">
        {metrics.map((metric) => (
          <div key={metric.metric_id} className="flex gap-2 items-center">
            <div className="flex items-center gap-1 flex-shrink-0">
              <Label htmlFor={`metric-${metric.metric_id}`} className="text-sm whitespace-nowrap">
                {metric.name}
              </Label>
              {(metric.benchmark_value !== null || metric.details) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help flex-shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-1">
                      {metric.benchmark_value !== null && (
                        <p className="text-sm">
                          <span className="font-medium">Benchmark:</span> {metric.benchmark_value} {metric.unit || ''}
                        </p>
                      )}
                      {metric.details && (
                        <p className="text-sm">{metric.details}</p>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <Input
              id={`metric-${metric.metric_id}`}
              type="text"
              value={values[metric.metric_id] || ''}
              onChange={(e) => handleChange(metric.metric_id, e.target.value)}
              placeholder="Enter value"
              className="flex-1 min-w-0"
            />
            {metric.unit && (
              <span className="text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">
                {metric.unit}
              </span>
            )}
            {values[metric.metric_id] && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleDelete(metric.metric_id)}
                className="flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
