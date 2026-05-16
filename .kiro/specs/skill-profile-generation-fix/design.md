# Skill Profile Generation Fix — Bugfix Design

## Overview

Five bugs affect the skill-profile-generation flow. The root cause of the cascade is Bug 1: the `cwf-skill-profile` Lambda calls Bedrock with a bare model ID that is rejected in `us-west-2`, causing a 503. This leaves the action without an approved skill profile, which in turn causes Bug 2 (404 on objectives). Bugs 3 and 4 are independent: a wrong redirect target in `apiService.ts` and an unhelpful error log in `useSkillProfile.ts`. Bug 5 is a design flaw: when generation succeeds, the AI overwrites the user's own growth intent text with a rewritten narrative, removing the user's voice from their skill profile.

All five fixes are surgical changes. No schema changes, no new endpoints, no new Lambda functions, and no architectural decisions are required.

---

## Glossary

- **Bug_Condition (C)**: The set of inputs or states that trigger defective behavior.
- **Property (P)**: The correct behavior that must hold for all inputs in C.
- **Preservation**: Existing correct behavior for inputs outside C that must not regress.
- **`callBedrockForSkillProfile`**: Function in `lambda/skill-profile/index.js` (line ~390)
  that constructs and sends the `InvokeModelCommand` to Bedrock. Contains the hard-coded
  `MODEL_ID` constant that is the root cause of Bug 1.
- **`apiRequest`**: Internal function in `src/lib/apiService.ts` that handles all HTTP
  requests, token refresh, and error routing. Contains the two `window.location.href = '/login'`
  redirects that are the root cause of Bug 3.
- **`useGenerateSkillProfile`**: TanStack Query mutation hook in `src/hooks/useSkillProfile.ts`
  (line 59). Its `onError` callback logs the raw error object, causing Bug 4.
- **Cross-region inference prefix**: AWS Bedrock requires the `us.` prefix on model IDs when
  invoking cross-region inference profiles in `us-west-2`. Without it, Bedrock returns a
  `ValidationException` and the Lambda returns 503.
- **`buildSkillProfilePrompt`**: Function in `lambda/skill-profile/index.js` that constructs
  the Bedrock prompt. When `growthIntent` is present, it instructs the AI to write a narrative
  framing the action as a "practice ground" — this is the source of Bug 5. The fix moves
  narrative responsibility out of the AI and into the user's own text.

---

## Bug Details

### Bug 1 — Wrong Bedrock Model ID (503 on `POST /api/skill-profiles/generate`)

**File**: `lambda/skill-profile/index.js`  
**Function**: `callBedrockForSkillProfile` (~line 390)

The bug manifests when any caller invokes `callBedrockForSkillProfile`. The constant
`MODEL_ID` is set to the bare model ID, which Bedrock rejects in `us-west-2` because
cross-region inference requires the `us.` prefix.

**Formal Specification:**
```
FUNCTION isBugCondition_1(invocation)
  INPUT: invocation — any call to POST /api/skill-profiles/generate
         or POST /api/profile-skills/generate
  OUTPUT: boolean

  modelId := invocation.bedrockCommand.modelId
  RETURN modelId = 'anthropic.claude-3-5-haiku-20241022-v1:0'
         AND awsRegion = 'us-west-2'
END FUNCTION
```

**Examples:**
- User submits growth intent → `POST /api/skill-profiles/generate` → Lambda calls Bedrock
  with `anthropic.claude-3-5-haiku-20241022-v1:0` → Bedrock returns `ValidationException`
  → Lambda catches it and returns HTTP 503 "AI service temporarily unavailable."
- User generates a profile skill preview → `POST /api/profile-skills/generate` → same
  `callBedrockForSkillProfile` function → same 503 failure.
- **Edge case**: Both the first attempt and the retry in `handleGenerate` call
  `callBedrockForSkillProfile`, so both fail. The retry does not help because the model ID
  is wrong, not the prompt.

---

### Bug 2 — 404 on `GET /api/learning/{actionId}/{userId}/objectives` (downstream of Bug 1)

