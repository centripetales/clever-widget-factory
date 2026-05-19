// Unified Action Types - Single source of truth for all action interfaces

export interface BaseAction {
  id: string;
  title: string;
  description?: string;
  policy?: string;
  status: string;
  assigned_to?: string | null;
  assigned_to_name?: string;
  assigned_to_color?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  issue_reference?: string;
  observations?: string;
  estimated_completion_date?: string | null;
  
  // Exploration flag - authoritative indicator
  is_exploration?: boolean;
  
  // Exploration-related fields (logical field mappings)
  state_text?: string; // Maps to description field
  policy_text?: string; // Maps to policy field
  summary_policy_text?: string; // New field for per-action synthesis
  policy_id?: number; // Foreign key to policy table
  
  // Parent relationship fields - only one should be set
  mission_id?: string | null;
  asset_id?: string | null;
  
  // Additional optional fields
  required_tools?: string[];
  required_tool_serial_numbers?: string[];
  required_stock?: { part_id: string; quantity: number; part_name: string; }[];
  attachments?: string[];
  scoring_data?: any;
  plan_commitment?: boolean | null;
  policy_agreed_at?: string | null;
  policy_agreed_by?: string | null;
  participants?: string[];
  has_implementation_updates?: boolean; // Boolean flag from Lambda indicating if states exist
  
  // Observation-based training fields
  expected_state?: string | null; // Expected outcome (S') - where we want to get to
  skill_profile?: {
    narrative: string;
    axes: { key: string; label: string; required_level: number }[];
    generated_at: string;
    approved_at?: string;
    approved_by?: string;
  } | null;
  
  // Related objects (populated by joins)
  assignee?: {
    id: string;
    user_id: string;
    full_name: string;
    role: string;
    favorite_color?: string;
  } | null;
  participants_details?: {
    id: string;
    user_id: string;
    full_name: string;
    role: string;
    favorite_color?: string;
  }[];
  mission?: {
    id: string;
    title: string;
    mission_number: number;
    status: string;
  } | null;
  asset?: {
    id: string;
    name: string;
    category?: string;
  } | null;
  issue_tool?: {
    id: string;
    name: string;
    description?: string;
  } | null;
}

export interface Profile {
  id: string;
  user_id: string;
  full_name: string;
  role: string;
  favorite_color?: string;
}

export interface ActionCreationContext {
  type: 'mission' | 'asset';
  parentId?: string;
  parentTitle?: string;
  prefilledData?: Partial<BaseAction>;
}

// Helper functions for creating context-specific actions
export const createMissionAction = (missionId: string): Partial<BaseAction> => ({
  mission_id: missionId,
  status: 'not_started',
  title: '',
  description: '',
  expected_state: '',
  state_text: '', // Logical field mapping
  policy: '',
  policy_text: '', // Logical field mapping
  summary_policy_text: '',
  assigned_to: null,
  participants: [],
  required_tools: [],
  required_stock: [],
  attachments: []
});

export const createIssueAction = (
  _issueId: string,
  _issueDescription?: string,
  _toolId?: string
): Partial<BaseAction> => ({
  // Issue system removed - returns empty action
  status: 'not_started',
  title: '',
  description: '',
  required_tools: [],
  required_stock: [],
  attachments: [],
});

export const createAssetAction = (assetId: string): Partial<BaseAction> => ({
  asset_id: assetId,
  status: 'not_started',
  title: '',
  description: '',
  expected_state: '',
  state_text: '', // Logical field mapping
  policy: '',
  policy_text: '', // Logical field mapping
  summary_policy_text: '',
  assigned_to: null,
  participants: [],
  required_tools: [],
  required_stock: [],
  attachments: []
});

export const createExplorationAction = (): Partial<BaseAction> => ({
  status: 'not_started',
  title: '',
  description: '',
  expected_state: '',
  state_text: '', // What situation/problem/context are you exploring?
  policy: '',
  policy_text: '', // What policy/best practice are you following?
  summary_policy_text: '', // AI-assisted synthesis of how this should be done
  assigned_to: null,
  participants: [],
  required_tools: [],
  required_stock: [],
  attachments: [],
  is_exploration: true // Mark as exploration
});

// Validation helpers
export const validateActionRelationship = (action: Partial<BaseAction>): boolean => {
  const relationships = [
    action.mission_id,
    action.asset_id,
  ].filter(Boolean);
  
  return relationships.length <= 1;
};

export const getActionTypeFromAction = (action: BaseAction): ActionCreationContext['type'] => {
  if (action.mission_id) return 'mission';
  return 'asset';
};

export interface ImplementationUpdate {
  id: string;
  action_id: string;
  updated_by: string;
  update_text: string;
  update_type?: string; // 'progress' for observations, other types for different update categories
  created_at: string;
  updated_by_profile?: {
    full_name: string;
    user_id: string;
    favorite_color?: string | null;
  };
}

export interface Exploration {
  id: number;
  action_id: string;
  exploration_code: string;
  exploration_notes_text?: string;
  metrics_text?: string;
  public_flag: boolean;
  created_at: string;
  updated_at: string;
}