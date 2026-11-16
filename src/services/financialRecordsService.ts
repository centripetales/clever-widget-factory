/**
 * FinancialRecordsService
 *
 * Handles financial record CRUD operations for cash tracking.
 * Follows the explorationService pattern — class with methods that call apiService.
 *
 * Requirements: 5.1, 6.1, 7.1
 */

import { apiService } from '../lib/apiService';
import type {
  FinancialRecord,
  FinancialRecordFilters,
  FinancialRecordListResponse,
} from '../types/financialRecords';

export interface CreateFinancialRecordRequest {
  transaction_date: string;
  description: string;
  amount: number;
  payment_method: 'Cash' | 'SCash' | 'GCash' | 'Wise';
  photos?: { photo_url: string; photo_description?: string; photo_order: number }[];
}

export interface UpdateFinancialRecordRequest {
  transaction_date?: string;
  amount?: number;
  payment_method?: 'Cash' | 'SCash' | 'GCash' | 'Wise';
  description?: string;
  photos?: { photo_url: string; photo_description?: string; photo_order: number }[];
}

export interface ExtractedPurchase {
  purchase_text: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number;
}

/** A fuel fill read from the photos: what the model observed, and the rate it gives (km/l, or L/h on an hour meter) */
export interface ExtractedFuelFill {
  machine: {
    id: string;
    name: string;
    meter_name: string;
    meter_unit: string;
    rate_unit: string;
    meter_metric_id: string;
    rate_metric_id: string | null;
    fuel_metric_id: string | null;
  };
  meter_reading: number | null;
  liters: number | null;
  octane: string | null;
  observed: { meter_photo: boolean; pump_photo: boolean; receipt_photo: boolean; full_tank: boolean };
  previous: { meter_reading: number; date: string } | null;
  rate: number | null;
}

/** A policy the record follows, and what it asks for that was not observed in the photos */
export interface FollowedPolicy {
  id: string;
  title: string;
  not_observed: string[];
}

export interface ExtractedReading {
  purchases: ExtractedPurchase[];
  fuel: ExtractedFuelFill | null;
  policies: FollowedPolicy[];
}

export class FinancialRecordsService {
  /**
   * List financial records with optional filters and running balance
   * @param filters - Optional filters (funding_source, date range, created_by, pagination)
   * @returns Promise<FinancialRecordListResponse> - Records, running balance, and total count
   */
  async listRecords(filters?: FinancialRecordFilters): Promise<FinancialRecordListResponse> {
    try {
      const queryParams = new URLSearchParams();

      if (filters?.payment_method) {
        queryParams.append('payment_method', filters.payment_method);
      }
      if (filters?.start_date) {
        queryParams.append('start_date', filters.start_date);
      }
      if (filters?.end_date) {
        queryParams.append('end_date', filters.end_date);
      }
      if (filters?.created_by) {
        queryParams.append('created_by', filters.created_by);
      }
      if (filters?.limit !== undefined) {
        queryParams.append('limit', String(filters.limit));
      }
      if (filters?.offset !== undefined) {
        queryParams.append('offset', String(filters.offset));
      }

      const queryString = queryParams.toString();
      const endpoint = queryString
        ? `/financial-records?${queryString}`
        : '/financial-records';

      const response = await apiService.get(endpoint);
      const data = response.data || response;

      return {
        records: data.records || [],
        running_balance: data.running_balance ?? 0,
        total_count: data.total_count ?? 0,
      };
    } catch (error) {
      console.error('Error listing financial records:', error);
      throw error;
    }
  }

  /**
   * Get a single financial record by ID (includes edit history)
   * @param id - Record UUID
   * @returns Promise<FinancialRecord> - The record with edits
   */
  async getRecord(id: string): Promise<FinancialRecord & { edits?: any[] }> {
    try {
      const response = await apiService.get(`/financial-records/${id}`);
      return response.data || response;
    } catch (error) {
      console.error('Error fetching financial record:', error);
      throw error;
    }
  }

  /**
   * Create a new financial record
   * @param data - Record creation data
   * @returns Promise<FinancialRecord> - The created record
   */
  async createRecord(data: CreateFinancialRecordRequest): Promise<FinancialRecord> {
    try {
      const response = await apiService.post('/financial-records', data);
      return response.data || response;
    } catch (error) {
      console.error('Error creating financial record:', error);
      throw error;
    }
  }

  /**
   * Update an existing financial record (partial update)
   * @param id - Record UUID
   * @param data - Fields to update
   * @returns Promise<FinancialRecord & { running_balance?: number }> - Updated record with running balance
   */
  async updateRecord(
    id: string,
    data: UpdateFinancialRecordRequest
  ): Promise<FinancialRecord & { running_balance?: number }> {
    try {
      const response = await apiService.put(`/financial-records/${id}`, data);
      return response.data || response;
    } catch (error) {
      console.error('Error updating financial record:', error);
      throw error;
    }
  }

  /**
   * Delete a financial record
   * @param id - Record UUID
   * @returns Promise<void>
   */
  async deleteRecord(id: string): Promise<void> {
    try {
      await apiService.delete(`/financial-records/${id}`);
    } catch (error) {
      console.error('Error deleting financial record:', error);
      throw error;
    }
  }

  /**
   * Purchases read from the record's photos (a draft: nothing is saved)
   */
  async extractPurchases(id: string): Promise<ExtractedReading> {
    const response = await apiService.post(`/financial-records/${id}/purchases/extract`, {});
    const { purchases, fuel, policies } = response.data || response;
    return { purchases, fuel: fuel ?? null, policies: policies ?? [] };
  }

  /**
   * The policies an action follows
   */
  async getActionPolicyIds(actionId: string): Promise<string[]> {
    const response = await apiService.get(`/actions/${actionId}/policies`);
    return ((response.data || response).policies as { id: string }[]).map((policy) => policy.id);
  }

  async setActionPolicyIds(actionId: string, policyIds: string[]): Promise<void> {
    await apiService.put(`/actions/${actionId}/policies`, { policy_ids: policyIds });
  }

  /**
   * Save the record's purchases
   */
  async savePurchases(id: string, purchases: ExtractedPurchase[]): Promise<void> {
    await apiService.put(`/financial-records/${id}/purchases`, { purchases });
  }
}

// Export a singleton instance for convenience
export const financialRecordsService = new FinancialRecordsService();
