-- A financial record's action: the purchase as the thing that was done. The
-- record keeps the money (amount, vendor, items, photos); the action is what
-- experiences, rewards and Positive Sum analysis hang off. One action per
-- record. This only adds the link; actions are created for new records, and
-- for old ones, in later steps, after every place that lists or counts actions
-- hides the ones that belong to a record (financial_records.action_id).

BEGIN;

ALTER TABLE financial_records ADD COLUMN action_id uuid REFERENCES actions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX financial_records_action_idx ON financial_records (action_id) WHERE action_id IS NOT NULL;

COMMIT;
