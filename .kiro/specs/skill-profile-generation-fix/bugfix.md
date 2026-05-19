# Bugfix Requirements Document

## Introduction

The skill profile generation and learning system has five bugs that prevent a user from completing the "generate skill profile with growth intent" flow correctly. The user answered "what do I want to get better at" (growth intent), then asked a follow-up question about experiment design — triggering a skill profile generation that returns 503, a subsequent learning objectives fetch that returns 404, and an authentication redirect that lands on a non-existent `/login` route. Additionally, when generation succeeds, the AI overwrites the user's own growth intent text with a rewritten narrative, removing the user's voice and specific context from their skill profile.

The five bugs are:

1. **503 on `POST /api/skill-profiles/generate`** — The `cwf-skill-profile` Lambda calls Bedrock using the bare model ID `anthropic.claude-3-5-haiku-20241022-v1:0`. In `us-west-2`, cross-region inference requires the `us.` prefix (`us.anthropic.claude-3-5-haiku-20241022-v1:0`). Without it, Bedrock rejects the invocation and the Lambda returns 503.

2. **404 on `GET /api/learning/{actionId}/{userId}/objectives`** — `handleGetObjectives` in the learning Lambda returns 404 when the action has no approved skill profile (`!skillProfile || !skillProfile.approved_at`). Because the skill profile generation fails (bug 1), the profile is never approved, so every subsequent objectives fetch returns 404. The frontend's `useLearningObjectives` hook treats 404 as "no objectives yet" and silently returns `null`, masking the root cause.

3. **404 on `/login` route** — `src/lib/apiService.ts` redirects to `window.location.href = '/login'` on unrecoverable 401 errors. The React Router configuration in `App.tsx` defines the authentication page at `/auth`, not `/login`. There is no `/login` route, so the redirect lands on the `NotFound` page instead of the sign-in form.

4. **`useSkillProfile.ts:59` logs "Failed to generate skill profile: Object"** — The `onError` handler in `useGenerateSkillProfile` logs `console.error('Failed to generate skill profile:', error)`. When the API returns a 503, `apiService` throws an `Error` object. The log message `"Object"` indicates the error is being serialized as `[object Object]` rather than its message string, making the log unhelpful for diagnosis.

5. **AI overwrites user's growth intent text as the skill narrative** — When a user types their own text into the "What do you want to get better at?" field and hits Generate, the Lambda uses that text as a prompt input and returns an AI-rewritten narrative. The user's original words — including their specific context, framing, and intent — are replaced by generic AI prose. The user has no control over what their skill narrative says.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user submits a growth intent and triggers `POST /api/skill-profiles/generate` THEN the `cwf-skill-profile` Lambda calls Bedrock with model ID `anthropic.claude-3-5-haiku-20241022-v1:0` (no `us.` prefix) and the system returns HTTP 503 "AI service temporarily unavailable"

1.2 WHEN `POST /api/skill-profiles/generate` returns 503 and no skill profile is approved THEN `GET /api/learning/{actionId}/{userId}/objectives` returns HTTP 404 because `handleGetObjectives` requires an approved skill profile to exist on the action

1.3 WHEN an API call receives an unrecoverable 401 and the token refresh also fails THEN `apiService.ts` redirects to `window.location.href = '/login'` which does not exist as a route, landing the user on the NotFound page instead of the sign-in form

1.4 WHEN `POST /api/skill-profiles/generate` fails with a 503 THEN `useGenerateSkillProfile`'s `onError` handler logs `"Failed to generate skill profile: Object"` because the error object is not converted to a string before logging

1.5 WHEN a user types their own text into the "What do you want to get better at?" field and triggers `POST /api/skill-profiles/generate` THEN the Lambda uses that text as a prompt input and returns an AI-rewritten `narrative` field, replacing the user's original words with generic AI prose in the Skill Narrative textarea

### Expected Behavior (Correct)

2.1 WHEN a user submits a growth intent and triggers `POST /api/skill-profiles/generate` THEN the `cwf-skill-profile` Lambda SHALL call Bedrock with the cross-region inference model ID `us.anthropic.claude-3-5-haiku-20241022-v1:0` and the system SHALL return a valid skill profile (HTTP 200)

2.2 WHEN `POST /api/skill-profiles/generate` succeeds and the skill profile is approved THEN `GET /api/learning/{actionId}/{userId}/objectives` SHALL return HTTP 200 with the generated learning objectives for the action

2.3 WHEN an API call receives an unrecoverable 401 and the token refresh also fails THEN `apiService.ts` SHALL redirect to `/auth` (the existing sign-in route) so the user lands on the sign-in form

2.4 WHEN `POST /api/skill-profiles/generate` fails THEN `useGenerateSkillProfile`'s `onError` handler SHALL log the error message string (e.g. `error?.message || String(error)`) so the log reads `"Failed to generate skill profile: AI service temporarily unavailable. Please try again."` rather than `"Failed to generate skill profile: Object"`

2.5 WHEN a user has typed their own text into the "What do you want to get better at?" field and triggers `POST /api/skill-profiles/generate` THEN the returned skill profile SHALL use the user's exact text verbatim as the `narrative` field, and the AI SHALL only generate the `axes`. The user's words SHALL NOT be rewritten, paraphrased, or replaced.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `POST /api/skill-profiles/generate` is called WITHOUT a growth intent THEN the system SHALL CONTINUE TO generate a skill profile using the action-driven prompt and return HTTP 200

3.2 WHEN `POST /api/skill-profiles/approve` is called with a valid skill profile THEN the system SHALL CONTINUE TO store the approved profile on the action and return HTTP 200

3.3 WHEN `DELETE /api/skill-profiles/:actionId` is called THEN the system SHALL CONTINUE TO remove the skill profile from the action and return HTTP 200

3.4 WHEN a user is authenticated and makes any API call that returns 200–399 THEN the system SHALL CONTINUE TO process the response normally without any redirect

3.5 WHEN `GET /api/learning/{actionId}/{userId}/objectives` is called for an action that has an approved skill profile THEN the system SHALL CONTINUE TO return the learning objectives (generating them via Bedrock if they do not yet exist)

3.6 WHEN `POST /api/learning/{actionId}/quiz/generate` is called THEN the system SHALL CONTINUE TO generate quiz questions and return HTTP 200

3.7 WHEN `POST /api/profile-skills/generate` is called THEN the system SHALL CONTINUE TO generate a profile skill preview using the `cwf-skill-profile` Lambda and return HTTP 200

3.8 WHEN `POST /api/skill-profiles/generate` is called WITHOUT a growth intent THEN the system SHALL CONTINUE TO generate both the narrative and axes via AI, unchanged from current behavior

3.9 WHEN a user edits the Skill Narrative textarea in the Preview state after generation THEN their edits SHALL be preserved and submitted as-is on Approve
