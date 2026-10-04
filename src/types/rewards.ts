// Rewards of an action — the REWARD perspective (lambda/actions/reward.js):
// claims about what moved between organizations, with amounts only as stated.
export interface RewardClaim {
  name: string;
  from_org_id: string | null; // null: not an organization in the app
  from_name: string;
  to_org_id: string | null; // same as from_org_id: time or money the org spent itself
  to_name: string;
  php: number | null; // null: not stated
  hours: number | null;
  cost_basis_method: 'purchase_price' | 'next_best_option_price' | null;
  claim: string;
  source_state_ids: string[];
}

// The single alternative people mentioned, priced as stated (stated parts may
// be added up). The saving is computed in the app, never stored.
export interface NextBestOption {
  name: string;
  php: number | null;
  hours: number | null;
  replaces: string[]; // names of the claims it would have replaced
  claim: string;
  source_state_ids: string[];
}

export interface ActionRewards {
  claims?: RewardClaim[]; // absent on rewards built before claims; rebuild to update
  next_best_option?: NextBestOption | null;
  org_names: Record<string, string>;
  context_state_ids: string[];
  generated_by?: string;
  created_at: string;
  status: 'SUCCESS' | 'FAILED';
  error: string | null;
}
