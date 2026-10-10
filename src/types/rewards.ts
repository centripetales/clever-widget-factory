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

// An alternative someone stated for one party, priced as stated (stated parts
// may be added up; hours stay hours). The value created is computed in the
// app, never stored.
export interface NextBestOption {
  name: string;
  for_org_id: string | null; // the party whose alternative it is; null: not an organization in the app
  for_name: string;
  // What the same thing would have cost this party another way, what it would
  // have had without this action, or that it had no other way to get this
  // (capability expanding: there is no advantage to work out).
  kind: 'cost_another_way' | 'had_otherwise' | 'no_other_option';
  php: number | null;
  hours: number | null;
  done_by: string | null; // who would have spent the hours
  replaces: string[]; // names of the claims it stands in place of
  claim: string;
  source_state_ids: string[];
  stated_by?: string[]; // the people whose observations it comes from
}

export interface ActionRewards {
  claims?: RewardClaim[]; // absent on rewards built before claims; rebuild to update
  next_best_options?: NextBestOption[];
  // Rewards built before several options: one, always a cost for whoever paid.
  next_best_option?: Omit<NextBestOption, 'for_org_id' | 'for_name' | 'kind' | 'done_by'> | null;
  org_names: Record<string, string>;
  context_state_ids: string[];
  generated_by?: string;
  created_at: string;
  status: 'SUCCESS' | 'FAILED';
  error: string | null;
}
