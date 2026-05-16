# Skill Axis Embedding WebSocket Feedback — Bugfix Design

## Overview

The capability assessment Lambda (`cwf-capability-lambda`) currently blocks for up to 30 seconds
polling the database for `skill_axis` embeddings before returning a result. When the embeddings
processor hasn't finished in time, the Lambda times out and the frontend shows a generic error
with no recovery path.

The fix has three coordinated parts:

1. **`cwf-embeddings-processor`** — after writing each `skill_axis` embedding, broadcast a
   WebSocket progress event so clients know work is happening.
2. **`cwf-capability-lambda`** — replace the blocking `ensurePerAxisEmbeddings` poll with an
   immediate HTTP 202 response when embeddings are not yet ready.
3. **`CapabilityAssessment` frontend** — handle the 202 state by showing a progress indicator,
   subscribing to the new WebSocket events, and auto-retrying when all embeddings are complete.

---

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — `skill_axis` embeddings are absent
  from `unified_embeddings` when the capability assessment is requested.
- **Property (P)**: The desired behavior when C holds — return HTTP 202 immediately and deliver
  real-time progress via WebSocket until embeddings are ready, then auto-load the assessment.
- **Preservation**: All existing behavior for requests where embeddings already exist (HTTP 200
  cache-hit or fresh Bedrock computation) must remain unchanged.
- **`ensurePerAxisEmbeddings`**: The function in `lambda/capability/index.js` that currently
  queues SQS messages and polls the DB up to 4 times (3 s, 6 s, 9 s, 12 s). This is the code
  being removed.
- **`broadcastInvalidation`**: The shared utility in
  `lambda/layers/cwf-common-nodejs/nodejs/broadcastInvalidation.js` that fans out WebSocket
  messages to all active connections in an organization. It hardcodes `type: 'cache:invalidate'`
  and writes to `entity_changes`, so a sibling function `broadcastEmbeddingEvent` will be added
  to the same file for the new event types.
- **`useWebSocket.subscribe`**: The hook method that registers a typed message handler and returns
  an unsubscribe function — the same pattern used by `useCacheInvalidation`.
- **`axes_complete` / `axes_total`**: Progress counters carried in the
  `embeddings:skill_axis_ready` payload. `axes_total` is determined by counting existing
  `skill_axis` rows for the action in `unified_embeddings` after each write.

---

## Bug Details

### Bug Condition

The bug manifests when a user opens the capability assessment immediately after a skill profile
is approved and `cwf-embeddings-processor` has not yet written all `skill_axis` rows to
`unified_embeddings`. The `ensurePerAxisEmbeddings` function queues SQS messages and then polls
the database with increasing waits (3 s, 6 s, 9 s, 12 s = 30 s total). If the processor hasn't
finished within that window, the Lambda throws and returns a 504 Gateway Timeout.

**Formal Specification:**

```
FUNCTION isBugCondition(request)
  INPUT: request — GET /api/capability/:actionId
  OUTPUT: boolean

  existingRows := COUNT(unified_embeddings
                        WHERE entity_type = 'skill_axis'
                          AND action_id = request.actionId
                          AND organization_id = request.organizationId)

  RETURN existingRows = 0
         AND skillProfile.approved_at IS NOT NULL
END FUNCTION
```

### Examples

- **Bug manifests**: User approves a skill profile with 3 axes, then immediately opens the
  capability tab. The processor is still running. `ensurePerAxisEmbeddings` polls 4 times over
  30 s, finds 0 rows each time, throws `"Skill axis embeddings could not be generated"`, and the
  Lambda returns 504. Frontend shows "Unable to load target growth areas."
- **Bug manifests (partial)**: 1 of 3 axes has been written when the capability request arrives.
  The poll finds `count < expectedCount` on every attempt and still times out.
- **Bug does NOT manifest**: All 3 axes are already in `unified_embeddings` when the request
  arrives. `ensurePerAxisEmbeddings` returns immediately and the assessment loads normally.
