# unified-embeddings-entity-id-type-fix Bugfix Design

## Overview

The `unified_embeddings.entity_id` column is typed as `text`, but every entity table it references (`parts`, `tools`, `actions`, `issues`, `policy`, `financial_records`, `states`, `state_space_models`) uses `uuid` primary keys. The `cwf-maxwell-unified-search` Lambda builds a `UNION ALL` query that JOINs `unified_embeddings.entity_id` to those primary keys, causing PostgreSQL to throw `operator does not exist: text = uuid` on every Maxwell query.

The fix has two phases:

1. **Immediate unblock** — deploy the `::uuid` cast workaround already present in `lambda/maxwell-unified-search/index.js` to restore Maxwell functionality now.
2. **Proper fix** — migrate `unified_embeddings.entity_id` from `text` to `uuid`, add `action_id` and `axis_key` columns to carry the data currently encoded in the composite `skill_axis` key, and update all Lambdas that read or write those rows.

---

## Glossary

- **Bug_Condition (C)**: `unified_embeddings.entity_id` column type is `text` while entity table primary keys are `uuid`, causing a type mismatch in JOIN conditions.
- **Property (P)**: After the fix, all JOIN conditions succeed without casting, PostgreSQL can use indexes on `entity_id`, and Maxwell returns results normally.
- **Preservation**: All existing embedding reads and writes for non-`skill_axis` entity types continue to work exactly as before.
- **Composite key**: The current `skill_axis` `entity_id` format `{action_uuid}:{axis_key}` — a text string that encodes two pieces of data and is not a valid UUID.
- **`composeAxisEntityId(actionId, axisKey)`**: Function in `axisUtils.js` (three copies: layer, `lambda/shared/`, `lambda/skill-profile/`) that produces the composite key. Retired by this fix.
- **`parseAxisEntityId(entityId)`**: Inverse of the above. Also retired.
- **`cwf-common-nodejs` layer**: Shared Lambda layer at version 24 containing `axisUtils.js`, `db.js`, and other utilities. Updating it requires redeploying all Lambdas that use it, or selectively updating only the affected ones.
- **`isBugCondition(X)`**: Returns `true` when `entity_id` column type is `text` and a JOIN to a `uuid` column is attempted.

---

## Bug Details

### Bug Condition

The bug manifests on every Maxwell query. The `cwf-maxwell-unified-search` Lambda constructs a `UNION ALL` SQL query with per-entity-type subqueries, each containing a JOIN like:

```sql
JOIN parts p ON ue.entity_id::uuid = p.id
```

The `::uuid` cast is the workaround already applied locally. Without it, PostgreSQL rejects the query because `text = uuid` has no implicit cast operator.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type SearchQuery (any Maxwell query)
  OUTPUT: boolean

  RETURN column_type(unified_embeddings.entity_id) = 'text'
         AND entity_table_pk_type = 'uuid'
         AND no explicit ::uuid cast present in JOIN condition
