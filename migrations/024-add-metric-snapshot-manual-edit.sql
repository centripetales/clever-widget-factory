-- Lets a person correct a metric_snapshots.value by hand (starting with
-- Coverage %, edited by the observation's owner from GroupCoverageGrid) and
-- have that correction survive the next automated rewrite. Without this,
-- scripts/azolla-wire-coverage-metric.js's ON CONFLICT ... DO UPDATE
-- unconditionally overwrites every state's value with the AI-computed one
-- on every rerun, silently clobbering any manual fix.

BEGIN;

ALTER TABLE metric_snapshots ADD COLUMN edited_by uuid;
ALTER TABLE metric_snapshots ADD COLUMN edited_at timestamptz;

COMMIT;
