// An organization's policies, as the policies service returns them.
export type PolicyStatus = 'active' | 'deprecated';

/** An observation or experience a policy rests on. Its content is absent when it is not visible to you. */
export interface PolicySource {
  type: 'observation' | 'experience';
  id: string;
  text: string | null;
  date: string | null;
  by: string | null;
}

export interface Policy {
  id: string;
  title: string;
  description_text: string;
  /** Why we do it, when shared. */
  reasoning: string | null;
  status: PolicyStatus;
  /** How many actions follow it. */
  action_count: number;
  sources: PolicySource[];
}

/** What a person writes; the sources are linked through Claude. */
export interface PolicyText {
  title: string;
  description_text: string;
  reasoning: string;
}
