-- A metric is a named measurable with a unit that can belong to any entity (an
-- organization, an action, a part, a state or a tool), not only a tool. Readings
-- already hang off observations (metric_snapshots), so they need no change.
-- Existing metrics become entity_type 'tool'. tool_id stays, for the code that
-- still reads metrics by tool; it is null for a metric of anything else. A
-- trigger fills the entity from tool_id, so inserts that only know tool_id
-- (the tool page, the metrics service) keep working. See the Price Models spec.

BEGIN;

ALTER TABLE metrics ADD COLUMN entity_type text;
ALTER TABLE metrics ADD COLUMN entity_id uuid;

UPDATE metrics SET entity_type = 'tool', entity_id = tool_id;

ALTER TABLE metrics ALTER COLUMN entity_type SET NOT NULL;
ALTER TABLE metrics ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE metrics ALTER COLUMN tool_id DROP NOT NULL;

ALTER TABLE metrics ADD CONSTRAINT metrics_tool_matches_entity
  CHECK (tool_id IS NULL OR (entity_type = 'tool' AND entity_id = tool_id));

CREATE INDEX metrics_entity_idx ON metrics (entity_type, entity_id);

CREATE FUNCTION metrics_entity_from_tool() RETURNS trigger AS $$
BEGIN
  IF NEW.tool_id IS NOT NULL AND NEW.entity_id IS NULL THEN
    NEW.entity_type := 'tool';
    NEW.entity_id := NEW.tool_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER metrics_entity_from_tool_trigger
  BEFORE INSERT ON metrics
  FOR EACH ROW
  EXECUTE FUNCTION metrics_entity_from_tool();

COMMIT;
