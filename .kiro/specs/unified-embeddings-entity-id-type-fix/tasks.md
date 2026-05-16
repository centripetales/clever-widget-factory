# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Maxwell JOIN Fails Without `::uuid` Cast
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the `text = uuid` type mismatch
  - **Scoped PBT Approach**: Scope the property to the concrete failing case — `buildSubquery` for each entity type (`part`, `tool`, `action`, `issue`, `policy`, `financial_record`) must produce a JOIN condition that does NOT contain `::uuid` cast on `entity_id`
  - Import `buildSubquery` and `VALID_ENTITY_TYPES` from `lambda/maxwell-unified-search/index.js`
  - For each entity type in `['part', 'tool', 'action', 'issue', 'policy', 'financial_record']`, call `buildSubquery(entityType, "'[...]'::vector", 'org-uuid', 3)` and assert the result does NOT match `/ue\.entity_id::uuid/`
  - Run test on UNFIXED code (with `::uuid` casts present in the source)
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the cast workaround is present and the bug condition holds)
  - Document counterexamples found: e.g., `buildSubquery('part', ...)` returns `JOIN parts p ON ue.entity_id::uuid = p.id` instead of `JOIN parts p ON ue.entity_id = p.id`
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.2, 2.2_

- [~] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-`skill_axis` Embedding Upsert Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: on unfixed code, `writeToUnifiedTable` in `lambda/embeddings-processor/index.js` generates an `INSERT INTO unified_embeddings` SQL with `entity_type`, `entity_id`, `embedding_source`, `model_version`, `embedding`, `organization_id` columns and an `ON CONFLICT (entity_type, entity_id, model_version) DO UPDATE` clause
  - Observe: for entity types `part`, `tool`, `action`, `issue`, `policy`, `state`, `financial_record` — the SQL does NOT include `action_id` or `axis_key` columns
  - Write property-based test: generate random valid UUID strings as `entity_id` and random entity types from `['part', 'tool', 'action', 'issue', 'policy', 'state', 'financial_record']` — assert the generated INSERT SQL is structurally identical before and after the fix (same columns, same ON CONFLICT clause, no new columns injected for non-`skill_axis` types)
  - Write property-based test: for `skill_axis` entity type with `action_id` + `axis_key` fields present in the SQS message, assert the INSERT SQL includes `action_id` and `axis_key` columns
  - Verify both tests PASS on UNFIXED code (the non-`skill_axis` preservation test passes; the `skill_axis` new-columns test fails — document this as expected)
  - _Requirements: 3.1, 3.3, 3.4_

- [x] 3. Phase 1 — Deploy immediate unblock (Maxwell `::uuid` cast workaround)

  - [x] 3.1 Deploy `cwf-maxwell-unified-search` Lambda as-is (no code changes)
    - The `::uuid` casts are already present in `lambda/maxwell-unified-search/index.js` locally
    - This is a deployment-only step — do NOT modify any code
    - Run: `./scripts/deploy/deploy-lambda-with-layer.sh maxwell-unified-search cwf-maxwell-unified-search`
    - _Bug_Condition: isBugCondition(X) where column_type(entity_id) = 'text' AND no cast present in deployed Lambda_
    - _Expected_Behavior: Maxwell queries return HTTP 200 with results array; no `operator does not exist: text = uuid` error_
    - _Preservation: All other Lambdas and flows are completely unaffected by this deployment_
    - _Requirements: 1.1, 1.2, 2.1_

  - [x] 3.2 Verify Phase 1 unblock — end-to-end Maxwell query returns 200
    - Submit a test query to the Maxwell AI assistant from the dashboard
    - Assert HTTP 200 response with a `results` array (may be empty if no embeddings match)
    - Assert no "an error occurred communicating with Maxwell" error message
    - **Property 1: Expected Behavior** — Maxwell query succeeds with `::uuid` cast workaround deployed
    - _Requirements: 2.1_