- **Edge case**: `WS_API_ENDPOINT` is not configured in the embeddings processor. The embedding
  write still succeeds; the broadcast is skipped silently (graceful degradation, same as the
  existing `broadcastInvalidation` pattern).

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- When `skill_axis` embeddings already exist, `GET /api/capability/:actionId` SHALL continue to
  return HTTP 200 with the full capability profile (cache hit or fresh Bedrock computation path
  is completely unaffected — `ensurePerAxisEmbeddings` is only called on the miss path).
- When the action has no approved skill profile, the Lambda SHALL continue to return HTTP 404.
- When the action does not exist, the Lambda SHALL continue to return HTTP 404.
- When `cwf-embeddings-processor` processes any non-`skill_axis` entity type (part, tool, action,
  state, etc.), it SHALL continue to write embeddings without broadcasting any WebSocket messages.
- When `broadcastInvalidation` is called by other Lambdas for `cache:invalidate` messages, it
  SHALL continue to function without modification.
- When the frontend capability query returns HTTP 200, it SHALL continue to render the radar
  chart, gap checklist, and learning objectives sections as before.
- The `?force=true` rescore path is unaffected — it only runs when embeddings already exist
  (the cache-first block runs before the embeddings check).

**Scope:**
All inputs where `isBugCondition` returns false are completely unaffected by this fix.

---

## Hypothesized Root Cause

The root cause is architectural, not a coding error:

1. **Synchronous dependency on an asynchronous pipeline**: The capability Lambda assumes it can
   wait for the embeddings processor to finish within its own execution window. The Lambda timeout
   is 30 s; the SQS processor can take longer under load.

2. **No feedback channel**: The embeddings processor writes to the database but has no mechanism
   to notify waiting clients. The only option was polling, which is bounded by the Lambda timeout.

3. **No graceful degradation**: When the poll exhausts its attempts, the Lambda throws rather
   than returning a structured "not ready yet" response that the frontend could handle.

---

## Correctness Properties

Property 1: Bug Condition — Non-blocking 202 with WebSocket progress

_For any_ request where `isBugCondition` returns true (embeddings absent, skill profile
approved), the fixed `handleIndividualCapability` function SHALL return HTTP 202 with
`{ status: 'embeddings_pending', action_id }` immediately, and `cwf-embeddings-processor`
SHALL subsequently broadcast `embeddings:skill_axis_ready` for each axis written and
`embeddings:skill_axis_complete` when all axes are done, causing the frontend to auto-retry
and load the assessment without user intervention.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

Property 2: Preservation — Existing 200 path unchanged

_For any_ request where `isBugCondition` returns false (embeddings already exist), the fixed
`handleIndividualCapability` function SHALL produce exactly the same result as the original
function — HTTP 200 with the full capability profile — preserving all cache-hit, cache-miss,
cache-stale, and force-rescore behaviors.

**Validates: Requirements 3.1, 3.2, 3.3, 3.6**

---

## Fix Implementation

### Part 1 — `cwf-embeddings-processor` (`lambda/embeddings-processor/index.js`)

#### Changes Required

**Add `broadcastEmbeddingEvent` to the shared layer**

File: `lambda/layers/cwf-common-nodejs/nodejs/broadcastInvalidation.js`

Add a new exported function alongside the existing `broadcastInvalidation`. It reuses the same
`ApiGatewayManagementApiClient` fan-out pattern but sends a caller-supplied `type` and `payload`
instead of the hardcoded `cache:invalidate` shape. It does NOT write to `entity_changes` (these
are transient progress events, not persistent cache invalidations).

```
FUNCTION broadcastEmbeddingEvent({ type, payload, organizationId })
  IF WS_API_ENDPOINT not set THEN RETURN  // graceful degradation

  connections := SELECT connection_id FROM websocket_connections
                 WHERE organization_id = organizationId
                   AND disconnected_at IS NULL

  message := JSON { type, payload, timestamp: NOW() }

  FOR EACH connection IN connections DO
    PostToConnection(connection_id, message)
    ON 410 GoneException → mark connection disconnected
  END FOR
END FUNCTION
```

