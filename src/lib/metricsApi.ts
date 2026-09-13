import { apiService } from './apiService';

export interface Metric {
  metric_id: string;
  tool_id: string;
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
  active: boolean;
  created_at: string;
  organization_id: string;
}

export interface CreateMetricRequest {
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
}

export interface UpdateMetricRequest {
  name: string;
  unit?: string;
  benchmark_value?: number;
  details?: string;
  active?: boolean;
}

export const metricsApi = {
  // Get all metrics for a tool
  getMetrics: async (toolId: string): Promise<Metric[]> => {
    const response = await apiService.get<{ metrics: Metric[] }>(`/tools/${toolId}/metrics`);
    return response.metrics;
  },

  // Create a new metric
  createMetric: async (toolId: string, data: CreateMetricRequest): Promise<Metric> => {
    const response = await apiService.post<{ metric: Metric }>(`/tools/${toolId}/metrics`, data);
    return response.metric;
  },

  // Update an existing metric
  updateMetric: async (toolId: string, metricId: string, data: UpdateMetricRequest): Promise<Metric> => {
    const response = await apiService.put<{ metric: Metric }>(`/tools/${toolId}/metrics/${metricId}`, data);
    return response.metric;
  },

  // Delete a metric
  deleteMetric: async (toolId: string, metricId: string): Promise<void> => {
    await apiService.delete(`/tools/${toolId}/metrics/${metricId}`);
  },
};