- [x] 4. Phase 2, Step 1 — Run database migration

  - [x] 4.1 Execute migration SQL via `cwf-db-migration` Lambda
    - Run the full migration as a single transaction (see design.md Phase 2 Step 1 for exact SQL)
    - Step 1: `ALTER TABLE unified_embeddings ADD COLUMN action_id uuid NULL`
    - Step 2: `ALTER TABLE unified_embeddings ADD COLUMN axis_key text NULL`
    - Step 3: Populate `action_id` and `axis_key` for existing `skill_axis` rows using `split_part(entity_id, ':', 1)::uuid` and `split_part(entity_id, ':', 2)`
    - Step 4: Populate `action_id` for existing `action_skill_profile` rows using `entity_id::uuid`
    - Step 5: Assign new random UUIDs to `skill_axis` rows: `UPDATE unified_embeddings SET entity_id = gen_random_uuid()::text WHERE entity_type = 'skill_axis'`
    - Step 6: `ALTER TABLE unified_embeddings ALTER COLUMN entity_id TYPE uuid USING entity_id::uuid`
    - Step 7: `CREATE INDEX idx_unified_embeddings_action_id ON unified_embeddings (action_id) WHERE action_id IS NOT NULL`
    - If any non-UUID value remains in `entity_id` after step 5, the `USING entity_id::uuid` cast in step 6 will raise an error and halt — this is the data integrity guard (Requirement 3.5)
    - _Requirements: 2.2, 2.3, 3.1, 3.4, 3.5_

  - [x] 4.2 Verify migration — 28 existing `skill_axis` rows migrated correctly
    - Query: `SELECT entity_id, action_id, axis_key FROM unified_embeddings WHERE entity_type = 'skill_axis'`
    - Assert all 28 rows have a valid UUID `entity_id` (not the old composite format)
    - Assert all 28 rows have non-null `action_id` matching the UUID prefix of the original composite key
    - Assert all 28 rows have non-null `axis_key` matching the suffix of the original composite key
    - Assert `entity_id` column type is now `uuid` (not `text`)
    - _Requirements: 3.1, 3.5_

- [x] 5. Phase 2, Step 2 — Update `cwf-common-nodejs` layer (`axisUtils.js`)

  - [x] 5.1 Remove `composeAxisEntityId` and `parseAxisEntityId` from layer `axisUtils.js`
    - File: `lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js`
    - Remove the `composeAxisEntityId(actionId, axisKey)` function entirely
    - Remove the `parseAxisEntityId(entityId)` function entirely
    - Remove both from the `module.exports` object
    - Keep `composeAxisEmbeddingSource(axis, narrative)` — still needed
    - _Requirements: 2.2_

  - [x] 5.2 Remove `composeAxisEntityId` and `parseAxisEntityId` from `lambda/shared/axisUtils.js`
    - File: `lambda/shared/axisUtils.js`
    - Apply the same removals as 5.1 (this is a local mirror of the layer file)
    - _Requirements: 2.2_

  - [x] 5.3 Remove `composeAxisEntityId` and `parseAxisEntityId` from `lambda/skill-profile/axisUtils.js`
    - File: `lambda/skill-profile/axisUtils.js`
    - Apply the same removals as 5.1 (this is a local copy used by the skill-profile Lambda)
    - _Requirements: 2.2_

  - [x] 5.4 Deploy updated `cwf-common-nodejs` layer (version bump)
    - Package and publish the updated layer with the retired functions removed
    - Update the layer ARN on `cwf-skill-profile` and `cwf-capability` Lambdas (the only ones affected by the `axisUtils` change)
    - _Requirements: 2.2_