**Signature:**
```javascript
async function broadcastEmbeddingEvent({ type, payload, organizationId })
```

No `excludeConnectionId` parameter — embedding events are broadcast to all connections including
the one that triggered the approval (the user who approved wants to see progress too).

**Add `WS_API_ENDPOINT` env var to the processor Lambda**

The processor already reads `WRITE_TO_UNIFIED`, `WRITE_TO_INLINE`, `USE_AI_SUMMARIZATION` from
`process.env`. Add `WS_API_ENDPOINT` to the Lambda's environment variables (same value used by
other broadcasting Lambdas). The `broadcastEmbeddingEvent` function reads it internally, so no
code change is needed in the processor to pass it — just the env var configuration.

**Require `broadcastEmbeddingEvent` in the processor**

```javascript
const { broadcastEmbeddingEvent } = require('/opt/nodejs/broadcastInvalidation');
```

**Count axes after each write to determine progress**

After `writeToUnifiedTable` succeeds for a `skill_axis` entity, query `unified_embeddings` to
count existing rows for that `action_id`. This gives `axes_complete`. The processor does not
know `axes_total` from the SQS message alone (the skill profile is not in the message), so
`axes_total` is derived from the count query: after writing, count all rows; `axes_complete`
equals that count. `axes_total` is not known to the processor — it is omitted from the
`embeddings:skill_axis_ready` payload or set to `null` to avoid a second DB query.

> **Design note**: The `axes_total` field in the requirements (2.3) requires knowing the total
> number of axes. The processor does not have the skill profile. Two options:
> (a) Include `axes_total` in the SQS message (sent by the skill-profile Lambda when it queues
> the messages — it knows the profile). This is the preferred approach.
> (b) Query the DB for the skill profile on each write (expensive).
>
> **Decision**: The SQS message body already carries `action_id`, `axis_key`,
> `organization_id`, and `embedding_source`. Add `axes_total` to the SQS message payload when
> the skill-profile Lambda queues the messages. The processor reads it from the message and
> passes it through. If absent (legacy messages), default to `null`.

**Broadcast sequence in the processor handler (skill_axis path only):**

```
AFTER writeToUnifiedTable succeeds FOR entity_type = 'skill_axis':

  axesCompleteResult := SELECT COUNT(*) FROM unified_embeddings
                        WHERE entity_type = 'skill_axis'
                          AND action_id = message.action_id
                          AND organization_id = message.organization_id

  axes_complete := axesCompleteResult.count
  axes_total    := message.axes_total ?? null

  BROADCAST embeddings:skill_axis_ready {
    action_id:       message.action_id,
    axis_key:        message.axis_key,
    organization_id: message.organization_id,
    axes_complete:   axes_complete,
    axes_total:      axes_total
  }

  IF axes_total IS NOT NULL AND axes_complete >= axes_total THEN
    BROADCAST embeddings:skill_axis_complete {
      action_id:       message.action_id,
      organization_id: message.organization_id
    }
  END IF

ON ERROR during writeToUnifiedTable:
  BROADCAST embeddings:skill_axis_failed {
    action_id: message.action_id,
    axis_key:  message.axis_key,
    error:     error.message
  }
  THROW error  // preserve existing SQS retry behavior
```

The `embeddings:skill_axis_failed` broadcast happens in the existing `catch` block before
re-throwing. The re-throw is preserved so SQS retries still work.

**Note on `axes_total` in the SQS message**: The skill-profile Lambda (`cwf-skill-profile-lambda`
or equivalent) queues the SQS messages when a profile is approved. It knows the full axis list.
Add `axes_total: skillProfile.axes.length` to each SQS message body it sends. This is a
backward-compatible addition — the processor already ignores unknown fields.

---

