# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Non-Blocking Verification and Scoped Cache Invalidation
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases: `createState` called with filters set, and `handleSubmit` called with `selectedObjectiveIds.size > 0`
  - In `src/hooks/__tests__/useStates.test.tsx`, add a test under `cache invalidation` that calls `createState` with `{ entity_type: 'action', entity_id: 'action-1' }` filters and asserts that `invalidateQueries` is NOT called with `{ queryKey: ['states'] }` (the broad key)
  - Also assert that the filtered cache is updated optimistically before the server responds (add a delayed mock and check cache mid-flight)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS — `invalidateQueries` IS called with `{ queryKey: ['states'] }` and no optimistic update exists (proves the bug)
  - Document counterexamples found: "createState invalidates ['states'] broad key" and "filtered cache not updated until server responds"
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Filtered Cache Update and Delete Invalidation Behavior
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: on unfixed code, after `createState` resolves, the filtered cache `['states', 'action', 'action-1']` IS invalidated (via `invalidateQueries`) — record this as the baseline behavior to preserve
  - Observe: on unfixed code, `deleteState` invalidates both `['states', 'action', 'action-1']` AND `['states']` — this must remain unchanged
  - Observe: on unfixed code, saving without objectives selected resets form state — this must remain unchanged
  - Write property-based test: for any `entity_type`/`entity_id` filter combination, after `createState` succeeds, the filtered cache key `statesQueryKey(filters)` is always invalidated (or updated)
  - Write test: `deleteState` still invalidates both `statesQueryKey(filters)` AND `statesQueryKey()` after the fix
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS — confirms baseline behavior to preserve
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.5, 3.6_

- [x] 3. Fix action observation lockup

  - [x] 3.1 Fix `createMutation` in `src/hooks/useStates.ts` — optimistic update + scoped invalidation
    - Add `onMutate` handler: cancel queries for `statesQueryKey(filters)`, snapshot previous filtered list, prepend a provisional observation (with `id: 'optimistic-' + Date.now()`, `observation_text` from `variables.state_text`, `photos: variables.photos ?? []`, `links: variables.links ?? []`, `captured_at: new Date().toISOString()`) to the filtered cache
    - In `onSuccess`: remove `queryClient.invalidateQueries({ queryKey: statesQueryKey() })` — keep only `queryClient.invalidateQueries({ queryKey: statesQueryKey(filters) })` to refresh with the real server id; also invalidate `actionsQueryKey()` and `completedActionsQueryKey()` when `filters?.entity_type === 'action'`
    - Add `onError` handler: restore the previous filtered cache snapshot from context (matching the `updateMutation` rollback pattern)
    - _Bug_Condition: isBugCondition(input) — broad statesQueryKey() invalidation on every create_
    - _Expected_Behavior: only statesQueryKey(filters) is invalidated; new observation appears optimistically_
    - _Preservation: filtered cache still updates; delete behavior unchanged; updateMutation unchanged_
    - _Requirements: 2.2, 3.1, 3.5, 3.6_

  - [x] 3.2 Fix `handleSubmit` in `src/components/StatesInline.tsx` — non-blocking verification
    - Replace `const results = await verificationMutation.mutateAsync({...})` with `verificationMutation.mutate({...}, { onSuccess: (results) => { setVerificationResults(results); }, onError: (verifyError) => { console.error(...); toast({ title: 'Verification unavailable', ... }); } })`
    - Move form reset logic (`setStateText('')`, `setPhotos([])`, `setEditingStateId(null)`, `setShowAddForm(false)`, `setSelectedObjectiveIds(new Set())`) to run immediately after the success toast — before the `.mutate()` call — so the user is not blocked
    - Remove the early `return` that was keeping `showAddForm` open to display results; instead, when `setVerificationResults` is called from the `onSuccess` callback, re-open or update the display as needed (e.g., set `showAddForm(true)` inside the callback if results should be shown)
    - Add a non-blocking loading indicator: when `verificationMutation.isPending`, show a small spinner or informational toast (e.g., "Verifying skill demonstration…") near the observation list — do NOT block the form
    - Clean up blob preview URLs in the `onSuccess` callback path as well (move the `photosSnapshot.forEach(URL.revokeObjectURL)` call to before the `.mutate()` call)
    - _Bug_Condition: isBugCondition(input) — mutateAsync awaited synchronously when selectedObjectiveIds.size > 0_
    - _Expected_Behavior: form resets immediately; verification runs in background; results shown when ready_
    - _Preservation: verification results still displayed; error toast still shown on failure_
    - _Requirements: 2.1, 2.3, 3.2, 3.3_

  - [x] 3.3 Update existing test for broad invalidation in `src/hooks/__tests__/useStates.test.tsx`
    - The existing test `'should invalidate states cache when creating state'` currently asserts that BOTH `['states', 'action', 'action-1']` AND `['states']` are invalidated on create
    - After the fix, the broad `['states']` invalidation is intentionally removed — update this test to assert that `['states']` is NOT invalidated on create, and that the filtered key IS invalidated (or that an optimistic update was applied)
    - This is a spec-driven test update, not a test deletion — the test now reflects the correct post-fix behavior
    - _Requirements: 2.2_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Non-Blocking Verification and Scoped Cache Invalidation
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the broad invalidation is gone and the optimistic update is in place
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Filtered Cache Update and Delete Invalidation Behavior
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm filtered cache still updates after create, delete still invalidates both keys, and form reset behavior is unchanged

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `npm run test:run` and confirm all tests in `src/hooks/__tests__/useStates.test.tsx` pass
  - Confirm no TypeScript errors in `src/hooks/useStates.ts` and `src/components/StatesInline.tsx`
  - Manually verify in the browser: save an observation with objectives selected, confirm the form closes immediately and a background loading indicator appears, then verification results appear without any freeze
  - Ensure all tests pass; ask the user if questions arise
