-- A vendor's catalog is parts in the vendor's organization (what they sell, in
-- their units, with their listed price in cost_per_unit). An org with no
-- people can't keep its own parts, so the org that adds one is recorded and
-- can see it: the org paid for what it learned and owns it.
-- A receipt line (financial_record_items) can point at the vendor's part it was
-- matched to. See the Price Models spec.

BEGIN;

ALTER TABLE parts ADD COLUMN created_by_organization_id uuid REFERENCES organizations(id);
CREATE INDEX parts_created_by_organization_idx ON parts (created_by_organization_id) WHERE created_by_organization_id IS NOT NULL;

ALTER TABLE financial_record_items ADD COLUMN part_id uuid REFERENCES parts(id) ON DELETE SET NULL;

COMMIT;