**Root cause**: `handleGetObjectives` in the learning Lambda returns 404 when
`!skillProfile || !skillProfile.approved_at`. Because Bug 1 prevents the skill profile from
ever being generated and approved, this 404 is a guaranteed downstream consequence.

**Formal Specification:**
```
FUNCTION isBugCondition_2(request)
  INPUT: request — GET /api/learning/{actionId}/{userId}/objectives
  OUTPUT: boolean

  action := db.getAction(request.actionId)
  RETURN action.skill_profile IS NULL
         OR action.skill_profile.approved_at IS NULL
END FUNCTION
```

**Examples:**
- After Bug 1 causes a 503, the action has no `skill_profile`. The next objectives fetch
  returns 404. The frontend `useLearningObjectives` hook treats 404 as "no objectives yet"
  and silently returns `null`, masking the root cause.
- **Resolution**: This bug resolves automatically once Bug 1 is fixed and the skill profile
  can be successfully generated and approved.

---

### Bug 3 — Redirect to `/login` instead of `/auth` (404 on redirect)

**File**: `src/lib/apiService.ts`  
**Function**: `apiRequest` (two locations, ~lines 270 and 282)

The bug manifests when an API call receives an unrecoverable 401 (either on first attempt
with a failed refresh, or on the retry). `apiRequest` redirects to `/login`, but `App.tsx`
defines the authentication page at `/auth` (line ~`<Route path="/auth" element={<Auth />} />`).
There is no `/login` route, so the redirect lands on `<NotFound />`.

**Formal Specification:**
```
FUNCTION isBugCondition_3(response)
  INPUT: response — HTTP response from any API call
  OUTPUT: boolean

  RETURN response.status = 401
         AND (tokenRefreshFailed OR isRetry)
END FUNCTION
```

**Examples:**
- Token expires, refresh fails → `window.location.href = '/login'` → React Router has no
  `/login` route → user sees the 404 / NotFound page instead of the sign-in form.
- Token expires, refresh succeeds but retry also returns 401 → same redirect → same 404.

---

### Bug 4 — Unhelpful error log in `useSkillProfile.ts` (logs "Object")

**File**: `src/hooks/useSkillProfile.ts`  
**Function**: `useGenerateSkillProfile` `onError` callback (line 59)

The bug manifests when `POST /api/skill-profiles/generate` fails. `apiService` throws an
`ApiError` object. `console.error('Failed to generate skill profile:', error)` serializes
the object as `[object Object]`, producing the log line
`"Failed to generate skill profile: Object"`.

**Formal Specification:**
```
FUNCTION isBugCondition_4(error)
  INPUT: error — value passed to onError callback
  OUTPUT: boolean

  RETURN typeof error = 'object'
         AND error IS NOT null
         AND error.message EXISTS
END FUNCTION
```

**Examples:**
- 503 from Bedrock → `apiService` throws `{ message: 'AI service temporarily unavailable...', status: 503, ... }`
  → `console.error('Failed to generate skill profile:', error)` → log reads
  `"Failed to generate skill profile: Object"`.
- After fix: log reads
  `"Failed to generate skill profile: AI service temporarily unavailable. Please try again."`.

---

### Bug 5 — AI overwrites user's growth intent text as the skill narrative

**File**: `lambda/skill-profile/index.js`  
**Function**: `buildSkillProfilePrompt` and `handleGenerate`

The bug manifests when a user types their own text into the "What do you want to get better at?" field and hits Generate. The `growth_intent` string is passed to `buildSkillProfilePrompt`, which instructs the AI to write a `narrative` field framing the action as a "practice ground." The AI produces its own prose — generic, abstracted, and stripped of the user's specific language — and that text becomes the `narrative` in the returned profile, overwriting what the user wrote.

The user's original words (e.g. *"what factors are involved in knowing the expected impact so that I can design a good experiment for this. I don't want to negatively impact my existing garden"*) are discarded. The AI's rewrite (e.g. *"By exploring the gypsum application as an experimental intervention, the learner will develop a systematic approach..."*) takes their place.

**Formal Specification:**
```
FUNCTION isBugCondition_5(request)
  INPUT: request — POST /api/skill-profiles/generate
  OUTPUT: boolean

  RETURN request.body.growth_intent IS NOT NULL
         AND request.body.growth_intent.trim() != ''
END FUNCTION
```

