# Requirements Document

## Introduction

This feature replaces the current "skill axes" model with **learning focuses** — a richer semantic anchor for the CWF learning module. The core problem is that a short axis label like "Ionic Interaction Dynamics in Soil Chemistry" is a thin embedding: the vector doesn't capture what the person actually wants to learn, and the two-step approval flow (axes first, then lazy objective generation) creates delays and a fragmented experience.

A learning focus adds a **rich description** (2–4 sentences) to each axis. The description captures the core concept, why it matters for this action, what understanding looks like, and what questions it raises — all grounded in the user's own growth intent. The embedding is built from this description, not just the label. Farm-specific context (soil samples, past observations, field notes) is retrieved dynamically at query time via vector similarity, not baked into the description.

The approval flow is also unified: when the user approves a skill profile, the learning focuses (with their descriptions) are generated and approved in one step. The existing learning objectives system coexists for now; quiz questions will eventually be generated directly from the focus description, but that simplification is out of scope for this iteration.

## Glossary

- **Skill_Profile**: The JSON object stored in `actions.skill_profile`, containing a narrative, a list of axes (learning focuses), and approval metadata.
- **Learning_Focus**: A single axis in the skill profile, now carrying `key`, `label`, `description`, and `required_level`. Replaces the term "skill axis" in user-facing surfaces.
- **Focus_Description**: The 2–4 sentence rich text field on a Learning_Focus. This is the primary embedding source and the semantic anchor for quiz generation and capability scoring.
- **Growth_Intent**: Free-text written by the user describing what they want to get better at. When present, it drives the Focus_Description content.
- **Embedding_Source**: The text string sent to AWS Bedrock Titan to generate a vector embedding for a Learning_Focus.
- **Skill_Profile_Panel**: The React component (`SkillProfilePanel.tsx`) that renders the generate / preview / approved states for a skill profile on an action.
- **Capability_Lambda**: The `lambda/capability/index.js` Lambda that scores a user's demonstrated capability against a skill profile using per-axis vector similarity.
- **Learning_Lambda**: The `lambda/learning/index.js` Lambda that generates and serves learning objectives and quiz questions.
- **Axis_Utils**: The shared utility module (`lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js`) that composes embedding source text for axes.
- **Bloom_Level**: An integer 0–5 representing depth of understanding on Bloom's taxonomy (0 = no exposure, 1 = remember, 2 = understand, 3 = apply, 4 = analyze, 5 = create).

---

## Requirements

### Requirement 1: Learning Focus Description Generation

**User Story:** As a learner, I want each skill axis to carry a rich description of the concept I'm learning, so that the system can generate relevant quiz questions and accurately score my capability without needing a separate objectives layer.

#### Acceptance Criteria

1. WHEN a skill profile is generated with a `growth_intent` present, THE Skill_Profile_Generator SHALL produce a `description` field on each Learning_Focus that captures: the core concept, why it matters for this action, what understanding it looks like, and at least one specific question it raises — all grounded in the user's own growth intent words.

2. WHEN a skill profile is generated without a `growth_intent`, THE Skill_Profile_Generator SHALL produce a `description` field on each Learning_Focus derived from the action context alone (title, description, expected outcome), following the same 2–4 sentence structure.

3. THE Skill_Profile_Generator SHALL produce descriptions that are about concepts and mechanisms, not about specific farm instances (e.g., field names, specific soil sample IDs, or past observation dates).

4. THE Skill_Profile_Generator SHALL produce descriptions that are between 2 and 4 sentences in length.

5. WHEN the `isValidSkillProfile` validator is called with a profile, THE Validator SHALL reject any axis that is missing a non-empty `description` string.

6. THE Skill_Profile_Generator SHALL produce a `description` that is semantically distinct from the `label` — the description must add explanatory content beyond restating the label.

7. WHEN a skill profile is generated with a `growth_intent`, THE Skill_Profile_Generator SHALL incorporate at least one phrase or concept from the `growth_intent` text into each Focus_Description.

---

### Requirement 2: Embedding Source Uses Description as Primary Source

**User Story:** As a system operator, I want the embedding for each learning focus to be built from the rich description rather than the label, so that vector similarity searches retrieve semantically relevant evidence rather than surface-level label matches.

#### Acceptance Criteria