END FUNCTION
```

### Examples

- **Bug present, no workaround**: `SELECT ... FROM unified_embeddings ue JOIN parts p ON ue.entity_id = p.id` → `ERROR: operator does not exist: text = uuid`
- **Workaround deployed**: `SELECT ... FROM unified_embeddings ue JOIN parts p ON ue.entity_id::uuid = p.id` → succeeds, but PostgreSQL cannot use the index on `entity_id`
- **Proper fix applied**: `SELECT ... FROM unified_embeddings ue JOIN parts p ON ue.entity_id = p.id` (column is now `uuid`) → succeeds with full index support
- **`skill_axis` composite key**: `entity_id = 'a1b2c3d4-...:scientific_observation'` — not a valid UUID, must be migrated before the column type change

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- All existing embedding reads for `part`, `tool`, `action`, `issue`, `policy`, `financial_record`, `state`, `state_space_model`, and `action_skill_profile` entity types must continue to work correctly after the migration.
- The unique constraint on `(entity_type, entity_id, model_version)` must continue to enforce uniqueness after the column type change.
- The `cwf-embeddings-processor` Lambda must continue to insert and upsert embeddings for all entity types.
- Mouse-click and non-Maxwell flows (capability scoring, skill profile approval, learning objectives) must be completely unaffected.
- The `action_skill_profile` entity type stores the action UUID directly as `entity_id` — this is already a valid UUID and requires no data migration beyond the type cast.

**Scope:**

All inputs that do NOT involve the `text = uuid` JOIN mismatch are unaffected. This includes:
- Direct `entity_id` lookups by exact value (no JOIN type conflict)
- Embedding inserts and upserts via `cwf-embeddings-processor`
- Capability scoring queries that look up `skill_axis` embeddings by composite key (these will be updated to use `action_id + axis_key` columns)

---

## Hypothesized Root Cause

1. **Schema design oversight**: When `unified_embeddings` was created, `entity_id` was typed as `text` to accommodate the composite `skill_axis` key (`{uuid}:{axis_key}`). This made the column incompatible with the `uuid` primary keys of all other entity tables.

2. **Composite key anti-pattern**: The `skill_axis` entity type encodes two pieces of data (`action_id` and `axis_key`) into a single `text` column rather than using dedicated columns. This was the original reason `entity_id` could not be `uuid`.

3. **Missing cast in JOIN**: The `cwf-maxwell-unified-search` Lambda was written assuming `entity_id` would eventually be `uuid`, or the type mismatch was not caught during development because the Lambda was tested without a live DB. The `::uuid` cast workaround was added locally but never deployed.

4. **Three copies of `axisUtils.js`**: The composite key logic exists in `lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js`, `lambda/shared/axisUtils.js`, and `lambda/skill-profile/axisUtils.js`. All three must be updated to retire `composeAxisEntityId` and `parseAxisEntityId`.

---

## Correctness Properties

Property 1: Bug Condition — Maxwell Query Succeeds Without Type Cast

_For any_ Maxwell search query where `isBugCondition` holds (i.e., the query reaches the `UNION ALL` JOIN), the fixed system SHALL execute the query successfully, return HTTP 200 with a `results` array, and raise no PostgreSQL type error — without requiring any `::uuid` cast in the JOIN condition.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Non-Maxwell Embedding Behavior Unchanged

_For any_ embedding read or write operation where `isBugCondition` does NOT hold (i.e., operations that do not involve the `text = uuid` JOIN mismatch), the fixed system SHALL produce exactly the same result as the original system, preserving all existing embedding inserts, upserts, unique constraint enforcement, and capability scoring queries.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

---

## Fix Implementation

### Phase 1 — Immediate Unblock

**File**: `lambda/maxwell-unified-search/index.js`

**Action**: Deploy the file as-is (the `::uuid` casts are already present locally). No code changes needed — this is a deployment-only step.

**Deployment**: `cwf-maxwell-unified-search` Lambda only.

---

### Phase 2 — Proper Fix

#### Step 1: Database Migration

Run as a single transaction via `cwf-db-migration` Lambda:

```sql
BEGIN;

-- 1. Add new columns for skill_axis decomposition
ALTER TABLE unified_embeddings ADD COLUMN action_id uuid NULL;
ALTER TABLE unified_embeddings ADD COLUMN axis_key text NULL;

-- 2. Populate action_id and axis_key for existing skill_axis rows
--    Composite key format: '{action_uuid}:{axis_key}'
UPDATE unified_embeddings
SET
  action_id = split_part(entity_id, ':', 1)::uuid,
  axis_key  = split_part(entity_id, ':', 2)
WHERE entity_type = 'skill_axis';

-- 3. Populate action_id for existing action_skill_profile rows
--    entity_id is already a valid UUID (the action UUID)
UPDATE unified_embeddings
SET action_id = entity_id::uuid
WHERE entity_type = 'action_skill_profile';

-- 4. Assign new random UUIDs to skill_axis rows
--    (their entity_id was a composite text key, not a real UUID)
UPDATE unified_embeddings
SET entity_id = gen_random_uuid()::text
WHERE entity_type = 'skill_axis';

-- 5. Change column type to uuid
ALTER TABLE unified_embeddings
  ALTER COLUMN entity_id TYPE uuid USING entity_id::uuid;

-- 6. Add index on action_id for efficient skill_axis lookups
CREATE INDEX idx_unified_embeddings_action_id
  ON unified_embeddings (action_id)
  WHERE action_id IS NOT NULL;

COMMIT;
```

**Data integrity note**: Step 5 (`USING entity_id::uuid`) will raise an error and halt the transaction if any non-UUID value remains in `entity_id` after step 4. This satisfies requirement 3.5.

---

#### Step 2: Update `cwf-common-nodejs` Layer (`axisUtils.js`)

**File**: `lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js`

**Changes**:
- Remove `composeAxisEntityId(actionId, axisKey)` — no longer needed; `entity_id` is now a generated UUID
- Remove `parseAxisEntityId(entityId)` — no longer needed; decomposition is done via `action_id` + `axis_key` columns
- Keep `composeAxisEmbeddingSource(axis, narrative)` — still needed for embedding text composition

**Also update** the two local copies that mirror the layer:
- `lambda/shared/axisUtils.js` — same removals
- `lambda/skill-profile/axisUtils.js` — same removals

---

#### Step 3: Update `lambda/embeddings-processor/index.js`

**Changes**:
- Accept optional `action_id` and `axis_key` fields from the SQS message payload
- Pass them to `writeToUnifiedTable` for `skill_axis` rows
- Update `writeToUnifiedTable` to include `action_id` and `axis_key` in the `INSERT` and `ON CONFLICT DO UPDATE` for `skill_axis` entity type

**Specific change to `writeToUnifiedTable`**: Add conditional logic — if `entity_type = 'skill_axis'` and `action_id`/`axis_key` are present in the message, include them in the INSERT column list.

---

#### Step 4: Update `lambda/skill-profile/index.js`

**In `handleApprove`** — delete existing `skill_axis` embeddings:

```js
// Before (composite LIKE query):
await deleteDb.query(
  `DELETE FROM unified_embeddings WHERE entity_type = 'skill_axis' AND entity_id LIKE '${actionIdPattern}'`
);