**Examples:**
- User types: *"I want to understand how gypsum affects soil structure without harming my existing plants"*
- AI returns narrative: *"By exploring the gypsum application as an experimental intervention, the learner will develop a systematic approach to understanding complex soil ecosystem interactions..."*
- User's specific concern about not harming existing plants is gone. The gypsum focus is diluted. The voice is not theirs.
- **After fix**: The returned `narrative` is exactly *"I want to understand how gypsum affects soil structure without harming my existing plants"*. The AI only generates the `axes`.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

3.1 `POST /api/skill-profiles/generate` called without a growth intent SHALL continue to
    generate a skill profile using the action-driven prompt and return HTTP 200.

3.2 `POST /api/skill-profiles/approve` with a valid skill profile SHALL continue to store
    the approved profile on the action and return HTTP 200.

3.3 `DELETE /api/skill-profiles/:actionId` SHALL continue to remove the skill profile and
    return HTTP 200.

3.4 Any API call that returns 200–399 SHALL continue to be processed normally with no redirect.

3.5 `GET /api/learning/{actionId}/{userId}/objectives` for an action that already has an
    approved skill profile SHALL continue to return learning objectives (HTTP 200).

3.6 `POST /api/learning/{actionId}/quiz/generate` SHALL continue to generate quiz questions
    and return HTTP 200.

3.7 `POST /api/profile-skills/generate` SHALL continue to generate a profile skill preview
    using the same `callBedrockForSkillProfile` function and return HTTP 200.

3.8 All API calls that return 200–399 SHALL continue to be processed normally without any
    redirect.

3.9 `useApproveSkillProfile` and `useDeleteSkillProfile` error handlers SHALL continue to
    log their respective messages and roll back optimistic cache updates unchanged.

3.10 WHEN `POST /api/skill-profiles/generate` is called WITHOUT a growth intent THEN the
    system SHALL CONTINUE TO generate both the narrative and axes via AI, unchanged from
    current behavior.

**Scope:**
The changes are strictly additive or substitutive at the character level. No function
signatures, interfaces, database schemas, or API contracts change.

---

## Hypothesized Root Cause

### Bug 1

The `callBedrockForSkillProfile` function hard-codes:
```javascript
const MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';
```
AWS Bedrock in `us-west-2` requires the cross-region inference prefix `us.` for this model
family. The correct ID is `us.anthropic.claude-3-5-haiku-20241022-v1:0`. This is a
configuration error introduced when the model was first wired up, likely copied from
documentation that predates the cross-region inference requirement.

### Bug 2

`handleGetObjectives` in the learning Lambda guards on `skillProfile.approved_at`. This is
correct behavior — objectives cannot be generated without a skill profile. The 404 is a
direct downstream consequence of Bug 1 preventing profile approval. No code change is needed
in the learning Lambda.

### Bug 3

`apiRequest` in `src/lib/apiService.ts` contains two redirect statements:
```typescript
window.location.href = '/login';  // line ~270 (after failed refresh)
window.location.href = '/login';  // line ~282 (after retry 401)
```
`App.tsx` defines `<Route path="/auth" element={<Auth />} />` and has no `/login` route.
The mismatch is a copy-paste error — the route was likely renamed from `/login` to `/auth`
at some point and the redirect in `apiService.ts` was not updated.

### Bug 4

`useGenerateSkillProfile`'s `onError` passes the raw error object as the second argument to
`console.error`. JavaScript's `console.error` serializes objects using `toString()`, which
for a plain object returns `[object Object]`. The fix is to extract `error?.message` (which
is a string on `ApiError` objects) before logging.

### Bug 5

`buildSkillProfilePrompt` in `lambda/skill-profile/index.js` always instructs the AI to
write the `narrative` field, even when the user has provided their own growth intent text.
The AI rewrites the user's words into generic learning-design prose. The fix is: when
`growthIntent` is present, set `profile.narrative = growthIntent` in `handleGenerate` after
the Bedrock call returns, overwriting the AI-generated narrative with the user's exact text.
The axes remain AI-generated. No prompt change is needed — the AI still generates axes
grounded in the growth intent; we just discard its narrative and substitute the user's.

