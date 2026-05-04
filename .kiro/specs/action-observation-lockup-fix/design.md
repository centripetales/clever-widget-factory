# Action Observation Lockup Bugfix Design

## Overview

Saving an action observation with learning objectives selected causes the browser to lock up. Two root causes compound each other: (1) `StatesInline.tsx` awaits a slow AI verification call synchronously on the UI thread, and (2) `useStates.ts` invalidates the entire `statesQueryKey()` cache on every create, triggering a cascade of simultaneous refetches across all components. The fix makes verification non-blocking and scopes cache invalidation to the specific entity, adding an optimistic update for `createMutation` to match the existing `updateMutation` pattern.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the lockup — saving an action observation when `selectedObjectiveIds.size > 0`, which causes `verificationMutation.mutateAsync` to block the UI thread
- **Property (P)**: The desired behavior — the UI remains responsive after saving; verification runs in the background and results are shown when ready
- **Preservation**: All existing save, update, delete, and verification-result-display behaviors that must remain unchanged by the fix
- **verificationMutation**: The `useMutation` instance from `useObservationVerification` that calls `/learning/:actionId/verify` via Bedrock/Claude (5–30 second latency)
- **statesQueryKey()**: The broad cache key `['states']` that, when invalidated, causes every `useStates` query in the app to refetch
- **statesQueryKey(filters)**: The scoped cache key `['states', entity_type, entity_id]` that only affects the specific entity's observation list
- **createMutation**: The `useMutation` in `useStateMutations` that calls `stateService.createState` — currently lacks an optimistic update

## Bug Details

### Bug Condition

The lockup manifests when a user saves an action observation with at least one learning objective checked. The `handleSubmit` function in `StatesInline.tsx` calls `await verificationMutation.mutateAsync(...)` after `createState` succeeds. Because this is `await`-ed inside an async event handler on the main thread, React cannot process any re-renders or user interactions until the Bedrock call resolves. Simultaneously, `createMutation.onSuccess` in `useStates.ts` calls `queryClient.invalidateQueries({ queryKey: statesQueryKey() })`, which invalidates every cached `useStates` query and triggers simultaneous refetches from all mounted components.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type ObservationSaveEvent
  OUTPUT: boolean

  RETURN input.selectedObjectiveIds.size > 0
         AND input.savedObservation.id IS NOT NULL
         AND verificationMutation.mutateAsync IS awaited synchronously
