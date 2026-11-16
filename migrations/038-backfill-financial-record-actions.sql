-- Every financial record gets its action (see 037). The two records that already
-- have an action from the reward flow are linked to it, and take its other
-- organization as their vendor when they have none. All other records get a
-- completed action titled with the description (cut to 80 characters), dated the
-- transaction date and assigned to whoever recorded it (empty when nobody did),
-- as the financial-records service does for new records. The receipt's
-- observation is not linked to the action.

BEGIN;

UPDATE financial_records fr
   SET action_id = c.action_id,
       vendor_organization_id = COALESCE(fr.vendor_organization_id, c.other_org_id)
  FROM (
    SELECT (state_text::jsonb->>'financial_record_id')::uuid AS record_id,
           (state_text::jsonb->>'action_id')::uuid AS action_id,
           (state_text::jsonb->>'other_org_id')::uuid AS other_org_id
      FROM states
     WHERE state_text LIKE '{"type":"positive_sum.transaction_context"%'
  ) c
 WHERE fr.id = c.record_id
   AND fr.action_id IS NULL
   AND EXISTS (SELECT 1 FROM actions a WHERE a.id = c.action_id)
   AND (c.other_org_id IS NULL OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.other_org_id));

CREATE TEMP TABLE new_record_actions ON COMMIT DROP AS
SELECT id AS record_id, gen_random_uuid() AS action_id
  FROM financial_records
 WHERE action_id IS NULL;

INSERT INTO actions (id, organization_id, title, status, created_by, updated_by, assigned_to,
                     participants, required_tools, attachments, created_at, updated_at, completed_at)
SELECT n.action_id, fr.organization_id,
       CASE WHEN length(t.title) > 80 THEN left(t.title, 77) || '...' ELSE t.title END,
       'completed', fr.created_by, fr.created_by, fr.created_by,
       '{}'::uuid[], '{}'::text[], '{}'::text[], fr.created_at, fr.created_at, fr.transaction_date
  FROM new_record_actions n
  JOIN financial_records fr ON fr.id = n.record_id
  LEFT JOIN LATERAL (
    SELECT s.state_text
      FROM state_links sl JOIN states s ON s.id = sl.state_id
     WHERE sl.entity_type = 'financial_record' AND sl.entity_id = fr.id
     ORDER BY s.created_at, s.id LIMIT 1
  ) d ON true
  CROSS JOIN LATERAL (
    SELECT COALESCE(NULLIF(btrim(d.state_text), ''), 'Transaction ' || to_char(fr.transaction_date, 'YYYY-MM-DD')) AS title
  ) t;

UPDATE financial_records fr
   SET action_id = n.action_id
  FROM new_record_actions n
 WHERE fr.id = n.record_id;

COMMIT;
