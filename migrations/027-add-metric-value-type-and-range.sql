-- A metric can now be a number (optionally bounded by a range) or free text.
--
-- number: a measurement; min_value/max_value bound it (e.g. Ammonia Smell
--   Strength 0-5, Coverage % 0-100), which validates entry and fixes the
--   chart axis.
-- text: presence of a written observation (e.g. "Estrus Signs" = "tail
--   flicking, discharge"). A blank entry stores no snapshot, so "no snapshot"
--   means nothing was seen.
--
-- Existing metrics are all numeric, so 'number' is the value they get here.

BEGIN;

ALTER TABLE metrics ADD COLUMN IF NOT EXISTS value_type TEXT NOT NULL DEFAULT 'number';
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS min_value NUMERIC;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS max_value NUMERIC;

ALTER TABLE metrics ADD CONSTRAINT metrics_value_type_check CHECK (value_type IN ('number', 'text'));
ALTER TABLE metrics ADD CONSTRAINT metrics_range_check CHECK (
  (min_value IS NULL AND max_value IS NULL)
  OR (value_type = 'number' AND (min_value IS NULL OR max_value IS NULL OR min_value <= max_value))
);

-- Coverage % is always 0-100 (the chart used to special-case it by name).
UPDATE metrics SET min_value = 0, max_value = 100 WHERE name = 'Coverage %';

COMMIT;
