import type { ObservationPhoto } from './observations';

/** An observation linked to the record after its description. */
export interface FinancialRecordNote {
  id: string;
  state_text: string;
  captured_at: string;
  captured_by_name: string;
}

/** What a model read from the record's photos (a perspective of its description), and which model. */
export interface FinancialRecordPerspective {
  id: string;
  perspective_type: string;
  created_at: string;
  model_id: string;
  version: string;
  content: {
    vehicle: { id: string; name: string } | null;
    odometer: { observed: boolean; reading: number | null };
    receipt: { observed: boolean; purchases: { purchase_text: string; amount: number }[] };
    pump: { observed: boolean; liters: number | null; octane: string | null };
    policy_ids: string[];
  };
}

/** A vehicle fuel can be bought for: a tool that tracks an odometer. */
export interface FinancialRecordMachine {
  id: string;
  name: string;
  meter_name: string;
  meter_unit: string;
  rate_unit: string;
  meter_metric_id: string;
  rate_metric_id: string | null;
  fuel_metric_id: string | null;
}

/** The fuel fill saved on a record: the vehicle and its readings. The rate is worked out from them. */
export interface FinancialRecordFuelFill {
  machine: FinancialRecordMachine;
  meter_reading: number | null;
  liters: number | null;
  previous: { meter_reading: number; date: string } | null;
  rate: number | null;
}

/** A policy the record's action follows. */
export interface FinancialRecordPolicy {
  id: string;
  title: string;
  description_text: string;
  status: string;
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
  policies?: FinancialRecordPolicy[];
  perspectives?: FinancialRecordPerspective[];
  fuel_fill?: FinancialRecordFuelFill | null;
  machines?: FinancialRecordMachine[];
  vendor?: { id: string; name: string } | null;
  state_id?: string;
  action_id?: string | null;
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
