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
  rewards?: OfferedReward[];
  taking_part?: TakingPart[];
  // The open challenges this is linked to as a collaboration, and who linked each.
  addresses?: { id: string; text: string; linked_by: string }[];
}

export interface ReadyItem extends PositiveSumItem {
  role: 'recipient' | 'implementor';
  value?: number;
}

// One observation shared for an offer, with what the offer credited it.
export interface SharedObservation {
  id: string;
  person: string;
  name: string | null;
  mine: boolean;
  text: string; // what the person wrote
  photos: { url: string; description: string }[]; // each with what they wrote on it
  created_at: string;
  // 'waiting': being read (new, or changed since its reading); 'unread': waited too long.
  reading: 'read' | 'waiting' | 'unread';
  php: number | null; // null until it has been read once
  was_php: number | null; // what it was credited before an edit raised it
  feedback: string;
}

// A reward someone attached to an action. Its tally is public: what each person
// has shared and earned. One with a prompt (`ask`: what the payer wants and how
// they value it, in their words) is read by AI: each observation gets a reading
// with an amount and what would be worth more, and `php` /
// `cap_php_per_person` / `budget_php` are the most it pays for one observation,
// per person and in total. One without pays `php` for any photo with a description.
export interface OfferedReward {
  id: string;
  action_id?: string;
  // The picture a person collects when they reach its cap: gray until then.
  image?: string | null;
  ask?: string;
  budget_php?: number | null;
  spent_php?: number;
  // The viewer's observations for it that have no reading yet: on their way, or stuck.
  my_reading?: { waiting: number; unread: number };
  // The observations shared for it: the viewer's own, or everyone's for its owner. Newest first.
  observations?: SharedObservation[];
  php: number;
  cap_php_per_person: number | null;
  payer_name: string;
  terms: string; // what a person is told before accepting
  owner: string;
  closed: boolean;
  accepted_by_me: boolean;
  tally: { id: string; name: string | null; count: number; php: number }[];
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
  rewards?: OfferedReward[];
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

// A proposed collaboration with at least one open reward on it.
export interface Offer {
  id: string;
  title: string;
  created_by?: string;
  situation?: string | null; // what it is proposed for, when it sits under something
  rewards: OfferedReward[];
}

export interface MyPositiveSum {
  goals: MyGoal[];
  // Every open offer in the org. Missing in a copy saved before it existed.
  offers?: Offer[];
  ready: ReadyItem[];
  // Open entries under "Where we could improve".
  challenges?: Challenge[];
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