1. WHEN `composeAxisEmbeddingSource` is called with an axis that has a non-empty `description`, THE Axis_Utils SHALL return the `description` as the sole embedding source text, without appending the `label` or `narrative`.

2. WHEN `composeAxisEmbeddingSource` is called with an axis that has no `description` (empty or absent), THE Axis_Utils SHALL fall back to the existing behavior: `label` joined with `narrative` (if present).

3. THE Axis_Utils SHALL NOT append the `narrative` to the embedding source when a `description` is present, because the growth intent is already incorporated into the description during generation.

4. FOR ALL axes with a non-empty `description`, the embedding source returned by `composeAxisEmbeddingSource` SHALL equal `axis.description` exactly (round-trip property: the description is not transformed or truncated).

5. WHEN `ensurePerAxisEmbeddings` in the Capability_Lambda queues SQS messages for axis embeddings, THE Capability_Lambda SHALL use the updated `composeAxisEmbeddingSource` behavior, so that description-based embeddings are generated on-the-fly for profiles approved before this feature.

---

### Requirement 3: Unified Approval — Description Included at Approve Time

**User Story:** As a learner, I want to see and optionally edit the focus description before I approve the skill profile, so that I can ensure the description reflects my actual learning intent before it becomes the semantic anchor for my capability scoring.

#### Acceptance Criteria

1. WHEN a skill profile is generated, THE Skill_Profile_Panel SHALL display the `description` for each Learning_Focus in the preview state, alongside the `label` and `required_level`.

2. WHEN the skill profile is in preview state, THE Skill_Profile_Panel SHALL render the `description` as an editable textarea for each Learning_Focus, so the user can refine it before approving.

3. WHEN the user submits the approval form, THE Skill_Profile_Panel SHALL include the (possibly edited) `description` for each axis in the `skill_profile` payload sent to `POST /api/skill-profiles/approve`.

4. WHEN `POST /api/skill-profiles/approve` receives a skill profile, THE Skill_Profile_Lambda SHALL validate that each axis has a non-empty `description` before storing the profile.

5. WHEN `POST /api/skill-profiles/approve` stores the profile and queues axis embeddings, THE Skill_Profile_Lambda SHALL use the `description` as the embedding source via `composeAxisEmbeddingSource`, so that the stored embedding reflects the approved description.

6. THE Skill_Profile_Panel SHALL NOT require a separate step or page navigation to generate descriptions — descriptions SHALL be present in the same generate response that produces labels and required levels.

---

### Requirement 4: Frontend Preview Shows Description

**User Story:** As a learner reviewing a generated skill profile, I want to see the full description for each learning focus, so that I can understand what the system thinks I should learn and correct it if needed.

#### Acceptance Criteria

1. WHEN the skill profile panel is in preview state, THE Skill_Profile_Panel SHALL render each Learning_Focus as a card or grouped block containing: the `label` (editable input), the `description` (editable textarea), and the `required_level` (editable number input).

2. WHEN the skill profile panel is in approved state, THE Skill_Profile_Panel SHALL display the `label` and `description` for each Learning_Focus, so the user can see what was approved.

3. WHEN the `description` text is longer than 3 lines in the approved state, THE Skill_Profile_Panel SHALL truncate it with a "show more" affordance, so the panel does not dominate the action view.

4. THE Skill_Profile_Panel SHALL update the Zod validation schema to require a non-empty `description` string on each axis, consistent with the backend validator.

5. THE `SkillAxis` TypeScript interface in `useSkillProfile.ts` SHALL include a `description: string` field so that the type system enforces the new shape across all consumers.

---

### Requirement 5: Backward Compatibility — Existing Profiles Without Description

**User Story:** As a system operator, I want actions with skill profiles approved before this feature to continue working without errors, so that the rollout does not break existing capability scoring or learning flows.

#### Acceptance Criteria

1. WHEN `composeAxisEmbeddingSource` is called with an axis that has no `description`, THE Axis_Utils SHALL fall back to the pre-existing behavior (label + optional narrative), preserving the embedding quality for legacy profiles.

2. WHEN the Capability_Lambda encounters a skill profile axis with no `description`, THE Capability_Lambda SHALL still generate and use a `skill_axis` embedding using the fallback embedding source.

3. WHEN the Learning_Lambda generates quiz questions for an axis with no `description`, THE Learning_Lambda SHALL continue to use the axis `label` and any available learning objectives as context, unchanged from current behavior.

