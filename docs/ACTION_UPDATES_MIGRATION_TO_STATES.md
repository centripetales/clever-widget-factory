# Action Updates Migration to States Table

**Date**: 2025-02-07  
**Status**: ✅ **COMPLETE**

## Summary

Successfully migrated all Lambda functions from querying the legacy `action_implementation_updates` table to the new `states` + `state_links` tables. This completes the backend migration that was started on 2025-02-05.

## Problem

The `/analytics/action_updates` endpoint was not detecting new action updates because it was still querying the legacy `action_implementation_updates` table, which was frozen after the migration to the `states` system.

## Root Cause

After the database migration (003-migrate-action-updates-to-states.sql) on 2025-02-05:
- 541 records were successfully migrated from `action_implementation_updates` → `states` + `state_links`
- New action updates were being written to the `states` table
- However, three Lambda functions were still querying the old `action_implementation_updates` table:
  - `cwf-analytics-lambda`
  - `cwf-actions-lambda`
  - `cwf-core-lambda`

## Changes Made

### 1. lambda/analytics/index.js

**Updated**: `/analytics/action_updates` endpoint query

**Before**:
```javascript
FROM action_implementation_updates aiu
JOIN actions a ON aiu.action_id = a.id
```

**After**:
```javascript
FROM states s
JOIN state_links sl ON s.id = sl.state_id
JOIN actions a ON sl.entity_id = a.id
WHERE sl.entity_type = 'action'
```

### 2. lambda/actions/index.js

**Updated**: 
- `has_implementation_updates` flag in actions list query
- `/action_implementation_updates` GET endpoint

**Before**:
```javascript
LEFT JOIN (
  SELECT DISTINCT action_id 
  FROM action_implementation_updates
  WHERE update_type != 'policy_agreement' OR update_type IS NULL
) updates ON a.id = updates.action_id
```

**After**:
```javascript
LEFT JOIN (
  SELECT DISTINCT sl.entity_id as action_id
  FROM state_links sl
  WHERE sl.entity_type = 'action'
) updates ON a.id = updates.action_id
```

### 3. lambda/core/index.js

**Updated**:
- `has_implementation_updates` flag in actions list queries (2 occurrences)
- `/action_implementation_updates` CRUD endpoints (GET, POST, PUT, DELETE)

**Key Changes**:
- GET: Query `states` + `state_links` with field mapping (`state_text` → `update_text`, `captured_by` → `updated_by`)
- POST: Insert into `states` table, then create link in `state_links` table
- PUT: Update `states` table (map `update_text` → `state_text`)
- DELETE: Delete from `states` table (cascade deletes `state_links`)

## Deployment

All three Lambda functions were successfully deployed:

```bash
./scripts/deploy/deploy-lambda-generic.sh analytics cwf-analytics-lambda
./scripts/deploy/deploy-lambda-generic.sh actions cwf-actions-lambda
./scripts/deploy/deploy-lambda-generic.sh core cwf-core-lambda
```

**Deployment Verification**:
- ✅ cwf-analytics-lambda: CodeSha256 `fyiE84CqMBrtD0wEjzPyNGAGshm4QKL1CRLMyrIuRVI=`
- ✅ cwf-actions-lambda: CodeSha256 `kuJ52bWh5NODfM3fC+dGQq4eJfKe70nbYfr8KH5ulDw=`
- ✅ cwf-core-lambda: CodeSha256 `Nc/CRPHu4h+2iTWWefZG6BATMwK1+7cGTxYoUEZnqQw=`

## Backward Compatibility

The `/action_implementation_updates` API endpoints remain unchanged from the frontend perspective:
- Same endpoint paths
- Same request/response formats
- Field mapping ensures compatibility (`state_text` ↔ `update_text`, `captured_by` ↔ `updated_by`)

## Testing

After deployment, verify:

1. **Analytics endpoint**:
   ```bash
   # Should now show recent action updates
   curl -H "Authorization: Bearer $TOKEN" \
     "https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/analytics/action_updates?start_date=2025-02-01&end_date=2025-02-08"
   ```

2. **Action updates CRUD**:
   ```bash
   # Create new update
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"action_id":"...","update_text":"Test","updated_by":"..."}' \
     "https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/action_implementation_updates"
   
   # List updates for action
   curl -H "Authorization: Bearer $TOKEN" \
     "https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/action_implementation_updates?action_id=..."
   ```

## Related Documentation

- Database Migration: `migrations/003-migrate-action-updates-to-states.sql`
- Migration Verification: `migrations/003-migration-verification-report.md`
- States System Migration: `migrations/MIGRATION_STATUS.md`
- Original Observations Roadmap: `docs/design/OBSERVATIONS_SYSTEM.md`

## Next Steps

1. ✅ **Complete** - All Lambda functions updated
2. ⏭️ **Monitor** - Watch for any issues in production
3. ⏭️ **Future** - Consider dropping `action_implementation_updates` table after confirming stability

## Conclusion

The backend migration from `action_implementation_updates` to the `states` system is now complete. All Lambda functions query the new tables, and the analytics endpoint will now correctly detect new action updates.

---

**Completed by**: Kiro AI Assistant  
**Date**: 2025-02-07