// After (uses new action_id column):
await deleteDb.query(
  `DELETE FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1`,
  [updatedAction.id]
);
```

**In `handleApprove`** — queue SQS messages for axis embeddings:

```js
// Before:
const entityId = composeAxisEntityId(updatedAction.id, axis.key);
MessageBody: JSON.stringify({
  entity_type: 'skill_axis',
  entity_id: entityId,
  embedding_source: embeddingSource,
  organization_id: updatedAction.organization_id
})

// After (entity_id omitted — processor generates a UUID; action_id + axis_key carried explicitly):
MessageBody: JSON.stringify({
  entity_type: 'skill_axis',
  action_id: updatedAction.id,
  axis_key: axis.key,
  embedding_source: embeddingSource,
  organization_id: updatedAction.organization_id
})
```

**Remove import** of `composeAxisEntityId` and `parseAxisEntityId` from `axisUtils`.

---

#### Step 5: Update `lambda/capability/index.js`

**In `ensurePerAxisEmbeddings`** — check for existing embeddings:

```js
// Before (composite LIKE query):
const existingResult = await db.query(
  `SELECT entity_id FROM unified_embeddings
   WHERE entity_type = 'skill_axis'
     AND entity_id LIKE '${actionIdSafe}:%'
     AND organization_id = '${orgIdSafe}'`
);

// After:
const existingResult = await db.query(
  `SELECT entity_id FROM unified_embeddings
   WHERE entity_type = 'skill_axis'
     AND action_id = $1
     AND organization_id = $2`,
  [actionId, organizationId]
);
```

**In `ensurePerAxisEmbeddings`** — queue SQS messages: same pattern as skill-profile (use `action_id` + `axis_key`, omit composite `entity_id`).

**In `ensurePerAxisEmbeddings`** — poll for embeddings:

```js
// Before:
`SELECT COUNT(*) as cnt FROM unified_embeddings
 WHERE entity_type = 'skill_axis'
   AND entity_id LIKE '${actionIdSafe}:%'
   AND organization_id = '${orgIdSafe}'`

// After:
`SELECT COUNT(*) as cnt FROM unified_embeddings
 WHERE entity_type = 'skill_axis'
   AND action_id = $1
   AND organization_id = $2`
```

**In `handlePerAxisCapability` and `handleOrganizationCapability`** — axis embedding lookup:

```js
// Before (inline composite key construction):
const axisEntityId = `${actionId}:${axis.key}`;
const axisEntityIdSafe = escapeLiteral(axisEntityId);
// ... WHERE entity_type = 'skill_axis' AND entity_id = '${axisEntityIdSafe}'

// After:
// ... WHERE entity_type = 'skill_axis' AND action_id = $1 AND axis_key = $2
// params: [actionId, axis.key]
```

**Remove import** of `composeAxisEntityId` from `axisUtils`.

---

#### Step 6: Update `lambda/maxwell-unified-search/index.js`

**Remove all `::uuid` casts** from JOIN conditions in `buildSubquery` — they are no longer needed once `entity_id` is `uuid`:

```js
// Before:
JOIN parts p ON ue.entity_id::uuid = p.id AND p.organization_id = '${safeOrgId}'::uuid