---

## Correctness Properties

Property 1: Bug Condition — Bedrock Model ID Produces Valid Skill Profile

_For any_ call to `POST /api/skill-profiles/generate` or `POST /api/profile-skills/generate`
where the request body is otherwise valid, the fixed `callBedrockForSkillProfile` function
SHALL invoke Bedrock with model ID `us.anthropic.claude-3-5-haiku-20241022-v1:0` and the
Lambda SHALL return HTTP 200 with a valid skill profile object.

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition — Auth Redirect Lands on Sign-In Form

_For any_ API call that receives an unrecoverable 401 (token refresh failed, or retry also
returned 401), the fixed `apiRequest` function SHALL redirect to `/auth`, which is the route
defined in `App.tsx` for the `<Auth />` component, so the user lands on the sign-in form.

**Validates: Requirements 2.3**

Property 3: Bug Condition — Error Log Contains Message String

_For any_ failure of `POST /api/skill-profiles/generate`, the fixed `useGenerateSkillProfile`
`onError` handler SHALL log a string (via `error?.message || String(error)`) so the console
output reads `"Failed to generate skill profile: <message text>"` rather than
`"Failed to generate skill profile: Object"`.

**Validates: Requirements 2.4**

Property 4: Preservation — Non-Buggy Bedrock Calls Unchanged

_For any_ call to `callBedrockForSkillProfile` where the model ID change is the only
difference, the fixed function SHALL produce the same JSON-parsed skill profile structure as
the original function would have produced if Bedrock had accepted the old model ID, preserving
all prompt construction, response parsing, and validation logic.

**Validates: Requirements 3.1, 3.7**

Property 5: Preservation — Non-401 API Responses Unchanged

_For any_ API response with status 200–399 or status 403, the fixed `apiRequest` function
SHALL produce exactly the same behavior as the original function, with no redirect and no
change to response parsing or cache update logic.

**Validates: Requirements 3.4, 3.8**

Property 6: Bug Condition — User's Growth Intent Text Is the Narrative

_For any_ call to `POST /api/skill-profiles/generate` where `growth_intent` is a non-empty
string, the returned `profile.narrative` SHALL equal the `growth_intent` string exactly
(trimmed). The AI-generated narrative SHALL be discarded. The `axes` array SHALL be
AI-generated as normal.

**Validates: Requirements 2.5**

Property 7: Preservation — No Growth Intent Uses Full AI Narrative

_For any_ call to `POST /api/skill-profiles/generate` where `growth_intent` is absent or
empty, the returned `profile.narrative` SHALL be the AI-generated narrative, unchanged from
current behavior.

**Validates: Requirements 3.8**

---

## Fix Implementation

### Bug 1 — Change Model ID in `callBedrockForSkillProfile`

**File**: `lambda/skill-profile/index.js`  
**Function**: `callBedrockForSkillProfile`

**Specific Change:**
```javascript
// Before
const MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';

// After
const MODEL_ID = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
```

This is the only change needed in the Lambda. All other logic (prompt construction,
`InvokeModelCommand` parameters, response parsing, retry logic) remains identical.

After this change, the Lambda must be redeployed to `cwf-skill-profile`.

---

### Bug 2 — No code change required

The 404 on `GET /api/learning/{actionId}/{userId}/objectives` resolves automatically once
Bug 1 is fixed and skill profiles can be successfully generated and approved. No changes to
the learning Lambda are needed.

---

### Bug 3 — Change redirect target in `apiRequest`

**File**: `src/lib/apiService.ts`  
**Function**: `apiRequest`

There are two redirect statements, both must be updated:

```typescript
// Before (both occurrences)
window.location.href = '/login';

// After (both occurrences)
window.location.href = '/auth';
```

First occurrence: inside the `catch (refreshError)` block after a failed token refresh
(~line 270).  
Second occurrence: inside the `if (response.status === 401 && _isRetry)` block (~line 282).

No other logic in `apiRequest` changes.

