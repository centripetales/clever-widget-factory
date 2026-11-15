-- A line on a receipt is a Purchase: an actual price paid, not an abstract item.
-- Renames the table, its text column, its indexes, constraints and trigger, and
-- the embeddings keyed by its rows (entity_type), so the name is the same
-- everywhere. Deploy the financial-records, embeddings-processor and MCP server
-- lambdas right after applying; until then they still use the old names.

BEGIN;

ALTER TABLE financial_record_items RENAME TO financial_record_purchases;
ALTER TABLE financial_record_purchases RENAME COLUMN item_text TO purchase_text;

ALTER INDEX financial_record_items_pkey RENAME TO financial_record_purchases_pkey;
ALTER INDEX financial_record_items_record_idx RENAME TO financial_record_purchases_record_idx;
ALTER INDEX financial_record_items_org_idx RENAME TO financial_record_purchases_org_idx;
ALTER TABLE financial_record_purchases RENAME CONSTRAINT financial_record_items_financial_record_id_fkey TO financial_record_purchases_financial_record_id_fkey;
ALTER TABLE financial_record_purchases RENAME CONSTRAINT financial_record_items_organization_id_fkey TO financial_record_purchases_organization_id_fkey;
ALTER TABLE financial_record_purchases RENAME CONSTRAINT financial_record_items_part_id_fkey TO financial_record_purchases_part_id_fkey;

-- The delete trigger removes a purchase's embedding by its entity type
DROP TRIGGER financial_record_items_delete_embedding ON financial_record_purchases;
CREATE TRIGGER financial_record_purchases_delete_embedding
  AFTER DELETE ON financial_record_purchases
  FOR EACH ROW
  EXECUTE FUNCTION delete_unified_embedding('financial_record_purchase');

UPDATE unified_embeddings SET entity_type = 'financial_record_purchase' WHERE entity_type = 'financial_record_item';

COMMIT;
