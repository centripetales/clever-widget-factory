import type { ObservationPhoto } from './observations';

/** An observation linked to the record after its description. */
export interface FinancialRecordNote {
  id: string;
  state_text: string;
  captured_at: string;
  captured_by_name: string;
}

export interface FinancialRecordPurchase {
  id: string;
  purchase_text: string;
  quantity: string | null;
  unit: string | null;
  amount: string;
  unit_price: string | null;
  part_id: string | null;
  part_name: string | null;
}

export interface FinancialRecord {
  id: string;
  organization_id: string;
  created_by: string | null;
  created_by_name?: string;
  transaction_date: string;
  amount: number;
  payment_method: 'Cash' | 'SCash' | 'GCash' | 'Wise';
  description?: string;
  photos?: ObservationPhoto[];
  purchases?: FinancialRecordPurchase[];
  notes?: FinancialRecordNote[];
  vendor?: { id: string; name: string } | null;
  state_id?: string;
  balance_after?: number | null;
  created_at: string;
  updated_at: string;
}

export interface FinancialRecordEdit {
  id: string;
  record_id: string;
  edited_by: string;
  edited_by_name?: string;
  edited_at: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
}

export interface FinancialRecordFilters {
  payment_method?: 'Cash' | 'SCash' | 'GCash' | 'Wise';
  start_date?: string;
  end_date?: string;
  created_by?: string;
  limit?: number;
  offset?: number;
}

export interface FinancialRecordListResponse {
  records: FinancialRecord[];
  running_balance: number;
  total_count: number;
}