4. WHEN the Skill_Profile_Panel renders an approved profile that has axes without a `description` field, THE Skill_Profile_Panel SHALL display the axis without error, omitting the description section gracefully.

5. IF a user regenerates a skill profile for an action that previously had axes without descriptions, THEN THE Skill_Profile_Generator SHALL produce descriptions for all axes in the new profile, and the old profile SHALL be replaced on approval.

---

### Requirement 6: Description Drives Quiz Question Generation

**User Story:** As a learner taking a quiz, I want quiz questions to be generated from the rich focus description, so that questions are specific to the concepts I'm learning rather than generic to the axis label.

#### Acceptance Criteria

1. WHEN the Learning_Lambda generates quiz questions for an axis that has a non-empty `description`, THE Learning_Lambda SHALL include the `description` in the Bedrock prompt as the primary concept context for question generation.

2. WHEN the Learning_Lambda generates quiz questions for an axis that has no `description`, THE Learning_Lambda SHALL fall back to using the axis `label` as context, preserving existing behavior.

3. THE Learning_Lambda SHALL continue to use learning objectives as the structural scaffold for quiz questions in this iteration — the description supplements but does not replace the objectives layer.

4. WHEN the Learning_Lambda includes the `description` in a quiz generation prompt, THE Learning_Lambda SHALL NOT also include farm-specific context (field names, soil sample IDs, specific observation dates) in the description portion of the prompt — farm context is retrieved separately via vector similarity.

---

### Requirement 7: Description Drives Capability Scoring Context

**User Story:** As a learner, I want my capability score to reflect how well my evidence matches the concepts described in my learning focuses, so that richer descriptions automatically improve the precision of my capability assessment.

#### Acceptance Criteria

1. WHEN the Capability_Lambda scores a user's capability for an axis that has a non-empty `description`, THE Capability_Lambda SHALL use the description-based embedding (generated via the updated `composeAxisEmbeddingSource`) for per-axis vector similarity search.

2. WHEN the Capability_Lambda calls Bedrock to synthesize capability levels, THE Capability_Lambda SHALL include the axis `description` in the per-axis context block sent to the model, so the model can assess evidence against the specific concepts described.

3. THE Capability_Lambda SHALL NOT require any changes to the capability scoring flow beyond the embedding source change — richer embeddings improve scoring automatically through the existing vector similarity mechanism.

---

### Requirement 8: No Separate Learning Objectives Step (Future Direction)

**User Story:** As a learner, I want the system to eventually generate quiz questions directly from the focus description, so that I don't have to wait for a lazy objectives generation step before I can start learning.

#### Acceptance Criteria

1. THE Skill_Profile_Generator SHALL produce descriptions rich enough that quiz questions could be generated directly from them in a future iteration, without requiring a separate learning objectives layer.

2. THE system SHALL continue to generate and store learning objectives in this iteration — the objectives system coexists with the new description field and is not removed.

3. THE requirements document SHALL note that the long-term direction is to generate quiz questions directly from the Focus_Description, eliminating the learning objectives layer, but this simplification is deferred to a future spec.

---

## Notes on Existing Code State

The following observations from the current codebase are relevant to implementation:

- **`isValidSkillProfile` in `lambda/skill-profile/index.js` (line 714)** already validates `axis.description` as a required non-empty string. This is ahead of the current prompt — the validator was updated but the prompt was not. This feature aligns the prompt with the validator.

- **`composeAxisEmbeddingSource` in `axisUtils.js`** already handles `axis.description` optionally (appends it after the label). The new behavior changes the logic: when `description` is present, it becomes the sole source rather than being appended to the label.

- **`lambda/learning/index.js`** already conditionally includes `skillAxis.description` in quiz generation prompts (lines 1564, 1737, 1794). This behavior is already correct and requires no change.

- **`SkillProfilePanel.tsx` PreviewState** currently renders only `label` and `required_level` inputs per axis. The `description` textarea must be added.

- **`SkillAxis` TypeScript interface** in `useSkillProfile.ts` currently has no `description` field. It must be added.

- **Three copies of `axisUtils.js`** exist: `lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js` (the layer), `lambda/skill-profile/axisUtils.js`, and `lambda/shared/axisUtils.js`. All three must be updated consistently.
