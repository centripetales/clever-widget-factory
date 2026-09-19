import { apiService } from './apiService';

import type { MetricValueType } from './metricValue';

export interface Metric {
  metric_id: string;
  tool_id: string;
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
  active: boolean;
  value_type: MetricValueType;
  min_value: number | null;
  max_value: number | null;
  created_at: string;
  organization_id: string;
}

export interface CreateMetricRequest {
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
  value_type: MetricValueType;
  min_value?: number;
  max_value?: number;
}

export interface UpdateMetricRequest {
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
  active?: boolean;
  value_type: MetricValueType;
  min_value?: number;
  max_value?: number;
}

// Postgres NUMERIC comes back from the API as a string.
const toNumberOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));
const normalizeMetric = (m: Metric): Metric => ({
  ...m,
  min_value: toNumberOrNull(m.min_value),
  max_value: toNumberOrNull(m.max_value),
});

export const metricsApi = {
  // Get all metrics for a tool
  getMetrics: async (toolId: string): Promise<Metric[]> => {
    const response = await apiService.get<{ metrics: Metric[] }>(`/tools/${toolId}/metrics`);
    return response.metrics.map(normalizeMetric);
  },

  // Create a new metric
  createMetric: async (toolId: string, data: CreateMetricRequest): Promise<Metric> => {
    const response = await apiService.post<{ metric: Metric }>(`/tools/${toolId}/metrics`, data);
    return normalizeMetric(response.metric);
  },

  // Update an existing metric
  updateMetric: async (toolId: string, metricId: string, data: UpdateMetricRequest): Promise<Metric> => {
    const response = await apiService.put<{ metric: Metric }>(`/tools/${toolId}/metrics/${metricId}`, data);
    return normalizeMetric(response.metric);
  },

  // Delete a metric
  deleteMetric: async (toolId: string, metricId: string): Promise<void> => {
    await apiService.delete(`/tools/${toolId}/metrics/${metricId}`);
  },
};
