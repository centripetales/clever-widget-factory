# Implementation Plan

- [x] 1. Write bug condition exploration tests
  - **Property 1: Bug Condition** - Bedrock Model ID, Auth Redirect, Error Log, Growth Intent Narrative
  - **CRITICAL**: These tests MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: These tests encode the expected behavior — they will validate the fixes when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate each bug exists
  - **Scoped PBT Approach**: For deterministic bugs, scope each property to the concrete failing case(s) to ensure reproducibility

  **Bug 1 — Bedrock Model ID (Property 1a)**
  - Test that `callBedrockForSkillProfile` invokes Bedrock with model ID `us.anthropic.claude-3-5-haiku-20241022-v1:0`
  - Scope: any call to `POST /api/skill-profiles/generate` or `POST /api/profile-skills/generate` with a valid request body
  - Bug condition: `modelId = 'anthropic.claude-3-5-haiku-20241022-v1:0'` AND `awsRegion = 'us-west-2'`
  - Mock the Bedrock client; assert the `modelId` passed to `InvokeModelCommand` equals the prefixed ID
  - Run on UNFIXED code — expect FAILURE (confirms the wrong model ID is used)
  - Document counterexample: `InvokeModelCommand` called with `anthropic.claude-3-5-haiku-20241022-v1:0` instead of `us.anthropic.claude-3-5-haiku-20241022-v1:0`

  **Bug 3 — Auth Redirect (Property 1b)**
  - Test that `apiRequest` redirects to `/auth` (not `/login`) on unrecoverable 401
  - Scope: any API response with `status = 401` where token refresh failed OR the call is a retry
  - Bug condition: `response.status = 401 AND (tokenRefreshFailed OR isRetry)`
  - Mock `window.location` and a failed token refresh; assert `window.location.href` is set to `/auth`
  - Run on UNFIXED code — expect FAILURE (confirms redirect goes to `/login`)
  - Document counterexample: `window.location.href` set to `/login` instead of `/auth`

  **Bug 4 — Error Log (Property 1c)**
  - Test that `useGenerateSkillProfile` `onError` logs the error message string, not `[object Object]`
  - Scope: any error object where `typeof error = 'object' AND error.message EXISTS`
  - Bug condition: raw error object passed directly to `console.error` second argument
  - Spy on `console.error`; call `onError` with `{ message: 'AI service temporarily unavailable', status: 503 }`
  - Assert the logged second argument is the message string, not `[object Object]`
  - Run on UNFIXED code — expect FAILURE (confirms `[object Object]` is logged)
  - Document counterexample: `console.error('Failed to generate skill profile:', [object Object])`

  **Bug 5 — Growth Intent Narrative (Property 1d)**
  - Test that `handleGenerate` returns `profile.narrative === growthIntent` when `growthIntent` is non-empty
  - Scope: any `POST /api/skill-profiles/generate` where `request.body.growth_intent` is a non-empty string
  - Bug condition: `request.body.growth_intent IS NOT NULL AND request.body.growth_intent.trim() != ''`
  - Mock Bedrock to return a profile with an AI-generated narrative; call `handleGenerate` with a growth intent
  - Assert `profile.narrative` equals the growth intent string exactly (not the AI-generated narrative)
  - Run on UNFIXED code — expect FAILURE (confirms AI narrative overwrites user's text)
  - Document counterexample: `profile.narrative` contains AI prose instead of user's exact growth intent text

  - _Requirements: 1.1, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Buggy Bedrock Calls, Non-401 Responses, Non-Error Hook States, No Growth Intent Path
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs (inputs where bug conditions do NOT hold)
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code

  **Preservation 2a — Non-401 API Responses Unchanged**
  - Observe: `apiRequest` with status 200, 400, 403, 500 produces no redirect on unfixed code
  - Write property-based test: for all responses with status 200–399 or 403, `window.location.href` is never set
  - Generate random status codes in range [200, 399] and verify no redirect occurs
  - Verify test PASSES on unfixed code

  **Preservation 2b — No Growth Intent Uses Full AI Narrative**
  - Observe: `handleGenerate` with absent or empty `growth_intent` returns AI-generated narrative on unfixed code
  - Write property-based test: for all calls where `growth_intent` is absent or empty string, `profile.narrative` is a non-empty AI-generated string
  - Generate random valid action contexts without a growth intent; assert narrative is non-empty and not equal to growth intent
  - Verify test PASSES on unfixed code

  **Preservation 2c — Approve/Delete Hook Error Handlers Unchanged**
  - Observe: `useApproveSkillProfile` and `useDeleteSkillProfile` `onError` handlers log their respective messages on unfixed code
  - Write tests asserting their `onError` callbacks are unaffected by any changes to `useGenerateSkillProfile`
  - Verify tests PASS on unfixed code

  **Preservation 2d — Skill Profile Generation Without Growth Intent Returns HTTP 200**
  - Observe: `POST /api/skill-profiles/generate` without a growth intent returns HTTP 200 with valid profile structure on unfixed code
  - Write property-based test: for all valid requests without `growth_intent`, response status is 200 and profile has `narrative` and `axes`
  - Verify test PASSES on unfixed code

  - _Requirements: 3.1, 3.4, 3.7, 3.8, 3.9_

- [x] 3. Fix all five bugs

  - [x] 3.1 Fix Bug 1 — Change Bedrock model ID in `callBedrockForSkillProfile`
    - In `lambda/skill-profile/index.js`, locate the `MODEL_ID` constant in `callBedrockForSkillProfile` (~line 390)
    - Change `'anthropic.claude-3-5-haiku-20241022-v1:0'` to `'us.anthropic.claude-3-5-haiku-20241022-v1:0'`
    - No other logic changes — prompt construction, `InvokeModelCommand` parameters, response parsing, and retry logic remain identical
    - Redeploy the Lambda to `cwf-skill-profile-lambda` using `./scripts/deploy/deploy-lambda-with-layer.sh skill-profile cwf-skill-profile-lambda`
    - _Bug_Condition: `modelId = 'anthropic.claude-3-5-haiku-20241022-v1:0' AND awsRegion = 'us-west-2'`_
    - _Expected_Behavior: `callBedrockForSkillProfile` invokes Bedrock with `us.anthropic.claude-3-5-haiku-20241022-v1:0` and Lambda returns HTTP 200 with valid skill profile_
    - _Preservation: All other `callBedrockForSkillProfile` logic (prompt, parsing, retry) unchanged; `POST /api/profile-skills/generate` continues to work_
    - _Requirements: 2.1, 2.2, 3.1, 3.7_

  - [x] 3.2 Fix Bug 2 — No code change required
    - Bug 2 (404 on `GET /api/learning/{actionId}/{userId}/objectives`) resolves automatically once Bug 1 is fixed
    - Verify after deploying Bug 1 fix: `POST /api/skill-profiles/generate` → approve profile → `GET /api/learning/{actionId}/{userId}/objectives` returns HTTP 200
    - No changes to the learning Lambda are needed
    - _Bug_Condition: `action.skill_profile IS NULL OR action.skill_profile.approved_at IS NULL`_
    - _Expected_Behavior: Once Bug 1 is fixed and profiles can be approved, objectives fetch returns HTTP 200_
    - _Requirements: 2.2, 3.5_

  - [x] 3.3 Fix Bug 3 — Change redirect target in `apiRequest`
    - In `src/lib/apiService.ts`, locate both `window.location.href = '/login'` occurrences in `apiRequest`
    - First occurrence: inside `catch (refreshError)` block after failed token refresh (~line 270)
    - Second occurrence: inside `if (response.status === 401 && _isRetry)` block (~line 282)
    - Change both to `window.location.href = '/auth'`
    - No other logic in `apiRequest` changes
    - _Bug_Condition: `response.status = 401 AND (tokenRefreshFailed OR isRetry)`_
    - _Expected_Behavior: `apiRequest` redirects to `/auth` so user lands on the sign-in form_
    - _Preservation: All API calls returning 200–399 or 403 continue with no redirect; response parsing and cache update logic unchanged_
    - _Requirements: 2.3, 3.4, 3.8_

  - [x] 3.4 Fix Bug 4 — Extract error message string in `useGenerateSkillProfile` `onError`
    - In `src/hooks/useSkillProfile.ts`, locate the `onError` callback in `useGenerateSkillProfile` (line 59)
    - Change `console.error('Failed to generate skill profile:', error)` to `console.error('Failed to generate skill profile:', (error as any)?.message || String(error))`
    - The `(error as any)` cast is consistent with the existing pattern in `useApproveSkillProfile` and `useDeleteSkillProfile` in the same file
    - _Bug_Condition: `typeof error = 'object' AND error IS NOT null AND error.message EXISTS`_
    - _Expected_Behavior: `onError` logs the message string so console reads `"Failed to generate skill profile: AI service temporarily unavailable. Please try again."` rather than `"Failed to generate skill profile: Object"`_
    - _Preservation: `useApproveSkillProfile` and `useDeleteSkillProfile` `onError` handlers unchanged_
    - _Requirements: 2.4, 3.9_

  - [x] 3.5 Fix Bug 5 — Preserve user's growth intent as the narrative in `handleGenerate`
    - In `lambda/skill-profile/index.js`, locate `handleGenerate` — find both `return success(profile)` calls (first attempt path and retry path)
    - Before each `return success(profile)`, add the guard: `if (growthIntent) { profile.narrative = growthIntent; }`
    - This is a post-processing step — the AI prompt is unchanged, axes remain fully AI-generated, and validation logic is unchanged
    - Apply to both the first-attempt path and the retry path
    - _Bug_Condition: `request.body.growth_intent IS NOT NULL AND request.body.growth_intent.trim() != ''`_
    - _Expected_Behavior: `profile.narrative` equals the user's exact `growthIntent` string; `profile.axes` is AI-generated as normal_
    - _Preservation: When `growth_intent` is absent or empty, `profile.narrative` remains the AI-generated narrative unchanged_
    - _Requirements: 2.5, 3.8, 3.10_

  - [x] 3.6 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Bedrock Model ID, Auth Redirect, Error Log, Growth Intent Narrative
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The tests from task 1 encode the expected behavior; when they pass, the fixes are confirmed
    - Run all four exploration tests (1a, 1b, 1c, 1d) against the fixed code
    - **EXPECTED OUTCOME**: All four tests PASS (confirms all bugs are fixed)
    - _Requirements: 2.1, 2.3, 2.4, 2.5_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Buggy Bedrock Calls, Non-401 Responses, Non-Error Hook States, No Growth Intent Path
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run all preservation tests (2a, 2b, 2c, 2d) against the fixed code
    - **EXPECTED OUTCOME**: All preservation tests PASS (confirms no regressions)
    - Confirm all tests still pass after fixes (no regressions introduced)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite: `npm run test:run`
  - Confirm all exploration tests (task 1) now pass
  - Confirm all preservation tests (task 2) still pass
  - Confirm no other tests regressed
  - Verify the end-to-end flow manually: submit growth intent → `POST /api/skill-profiles/generate` returns 200 with user's text as narrative → approve profile → `GET /api/learning/{actionId}/{userId}/objectives` returns 200
  - Verify auth expiry flow: expire token, fail refresh → browser navigates to `/auth` and sign-in form renders
  - Ask the user if any questions arise before closing the spec
