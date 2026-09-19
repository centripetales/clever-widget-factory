export type MetricValueType = 'number' | 'text';

export interface MetricValueRules {
  name: string;
  value_type: MetricValueType;
  min_value: number | null;
  max_value: number | null;
}

// Why `raw` can't be saved for this metric, or null when it can. A blank is
// fine here: a blank entry just means no reading is stored. Mirrors
// validateMetricValue in lambda/snapshots/index.js.
export function validateMetricValue(metric: MetricValueRules, raw: string): string | null {
  const text = raw.trim();
  if (text === '' || metric.value_type === 'text') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return 'Enter a number';
  if (metric.min_value !== null && n < metric.min_value) return `Must be at least ${metric.min_value}`;
  if (metric.max_value !== null && n > metric.max_value) return `Must be at most ${metric.max_value}`;
  return null;
}

// "0-5", "≥ 0", "≤ 100", or null when the metric has no range.
export function describeRange(metric: Pick<MetricValueRules, 'min_value' | 'max_value'>): string | null {
  const { min_value: min, max_value: max } = metric;
  if (min !== null && max !== null) return `${min}–${max}`;
  if (min !== null) return `≥ ${min}`;
  if (max !== null) return `≤ ${max}`;
  return null;
}
