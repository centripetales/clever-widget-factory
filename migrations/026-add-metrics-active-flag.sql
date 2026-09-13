-- Lets a metric definition be disabled without deleting it or its history.
-- Needed for experimental metrics (e.g. trying out a second measurement
-- method for the same quantity, like an IR thermometer alongside an
-- existing probe thermometer) that shouldn't clutter observation forms or
-- charts once the experiment is done, but whose past readings should stay
-- recoverable by re-enabling the metric.

BEGIN;

ALTER TABLE metrics ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
