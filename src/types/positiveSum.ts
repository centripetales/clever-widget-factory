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

// Someone taking part in a desired state, with what they said about their
// ideas and how they want to be involved.
export interface TakingPart {
  id: string;
  name: string | null;
  comments: string[];
}

export interface MyGoal extends PositiveSumItem {
  options: SuggestedOption[];
  participants?: string[]; // who joined
  taking_part?: TakingPart[];
  // The open challenges this is linked to as a collaboration, and who linked each.
  addresses?: { id: string; text: string; linked_by: string }[];
}

export interface ReadyItem extends PositiveSumItem {
  role: 'recipient' | 'implementor';
  value?: number;
}

// A collaboration someone proposed: an action whose title says what to do and
// whose existing state is the situation it answers.
export interface ProposedCollaboration {
  id: string;
  title: string;
  status: string;
  created_by: string;
  created_by_name: string | null;
  participants: string[]; // who joined
}

// Something a person is running into, in their words. People vote for the
// ones that matter to them too and propose collaborations for them.
export interface Challenge {
  id: string;
  organization_id: string;
  text: string;
  owner: string; // the challenge's assignee; only they edit or delete it
  owner_name: string | null;
  created_at: string;
  votes: number;
  voted_by_me: boolean;
  voters?: { id: string; name: string | null }[];
  collaborations: ProposedCollaboration[];
}

export interface MyPositiveSum {
  goals: MyGoal[];
  ready: ReadyItem[];
  challenges?: Challenge[]; // everyone's open challenges in the org
  // The people of this org and of the viewer's own orgs, for assigning a challenge.
  members?: { id: string; name: string | null }[];
}

export interface NewGoal {
  organization_id: string;
  desired_state: string;
  attachments?: string[];
  challenge_id?: string; // the challenge this collaboration is proposed for
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
