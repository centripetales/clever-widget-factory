# TODO: Add organization_id to policy table

## Problem

The `policy` table is the only entity table missing an `organization_id` column. All other entity tables (`parts`, `tools`, `actions`, `issues`, `financial_records`) have it for multi-tenancy scoping.

Currently, policy org scoping relies on:
- `unified_embeddings.organization_id` for search
- `created_by_user_id` for indirect ownership

This is a gap — direct queries to the `policy` table cannot be filtered by organization.

## What to do

1. Add `organization_id UUID` column to `policy` table with FK to `organizations`
2. Backfill existing rows (derive from `created_by_user_id` → `organization_members`)
3. Add NOT NULL constraint after backfill
4. Update `maxwell-unified-search` policy subquery to include `po.organization_id` in the JOIN (currently omitted because the column doesn't exist)
5. Update any Lambda handlers that query `policy` directly to include org filter

## Discovered during

Maxwell Unified Search implementation — the policy JOIN in `lambda/maxwell-unified-search/index.js` had to omit the `organization_id` filter because the column doesn't exist.

## Priority

Low — unified search is safe because `unified_embeddings.organization_id` handles scoping. But this should be addressed in the next multi-tenancy refactor pass.
