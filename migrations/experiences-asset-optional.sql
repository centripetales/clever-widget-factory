-- An experience need not be on an asset: a write-up can stand on observations
-- and actions alone (e.g. a gypsum trial marked with a stake that isn't an
-- asset). When it is on one, both the type and the id are set.
ALTER TABLE experiences
  ALTER COLUMN entity_type DROP NOT NULL,
  ALTER COLUMN entity_id DROP NOT NULL;

ALTER TABLE experiences
  ADD CONSTRAINT experiences_entity_both_or_neither CHECK ((entity_type IS NULL) = (entity_id IS NULL));