- [x] 6. Phase 2, Step 3 — Update `lambda/embeddings-processor/index.js`

  - [x] 6.1 Update `writeToUnifiedTable` to accept and store `action_id` and `axis_key` for `skill_axis` rows
    - File: `lambda/embeddings-processor/index.js`
    - Add `action_id` and `axis_key` parameters to `writeToUnifiedTable` signature
    - For `skill_axis` entity type: include `action_id` and `axis_key` in the INSERT column list and in the `ON CONFLICT DO UPDATE` SET clause
    - For all other entity types: INSERT SQL is unchanged (no new columns)
    - _Bug_Condition: isBugCondition(X) where entity_id column is text and skill_axis rows use composite keys_
    - _Expected_Behavior: skill_axis rows are stored with a generated UUID entity_id and explicit action_id + axis_key columns_
    - _Preservation: INSERT SQL for part, tool, action, issue, policy, state, financial_record entity types is structurally identical to before_
    - _Requirements: 3.3, 3.4_

  - [x] 6.2 Update `handler` to extract `action_id` and `axis_key` from SQS message and pass to `writeToUnifiedTable`
    - File: `lambda/embeddings-processor/index.js`
    - Destructure `action_id` and `axis_key` from the SQS message body alongside existing fields
    - Pass them through to `writeToUnifiedTable`
    - For `skill_axis` messages: `entity_id` will be absent from the message (processor generates a UUID via `gen_random_uuid()` in the INSERT, or uses `uuid` default)
    - _Requirements: 3.3_

  - [x] 6.3 Deploy `cwf-embeddings-processor` Lambda
    - Run: `./scripts/deploy/deploy-lambda-with-layer.sh embeddings-processor cwf-embeddings-processor`
    - _Requirements: 3.3_

- [x] 7. Phase 2, Step 4 — Update `lambda/skill-profile/index.js`

  - [x] 7.1 Update `handleApprove` — replace composite LIKE delete with `action_id`-based delete
    - File: `lambda/skill-profile/index.js`
    - Replace: `DELETE FROM unified_embeddings WHERE entity_type = 'skill_axis' AND entity_id LIKE '${actionIdPattern}'`
    - With: `DELETE FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1` (parameterized, passing `updatedAction.id`)
    - _Requirements: 2.2_

  - [x] 7.2 Update `handleApprove` — queue SQS messages with `action_id` + `axis_key` instead of composite `entity_id`
    - File: `lambda/skill-profile/index.js`
    - Remove: `const entityId = composeAxisEntityId(updatedAction.id, axis.key)`
    - Replace SQS `MessageBody` for `skill_axis` type: omit `entity_id`, add `action_id: updatedAction.id` and `axis_key: axis.key`
    - _Requirements: 2.2, 3.3_

  - [x] 7.3 Remove `composeAxisEntityId` and `parseAxisEntityId` from the import in `skill-profile/index.js`
    - File: `lambda/skill-profile/index.js`
    - Update the `require('/opt/nodejs/axisUtils')` destructure to only import `composeAxisEmbeddingSource`
    - Remove any remaining references to `composeAxisEntityId` or `parseAxisEntityId`
    - _Requirements: 2.2_

  - [x] 7.4 Deploy `cwf-skill-profile-lambda` Lambda
    - Run: `./scripts/deploy/deploy-lambda-with-layer.sh skill-profile cwf-skill-profile-lambda`
    - _Requirements: 2.2, 3.3_

