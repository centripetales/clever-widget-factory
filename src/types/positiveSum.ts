// Positive Sum: goal → policy → option → approval → action → experience.
// Shapes returned by the /positive-sum/* routes (lambda/actions/positiveSum.js).

export interface PositiveSumItem {
  id: string;
  organization_id: string;
  title: string;
  initial_state: string | null;
  policy: string | null;
  desired_state: string | null;
  status: string;
  created_by: string;
  implementors: string[];
  required_tools: string[];
  attachments: string[];
  created_at: string;
}

export interface Opportunity extends PositiveSumItem {
  kind: 'goal' | 'option';
  organization_name: string;
  created_by_name: string | null;
  capacity: number | null;
  goal_ids: string[];
}

export interface SuggestedOption extends PositiveSumItem {
  value: number;
  approved_by_me: boolean;
}

export interface MyGoal extends PositiveSumItem {
  options: SuggestedOption[];
}

export interface ReadyItem extends PositiveSumItem {
  role: 'recipient' | 'implementor';
  value?: number;
}

export interface MyPositiveSum {
  goals: MyGoal[];
  ready: ReadyItem[];
}

export interface NewGoal {
  organization_id: string;
  desired_state: string;
  attachments?: string[];
}

export interface NewOption {
  goal_ids: string[];
  source_option_ids?: string[];
  initial_state: string;
  policy: string;
  final_state: string;
  capacity?: number;
  parent_option_id?: string | null;
}

// The action behind a transaction (lambda/actions/transaction.js).
export interface NamedOrganization {
  id: string;
  name: string;
}

export interface TransactionAction {
  action_id: string;
  other_org: NamedOrganization;
}

// The LLM's draft for the review; the organization has no id when it isn't in the app yet.
export interface TransactionDraft {
  other_org: { id: string | null; name: string };
  llm_generation_config_id: string;
}

export interface NewTransactionAction {
  other_org_id: string;
  llm_generation_config_id?: string;
}
