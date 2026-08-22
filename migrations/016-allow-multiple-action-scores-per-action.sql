BEGIN;

-- action_scores previously allowed exactly one row per action
-- (UNIQUE(action_id)), meaning re-scoring meant UPDATE-in-place and lost
-- the trail of how a score evolved. For Azolla Impact's power scoring
-- (docs/specs/azolla-impact-power-model.md), impact is explicitly
-- retrospective and revisable — a diagnostic tip's actual impact may only
-- be knowable once the recipient's outcome plays out. Scoring needs to be
-- able to run again later as evidence accumulates, as a new row, not an
-- overwrite, so the evolution stays visible (most recent row = current,
-- same pattern already used by state_perspectives for multiple rows over
-- time per state).
ALTER TABLE action_scores DROP CONSTRAINT action_scores_action_id_unique;

COMMIT;