// After:
JOIN parts p ON ue.entity_id = p.id AND p.organization_id = '${safeOrgId}'::uuid
```

Apply the same removal to all entity type cases: `tool`, `action`, `issue`, `policy`, `financial_record`.

The `'${safeOrgId}'::uuid` cast on `organization_id` comparisons is harmless and can remain (it's a string literal cast, not a column type mismatch).

---

### Deployment Order

1. **Deploy DB migration** — adds `action_id`/`axis_key` columns, migrates `skill_axis` data, changes `entity_id` to `uuid`
2. **Deploy updated `cwf-common-nodejs` layer** (version 25) — removes retired `axisUtils` functions
3. **Deploy `cwf-embeddings-processor`** — accepts `action_id`/`axis_key` from SQS messages
4. **Deploy `cwf-skill-profile-lambda`** — writes new fields, uses `action_id`-based delete query
5. **Deploy `cwf-capability`** — uses `action_id + axis_key` for all `skill_axis` lookups
6. **Deploy `cwf-maxwell-unified-search`** — removes `::uuid` casts (now unnecessary)

> **Note on layer deployment**: Deploying a new `cwf-common-nodejs` layer version requires updating the layer ARN on every Lambda that uses it, or selectively updating only the Lambdas affected by the `axisUtils` change (`cwf-skill-profile-lambda`, `cwf-capability`). The tasks phase will specify the exact approach.

---

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis.

**Test Plan**: Write a unit test for `buildSubquery` that constructs the SQL for each entity type and asserts the JOIN condition does NOT contain `::uuid` cast (verifying the post-fix state), then run the same test against the pre-fix code to observe the failure. Separately, write an integration test that fires a real Maxwell query against the unfixed Lambda and asserts the `operator does not exist` error is returned.

**Test Cases**:

1. **Maxwell query on unfixed code**: Submit any query to `cwf-maxwell-unified-search` without the `::uuid` cast — expect `operator does not exist: text = uuid` (will fail on unfixed code)
2. **`buildSubquery` JOIN condition test**: Assert that the generated SQL for `part` type contains `ue.entity_id = p.id` (no cast) — will fail on unfixed code
3. **`skill_axis` composite key migration**: Assert that after migration, all `skill_axis` rows have a valid UUID `entity_id` and non-null `action_id` + `axis_key` — will fail before migration
4. **Non-UUID value guard**: Insert a row with `entity_id = 'not-a-uuid'` and assert the migration halts with an error — verifies requirement 3.5

**Expected Counterexamples**:
- Maxwell returns 500 with `operator does not exist: text = uuid` on every query
- `skill_axis` rows with composite keys like `a1b2c3d4-...:scientific_observation` cause the `USING entity_id::uuid` cast to fail if not pre-migrated

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  result := cwfMaxwellUnifiedSearch_fixed(X)
  ASSERT result.httpStatusCode = 200
         AND result.results IS ARRAY
         AND no PostgreSQL type error raised
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed system produces the same result as the original.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT embeddings_processor_original(X) = embeddings_processor_fixed(X)
  ASSERT capability_original(X) = capability_fixed(X)
  ASSERT skill_profile_original(X) = skill_profile_fixed(X)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many random `entity_id` values (valid UUIDs) and verifies the upsert logic is unchanged
- It catches edge cases in the `action_id`/`axis_key` column population logic
- It provides strong guarantees that non-`skill_axis` entity types are completely unaffected

**Test Plan**: Observe behavior on UNFIXED code first for embedding inserts and capability queries, then write property-based tests capturing that behavior.

**Test Cases**:

1. **Embedding upsert preservation**: Generate random valid UUID `entity_id` values for `part`, `tool`, `action`, `issue`, `policy` entity types and verify the upsert SQL is identical before and after the fix
2. **Unique constraint preservation**: Verify that inserting a duplicate `(entity_type, entity_id, model_version)` still triggers `ON CONFLICT DO UPDATE` after the column type change
3. **`skill_axis` lookup by `action_id + axis_key`**: Verify that after migration, querying `WHERE action_id = $1 AND axis_key = $2` returns the same embedding that was previously found via `WHERE entity_id = '${actionId}:${axisKey}'`
4. **`action_skill_profile` lookup preservation**: Verify that `action_skill_profile` rows (whose `entity_id` was already a valid UUID) are retrievable by the same UUID after migration

### Unit Tests

- Test `buildSubquery` for each entity type: assert JOIN uses `ue.entity_id = p.id` (no cast) after fix
- Test `writeToUnifiedTable` in embeddings-processor: assert `action_id` and `axis_key` are included in INSERT for `skill_axis` entity type
- Test `ensurePerAxisEmbeddings` in capability: assert it uses `action_id = $1` query instead of `LIKE` pattern
- Test migration SQL in isolation: verify `split_part` correctly decomposes `{uuid}:{axis_key}` composite keys

### Property-Based Tests

- Generate random valid UUID strings and verify `writeToUnifiedTable` produces identical SQL before and after the fix (preservation of non-`skill_axis` paths)
- Generate random `(actionId, axisKey)` pairs and verify that the new `action_id + axis_key` lookup returns the same row as the old composite `entity_id` lookup
- Generate random `skill_axis` SQS messages with `action_id` + `axis_key` fields and verify the processor stores them correctly in the new columns

### Integration Tests

- End-to-end Maxwell query after Phase 1 deployment: assert 200 response with results array
- End-to-end Maxwell query after Phase 2 deployment: assert 200 response, no `::uuid` cast in generated SQL
- Skill profile approve → capability score flow: assert `skill_axis` embeddings are created with correct `action_id` + `axis_key` and are retrievable by the capability Lambda
- Verify 28 existing `skill_axis` rows are correctly migrated: `action_id` matches the UUID prefix, `axis_key` matches the suffix, new `entity_id` is a valid UUID