### Part 2 — `cwf-capability-lambda` (`lambda/capability/index.js`)

#### Changes Required

**Remove `ensurePerAxisEmbeddings` call from `handleIndividualCapability`**

The current flow in `handleIndividualCapability` (after the cache-first block):

```javascript
// Ensure skill_axis embeddings exist (generates on-the-fly if missing)
await ensurePerAxisEmbeddings(db, actionId, organizationId, skillProfile);

// Always use per-axis evidence retrieval flow
const computedResponse = await handlePerAxisCapability(...);
```

Replace with an existence check that returns 202 immediately if embeddings are absent:

```javascript
// Check if skill_axis embeddings exist — if not, return 202 immediately.
// The embeddings-processor will broadcast progress via WebSocket.
const embeddingsReady = await checkSkillAxisEmbeddingsExist(db, actionId, organizationId);
if (!embeddingsReady) {
  return { statusCode: 202, body: JSON.stringify({ status: 'embeddings_pending', action_id: actionId }) };
}

// Embeddings exist — proceed with per-axis evidence retrieval
const computedResponse = await handlePerAxisCapability(...);
```

**Add `checkSkillAxisEmbeddingsExist` helper**

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

This replaces the entire `ensurePerAxisEmbeddings` function. The `ensurePerAxisEmbeddings`
function itself is deleted from `lambda/capability/index.js` (it is also exported via
`module.exports.ensurePerAxisEmbeddings` — remove that export too).

**Do NOT queue SQS messages from the capability Lambda**

The capability Lambda becomes read-only with respect to embeddings. It never triggers embedding
generation. That responsibility stays with the skill-profile Lambda (which queues messages on
approve). This satisfies requirement 3.1 and prevents double-queuing.

**`handleOrganizationCapability` — same change**

`handleOrganizationCapability` also calls `ensurePerAxisEmbeddings`. Apply the same replacement:
check existence, return 202 if absent. (The organization capability view is marked `@deprecated`
in `useCapability.ts` but the Lambda code still runs it.)

**CORS / response format**

The existing `successResponse` / `errorResponse` helpers are used for all responses. The 202
response bypasses these helpers since they don't support 202. Return a raw API Gateway response
object:

```javascript
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
```

---

### Part 3 — Frontend (`src/components/CapabilityAssessment.tsx` + `src/hooks/useCapability.ts`)

#### Changes Required

**`src/hooks/useCapability.ts` — handle 202 in `useCapabilityProfile`**

`apiService.get` throws an `ApiError` (with `.status`) for any non-`response.ok` status,
including 202. The `queryFn` must catch the 202 case and return a sentinel value instead of
letting TanStack Query treat it as an error.

Add a discriminated union return type:

```typescript
export type CapabilityQueryResult =
  | { status: 'ready'; profile: CapabilityProfile }
  | { status: 'embeddings_pending'; action_id: string };
```

Update `useCapabilityProfile` to return `CapabilityQueryResult`:

```typescript
queryFn: async (): Promise<CapabilityQueryResult> => {
  try {
    const result = await apiService.get<{ data: CapabilityProfile }>(
      `/capability/${actionId}`
    );
    return { status: 'ready', profile: result.data };
  } catch (err: any) {
    if (err?.status === 202) {
      // Embeddings not yet ready — return pending sentinel (not an error)
      return { status: 'embeddings_pending', action_id: actionId! };
    }
    throw err; // All other errors propagate normally
  }
}
```

**`src/components/CapabilityAssessment.tsx` — pending state + WebSocket subscriptions**

The component currently uses `capabilityQuery.data` directly as a `CapabilityProfile`. After
the change, `capabilityQuery.data` is a `CapabilityQueryResult`. Add a discriminated check:

```typescript
const isPending = capabilityQuery.data?.status === 'embeddings_pending';
const capabilityProfile = capabilityQuery.data?.status === 'ready'
  ? capabilityQuery.data.profile
  : null;
```

Add state for embedding progress:

