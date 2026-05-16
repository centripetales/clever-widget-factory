# Implementation Plan

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Blocking Poll on Absent Skill Axis Embeddings
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the blocking poll bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case — `skill_axis` row count = 0 with an approved skill profile — to ensure reproducibility
  - Test that `handleIndividualCapability` returns HTTP 202 with `{ status: 'embeddings_pending', action_id }` when the DB returns 0 `skill_axis` rows for the action (from Bug Condition in design: `existingRows = 0 AND skillProfile.approved_at IS NOT NULL`)
  - Mock the DB to return 0 rows for `SELECT 1 FROM unified_embeddings WHERE entity_type = 'skill_axis'`; mock an approved skill profile
  - Run test on UNFIXED code — expect FAILURE (unfixed code calls `ensurePerAxisEmbeddings`, polls 4 times, then throws `"Skill axis embeddings could not be generated"` → 500/504)
  - Also test partial embeddings case: mock DB returns 1 of 3 expected rows — unfixed code still times out
  - Document counterexamples found (e.g., `handleIndividualCapability` throws after 4 poll attempts instead of returning 202)
  - Assert no SQS `SendMessageCommand` calls are made in the fixed path (capability Lambda becomes read-only)
  - _Requirements: 1.1, 1.2, 2.1_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Existing 200 Path Unchanged for Requests Where Embeddings Exist
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs (requests where `skill_axis` rows already exist in `unified_embeddings`)
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code

  **Preservation 2a — HTTP 200 cache-hit path unchanged**
  - Observe: `handleIndividualCapability` with existing `skill_axis` rows AND a valid cached profile returns HTTP 200 with full profile on unfixed code; Bedrock is NOT called
  - Write property-based test: for all `(actionId, organizationId)` pairs where `skill_axis` rows exist and a cached profile hash matches, response is always 200 with profile body; Bedrock mock is never invoked
  - Verify test PASSES on unfixed code

  **Preservation 2b — HTTP 200 cache-miss path unchanged**
  - Observe: `handleIndividualCapability` with existing `skill_axis` rows but no cached profile calls Bedrock and returns HTTP 200 on unfixed code
  - Write property-based test: for all requests where rows exist and no cache entry is present, Bedrock IS called and response is 200
  - Verify test PASSES on unfixed code

  **Preservation 2c — HTTP 200 force-rescore path unchanged**
  - Observe: `handleIndividualCapability` with `?force=true` and existing embeddings calls Bedrock regardless of cache on unfixed code
  - Write test: `force=true` with existing rows → Bedrock IS called → response is 200
  - Verify test PASSES on unfixed code

  **Preservation 2d — HTTP 404 for missing or unapproved skill profile unchanged**
  - Observe: `handleIndividualCapability` returns 404 when `skillProfile.approved_at` is null or no action row exists on unfixed code
  - Write property-based test: for all requests where the action does not exist or the profile is unapproved, response is always 404
  - Verify test PASSES on unfixed code

  **Preservation 2e — Non-`skill_axis` processor messages produce no WebSocket broadcast**
  - Observe: `cwf-embeddings-processor` processes `part`, `tool`, `action`, `state` entity types without calling any broadcast function on unfixed code
  - Write property-based test: for all entity types in `['part', 'tool', 'action', 'state', 'issue', 'policy']`, `broadcastEmbeddingEvent` is never called
  - Verify test PASSES on unfixed code (function doesn't exist yet — mock it and assert zero calls)

  **Preservation 2f — `WS_API_ENDPOINT` absent — graceful degradation**
  - Observe: processing a `skill_axis` message with `WS_API_ENDPOINT` unset writes the embedding successfully and throws no error on unfixed code
  - Write test: unset `process.env.WS_API_ENDPOINT`, process a `skill_axis` message → embedding write succeeds, no error thrown
  - Verify test PASSES on unfixed code

  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [ ] 3. Implement the fix across all four files

  - [ ] 3.1 Add `broadcastEmbeddingEvent` to the shared layer
    - In `lambda/layers/cwf-common-nodejs/nodejs/broadcastInvalidation.js`, add a new exported function `broadcastEmbeddingEvent` as a sibling to the existing `broadcastInvalidation`
    - Reuse the same `ApiGatewayManagementApiClient` fan-out pattern: read `WS_API_ENDPOINT` from `process.env`; if absent, return immediately (graceful degradation)
    - Query `websocket_connections WHERE organization_id = organizationId AND disconnected_at IS NULL`
    - Build message as `JSON.stringify({ type, payload, timestamp: new Date().toISOString() })`
    - Fan out with `PostToConnection`; on 410 `GoneException`, mark the connection disconnected (same pattern as `broadcastInvalidation`)
    - Do NOT write to `entity_changes` — these are transient progress events, not persistent cache invalidations
    - No `excludeConnectionId` parameter — broadcast to all connections including the approving user
    - Export via `module.exports` alongside the existing `broadcastInvalidation` export
    - Bump the layer version in preparation for deployment
    - _Bug_Condition: `isBugCondition(request)` where `existingRows = 0 AND skillProfile.approved_at IS NOT NULL`_
    - _Expected_Behavior: `broadcastEmbeddingEvent({ type, payload, organizationId })` fans out to all active connections; returns silently when `WS_API_ENDPOINT` is absent_
    - _Preservation: `broadcastInvalidation` function and its callers are completely unchanged_
    - _Requirements: 2.3, 2.5, 2.7, 3.5, 3.7_

  - [ ] 3.2 Add `axes_total` to SQS messages in `lambda/skill-profile/index.js`
    - Locate the code path in `lambda/skill-profile/index.js` that queues SQS messages for `skill_axis` embeddings when a profile is approved
    - Add `axes_total: skillProfile.axes.length` to each SQS message body alongside the existing `action_id`, `axis_key`, `organization_id`, and `embedding_source` fields
    - This is a backward-compatible addition — the processor already ignores unknown fields on legacy messages
    - No other logic in the skill-profile Lambda changes
    - _Bug_Condition: processor receives SQS messages without `axes_total`, cannot determine completion_
    - _Expected_Behavior: each SQS message body carries `axes_total` so the processor can broadcast `embeddings:skill_axis_complete` when `axes_complete >= axes_total`_
    - _Preservation: all other skill-profile Lambda behavior (profile generation, approval, deletion) unchanged_
    - _Requirements: 2.3, 2.5_

  - [ ] 3.3 Add WebSocket broadcasts to `lambda/embeddings-processor/index.js`
    - Add `require` for `broadcastEmbeddingEvent` from `/opt/nodejs/broadcastInvalidation`
    - Add `WS_API_ENDPOINT` to the Lambda's environment variable configuration (same value used by other broadcasting Lambdas)
    - In the `skill_axis` processing path, after `writeToUnifiedTable` succeeds:
      - Query `SELECT COUNT(*) FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1 AND organization_id = $2` to get `axes_complete`
      - Read `axes_total` from `message.axes_total ?? null`
      - Broadcast `embeddings:skill_axis_ready` with `{ action_id, axis_key, organization_id, axes_complete, axes_total }`
      - If `axes_total IS NOT NULL AND axes_complete >= axes_total`, broadcast `embeddings:skill_axis_complete` with `{ action_id, organization_id }`
    - In the existing `catch` block for `writeToUnifiedTable` failures (before re-throwing), broadcast `embeddings:skill_axis_failed` with `{ action_id, axis_key, error: error.message }`
    - Re-throw the error after broadcasting to preserve existing SQS retry behavior
    - Non-`skill_axis` entity types: no broadcast calls added — their code paths are untouched
    - _Bug_Condition: `isBugCondition(request)` — processor writes embeddings but no client notification occurs_
    - _Expected_Behavior: `embeddings:skill_axis_ready` broadcast after each write; `embeddings:skill_axis_complete` when all axes done; `embeddings:skill_axis_failed` on error_
    - _Preservation: non-`skill_axis` entity processing unchanged; embedding write to `unified_embeddings` always succeeds regardless of broadcast outcome; SQS retry behavior preserved_
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.4, 3.5_

  - [ ] 3.4 Replace `ensurePerAxisEmbeddings` with `checkSkillAxisEmbeddingsExist` in `lambda/capability/index.js`
    - Delete the entire `ensurePerAxisEmbeddings` function from `lambda/capability/index.js`
    - Remove the `module.exports.ensurePerAxisEmbeddings` export
    - Add the new `checkSkillAxisEmbeddingsExist` helper:
      ```javascript
      async function checkSkillAxisEmbeddingsExist(db, actionId, organizationId) {
        const result = await db.query(
          `SELECT 1 FROM unified_embeddings
           WHERE entity_type = 'skill_axis'
             AND action_id = $1
             AND organization_id = $2
           LIMIT 1`,
          [actionId, organizationId]
        );
        return result.rows.length > 0;
      }
      ```
    - In `handleIndividualCapability`, replace the `await ensurePerAxisEmbeddings(...)` call with:
      ```javascript
      const embeddingsReady = await checkSkillAxisEmbeddingsExist(db, actionId, organizationId);
      if (!embeddingsReady) {
        return {
          statusCode: 202,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
          },
          body: JSON.stringify({ status: 'embeddings_pending', action_id: actionId })
        };
      }
      ```
    - Apply the same replacement in `handleOrganizationCapability` (also calls `ensurePerAxisEmbeddings`)
    - The capability Lambda becomes read-only with respect to embeddings — it never queues SQS messages
    - _Bug_Condition: `existingRows = 0 AND skillProfile.approved_at IS NOT NULL` → `ensurePerAxisEmbeddings` polls 4 times and throws_
    - _Expected_Behavior: `checkSkillAxisEmbeddingsExist` returns false → immediate HTTP 202 with `{ status: 'embeddings_pending', action_id }`_
    - _Preservation: when rows exist, `handlePerAxisCapability` is called exactly as before; 404 paths for missing action or unapproved profile are untouched; `?force=true` path is untouched_
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.6_

  - [ ] 3.5 Update `src/hooks/useCapability.ts` to handle 202 response
    - Add the `CapabilityQueryResult` discriminated union type:
      ```typescript
      export type CapabilityQueryResult =
        | { status: 'ready'; profile: CapabilityProfile }
        | { status: 'embeddings_pending'; action_id: string };
      ```
    - Update `useCapabilityProfile`'s `queryFn` return type to `Promise<CapabilityQueryResult>`
    - Wrap the existing `apiService.get` call in a try/catch:
      - On success: return `{ status: 'ready', profile: result.data }`
      - On `err?.status === 202`: return `{ status: 'embeddings_pending', action_id: actionId! }` (not an error — do not throw)
      - All other errors: re-throw so TanStack Query treats them as errors normally
    - _Bug_Condition: `apiService.get` throws on 202 → TanStack Query marks query as errored → no pending state possible_
    - _Expected_Behavior: 202 is caught and returned as a sentinel value; query enters `success` state with `embeddings_pending` data_
    - _Preservation: HTTP 200 path returns `{ status: 'ready', profile }` unchanged; all non-202 errors propagate as before; `useCapabilityProfile` query key and stale-time config unchanged_
    - _Requirements: 2.2, 3.8_

  - [ ] 3.6 Update `src/components/CapabilityAssessment.tsx` to handle pending state and WebSocket events
    - Unwrap `capabilityQuery.data` using the discriminated union:
      ```typescript
      const isPending = capabilityQuery.data?.status === 'embeddings_pending';
      const capabilityProfile = capabilityQuery.data?.status === 'ready'
        ? capabilityQuery.data.profile
        : null;
      ```
    - Add local state for embedding progress and errors:
      ```typescript
      const [embeddingProgress, setEmbeddingProgress] = useState<{
        axesComplete: number;
        axesTotal: number | null;
      } | null>(null);
      const [embeddingError, setEmbeddingError] = useState<string | null>(null);
      ```
    - Add a `useEffect` that subscribes to WebSocket events only when `isPending` is true:
      - `embeddings:skill_axis_ready` → update `embeddingProgress` with `{ axesComplete: payload.axes_complete, axesTotal: payload.axes_total ?? null }` (guard: `payload.action_id !== action.id`)
      - `embeddings:skill_axis_complete` → call `capabilityQuery.refetch()` (guard: `payload.action_id !== action.id`)
      - `embeddings:skill_axis_failed` → set `embeddingError` with `payload.error || 'Embedding generation failed'` (guard: `payload.action_id !== action.id`)
      - Return cleanup function calling all three unsubscribe functions
      - Dependency array: `[isPending, action.id, subscribe, capabilityQuery]`
    - Add a pending render branch (before the existing loading/error/success branches):
      - Show `<Loader2 className="h-8 w-8 animate-spin text-primary" />` with "Preparing skill analysis…" text
      - When `embeddingProgress` is set, show per-axis progress: `"N of M axes ready"` (or `"N axes ready"` when `axesTotal` is null)
      - When `embeddingError` is set, show error text in `text-destructive` and a `<Button variant="outline" size="sm">` Retry button that clears the error and calls `capabilityQuery.refetch()`
    - Update the existing `capabilityProfiles` memo to use the unwrapped `capabilityProfile` value instead of `capabilityQuery.data` directly
    - All downstream consumers (`SkillRadialChart`, `PersonGapChecklist`, learning objectives) continue to receive `CapabilityProfile[]` unchanged
    - _Bug_Condition: frontend receives 202 → TanStack Query error state → "Unable to load target growth areas" with no recovery_
    - _Expected_Behavior: 202 → `isPending = true` → "Preparing skill analysis…" UI → WebSocket events update progress → `embeddings:skill_axis_complete` triggers refetch → assessment loads automatically_
    - _Preservation: HTTP 200 path renders radar chart, gap checklist, and learning objectives exactly as before; `isPending = false` when data is ready_
    - _Requirements: 2.2, 2.4, 2.6, 2.8, 3.8_

  - [ ] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Non-blocking 202 with WebSocket Progress
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior; when it passes, the fix is confirmed
    - Run the exploration test against the fixed `handleIndividualCapability` code
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed — 202 returned immediately, no polling, no SQS calls)
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6_

  - [ ] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Existing 200 Path Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run all preservation tests (2a through 2f) against the fixed code
    - **EXPECTED OUTCOME**: All preservation tests PASS (confirms no regressions)
    - Confirm HTTP 200 cache-hit, cache-miss, force-rescore, and 404 paths all behave identically to unfixed code

