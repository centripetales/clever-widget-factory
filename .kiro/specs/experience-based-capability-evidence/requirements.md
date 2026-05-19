# Requirements Document

## Introduction

The current per-axis capability scoring system retrieves evidence only from states that are linked to learning objectives on the specific action being assessed (`INNER JOIN state_links sl ON sl.entity_type = 'learning_objective'`). This is too narrow: it ignores the full body of work a person has personally written across the organisation — field observations, action updates, and notes on any action they have touched.

This feature changes the evidence source for per-axis capability scoring to draw from **all states personally written by the user** (`captured_by = userId`) across the entire organisation, not just states linked to learning objectives on the current action. Quiz answers are already captured this way and remain as a secondary signal. The top-N results are still selected by vector similarity to the `skill_axis` embedding. The response shape, caching logic, and learning completion data are unchanged.

## Glossary

- **Capability_Lambda**: The `lambda/capability/index.js` Lambda that scores a user's demonstrated capability against a skill profile using per-axis vector similarity.
- **Evidence_Pool**: The set of states eligible to be retrieved as evidence for a given axis and user. After this change, the pool is all states where `captured_by = userId` in `unified_embeddings` (entity_type = `'state'`), filtered by organisation.
- **Per_Axis_Evidence_Query**: The SQL query inside `handlePerAxisCapability` that retrieves the top-N states most similar to a `skill_axis` embedding for a given user and axis.
- **Observation**: A state written by the user that is not a quiz answer — field notes, action updates, personal reflections. Detected by the absence of the quiz answer pattern in `determineEvidenceTypeEnriched`.
- **Quiz_Answer**: A state written by the user that records a quiz response. Detected by `determineEvidenceTypeEnriched` — recognition answers contain "which was the correct answer"; open-form answers match the open-form state text pattern.
- **Skill_Axis_Embedding**: The vector stored in `unified_embeddings` with `entity_type = 'skill_axis'`, `action_id`, and `axis_key`. Used as the query vector for per-axis similarity search.
- **Learning_Completion_Data**: Quiz completion counts and objective texts fetched by `fetchLearningCompletionData`. This data is unchanged by this feature.
- **Bedrock_Prompt**: The prompt sent to Claude in `callBedrockForPerAxisCapability` to synthesise capability levels from per-axis evidence.
- **Evidence_Limit**: The maximum number of evidence items retrieved per axis, controlled by `aiConfig.evidence_limit`.
- **State_Link**: A row in the `state_links` table linking a state to an entity. The current evidence query requires a `state_links` row with `entity_type = 'learning_objective'`; this requirement is removed.

---

## Requirements

### Requirement 1: Expand the Per-Axis Evidence Pool to All User-Authored States

**User Story:** As a learner, I want my capability score to reflect everything I have personally written across the organisation — not just quiz answers on the current action — so that my field observations and notes on any action count as evidence of my capability.

#### Acceptance Criteria

1. WHEN `handlePerAxisCapability` queries evidence for an axis, THE Capability_Lambda SHALL retrieve states from `unified_embeddings` where `entity_type = 'state'` and the joined `states` row has `captured_by = userId`, without requiring a `state_links` row with `entity_type = 'learning_objective'`.

2. WHEN `handlePerAxisCapability` queries evidence for an axis, THE Capability_Lambda SHALL filter results to the user's organisation using `ue.organization_id = organizationId`.

3. THE Capability_Lambda SHALL rank retrieved states by vector similarity to the `skill_axis` embedding for the axis being scored, using the existing cosine similarity expression `(1 - (ue.embedding <=> skill_axis_embedding))`.

4. THE Capability_Lambda SHALL limit retrieved evidence to `aiConfig.evidence_limit` items per axis, preserving the existing top-N behaviour.

5. WHEN a user has written observations on actions they are not assigned to, THE Capability_Lambda SHALL include those observations in the evidence pool, because authorship (`captured_by`) is the only eligibility criterion.

6. THE Capability_Lambda SHALL exclude states with `state_text` prefixed by `[capability_profile]` or `[learning_objective]` from the evidence pool, consistent with the existing exclusion in `fetchEvidenceStateIds`.

---

### Requirement 2: Quiz Answers Remain in the Evidence Pool

**User Story:** As a learner, I want my quiz answers to continue contributing to my capability score alongside my field observations, so that structured learning activity is not discarded when the evidence pool is broadened.

#### Acceptance Criteria

1. WHEN the expanded evidence pool is queried, THE Capability_Lambda SHALL include states that are quiz answers (`captured_by = userId`) alongside observation states, because quiz answers are already authored by the user and satisfy the `captured_by` filter.

2. THE Capability_Lambda SHALL continue to classify each retrieved state using `determineEvidenceTypeEnriched` to distinguish quiz answers (recognition, open-form) from observations, so that the Bedrock prompt can weight them appropriately.