END FUNCTION
```

### Examples

- User checks 2 learning objectives, types an observation, clicks Save → browser freezes for 10–30 seconds (bug condition met)
- User types an observation with no objectives checked, clicks Save → form resets normally (bug condition NOT met, but broad invalidation still fires)
- User edits an existing observation → optimistic update fires, no lockup (update path is unaffected)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Saving an observation without objectives selected must continue to work and reset the form
- Verification results must still be shown to the user after background verification completes
- The "Verification unavailable" toast must still appear when verification fails
- Updating an existing observation must continue to use the optimistic update pattern
- Deleting an observation must continue to invalidate both filtered and broad caches
- The new observation must appear in the UI immediately after saving (via optimistic update)

**Scope:**
All inputs where `selectedObjectiveIds.size === 0` are unaffected by the verification fix. The cache invalidation fix affects all creates, but the new behavior (optimistic update + scoped invalidation) is strictly better — the observation appears immediately and no unnecessary refetches occur.

## Hypothesized Root Cause

1. **Blocking `mutateAsync` call**: `verificationMutation.mutateAsync` is awaited inside `handleSubmit`. React's event loop is blocked until the promise resolves. Using `.mutate()` with `onSuccess`/`onError` callbacks (or firing the async call without awaiting it) would allow React to continue rendering.

2. **Broad cache invalidation on create**: `createMutation.onSuccess` calls `queryClient.invalidateQueries({ queryKey: statesQueryKey() })` unconditionally. With multiple components mounted that each call `useStates`, this triggers N simultaneous GET requests. The fix is to remove this broad invalidation and instead use an optimistic update (like `updateMutation` already does) to add the new observation directly to the filtered cache.

3. **No optimistic update for createMutation**: Unlike `updateMutation`, `createMutation` has no `onMutate` handler. Adding one (following the existing pattern) means the new observation appears instantly in the UI without any network round-trip.

## Correctness Properties

Property 1: Bug Condition - Non-Blocking Verification

_For any_ observation save event where `isBugCondition` returns true (objectives are selected), the fixed `handleSubmit` function SHALL fire the verification call without blocking the UI thread — the form SHALL reset (or show a loading indicator) immediately after `createState` resolves, and verification results SHALL be delivered asynchronously when the Bedrock call completes.

**Validates: Requirements 2.1, 2.3**

Property 2: Preservation - Scoped Cache Invalidation and Observation Visibility

_For any_ observation save event where `isBugCondition` does NOT hold (no objectives selected, or any create regardless of objectives), the fixed `createMutation` SHALL add the new observation to the filtered cache optimistically and SHALL only invalidate `statesQueryKey(filters)` — NOT `statesQueryKey()` — so that unrelated `useStates` queries are not triggered to refetch.

**Validates: Requirements 2.2, 3.1, 3.6**

## Fix Implementation

### Changes Required

**File 1**: `src/hooks/useStates.ts`

**Function**: `createMutation` inside `useStateMutations`

**Specific Changes**:
1. **Add `onMutate` optimistic update**: Cancel outgoing queries for `statesQueryKey(filters)`, snapshot the previous filtered list, and prepend a provisional observation object (with a temporary id) to the filtered cache — mirroring the pattern in `updateMutation`.
2. **Remove broad invalidation**: Delete `queryClient.invalidateQueries({ queryKey: statesQueryKey() })` from `onSuccess`. This is the line that triggers the cascade of refetches.
3. **Scope `onSuccess` invalidation**: Keep `queryClient.invalidateQueries({ queryKey: statesQueryKey(filters) })` so the list refreshes with the real server-returned id after the mutation settles.
4. **Add `onError` rollback**: Restore the previous filtered cache snapshot if the create fails, matching the `updateMutation` rollback pattern.
5. **Invalidate actions cache on create**: If `filters?.entity_type === 'action'`, invalidate `actionsQueryKey()` and `completedActionsQueryKey()` in `onSuccess` to keep action-level counts consistent (same as `updateMutation`).

**File 2**: `src/components/StatesInline.tsx`

**Function**: `handleSubmit`

**Specific Changes**:
1. **Replace `mutateAsync` with fire-and-forget**: After `createState(data)` resolves and the success toast is shown, call `verificationMutation.mutate(...)` instead of `await verificationMutation.mutateAsync(...)`. Pass `onSuccess` and `onError` callbacks directly to `.mutate()`.
2. **Reset form immediately**: Move the form reset logic (`setStateText('')`, `setPhotos([])`, `setShowAddForm(false)`, etc.) to run right after the success toast, before verification starts — so the user is not blocked.
3. **Show background loading state**: When verification is in flight (`verificationMutation.isPending`), show a non-blocking indicator (e.g., a small spinner or toast) so the user knows verification is running.
4. **Handle verification result via callback**: In the `onSuccess` callback passed to `.mutate()`, call `setVerificationResults(results)` and re-open or update the relevant UI section to display results.
5. **Handle verification error via callback**: In the `onError` callback, show the existing "Verification unavailable" toast.

## Testing Strategy

### Validation Approach

The testing strategy follows the bug condition methodology: first write an exploration test that fails on unfixed code to confirm the bug, then write preservation tests that pass on unfixed code to capture baseline behavior, then implement the fix and verify both sets of tests pass.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the blocking behavior BEFORE implementing the fix. Confirm that `verificationMutation.mutateAsync` is awaited and that broad cache invalidation fires.

**Test Plan**: In `useStates.test.tsx`, write a test that calls `createState` and asserts that `statesQueryKey()` (broad) is NOT invalidated. Run on UNFIXED code — expect FAILURE (confirms the bug exists). In a component test for `StatesInline`, simulate saving with objectives selected and assert the form resets before the verification promise resolves.

**Test Cases**:
1. **Broad invalidation test**: Call `createState` with filters set, assert `invalidateQueries` is NOT called with `{ queryKey: ['states'] }` — will FAIL on unfixed code
2. **Optimistic update test**: Call `createState` with a delayed mock, assert the new observation appears in the filtered cache before the promise resolves — will FAIL on unfixed code (no `onMutate` exists)
3. **Non-blocking verification test**: Simulate `handleSubmit` with objectives selected and a slow verification mock, assert form state resets before verification resolves — will FAIL on unfixed code

**Expected Counterexamples**:
- `invalidateQueries` is called with `{ queryKey: ['states'] }` on every create
- The filtered cache is not updated until after the server responds (no optimistic update)
- Form state (`showAddForm`, `stateText`) remains set while verification is pending

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed code produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := handleSubmit_fixed(input)
  ASSERT form_reset_before_verification_resolves(result)
  ASSERT verification_runs_in_background(result)
  ASSERT ui_remains_responsive(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code produces the same result as the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT createMutation_original(input) = createMutation_fixed(input)
  // i.e., observation is saved, filtered cache is updated, form resets
END FOR
```

**Testing Approach**: Property-based testing is recommended for the cache invalidation preservation check because it can generate many combinations of filter values and verify that only the scoped key is invalidated.

**Test Cases**:
1. **No-objectives save preservation**: Observe that saving without objectives resets the form on unfixed code, write test to verify this continues after fix
2. **Filtered cache update preservation**: Observe that the filtered states list updates after create on unfixed code, write test to verify this continues (now via optimistic update)
3. **Delete invalidation preservation**: Verify delete still invalidates both filtered and broad caches (delete behavior is unchanged)

### Unit Tests

- Test `createMutation.onMutate` adds observation optimistically to filtered cache
- Test `createMutation.onError` rolls back the filtered cache
- Test `createMutation.onSuccess` invalidates only `statesQueryKey(filters)`, not `statesQueryKey()`
- Test that `handleSubmit` resets form state before verification resolves

### Property-Based Tests

- Generate random `entity_type`/`entity_id` filter combinations and verify `createMutation` never invalidates the broad `statesQueryKey()` key
- Generate random observation data and verify the optimistic update always adds the item to the correct filtered cache

### Integration Tests

- Full flow: open `UnifiedActionDialog`, add observation with objectives, verify form closes immediately and verification result appears asynchronously
- Full flow: add observation without objectives, verify form closes and observation appears in list
- Verify no other `useStates` queries refetch when an observation is created for a specific action