---

### Bug 4 — Extract error message string in `useGenerateSkillProfile`

**File**: `src/hooks/useSkillProfile.ts`  
**Function**: `useGenerateSkillProfile` `onError` callback (line 59)

```typescript
// Before
onError: (error) => {
  console.error('Failed to generate skill profile:', error);
},

// After
onError: (error) => {
  console.error('Failed to generate skill profile:', (error as any)?.message || String(error));
},
```

The cast `(error as any)` is consistent with the existing pattern used in
`useApproveSkillProfile` and `useDeleteSkillProfile` in the same file, which also receive
`unknown`-typed errors from TanStack Query.

---

### Bug 5 — Preserve user's growth intent as the narrative

**File**: `lambda/skill-profile/index.js`  
**Function**: `handleGenerate`

After the Bedrock call returns a valid profile, overwrite the AI-generated `narrative` with
the user's own `growthIntent` text:

```javascript
// After isValidSkillProfile check passes, before return success(profile):

// Bug 5 fix: when the user provided their own growth intent text, use it verbatim
// as the narrative. The user controls what their skill profile says about them.
// The AI only generates the axes.
if (growthIntent) {
  profile.narrative = growthIntent;
}

return success(profile);
```

This is a post-processing step — the AI prompt is unchanged, the axes are still fully
AI-generated and grounded in the growth intent, and the validation logic is unchanged.
We simply replace the AI's narrative with the user's words before returning.

The same pattern applies to the retry path — both `return success(profile)` calls in
`handleGenerate` must have this substitution applied before returning.

---

## Testing Strategy

### Validation Approach

The testing strategy follows the bug condition methodology: first surface counterexamples
that demonstrate each bug on unfixed code, then verify the fix produces correct behavior,
then verify preservation of unchanged behavior.

---

### Exploratory Bug Condition Checking

**Goal**: Confirm the root cause of each bug before implementing the fix.

**Bug 1 — Bedrock Model ID**

Run the existing Lambda locally or in a test environment with the unfixed model ID and
observe the Bedrock `ValidationException`. The error message from AWS will confirm that the
model ID is the cause.

**Test Cases:**
1. **Direct Bedrock call test**: Call `InvokeModelCommand` with
   `anthropic.claude-3-5-haiku-20241022-v1:0` in `us-west-2` → expect
   `ValidationException: The provided model identifier is invalid`.
2. **Lambda integration test**: `POST /api/skill-profiles/generate` with valid body →
   expect HTTP 503 "AI service temporarily unavailable." (will fail on unfixed code).
3. **Profile skill test**: `POST /api/profile-skills/generate` with valid narrative →
   expect HTTP 503 (will fail on unfixed code, same root cause).

**Expected Counterexamples:**
- Bedrock returns `ValidationException` with message indicating invalid model identifier.
- Lambda catches the error and returns 503.

**Bug 3 — Redirect target**

Inspect `App.tsx` routes and confirm there is no `<Route path="/login" ...>`. Confirm
`<Route path="/auth" element={<Auth />} />` exists. This is a static analysis check —
no runtime test needed to confirm the mismatch.

**Bug 4 — Error log**

Trigger a 503 from the API (or mock one) and observe the browser console. The log line
`"Failed to generate skill profile: Object"` confirms the bug.

**Bug 5 — Narrative overwrite**

