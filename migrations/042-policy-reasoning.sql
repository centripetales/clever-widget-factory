-- The reasoning behind a policy, kept apart from what to do and when: the text
-- is what gets search data, the reasoning is not. The fueling policy's
-- "Purpose" paragraph is its reasoning, so it moves there in its own words; it
-- moves only while the policy still reads exactly as it did.

BEGIN;

ALTER TABLE policy ADD COLUMN reasoning text;

UPDATE policy
   SET description_text = E'1. Purchase a full tank\n2. Take pictures of the odometer, receipt and gas pump.',
       reasoning = 'Collect the data so we can track km/l which tells us if there are vehicle issues. Km/l also can help establish if our vehicle runs differently on different gas.',
       updated_at = NOW()
 WHERE id = 'ea42a70a-9e1a-42b2-9bd2-d25579631fd5'
   AND description_text = E'1. Purchase a full tank\n2. Take pictures of the odometer, receipt and gas pump.\n\nPurpose:\nCollect the data so we can track km/l which tells us if there are vehicle issues. Km/l also can help establish if our vehicle runs differently on different gas.';

COMMIT;