```typescript
const [embeddingProgress, setEmbeddingProgress] = useState<{
  axesComplete: number;
  axesTotal: number | null;
} | null>(null);
const [embeddingError, setEmbeddingError] = useState<string | null>(null);
```

Add WebSocket subscriptions (only active when `isPending`):

```typescript
const { subscribe } = useWebSocket();

useEffect(() => {
  if (!isPending) return;

  const unsubReady = subscribe('embeddings:skill_axis_ready', (payload: any) => {
    if (payload.action_id !== action.id) return;
    setEmbeddingProgress({
      axesComplete: payload.axes_complete,
      axesTotal: payload.axes_total ?? null,
    });
  });

  const unsubComplete = subscribe('embeddings:skill_axis_complete', (payload: any) => {
    if (payload.action_id !== action.id) return;
    capabilityQuery.refetch();
  });

  const unsubFailed = subscribe('embeddings:skill_axis_failed', (payload: any) => {
    if (payload.action_id !== action.id) return;
    setEmbeddingError(payload.error || 'Embedding generation failed');
  });

  return () => {
    unsubReady();
    unsubComplete();
    unsubFailed();
  };
}, [isPending, action.id, subscribe, capabilityQuery]);
```

Add a pending render branch (before the existing loading/error/success branches):

```tsx
// --- Embeddings pending state ---
if (isPending) {
  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-3">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm font-medium text-foreground">Preparing skill analysis…</p>
      {embeddingProgress && (
        <p className="text-xs text-muted-foreground">
          {embeddingProgress.axesTotal
            ? `${embeddingProgress.axesComplete} of ${embeddingProgress.axesTotal} axes ready`
            : `${embeddingProgress.axesComplete} axes ready`}
        </p>
      )}
      {embeddingError && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-xs text-destructive">{embeddingError}</p>
          <Button variant="outline" size="sm" onClick={() => {
            setEmbeddingError(null);
            capabilityQuery.refetch();
          }}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
```

**Existing `capabilityProfiles` memo** — update to use `capabilityProfile` (the unwrapped value):

```typescript
const capabilityProfiles = useMemo(
  () => (capabilityProfile ? [capabilityProfile] : []),
  [capabilityProfile]
);
```

All downstream code (`SkillRadialChart`, `PersonGapChecklist`, etc.) continues to receive
`CapabilityProfile[]` unchanged.

---

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that
demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing
behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm
or refute the root cause analysis.

**Test Plan**: Write unit tests for `handleIndividualCapability` that mock the DB to return zero
`skill_axis` rows. Run these tests against the UNFIXED code to observe the 504 timeout behavior.

**Test Cases**:

1. **Zero embeddings test**: Mock DB returns 0 rows for `skill_axis` query. On unfixed code,
   `ensurePerAxisEmbeddings` queues SQS messages and polls 4 times, then throws
   `"Skill axis embeddings could not be generated"` → Lambda returns 500/504.
   (Will fail on unfixed code — confirms the bug.)

2. **Partial embeddings test**: Mock DB returns 1 of 3 expected rows. On unfixed code, the poll
   never reaches `expectedCount` and throws. (Will fail on unfixed code.)

