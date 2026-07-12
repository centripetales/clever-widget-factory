# Requirements Document: Time Perspective

## Introduction

The Time Perspective feature adds AI-computed time estimates to observations in CWF, enabling the team to understand how time is allocated across farm/workshop activities without manual time tracking. Unlike the existing rsp-worker perspectives (claim/significance/entropy) which process observations individually, the Time Perspective analyzes ALL observations for a given day collectively — because understanding one activity's duration requires knowing what else happened that day.

This feature serves three purposes:
1. **Accountability**: Understand where hours go across agriculture, electrical, compliance, and livestock work
2. **Cost estimation**: Enable Maxwell to answer "how much time did compliance cost us this quarter?" by querying pre-computed data instead of reasoning over raw observations
3. **Planning**: Visualize time allocation trends to inform staffing and scheduling decisions

The Time Perspective is a SEPARATE computation from the existing claim/significance/entropy extraction in the rsp-worker. It has its own Lambda, its own table, and its own trigger mechanism.

## Glossary

- **Time Perspective**: An AI-generated estimate of hours spent on the activity described in a single observation, computed with full-day context
- **Day Cohort**: All observations captured on the same calendar day (Philippine Time, UTC+8) across all users — the unit of computation for time perspectives
- **Stale**: A time perspective that was computed before a new observation was added to the same day; must be recomputed on next access
- **On-Demand Computation**: Computing time perspectives only when requested (analytics page load or Maxwell query), not proactively
- **Maxwell**: The AI assistant agent in CWF that answers questions about the farm/workshop using structured queries
- **State**: The internal name for an observation record in the database (renamed from "observations" to "states" table)
- **rsp-worker**: The existing Lambda that computes claim/significance/entropy perspectives per observation — Time Perspective does NOT modify this
- **Confidence Level**: AI's self-assessment of estimate reliability: high (explicit time mentioned or obvious full-day task), medium (reasonable inference from context), low (educated guess), unknown (insufficient evidence or activity doesn't match estimated duration)

## Requirements

### Requirement 1: Time Perspective Data Model

**User Story:** As a developer, I want daily time summaries stored as states (observations) with structured JSON, so that they integrate with the existing embedding and search infrastructure without new tables.

**Acceptance Criteria:**

1. THE System SHALL store daily time summaries as states in the existing `states` table with `state_text` prefixed by `[summary:day]`
2. THE state_text SHALL contain a JSON object after the prefix with the following shape:
   ```json
   {
     "date": "2026-07-12",
     "entries": [
       {
         "user_id": "cognito-uuid",
         "activity": "string describing what was done",
         "hours": 5.0,
         "confidence": "high|medium|low|unknown",
         "evidence": "string explaining why this estimate — timestamps, stated duration, inference",
         "source_ids": ["state-uuid-1", "state-uuid-2"],
         "energy_weights": { "dynamis": 0.1, "oikonomia": 0.7, "techne": 0.2 },
         "boundary_type": "internal|external",
         "tags": ["SEC", "compliance", "HARBOR"]
       }
     ],
     "notes": "string — unaccounted time, gaps, or caveats"
   }
   ```
3. THE `energy_weights` object SHALL contain three fields (dynamis, oikonomia, techne) that sum to 1.0, following the existing Energeia Schema definitions:
   - `dynamis` — Exploration: activities that expand capability, revenue, or reach (The Spark)
   - `oikonomia` — Exploitation: activities that sustain existing operations (The Hearth)
   - `techne` — Meta-Policy: activities that improve how work is done (The Tool)
