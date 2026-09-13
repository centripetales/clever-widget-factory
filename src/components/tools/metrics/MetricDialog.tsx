import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { Metric } from '@/lib/metricsApi';

interface MetricDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: {
    name: string;
    unit?: string;
    benchmark_value?: number;
    details?: string;
    active?: boolean;
  }) => void;
  metric?: Metric;
  isSubmitting?: boolean;
}

export function MetricDialog({ open, onOpenChange, onSave, metric, isSubmitting }: MetricDialogProps) {
  const [formData, setFormData] = useState({
    name: '',
    unit: '',
    benchmark_value: '',
    details: '',
    active: true,
  });

  useEffect(() => {
    if (metric) {
      setFormData({
        name: metric.name,
        unit: metric.unit || '',
        benchmark_value: metric.benchmark_value?.toString() || '',
        details: metric.details || '',
        active: metric.active !== false,
      });
    } else {
      setFormData({
        name: '',
        unit: '',
        benchmark_value: '',
        details: '',
        active: true,
      });
    }
  }, [metric, open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!formData.name.trim()) {
      return;
    }

    onSave({
      name: formData.name.trim(),
      unit: formData.unit.trim() || undefined,
      benchmark_value: formData.benchmark_value ? parseFloat(formData.benchmark_value) : undefined,
      details: formData.details.trim() || undefined,
      active: formData.active,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{metric ? 'Edit Metric' : 'Add Metric'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., Tree Girth, Ant Activity, Nut Count"
              required
            />
          </div>

          <div>
            <Label htmlFor="unit">Unit</Label>
            <Input
              id="unit"
              value={formData.unit}
              onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
              placeholder="e.g., cm, count, low/med/high"
            />
          </div>

          <div>
            <Label htmlFor="benchmark_value">Benchmark Value</Label>
            <Input
              id="benchmark_value"
              type="number"
              step="any"
              value={formData.benchmark_value}
              onChange={(e) => setFormData(prev => ({ ...prev, benchmark_value: e.target.value }))}
              placeholder="e.g., 50"
            />
          </div>

          <div>
            <Label htmlFor="details">Details</Label>
            <Textarea
              id="details"
              value={formData.details}
              onChange={(e) => setFormData(prev => ({ ...prev, details: e.target.value }))}
              placeholder="Why are you tracking this? How should it be measured?"
              rows={3}
            />
          </div>

          {metric && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="active">Active</Label>
                <p className="text-sm text-muted-foreground">
                  Disable to hide this metric from observation forms and charts, without losing its history.
                </p>
              </div>
              <Switch
                id="active"
                checked={formData.active}
                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, active: checked }))}
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !formData.name.trim()}>
              Save Metric
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
