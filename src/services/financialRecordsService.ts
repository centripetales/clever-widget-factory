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
  FinancialRecordFuelFill,
  FinancialRecordMachine,
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
  /** Set for a purchase already saved: it is updated, not replaced, and keeps its part */
  id?: string;
  part_id?: string | null;
  purchase_text: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number;
}

/** A fuel fill read from the photos: what the model observed, and the rate it gives (km/l, or L/h on an hour meter) */
export type ExtractedMachine = FinancialRecordMachine;

export interface ExtractedFuelFill {
  machine: ExtractedMachine;
  meter_reading: number | null;
  /** What the model read, when it was corrected to fit the previous reading */
  meter_reading_read: number | null;
  liters: number | null;
  octane: string | null;
  previous: { meter_reading: number; date: string } | null;
  rate: number | null;
}

/** A policy the record follows */
export interface FollowedPolicy {
  id: string;
  title: string;
}

/** What the model could see in the photos: the odometer, the receipt, the fuel pump */
export interface ObservedParts {
  odometer: boolean;
  receipt: boolean;
  pump: boolean;
}

export interface ExtractedReading {
  purchases: ExtractedPurchase[];
  fuel: ExtractedFuelFill | null;
  observed: ObservedParts;
  machines: ExtractedMachine[];
  policies: FollowedPolicy[];
}

const toReading = (data: ExtractedReading): ExtractedReading => ({
  purchases: data.purchases,
  fuel: data.fuel ?? null,
  observed: data.observed,
  machines: data.machines ?? [],
  policies: data.policies ?? [],
});

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
   * What is read from a saved record's photos (a draft to confirm: the reading is kept as a perspective)
   */
  async extractPurchases(id: string): Promise<ExtractedReading> {
    const response = await apiService.post(`/financial-records/${id}/purchases/extract`, {});
    return toReading(response.data || response);
  }

  /**
   * What is read from photos before the expense is saved (nothing is written)
   */
  async readPhotos(data: { photo_urls: string[]; description: string; amount: number; transaction_date: string }): Promise<ExtractedReading> {
    const response = await apiService.post('/financial-records/read-photos', data);
    return toReading(response.data || response);
  }

  /**
   * The fuel fill the person confirmed or corrected: the vehicle and its readings. With no vehicle
   * the record is not a fuel fill. The policies given are added to those its action follows.
   */
  async saveFuelFill(
    id: string,
    fill: { machine_id: string | null; meter_reading: number | null; liters: number | null; policy_ids?: string[] }
  ): Promise<FinancialRecordFuelFill | null> {
    const response = await apiService.put(`/financial-records/${id}/fuel-fill`, fill);
    return (response.data || response).fuel_fill ?? null;
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