4. THE `boundary_type` field SHALL be "internal" (core operations) or "external" (interactions with outside entities — government, vendors, agencies)
5. THE `tags` field SHALL be freeform strings that include agencies (SEC, BIR, DENR, SSS, PAGIBIG, notary, LGU), activity categories (electrical, livestock, AI, software, rework), or any other relevant label
6. THE `confidence` field SHALL be "high" (explicit time evidence like photo timestamps or stated duration), "medium" (reasonable inference from gaps or patterns), "low" (educated guess), or "unknown" (insufficient evidence)
7. THE summary state SHALL be linked via `state_links` to each source observation (entity_type: 'state', entity_id: source state's id)
8. THE summary state SHALL be embedded into `unified_embeddings` like any other state, making it searchable by Maxwell
9. THE summary state SHALL be filtered from the observations list UI (same pattern as `[photo_analysis]` states)
10. THE `source_ids` in each entry SHALL correspond to observation state IDs, renderable as a param URL (e.g., `/observations?date=2026-07-12&highlight=uuid1,uuid2`)

### Requirement 2: AI-Powered Time Estimation with Day Context

**User Story:** As Stefan (owner/documenter), I want the AI to estimate how long each documented activity took by looking at everything that happened that day, so that I get realistic time allocations without manually tracking hours.

**Acceptance Criteria:**

1. WHEN computing a daily summary, THE System SHALL fetch ALL observations for the same calendar day (Philippine Time, UTC+8) across ALL users in the organization
2. THE AI SHALL use judgment (not keyword matching) to estimate hours for each activity
3. THE AI SHALL produce one entry per person per distinct activity (not one entry per observation — multiple observations about the same activity should be merged)
4. THE AI SHALL prioritize evidence strength when estimating hours:
   - Strongest: photo timestamps (EXIF `captured_at`) bracketing an activity
   - Strong: explicit duration stated in observation text ("spent 3 hours", "the whole day")
   - Medium: inference from gaps between observations on the same day
   - Medium: known patterns (e.g., "Stefan typically does computer work until 14:00-15:00 then outdoor work")
   - Low: routine inference without direct evidence
5. THE AI SHALL set confidence to 'unknown' if the described activity doesn't seem like it could fill the estimated hours
6. THE AI SHALL NOT force daily totals to sum to exactly 8 hours — report what the evidence supports and flag unaccounted time in `notes`
7. THE AI SHALL classify each activity with energy_weights (dynamis/oikonomia/techne summing to 1.0) and boundary_type (internal/external) consistent with the Energeia Schema definitions
8. THE AI SHALL assign freeform tags including relevant agencies (SEC, BIR, DENR, SSS, PAGIBIG, notary), activity types (electrical, livestock, AI, software, agriculture), or qualifiers (rework)
9. THE AI prompt SHALL include these context rules:
   - Stefan is most likely the person documenting items involving Mae
   - Electrical work typically involves Stefan and Lester together
   - Government office trips (especially to Roxas) typically involve Stefan + Mae + Lester (3 people, but logged as separate entries per person)
   - Stefan typically does computer/AI/admin work until 14:00-15:00, then outdoor/agriculture work
   - Morning chicken care is a routine task (~0.5-1 hour) unless the observation indicates otherwise
   - 'whole morning' = ~4 hours, 'whole day' / 'spent the day' = ~8 hours, 'afternoon' = ~4 hours
10. THE AI SHALL include photo descriptions (ai_description from photo analysis) in context for people identification and activity verification

### Requirement 3: On-Demand Computation with Caching

**User Story:** As a system operator, I want daily summaries computed only when needed and cached as states for reuse, so that Bedrock costs are minimized while still providing fresh data when requested.

**Acceptance Criteria:**

1. WHEN the analytics page or Maxwell requests time data for a date range AND a `[summary:day]` state does not exist for days in that range, THE System SHALL trigger computation for those days
2. WHEN a `[summary:day]` state already exists and is not stale for a requested day, THE System SHALL return the cached state without re-invoking Bedrock
3. THE System SHALL compute all observations for a day together in a single AI invocation (one Bedrock call per day)
4. WHEN a new observation is added to a day that already has a `[summary:day]` state, THE System SHALL mark the summary as stale (prepend `[stale]` to state_text or use a staleness indicator)
5. WHEN a stale summary is requested, THE System SHALL recompute by deleting the old summary state and creating a new one
6. THE computation Lambda SHALL accept a request payload specifying: organization_id, dates (array of YYYY-MM-DD), and optionally force_recompute flag
7. THE response SHALL be synchronous (the caller waits for computation) with a timeout of 60 seconds per day
8. IF computation times out or fails, THE System SHALL return partial results (stale cached data if available) with an indicator that some data is incomplete

### Requirement 4: Staleness Detection on New Observations

**User Story:** As a documenter adding new observations throughout the day, I want previously computed daily summaries to automatically invalidate when I add new context, so that the analytics stay accurate as more information becomes available.

**Acceptance Criteria:**

1. WHEN a new state (observation) is created with a qualifying entity_type in state_links, THE System SHALL check if a `[summary:day]` state exists for that calendar day
2. IF a summary state exists for that day (same organization, same calendar day in PHT), THE System SHALL mark it as stale by updating its state_text to prepend `[stale]` (e.g., `[stale][summary:day] {...}`)
3. THE staleness marking SHALL be a lightweight UPDATE in the states Lambda (no Bedrock call)
4. THE System SHALL NOT recompute immediately on observation creation — only mark as stale for lazy recomputation on next access
5. THE day boundary SHALL be calculated in Philippine Time (UTC+8): a state with captured_at = '2026-07-12T23:30:00+08:00' belongs to day '2026-07-12'
6. THE `[stale]` prefix SHALL cause the summary to be excluded from embedding searches (or re-embedded only after recomputation)

### Requirement 5: Time Allocation Analytics Chart

**User Story:** As Stefan, I want to see a stacked bar chart showing hours per activity tag over time, so that I can visualize where my team's time goes across days, weeks, and months.

**Acceptance Criteria:**

1. THE analytics page SHALL display a new "Time Allocation" chart section
2. THE chart SHALL show a stacked bar/area chart with:
   - X-axis: time periods (days, weeks, or months — selectable)
   - Y-axis: hours
   - Stacks: colored by tag (agriculture, compliance, electrical, livestock, etc.)
3. THE chart SHALL support filtering by:
   - Person (from people_involved field)
   - Tag
   - Confidence level (show/hide low confidence or unknown estimates)
4. THE chart SHALL include a time range selector consistent with the existing analytics filters
5. WHEN a user clicks on a bar segment, THE System SHALL show a detail popover/drawer listing:
   - The individual observations that contributed to that segment
   - The AI's reasoning for each time estimate
   - The confidence level for each estimate
6. THE chart SHALL visually distinguish confidence levels (e.g., hatching or opacity for low/unknown confidence)
7. THE chart SHALL use the recharts library consistent with existing analytics charts
8. THE chart SHALL trigger on-demand computation for any missing/stale time perspectives in the selected range

### Requirement 6: Maxwell Integration for Time Queries

**User Story:** As Stefan asking Maxwell "how much time did compliance cost us in June?", I want Maxwell to find pre-computed daily summaries via search, so that I get fast answers without expensive per-query AI reasoning.

**Acceptance Criteria:**

1. DAILY summaries SHALL be embedded in `unified_embeddings` with entity_type 'state', making them discoverable via UnifiedSearch
2. THE embedding_source for a daily summary SHALL be a natural language rendering of the entries (e.g., "2026-07-12: Stefan spent 5 hours on SEC compliance (HARBOR portal, GIS amendment). Mae spent 6 hours at SSS and PAGIBIG offices in Roxas.") — optimized for semantic search
3. WHEN Maxwell detects a time/hours question with the compliance skill active, it SHALL search for `[summary:day]` states using UnifiedSearch with date_from/date_to
4. MAXWELL SHALL be able to extract and sum hours from the JSON in returned summary states without needing a separate tool
5. THE cost of answering a time question via pre-computed summaries SHALL be significantly less than having Maxwell reason over raw observations (one search call returns the pre-computed data)

### Requirement 7: Batch Pre-computation Job (Optional Enhancement)

**User Story:** As a system operator, I want a nightly job that pre-computes time perspectives for the current day's observations, so that the analytics page loads instantly the next morning without triggering on-demand computation.

**Acceptance Criteria:**

1. THE System MAY include a scheduled Lambda (EventBridge rule) that runs nightly at 23:00 PHT
2. THE job SHALL compute time perspectives for all observations from the current day that don't yet have a time perspective
3. THE job SHALL also recompute any stale perspectives from the current day
4. THE job SHALL NOT recompute non-stale perspectives from previous days
5. THE job SHALL be optional and not required for the feature to function (on-demand is the primary trigger)
6. THE job SHALL log computation results (days processed, observations computed, errors) for monitoring

### Requirement 8: Daily Summary Lambda Architecture

**User Story:** As a developer, I want the daily summary computation in a dedicated Lambda separate from the rsp-worker, so that changes to one don't affect the other and they can scale independently.

**Acceptance Criteria:**

1. THE System SHALL create a new Lambda function `time-perspective-worker` in the `lambda/` directory
2. THE Lambda SHALL use Bedrock (Anthropic Claude) for AI estimation with tool_use for structured JSON output
3. THE Lambda SHALL be invocable via:
   - Direct invocation (from analytics Lambda when on-demand computation is needed)
   - Scheduled invocation (from EventBridge for nightly batch)
4. THE Lambda SHALL accept a payload: `{ organization_id, dates: ['2026-07-12', '2026-07-13'], force_recompute: false }`
5. THE Lambda SHALL process one day at a time sequentially within a single invocation
6. THE Lambda SHALL have a timeout of 5 minutes (300 seconds) to handle multiple days
7. FOR each day, THE Lambda SHALL:
   - Fetch all observations for that day (all users in the org)
   - Include photo descriptions (ai_description) for context
   - Include linked entity names (action titles, tool/part names) for context
   - Invoke Bedrock with tool_use to produce the structured JSON
   - Create a new state with `[summary:day]` prefix + JSON as state_text
   - Create state_links connecting the summary to each source observation
   - Queue embedding generation for the new summary state via SQS
8. THE Lambda SHALL handle JSON parsing failures gracefully — if the AI returns malformed JSON, store the raw response as state_text anyway (still embeddable as text)
9. THE Lambda response SHALL include: `{ computed: [{ date, observations_count, success }], errors: [] }`

### Requirement 9: API Endpoint for Daily Summaries

**User Story:** As a frontend developer, I want an API endpoint to retrieve daily summaries for a date range, triggering computation if needed, so that the analytics chart can display data reliably.

**Acceptance Criteria:**

1. THE System SHALL expose a GET endpoint: `/api/analytics/time-summaries?start_date=X&end_date=Y`
2. THE endpoint SHALL return parsed daily summary entries for all days in the date range within the user's organization
3. THE response shape SHALL be:
   ```json
   {
     "summaries": [
       {
         "date": "2026-07-12",
         "state_id": "uuid-of-summary-state",
         "entries": [
           {
             "user_id": "cognito-uuid",
             "activity": "SEC GIS amendment research",
             "hours": 5,
             "confidence": "high",
             "evidence": "Photos 09:12-14:08",
             "source_ids": ["uuid1", "uuid2"],
             "energy_weights": { "dynamis": 0.1, "oikonomia": 0.7, "techne": 0.2 },
             "boundary_type": "external",
             "tags": ["SEC", "compliance"]
           }
         ],
         "notes": "...",
         "is_stale": false
       }
     ],
     "computation_status": {
       "days_requested": 7,
       "days_computed": 7,
       "days_pending": 0,
       "stale_count": 0
     }
   }
   ```
4. IF some days have missing or stale summaries, THE endpoint SHALL trigger on-demand computation (invoke time-perspective-worker Lambda synchronously)
5. THE endpoint SHALL support optional query parameters: `user_id`, `tags`, `boundary_type`, `confidence` for server-side filtering
6. THE endpoint SHALL be authenticated and scoped to the user's organization (same authorizer as existing analytics endpoints)
7. THE endpoint SHALL provide a link pattern for source observations: `/observations?date=YYYY-MM-DD&highlight=id1,id2`

### Requirement 10: Photo Context for People and Activity Verification

**User Story:** As a system, I want the AI to consider photo content when identifying who was involved and what was done, so that people visible in photos but not mentioned in text are still attributed correctly.

**Acceptance Criteria:**

1. WHEN computing daily summaries, THE System SHALL include photo descriptions (ai_description from photo analysis) in the context sent to the AI
2. THE AI prompt SHALL instruct: "Photos may show people working — try to identify who is involved based on descriptions of people visible in photos"
3. THE System SHALL NOT send raw photo bytes to the AI (too expensive) — only text descriptions from prior photo analysis
4. IF no photo analysis exists for a state's photos, THE System SHALL note this absence and rely only on text and contextual clues
5. THE System SHALL include photo `captured_at` timestamps as evidence for time bracketing (strongest evidence type)

## Technical Notes

- **Timezone handling**: All day boundaries are in Philippine Time (UTC+8). A `captured_at` of `2026-07-13T01:30:00+08:00` belongs to day `2026-07-13`.
- **AI model**: Use Bedrock Anthropic Claude with tool_use for structured JSON output. Model choice should balance cost and quality (Haiku for routine days, Sonnet for complex days with many observations).
- **Cost consideration**: One Bedrock invocation per day (not per observation). A day with 5 observations = 1 AI call.
- **Storage pattern**: Daily summaries are states — same table, same embedding pipeline, same search infrastructure. No new tables needed.
- **Existing perspective separation**: This feature does NOT modify the rsp-worker or its claim/significance/entropy perspectives. It creates a new type of machine-generated state.
- **Organization scoping**: All queries and computations are scoped to a single organization.
- **Graceful degradation**: If AI returns malformed JSON, store the raw text anyway (still embeddable, still human-readable). Parse what you can, default what you can't.
- **Future rollups**: Weekly and monthly summaries (`[summary:week]`, `[summary:month]`) can follow the same pattern — summarize the daily summaries below them. This is a future enhancement, not part of v1.