3. THE Capability_Lambda SHALL NOT require any change to `determineEvidenceTypeEnriched` or `capabilityUtils.js` — evidence classification is unchanged.

---

### Requirement 3: Learning Completion Data Is Unchanged

**User Story:** As a learner, I want my quiz completion progress (objectives completed, recognition vs open-form counts) to continue feeding into my capability score, so that structured learning activity is still reflected even after the evidence query changes.

#### Acceptance Criteria

1. THE Capability_Lambda SHALL continue to call `fetchLearningCompletionData` with the same parameters and include its output in the Bedrock prompt, unchanged from the current implementation.

2. THE Capability_Lambda SHALL continue to call `fetchLearningCompletionCount` for cache hash computation, unchanged from the current implementation.

3. WHEN no evidence is found in the expanded pool and no learning completion data exists, THE Capability_Lambda SHALL return the zero capability profile, consistent with existing behaviour.

---

### Requirement 4: Bedrock Prompt Handles Mixed Evidence

**User Story:** As a system operator, I want the Bedrock prompt to correctly interpret a mix of field observations and quiz answers, so that the capability assessment is accurate when evidence comes from across the organisation rather than only from quiz activity.

#### Acceptance Criteria

1. WHEN `callBedrockForPerAxisCapability` builds the per-axis evidence sections, THE Capability_Lambda SHALL label each evidence item with its type tag (`[observation]`, `[quiz:recognition]`, `[quiz:bridging, score:X]`, etc.) using the existing tag-building logic, which already handles both observations and quiz answers.

2. WHEN an axis has evidence that includes observations from actions other than the scored action, THE Capability_Lambda SHALL include the `source_action_title` for each evidence item in the prompt, so the model has context about where the observation came from.

3. THE Capability_Lambda SHALL retain the existing `EVIDENCE TYPE INTERPRETATION` section in the Bedrock prompt, which already explains how to interpret both observation and quiz evidence types.

4. WHEN the Bedrock prompt describes the axes, THE Capability_Lambda SHALL continue to include the axis `description` (if present) as the concept context, unchanged from the current prompt construction.

---

### Requirement 5: Response Shape and Caching Are Unchanged

**User Story:** As a frontend consumer, I want the capability response shape to remain identical after this change, so that no frontend code needs to be updated.

#### Acceptance Criteria

1. THE Capability_Lambda SHALL return the same response shape as before: `{ user_id, user_name, action_id, narrative, axes, total_evidence_count, computed_at }` with each axis containing `{ key, label, level, evidence_count, evidence, axis_narrative }`.

2. THE Capability_Lambda SHALL continue to use `fetchEvidenceStateIds` (which already queries all user-authored states by `captured_by`) for cache hash computation — no change is needed to the cache invalidation logic.

3. WHEN a cached profile exists and the evidence hash is unchanged, THE Capability_Lambda SHALL return the cached profile without re-querying evidence or calling Bedrock, unchanged from the current cache-first behaviour.

4. THE Capability_Lambda SHALL continue to store and update cached profiles using `storeCachedProfile` and `updateCachedProfile`, unchanged.

---

### Requirement 6: Organisation-Level Capability Is Not Affected

**User Story:** As a system operator, I want the organisation-level capability scoring path to remain unchanged, so that this feature only affects per-user scoring.

#### Acceptance Criteria

1. THE `handleOrganizationCapability` function SHALL NOT be modified by this feature — it has its own evidence query that is out of scope.

2. THE Capability_Lambda SHALL apply the evidence pool expansion only within `handlePerAxisCapability`, which is the per-user scoring path.

---

## Notes on Existing Code

The following observations from the current codebase are directly relevant to implementation:

- **`handlePerAxisCapability` (lines ~265–330 of `lambda/capability/index.js`)**: The current `axisSearchResult` query has `INNER JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'learning_objective'`. This join must be removed. The `captured_by = userIdSafe` filter on `states s` is already present and becomes the sole eligibility criterion.

- **`fetchEvidenceStateIds`**: Already queries all states where `captured_by = userId`, excluding `[capability_profile]` and `[learning_objective]` prefixed states. The cache hash computation is therefore already consistent with the expanded evidence pool — no change needed.

- **`determineEvidenceTypeEnriched`**: Already handles both observation and quiz evidence types. No change needed.

- **`callBedrockForPerAxisCapability`**: The tag-building logic and `EVIDENCE TYPE INTERPRETATION` section already handle both `[observation]` and `[quiz:*]` tags. The `source_action_title` field is already resolved and included per evidence item. The prompt already includes `axis.description` when present. The only change needed is ensuring the prompt's framing does not assume evidence is exclusively quiz-based — the existing prompt already uses neutral language ("per-axis evidence") so no wording change is required.

- **`handleOrganizationCapability`**: Has its own evidence query with the same `INNER JOIN state_links` pattern. This is explicitly out of scope for this feature.