Type a specific, personal growth intent (e.g. *"I want to understand how gypsum affects soil
structure without harming my existing plants"*) and hit Generate. Observe that the Skill
Narrative textarea shows AI-rewritten prose instead of the user's exact text. This confirms
the bug.

---

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed code produces
the expected behavior.

**Pseudocode (Bug 1):**
```
FOR ALL request WHERE isValidSkillProfileRequest(request) DO
  result := POST /api/skill-profiles/generate (fixed Lambda)
  ASSERT result.status = 200
  ASSERT isValidSkillProfile(result.body.data)
END FOR
```

**Pseudocode (Bug 3):**
```
FOR ALL response WHERE response.status = 401 AND (refreshFailed OR isRetry) DO
  redirect := captureRedirect(apiRequest_fixed(response))
  ASSERT redirect = '/auth'
END FOR
```

**Pseudocode (Bug 4):**
```
FOR ALL error WHERE typeof error = 'object' AND error.message EXISTS DO
  logOutput := captureConsoleError(onError_fixed(error))
  ASSERT logOutput CONTAINS error.message
  ASSERT logOutput NOT CONTAINS '[object Object]'
END FOR
```

**Pseudocode (Bug 5):**
```
FOR ALL request WHERE request.growth_intent IS NOT NULL AND request.growth_intent != '' DO
  result := POST /api/skill-profiles/generate (fixed Lambda)
  ASSERT result.status = 200
  ASSERT result.body.data.narrative = request.growth_intent.trim()
  ASSERT result.body.data.axes.length >= minAxes
  ASSERT result.body.data.axes.length <= maxAxes
END FOR
```

---

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code
produces the same result as the original code.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain.
- It catches edge cases that manual unit tests might miss.
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs.

**Test Plan**: Observe behavior on unfixed code first for non-buggy inputs (valid Bedrock
calls with the correct model ID, non-401 API responses, non-error hook states), then write
property-based tests capturing that behavior.

**Test Cases:**
1. **Skill profile generation preservation**: Generate a skill profile without a growth
   intent (action-driven path) → verify HTTP 200 and valid profile structure after fix.
2. **Profile skill generation preservation**: Generate a profile skill preview → verify
   HTTP 200 and valid `ai_interpretation` + `axes` structure after fix.
3. **Non-401 response preservation**: Make API calls returning 200, 400, 403, 500 → verify
   no redirect occurs and response handling is identical before and after fix.
4. **Approve/delete hook preservation**: Trigger `useApproveSkillProfile` and
   `useDeleteSkillProfile` errors → verify their `onError` handlers are unchanged.
5. **No growth intent preservation**: Generate a skill profile without a growth intent →
   verify the narrative is AI-generated and the response is HTTP 200, unchanged from before.

---

### Unit Tests

- Test `callBedrockForSkillProfile` with a mocked Bedrock client: verify the `modelId`
  passed to `InvokeModelCommand` is `us.anthropic.claude-3-5-haiku-20241022-v1:0`.
- Test `apiRequest` with a mocked 401 response and failed refresh: verify
  `window.location.href` is set to `/auth`, not `/login`.
- Test `useGenerateSkillProfile` `onError` with an `ApiError` object: verify
  `console.error` is called with the message string, not `[object Object]`.
- Test `useGenerateSkillProfile` `onError` with a plain `Error` object: verify
  `console.error` is called with `error.message`.
- Test `useGenerateSkillProfile` `onError` with a string error: verify `String(error)` is
  used as fallback.
- Test `handleGenerate` with a non-empty `growth_intent`: verify the returned `profile.narrative`
  equals the `growth_intent` string exactly, and `profile.axes` is the AI-generated array.
- Test `handleGenerate` with an empty or absent `growth_intent`: verify the returned
  `profile.narrative` is the AI-generated string (not empty, not the growth intent).

### Property-Based Tests

- Generate random valid skill profile request bodies and verify the fixed Lambda always
  returns HTTP 200 with a structurally valid profile (property 1).
- Generate random API responses with status codes 200–399 and verify the fixed `apiRequest`
  never redirects (property 5).
- Generate random error objects (with and without `.message`) and verify the fixed
  `onError` always logs a string (property 3).
- Generate random non-empty `growth_intent` strings and verify the fixed `handleGenerate`
  always returns `profile.narrative === growth_intent.trim()` (property 6).
- Generate random valid action contexts without a growth intent and verify the fixed
  `handleGenerate` always returns an AI-generated narrative (non-empty string, property 7).

### Integration Tests

- Full flow: submit growth intent → `POST /api/skill-profiles/generate` returns 200 →
  approve profile → `GET /api/learning/{actionId}/{userId}/objectives` returns 200.
- Auth expiry flow: expire token, fail refresh → verify browser navigates to `/auth` and
  the sign-in form renders.
- Error display flow: mock a 503 → verify the console log contains the error message string
  and the UI shows the appropriate error toast.
