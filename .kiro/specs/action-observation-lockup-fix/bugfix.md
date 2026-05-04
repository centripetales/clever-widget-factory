# Bugfix Requirements Document

## Introduction

When a user adds an observation to an action via the `StatesInline` component (inside `UnifiedActionDialog`), the browser locks up and requires a force quit. The lockup is caused by two compounding issues: a blocking AI verification call that awaits a slow Bedrock/Claude response on the UI thread, and an overly broad cache invalidation that triggers a cascade of simultaneous API refetches across all components using `useStates`. Together these make the UI completely unresponsive after saving an action observation.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user saves an action observation with one or more learning objectives selected THEN the system awaits the AI verification call (`verificationMutation.mutateAsync`) synchronously on the UI thread, blocking all interaction for 5–30 seconds until the Bedrock response returns

1.2 WHEN a user saves an action observation (with or without objectives selected) THEN the system invalidates the broad `statesQueryKey()` cache key, causing every `useStates` query across the entire app to refetch simultaneously, creating a cascade of API calls that further degrades UI responsiveness

1.3 WHEN both conditions above occur together (observation saved with objectives selected) THEN the browser becomes completely unresponsive and requires a force quit

### Expected Behavior (Correct)

2.1 WHEN a user saves an action observation with one or more learning objectives selected THEN the system SHALL save the observation immediately, close or update the form without blocking, and run the AI verification in the background — showing a non-blocking loading indicator while verification is in progress and displaying results when they arrive

2.2 WHEN a user saves an action observation THEN the system SHALL only invalidate the scoped `statesQueryKey(filters)` cache key for the specific entity, and SHALL use an optimistic update to add the new observation to the cache immediately without triggering a broad refetch of all `useStates` queries

2.3 WHEN the AI verification completes in the background THEN the system SHALL display the verification results to the user without having blocked the UI during the wait

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user saves an action observation without any learning objectives selected THEN the system SHALL CONTINUE TO save the observation and reset the form as before

3.2 WHEN a user saves an action observation with learning objectives selected and verification succeeds THEN the system SHALL CONTINUE TO display the verification results to the user

3.3 WHEN a user saves an action observation with learning objectives selected and verification fails THEN the system SHALL CONTINUE TO show a toast notification that verification was unavailable while keeping the saved observation

3.4 WHEN a user updates an existing observation THEN the system SHALL CONTINUE TO apply the optimistic update pattern and invalidate only the relevant caches

3.5 WHEN a user deletes an observation THEN the system SHALL CONTINUE TO invalidate the filtered states cache and the broad states cache as before

3.6 WHEN the `createState` mutation succeeds THEN the system SHALL CONTINUE TO make the new observation visible in the UI for the relevant entity
