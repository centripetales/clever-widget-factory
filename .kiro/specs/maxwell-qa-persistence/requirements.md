# Requirements Document

## Introduction

The Maxwell Q&A Persistence feature saves all Maxwell interactions (questions and responses) to the backend so that valuable insights aren't lost across sessions, and usage/cost can be tracked. Saved interactions are surfaced as starter questions in the Maxwell panel, replacing the current hardcoded suggestions with real questions previously asked.

## Glossary

- **Interaction**: A single question-response pair from a Maxwell conversation
- **Starter Questions**: The clickable question buttons shown when Maxwell has no active conversation — currently hardcoded, to be replaced with saved interactions
- **Usage Metadata**: Token counts (input/output) and duration that enable cost estimation

## Requirements

### Requirement 1: Persist Maxwell Q&A Server-Side

**User Story:** As a user, I want my Maxwell questions and responses saved to the backend with usage metadata, so that valuable insights aren't lost and I can estimate costs.

**Acceptance Criteria:**

1. WHEN Maxwell returns a completed response, THE System SHALL save the interaction to the backend
2. THE saved record SHALL include: question text, response text, user_id, timestamp, model used (quick/deep), input_tokens, output_tokens, and duration_ms
3. THE System SHALL save automatically on response completion — no manual action required
4. THE System SHALL continue to function if the save fails (fire-and-forget, non-blocking)
5. THE save SHALL be initiated from the frontend after the response is received

### Requirement 2: Surface Past Questions as Starter Questions

**User Story:** As a user opening Maxwell, I want to see questions I previously asked, so that I can quickly re-ask valuable questions or continue a previous line of inquiry.

**Acceptance Criteria:**

1. WHEN the Maxwell panel opens with no active conversation, THE System SHALL display recent questions the user previously asked (instead of or in addition to hardcoded starters)
2. THE System SHALL show the most recent questions first (up to a reasonable limit, e.g., 5)
3. WHEN a user clicks a saved starter question, THE System SHALL send that question to Maxwell as if the user typed it
4. WHEN no saved questions exist, THE System SHALL fall back to the existing hardcoded starter questions
5. THE System SHALL scope saved questions to the user within their current organization (user + org pair)

### Requirement 3: Delete Saved Interactions

**User Story:** As a user who accidentally asked something sensitive, I want to hide a saved interaction, so that it doesn't appear as a starter question, while still preserving the record for cost tracking.

**Acceptance Criteria:**

1. WHEN viewing saved starter questions, THE System SHALL display a delete button (e.g., X icon) on each question
2. WHEN a user clicks delete, THE System SHALL soft-delete the interaction (set a `deleted_at` timestamp)
3. THE System SHALL NOT display soft-deleted interactions as starter questions
4. THE System SHALL NOT require confirmation for deletion (quick action, low risk)
5. A user SHALL only be able to see and delete their own saved interactions
6. Soft-deleted records SHALL remain in the database for cost tracking and analytics purposes

### Requirement 4: Storage in States Table with Selective Embedding

**User Story:** As a system, I want Maxwell interactions stored in the existing states table as JSON, with the embedding processor extracting only the Q&A text for search, so that metadata doesn't pollute the semantic signal.

**Acceptance Criteria:**

1. THE System SHALL store Maxwell interactions as rows in the `states` table with `state_text` containing a JSON object
2. THE JSON object SHALL include: `type` ("maxwell_interaction"), `question`, `response`, `model`, `input_tokens`, `output_tokens`, `duration_ms`, `deleted_at`
3. THE state row SHALL use `captured_by` for the user_id and `organization_id` for org scoping
4. THE System SHALL link the state to the relevant entity via `state_links` if entity context was present when the question was asked
5. THE embedding processor SHALL detect `state_text` containing `"type": "maxwell_interaction"`, parse the JSON, and compose the embedding source from only `question` + `response` text (excluding model, tokens, duration, and other metadata)
6. THE `deleted_at` field in the JSON SHALL be used for soft-delete (set to ISO timestamp when user deletes)
