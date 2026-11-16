-- Line items of a financial record: what was bought, as written on the receipt,
-- with quantity, unit, the line's amount and its unit price, so prices can be
-- searched (semantic search on item_text) and compared. A shared cost such as
-- delivery is its own row with no quantity. The receipt photo stays on the
-- record's observation as the evidence. The seller belongs to the transaction,
-- so a record gets one optional vendor organization that all its items share.
-- See the Price Models spec.

BEGIN;

ALTER TABLE financial_records ADD COLUMN vendor_organization_id uuid REFERENCES organizations(id);

CREATE TABLE financial_record_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_record_id uuid NOT NULL REFERENCES financial_records(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  item_text text NOT NULL,
  quantity numeric(14,4),
  unit text,
  amount numeric(12,2) NOT NULL,
  unit_price numeric(14,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX financial_record_items_record_idx ON financial_record_items (financial_record_id);
CREATE INDEX financial_record_items_org_idx ON financial_record_items (organization_id);

-- Embeddings of item_text are keyed by the item id like every other entity
-- type; unified_embeddings has no entity_type constraint to extend.
CREATE TRIGGER financial_record_items_delete_embedding
  AFTER DELETE ON financial_record_items
  FOR EACH ROW
  EXECUTE FUNCTION delete_unified_embedding('financial_record_item');

COMMIT;
