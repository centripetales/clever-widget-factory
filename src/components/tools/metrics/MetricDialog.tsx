import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Metric } from '@/lib/metricsApi';
import type { MetricValueType } from '@/lib/metricValue';

export interface MetricFormData {
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
  active?: boolean;
  value_type: MetricValueType;
  min_value?: number;
  max_value?: number;
}

interface MetricDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: MetricFormData) => void;
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
    value_type: 'number' as MetricValueType,
    min_value: '',
    max_value: '',
  });

  useEffect(() => {
    if (metric) {
      setFormData({
        name: metric.name,
        unit: metric.unit || '',
        benchmark_value: metric.benchmark_value?.toString() || '',
        details: metric.details || '',
        active: metric.active !== false,
        value_type: metric.value_type,
        min_value: metric.min_value?.toString() ?? '',
        max_value: metric.max_value?.toString() ?? '',
      });
    } else {
      setFormData({
        name: '',
        unit: '',
        benchmark_value: '',
        details: '',
        active: true,
        value_type: 'number',
        min_value: '',
        max_value: '',
      });
    }
  }, [metric, open]);

  const isNumber = formData.value_type === 'number';
  const rangeInvalid =
    isNumber && formData.min_value !== '' && formData.max_value !== '' &&
    parseFloat(formData.min_value) > parseFloat(formData.max_value);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!formData.name.trim() || rangeInvalid) {
      return;
    }

    onSave({
      name: formData.name.trim(),
      value_type: formData.value_type,
      min_value: isNumber && formData.min_value !== '' ? parseFloat(formData.min_value) : undefined,
      max_value: isNumber && formData.max_value !== '' ? parseFloat(formData.max_value) : undefined,
      unit: isNumber ? formData.unit.trim() || undefined : undefined,
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
            <Label htmlFor="value_type">Type</Label>
            <Select
              value={formData.value_type}
              onValueChange={(v) => setFormData(prev => ({ ...prev, value_type: v as MetricValueType }))}
              // A metric that already has readings keeps its type.
              disabled={!!metric}
            >
              <SelectTrigger id="value_type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="text">Text (write what was seen; leave blank if nothing)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isNumber && (
            <>
              <div>
                <Label htmlFor="unit">Unit</Label>
                <Input
                  id="unit"
                  value={formData.unit}
                  onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
                  placeholder="e.g., cm, count, low/med/high"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="min_value">Minimum</Label>
                  <Input
                    id="min_value"
                    type="number"
                    step="any"
                    value={formData.min_value}
                    onChange={(e) => setFormData(prev => ({ ...prev, min_value: e.target.value }))}
                    placeholder="e.g., 0"
                  />
                </div>
                <div>
                  <Label htmlFor="max_value">Maximum</Label>
                  <Input
                    id="max_value"
                    type="number"
                    step="any"
                    value={formData.max_value}
                    onChange={(e) => setFormData(prev => ({ ...prev, max_value: e.target.value }))}
                    placeholder="e.g., 5"
                  />
                </div>
                {rangeInvalid && (
                  <p className="col-span-2 text-sm text-destructive">Minimum can't be greater than maximum.</p>
                )}
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
            </>
          )}

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
            <Button type="submit" disabled={isSubmitting || !formData.name.trim() || rangeInvalid}>
              Save Metric
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
