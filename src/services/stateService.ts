import { apiService } from '../lib/apiService';
import type { Observation, CreateObservationData } from '../types/observations';

export const stateService = {
  async getStates(filters?: { entity_type?: string; entity_id?: string; view_shared?: string }): Promise<Observation[]> {
    const params = new URLSearchParams();
    if (filters?.entity_type) params.append('entity_type', filters.entity_type);
    if (filters?.entity_id) params.append('entity_id', filters.entity_id);
    if (filters?.view_shared) params.append('view_shared', filters.view_shared);
    
    const queryString = params.toString();
    return apiService.get(`/states${queryString ? `?${queryString}` : ''}`);
  },

  async getState(id: string): Promise<Observation> {
    return apiService.get(`/states/${id}`);
  },

  async createState(data: CreateObservationData): Promise<Observation> {
    return apiService.post('/states', data);
  },

  async updateState(id: string, data: Partial<CreateObservationData>): Promise<Observation> {
    return apiService.put(`/states/${id}`, data);
  },

  async deleteState(id: string): Promise<void> {
    return apiService.delete(`/states/${id}`);
  },
};
