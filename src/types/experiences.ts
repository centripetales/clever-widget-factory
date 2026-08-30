import { BaseAction } from './actions';
import { ObservationPhoto } from './observations';

/**
 * Experience - Represents a state transition (S → A → S') for learning and analysis
 * Captures observed changes in entities (tools, parts) across time
 */
export interface Experience {
  id: string;
  entity_type: 'tool' | 'part';
  entity_id: string;
  organization_id: string;
  created_by: string;
  created_at: string;
  
  metadata?: {
    experience_perspective_id?: string;
    llm_generation_config_id?: string;
    /**
     * Person-authored edits to an attached action's CLAIM, keyed by action id.
     * Stored here rather than overwriting the action's own CLAIM perspective,
     * so the AI baseline survives and delta(original, edit) stays computable.
     */
    action_claim_edits?: Record<string, string>;
    [key: string]: unknown;
  };

  // Populated from joins
  entity?: Tool | Part;

  /**
   * All three legs are arrays. An experience legitimately has several states
   * and several actions per leg — e.g. start with ash, measure phosphorus and
   * take a water sample (two actions), end with the phosphorus reading and the
   * water reading (two final states). Any leg may also be empty: an experience
   * whose outcome hasn't been observed yet is normal, not invalid.
   */
  components?: {
    initial_states?: ExperienceComponent[];
    actions?: ExperienceComponent[];
    final_states?: ExperienceComponent[];
  };
}

/**
 * ExperienceComponent - Links experiences to states or actions
 * Represents one component of the state transition tuple (S, A, or S')
 */
export interface ExperienceComponent {
  id: string;
  experience_id: string;
  component_type: 'initial_state' | 'action' | 'final_state';
  state_id?: string;
  action_id?: string;
  organization_id: string;
  created_at: string;
  
  // Populated from joins — a lighter shape than the full Observation type,
  // matching exactly what lambda/experiences/index.js's component queries
  // select, not a full observation.
  state?: {
    id: string;
    state_text: string | null;
    captured_at: string;
    /** captured_at here is the photo's own EXIF/file date (from
     *  photo_metadata_extractions), not the state row's — prefer it for
     *  date-range display since a synthesized state's own captured_at is
     *  just when the write-up was made. */
    photos?: (ObservationPhoto & { captured_at?: string | null })[];
    /** Measurements on this state — for a measurement-shaped final state these
     *  readings ARE the outcome, so they're first-class here, not just prose. */
    metrics?: ExperienceStateMetric[];
  };
  action?: BaseAction & {
    /** The action's own CLAIM perspective — the dense account of what was done. */
    claim?: string | null;
    report_span?: string | null;
    /** A person's edit of that claim, stored on the experience (see metadata). */
    claim_edit?: string | null;
    action_type?: string | null;
    /** photo_urls (from this action's linked observations) explicitly picked
     *  as part of this write-up — opt-in, default none (see metadata). */
    included_photo_urls?: string[];
  };
}

export interface ExperienceStateMetric {
  snapshot_id: string;
  name: string;
  value: string | number;
  unit?: string | null;
}

/**
 * Tool - Basic tool entity structure
 * Full definition should exist elsewhere, this is a minimal reference
 */
export interface Tool {
  id: string;
  name: string;
  category?: string;
  description?: string;
}

/**
 * Part - Basic part entity structure
 * Full definition should exist elsewhere, this is a minimal reference
 */
export interface Part {
  id: string;
  name: string;
  category?: string;
  description?: string;
}

/**
 * CreateExperienceRequest - Request payload for creating a new experience
 */
export interface CreateExperienceRequest {
  entity_type: 'tool' | 'part';
  entity_id: string;

  // Plural forms are current. Every leg is optional — only the entity is
  // required, so an experience can be created before its outcome is observed.
  initial_state_ids?: string[];
  action_ids?: string[];
  final_state_ids?: string[];

  // Deprecated singular forms, still accepted by the API (StockDetails.tsx).
  initial_state_id?: string;
  action_id?: string;
  final_state_id?: string;

  /** Set at creation time so picks made before the first save aren't lost. */
  action_photo_inclusions?: Record<string, string[]>;

  /** When this experience was written from an AI draft ("Draft Experience"),
   *  the untouched draft's own state_perspectives id — kept so
   *  delta(AI draft, human result) stays computable. Set once; never
   *  overwritten by a later save. */
  experience_perspective_id?: string;
  llm_generation_config_id?: string;
}

/**
 * UpdateExperienceRequest - PUT payload. Omitting a leg leaves it untouched;
 * passing [] clears it.
 */
export interface UpdateExperienceRequest {
  initial_state_ids?: string[];
  action_ids?: string[];
  final_state_ids?: string[];
  /** Person-authored CLAIM edits, keyed by action id. Merged into metadata. */
  action_claim_edits?: Record<string, string>;
  /** Linked photo_urls explicitly picked per action, keyed by action id. Merged into metadata. */
  action_photo_inclusions?: Record<string, string[]>;

  /** Same as on CreateExperienceRequest — set once, never cleared by a save
   *  that omits it. */
  experience_perspective_id?: string;
  llm_generation_config_id?: string;
}

/**
 * ExperienceListParams - Query parameters for listing experiences
 */
export interface ExperienceListParams {
  entity_type?: 'tool' | 'part';
  entity_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * ExperienceListResponse - Paginated response for experience list
 */
export interface ExperienceListResponse {
  data: Experience[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}
