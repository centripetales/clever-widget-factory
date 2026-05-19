# Embeddings Type Mismatch - Phase 2 Implementation Plan

**Issue**: Embeddings have not been searchable since May 10, 2026 due to `unified_embeddings.entity_id` column type mismatch  
**Root Cause**: Column typed as TEXT to accommodate composite `skill_axis` keys, causing PostgreSQL `text = uuid` errors in JOINs  
**Solution**: Properly decompose composite keys and migrate `entity_id` to UUID  
**Status**: Ready for implementation

---

## Problem Statement

The `unified_embeddings` table was created with `entity_id` as TEXT to support composite keys for `skill_axis` entity type (format: `{action_uuid}:{axis_key}`). This single design decision broke the entire architecture:

```sql
-- Current (broken)
unified_embeddings.entity_id :: TEXT
parts.id :: UUID
tools.id :: UUID
actions.id :: UUID
states.id :: UUID
... all entity tables use UUID

-- JOIN fails with: ERROR: operator does not exist: uuid = text
JOIN parts p ON ue.entity_id = p.id
```

The composite key anti-pattern violates the architectural principle: **"UUID everywhere"** — that was already decided at the time of the Transferable Learning spec.

---

## Solution: Phase 2 - Proper Schema Migration

### What Phase 2 Does

1. **Decomposes composite keys** - Replaces `{action_uuid}:{axis_key}` with separate columns
2. **Fixes column type** - Changes `entity_id` from TEXT to UUID
3. **Restores index efficiency** - Eliminates need for type casts in JOINs
4. **Updates all code** - Already done (see verification below)

### Implementation Steps

#### Step 1: Run Database Migration

Execute the migration via `cwf-db-migration` Lambda:

```bash
# Read the migration file
cat migrations/001-fix-unified-embeddings-entity-id-type.sql

# Execute it (trigger the Lambda with the SQL)
# OR run directly in psql if you have access
```

**What the migration does:**
- Adds `action_id` (UUID) and `axis_key` (TEXT) columns
- Parses existing `skill_axis` composite keys into separate columns
- Generates new UUIDs for `skill_axis` rows
- Converts `entity_id` column type from TEXT to UUID
- Creates partial unique index on `(entity_type, action_id, axis_key)` for `skill_axis` rows

**Data integrity guards:**
- Transaction rolls back if any non-UUID values remain in `entity_id`
- No data loss — all existing embeddings are preserved with new structure

#### Step 2: Verify Migration

After the migration completes:

```sql
-- Check skill_axis rows have proper structure
SELECT 
  entity_id,           -- Now UUID, not TEXT
  action_id,           -- Populated for skill_axis
  axis_key,            -- Populated for skill_axis
  entity_type
FROM unified_embeddings
WHERE entity_type = 'skill_axis'
LIMIT 5;

-- Verify entity_id column type
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'unified_embeddings' 
  AND column_name = 'entity_id';
-- Expected: uuid
```

#### Step 3: Deploy Lambdas (In Order)

All Lambdas are already coded correctly, just need deployment:

```bash
# 1. maxwell-unified-search - No type casts needed now
./scripts/deploy/deploy-lambda-with-layer.sh maxwell-unified-search cwf-maxwell-unified-search

# 2. embeddings-processor - Already handles action_id + axis_key correctly
./scripts/deploy/deploy-lambda-with-layer.sh embeddings-processor cwf-embeddings-processor

# 3. skill-profile - Already queues with separate columns
./scripts/deploy/deploy-lambda-with-layer.sh skill-profile cwf-skill-profile-lambda

# 4. capability - Already queries with action_id + axis_key
./scripts/deploy/deploy-lambda-with-layer.sh capability cwf-capability-lambda
```

#### Step 4: Test End-to-End

1. **Test Maxwell search:**
   - Open Maxwell AI assistant
   - Submit a search query
   - Expected: HTTP 200 with results array
   - No "operator does not exist" errors in logs

2. **Test skill profile approval:**
   - Approve a new skill profile
   - Verify skill_axis embeddings are generated
   - Check `unified_embeddings` has new rows with populated `action_id` and `axis_key`

3. **Test capability assessment:**
   - Open capability assessment
   - Per-axis evidence should display
   - No SQL errors in CloudWatch logs

---

## Code Status: Already Ready

All code changes have already been implemented:

- ✅ **embeddings-processor** - `writeToUnifiedTable` handles `action_id` + `axis_key` for `skill_axis`
- ✅ **skill-profile** - Deletes skill_axis embeddings by `action_id`, queues with separate columns
- ✅ **capability** - Queries skill_axis embeddings by `action_id` + `axis_key`
- ✅ **maxwell-unified-search** - JOIN conditions are clean (ready for UUID comparison)
- ✅ **axisUtils** - Composite key functions already removed, only `composeAxisEmbeddingSource` remains

**Why it's ready**: The Transferable Learning spec implemented the *proper* architecture from the start, then Phase 1 (database migration) was designed but never deployed. The code is correct; only the schema needs updating.

---

## Why This Is The Right Fix

**Vs. Phase 1 Workaround (::uuid casts):**
- ❌ Hides the problem with temporary casts
- ❌ Prevents index usage (every row is cast before comparison)
- ❌ Creates technical debt for future migrations
- ❌ Doesn't solve the root architectural issue

**Vs. Creating New `skill_axis` Tables:**
- ❌ Would fragment the embeddings data across multiple tables
- ❌ Makes unified search impossible
- ❌ Adds complexity (separate queries per entity type)

**Phase 2 (This Plan):**
- ✅ Restores original architectural intent (UUID everywhere)
- ✅ Enables efficient indexes
- ✅ Eliminates type mismatch errors
- ✅ All code already implements this model
- ✅ One-transaction migration (atomic, safe rollback)

---

## Rollback Plan

If the migration fails at Step 5 (type conversion):
1. The transaction will automatically roll back
2. No data is lost
3. `entity_id` remains TEXT
4. All columns (`action_id`, `axis_key`) are rolled back

If deployment fails:
1. Revert Lambda deployments to previous versions
2. Code is backward compatible (old and new code both work with the schema during transition)

---

## Post-Implementation Checklist

- [ ] Migration executed successfully
- [ ] `entity_id` column type verified as UUID
- [ ] 28+ existing `skill_axis` rows have populated `action_id` and `axis_key`
- [ ] All 4 Lambdas deployed
- [ ] Maxwell search test passes (HTTP 200, no type errors)
- [ ] Skill profile approval generates embeddings
- [ ] Capability assessment displays per-axis evidence
- [ ] CloudWatch logs show no "operator does not exist" errors
- [ ] Update README/docs to reflect Phase 2 completion
- [ ] Archive this document in COMPLETED_MIGRATIONS or similar

---

## References

- **Design**: `.kiro/specs/unified-embeddings-entity-id-type-fix/design.md`
- **Tasks**: `.kiro/specs/unified-embeddings-entity-id-type-fix/tasks.md`
- **Migration SQL**: `migrations/001-fix-unified-embeddings-entity-id-type.sql`
- **Investigation Results**: `investigate_results.txt`, `investigate.js` (historical)