3. **SQS queue failure test**: Mock SQS `SendMessageCommand` to throw. On unfixed code,
   `ensurePerAxisEmbeddings` swallows the SQS error (it's in a `.catch`) but still polls and
   times out. (Will fail on unfixed code.)

**Expected Counterexamples**:
- `ensurePerAxisEmbeddings` throws `"Skill axis embeddings could not be generated"` after 4 poll
  attempts when DB returns 0 rows.
- Possible causes: SQS processing lag, Lambda cold start, high queue depth.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function returns
HTTP 202 immediately.

**Pseudocode:**

```
FOR ALL request WHERE isBugCondition(request) DO
  result := handleIndividualCapability_fixed(request)
  ASSERT result.statusCode = 202
  ASSERT JSON.parse(result.body).status = 'embeddings_pending'
  ASSERT JSON.parse(result.body).action_id = request.actionId
END FOR
```

**Test Cases**:

1. **202 on zero embeddings**: Mock DB returns 0 `skill_axis` rows → assert response is 202
   with `{ status: 'embeddings_pending', action_id }`. Assert no SQS calls are made.
2. **202 on partial embeddings**: Mock DB returns 1 of 3 rows → same 202 assertion.
3. **Processor broadcasts `skill_axis_ready`**: Mock `broadcastEmbeddingEvent` and verify it is
   called with correct payload after `writeToUnifiedTable` succeeds for a `skill_axis` entity.
4. **Processor broadcasts `skill_axis_complete`**: When `axes_complete >= axes_total`, verify
   `embeddings:skill_axis_complete` is broadcast.
5. **Processor broadcasts `skill_axis_failed`**: When `writeToUnifiedTable` throws, verify
   `embeddings:skill_axis_failed` is broadcast before re-throwing.

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold (embeddings exist),
the fixed function produces the same result as the original function.

**Pseudocode:**

```
FOR ALL request WHERE NOT isBugCondition(request) DO
  ASSERT handleIndividualCapability_original(request)
       = handleIndividualCapability_fixed(request)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for requests where embeddings exist, then
write property-based tests capturing that behavior.

**Test Cases**:

1. **200 cache hit preserved**: Mock DB returns existing `skill_axis` rows AND a valid cached
   profile with matching hash → assert response is 200 with full profile. Assert Bedrock is NOT
   called.
2. **200 cache miss preserved**: Mock DB returns existing `skill_axis` rows, no cached profile
   → assert Bedrock IS called and response is 200.
3. **200 force rescore preserved**: `?force=true` with existing embeddings → assert Bedrock IS
   called regardless of cache.
4. **404 no skill profile preserved**: `skillProfile.approved_at` is null → assert 404.
5. **404 action not found preserved**: DB returns no action row → assert 404.
6. **Non-skill_axis processor messages unchanged**: Send a `part` entity through the processor
   → assert `broadcastEmbeddingEvent` is NOT called.
7. **`WS_API_ENDPOINT` absent — graceful degradation**: Unset env var, process a `skill_axis`
   message → assert embedding is written successfully, no error thrown.

### Unit Tests

- Test `checkSkillAxisEmbeddingsExist` returns `true` when rows exist, `false` when none.
- Test `handleIndividualCapability` returns 202 when `checkSkillAxisEmbeddingsExist` returns
  `false`.
- Test `broadcastEmbeddingEvent` fans out to all active connections for the organization.
- Test `broadcastEmbeddingEvent` marks stale connections (410) as disconnected.
- Test `broadcastEmbeddingEvent` returns silently when `WS_API_ENDPOINT` is not set.
- Test `useCapabilityProfile` `queryFn` returns `{ status: 'embeddings_pending' }` when
  `apiService.get` throws with `status: 202`.
- Test `useCapabilityProfile` `queryFn` re-throws errors with status other than 202.

### Property-Based Tests

- Generate random `action_id` / `organization_id` pairs and verify that when `skill_axis` rows
  exist in the mock DB, the capability Lambda always returns 200 (never 202).
- Generate random `skill_axis` message payloads and verify that `broadcastEmbeddingEvent` is
  called exactly once per successful write, with the correct `action_id` and `axis_key`.
- Generate random non-`skill_axis` entity types and verify `broadcastEmbeddingEvent` is never
  called.

### Integration Tests

- Full flow: approve skill profile → open capability tab → observe 202 + "Preparing skill
  analysis…" → wait for processor → observe WebSocket progress events → observe auto-refetch →
  capability assessment loads.
- Failure flow: processor fails on one axis → `embeddings:skill_axis_failed` received → error
  state with retry button shown.
- Preservation flow: capability tab opened when embeddings already exist → 200 response →
  radar chart renders immediately, no pending state shown.