- [x] 8. Phase 2, Step 5 — Update `lambda/capability/index.js`

  - [x] 8.1 Update `ensurePerAxisEmbeddings` — replace LIKE existence check with `action_id`-based query
    - File: `lambda/capability/index.js`
    - Replace: `WHERE entity_type = 'skill_axis' AND entity_id LIKE '${actionIdSafe}:%' AND organization_id = '${orgIdSafe}'`
    - With parameterized query: `WHERE entity_type = 'skill_axis' AND action_id = $1 AND organization_id = $2` (params: `[actionId, organizationId]`)
    - _Requirements: 2.2_

  - [x] 8.2 Update `ensurePerAxisEmbeddings` — queue SQS messages with `action_id` + `axis_key`
    - File: `lambda/capability/index.js`
    - Remove: `const entityId = composeAxisEntityId(actionId, axis.key)`
    - Replace SQS `MessageBody` for `skill_axis` type: omit `entity_id`, add `action_id: actionId` and `axis_key: axis.key`
    - _Requirements: 2.2, 3.3_

  - [x] 8.3 Update `ensurePerAxisEmbeddings` — replace LIKE poll query with `action_id`-based query
    - File: `lambda/capability/index.js`
    - Replace the polling `COUNT(*)` query: `WHERE entity_type = 'skill_axis' AND entity_id LIKE '${actionIdSafe}:%' AND organization_id = '${orgIdSafe}'`
    - With parameterized query: `WHERE entity_type = 'skill_axis' AND action_id = $1 AND organization_id = $2`
    - _Requirements: 2.2_

  - [x] 8.4 Update `handlePerAxisCapability` — replace composite `entity_id` lookup with `action_id + axis_key`
    - File: `lambda/capability/index.js`
    - In the per-axis vector search subquery (the `SELECT embedding FROM unified_embeddings WHERE entity_type = 'skill_axis' AND entity_id = '${axisEntityIdSafe}'` subquery)
    - Replace: `WHERE entity_type = 'skill_axis' AND entity_id = '${axisEntityIdSafe}'`
    - With parameterized: `WHERE entity_type = 'skill_axis' AND action_id = $1 AND axis_key = $2` (params: `[actionId, axis.key]`)
    - Remove: `const axisEntityId = \`${actionId}:${axis.key}\`` and `const axisEntityIdSafe = escapeLiteral(axisEntityId)` (no longer needed)
    - Apply the same change in `handleOrganizationCapability` (same pattern, same subquery)
    - _Requirements: 2.2_

  - [x] 8.5 Remove `composeAxisEntityId` import from `capability/index.js`
    - File: `lambda/capability/index.js`
    - Update the `require('/opt/nodejs/axisUtils')` destructure to only import `composeAxisEmbeddingSource`
    - _Requirements: 2.2_

  - [x] 8.6 Deploy `cwf-capability` Lambda
    - Run: `./scripts/deploy/deploy-lambda-with-layer.sh capability cwf-capability`
    - _Requirements: 2.2_

- [x] 9. Phase 2, Step 6 — Update `lambda/maxwell-unified-search/index.js`

  - [x] 9.1 Remove all `::uuid` casts from `buildSubquery` JOIN conditions
    - File: `lambda/maxwell-unified-search/index.js`
    - For each entity type case (`part`, `tool`, `action`, `issue`, `policy`, `financial_record`): replace `ue.entity_id::uuid = <table>.id` with `ue.entity_id = <table>.id`
    - The `'${safeOrgId}'::uuid` cast on `organization_id` comparisons is harmless — leave it as-is
    - _Bug_Condition: isBugCondition(X) where entity_id is text and JOIN uses no cast_
    - _Expected_Behavior: entity_id is now uuid, JOIN succeeds natively without cast, PostgreSQL can use indexes_
    - _Preservation: Query structure, result shape, and all other Lambda behavior are unchanged_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 9.2 Deploy `cwf-maxwell-unified-search` Lambda (Phase 2 version, casts removed)
    - Run: `./scripts/deploy/deploy-lambda-with-layer.sh maxwell-unified-search cwf-maxwell-unified-search`
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 9.3 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Maxwell JOIN Conditions Use No `::uuid` Cast
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 asserts `buildSubquery` output does NOT match `/ue\.entity_id::uuid/`
    - When this test passes, it confirms the `::uuid` cast has been removed and the proper fix is in place
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 9.4 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-`skill_axis` Embedding Upsert Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run the non-`skill_axis` preservation property test: assert INSERT SQL for `part`, `tool`, `action`, `issue`, `policy`, `state`, `financial_record` is structurally identical
    - Run the `skill_axis` new-columns test: assert INSERT SQL for `skill_axis` includes `action_id` and `axis_key`
    - **EXPECTED OUTCOME**: Both tests PASS (confirms no regressions)
    - _Requirements: 3.1, 3.3, 3.4_

- [~] 10. Checkpoint — Ensure all tests pass and end-to-end flows work
  - Re-run all property-based tests (tasks 1 and 2 suites) — assert all pass
  - End-to-end Maxwell query after Phase 2 deployment: assert 200 response with results array, no `::uuid` cast in generated SQL
  - Skill profile approve → capability score flow: approve a skill profile, assert `skill_axis` embeddings are created with correct `action_id` + `axis_key` columns, assert capability scoring retrieves them correctly via `action_id + axis_key` lookup
  - Verify 28 migrated `skill_axis` rows are still retrievable by the capability Lambda using the new `action_id + axis_key` query pattern
  - Ensure all tests pass; ask the user if questions arise.