- [ ] 4. Deploy updated Lambda functions and layer

  - [ ] 4.1 Deploy updated `cwf-common-nodejs` layer
    - Bump the layer version in `lambda/layers/cwf-common-nodejs/` (update `package.json` version or layer description)
    - Package and publish the new layer version to AWS
    - Note the new layer ARN / version number for use in subsequent Lambda deployments
    - Verify the new layer exports both `broadcastInvalidation` and `broadcastEmbeddingEvent`

  - [ ] 4.2 Deploy `cwf-embeddings-processor` Lambda
    - Run `./scripts/deploy/deploy-lambda-with-layer.sh embeddings-processor cwf-embeddings-processor`
    - Confirm the new layer version (from 4.1) is attached
    - Add `WS_API_ENDPOINT` environment variable (same value as other broadcasting Lambdas — check `.env.local` or existing Lambda config)
    - Verify the deployment succeeded and the function configuration shows the correct layer ARN and env vars

  - [ ] 4.3 Deploy `cwf-skill-profile-lambda` Lambda
    - Run `./scripts/deploy/deploy-lambda-with-layer.sh skill-profile cwf-skill-profile-lambda`
    - Verify the deployment succeeded
    - Confirm SQS messages now include `axes_total` by checking CloudWatch logs after a test approval

  - [ ] 4.4 Deploy `cwf-capability-lambda` Lambda
    - Run `./scripts/deploy/deploy-lambda-with-layer.sh capability cwf-capability-lambda`
    - Verify the deployment succeeded
    - Confirm `ensurePerAxisEmbeddings` is no longer present in the deployed code

- [ ] 5. Checkpoint — Ensure all tests pass and end-to-end flow works
  - Run the full test suite: `npm run test:run`
  - Confirm the exploration test (task 1) now passes
  - Confirm all preservation tests (task 2) still pass
  - Confirm no other tests regressed
  - Verify the happy-path end-to-end flow manually:
    - Approve a skill profile with 3 axes
    - Immediately open the capability tab → observe HTTP 202 → "Preparing skill analysis…" spinner appears
    - Watch WebSocket events arrive: `embeddings:skill_axis_ready` updates progress counter ("1 of 3 axes ready", "2 of 3 axes ready", "3 of 3 axes ready")
    - `embeddings:skill_axis_complete` triggers auto-refetch → capability assessment loads with radar chart, gap checklist, and learning objectives
  - Verify the failure flow manually:
    - Simulate a processor failure on one axis → `embeddings:skill_axis_failed` received → error state with Retry button shown
  - Verify the preservation flow manually:
    - Open capability tab when embeddings already exist → HTTP 200 → radar chart renders immediately, no pending state shown
  - Ask the user if any questions arise before closing the spec
