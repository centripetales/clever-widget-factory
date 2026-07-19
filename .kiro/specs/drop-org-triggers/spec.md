# Spec: Drop Organization-ID Override Triggers

## Problem

Legacy Supabase-era triggers on 15 tables unconditionally overwrite `organization_id` using a stub function `get_user_organization_id()` that always returns Stargazer Farm's ID (`00000000-0000-0000-0000-000000000001`). This breaks multi-org data isolation — any INSERT from a non-Stargazer org gets its `organization_id` silently overwritten.

## Root Cause

After migrating from Supabase to AWS, a stub function was created to prevent trigger errors. All Lambda functions now pass `organization_id` explicitly from the authorizer context, making these triggers harmful rather than helpful.

## Triggers to Remove

| # | Table | Trigger Name | Status |
|---|-------|-------------|--------|
| 1 | tools | set_organization_id_tools_trigger | Lambda passes org_id ✅ |
| 2 | issues | set_organization_id_issues_trigger | Lambda passes org_id ✅ |
| 3 | missions | set_organization_id_missions_trigger | Lambda passes org_id ✅ |
| 4 | mission_attachments | set_organization_id_mission_attachments_trigger | No active INSERT path (dead) |
| 5 | parts_history | set_organization_id_parts_history_trigger | Lambda passes org_id ✅ |
| 6 | parts_orders | set_organization_id_parts_orders_trigger | No active INSERT path (dead) |
| 7 | issue_history | set_organization_id_issue_history_trigger | Lambda passes org_id ✅ |
| 8 | issue_requirements | set_organization_id_issue_requirements_trigger | No active INSERT path (dead) |
| 9 | tool_audits | set_organization_id_tool_audits_trigger | No active INSERT path (dead) |
| 10 | action_scores | trigger_set_organization_id_action_scores | No active INSERT path (dead) |
| 11 | scoring_prompts | set_organization_id_scoring_prompts_trigger | Lambda INSERT missing org_id ⚠️ |
| 12 | storage_vicinities | set_organization_id_storage_vicinities_trigger | No active INSERT path (dead) |
| 13 | worker_attributes | set_organization_id_worker_attributes_trigger | No active INSERT path (dead) |
| 14 | worker_performance | set_organization_id_worker_performance_trigger | No active INSERT path (dead) |
| 15 | worker_strategic_attributes | set_organization_id_worker_strategic_attributes_trigger | No active INSERT path (dead) |

Note: The `parts` trigger was already dropped during initial debugging.

## Approach Per Trigger

For each trigger:
1. **Verify** the Lambda INSERT includes `organization_id` from authorizer context
2. **Fix** any INSERT that doesn't pass `organization_id` (only scoring_prompts known)
3. **Drop** the trigger
4. **Verify** no errors in existing data (spot-check existing rows have org_id set)

## Acceptance Criteria

- ✅ All 15 triggers are dropped (verified: 0 remaining org-override triggers)
- ✅ scoring_prompts INSERT fixed to include organization_id from authorizer (deployed)
- ✅ No Lambda INSERT path is left without explicit organization_id
- ✅ Existing Stargazer data remains unchanged (org_id already correct since trigger always set it to Stargazer)
- ✅ parts trigger was dropped earlier during initial debugging

## Completion Notes

- **Code change**: `lambda/core/index.js` — added `organization_id` column to scoring_prompts INSERT
- **Deployed**: via `deploy-lambda-fast.sh core cwf-core-lambda`
- **16 triggers total dropped** (15 listed + parts trigger dropped earlier)
- **9 tables** had dead triggers (no INSERT path exists in any Lambda)
- **6 tables** had active INSERT paths that already passed organization_id correctly
- **1 table** (scoring_prompts) needed a Lambda code fix before dropping
