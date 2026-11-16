-- A policy is what an action follows (a mapping from state to action), so it
-- belongs to an organization like the actions that follow it, and an action
-- can follow several. The policy table had no organization and nothing used
-- it (no rows, no action with a policy_id), so organization_id can be required.
-- actions.policy_id is left as it is, unused; action_policies is what actions
-- follow from here.

BEGIN;

ALTER TABLE policy ADD COLUMN organization_id uuid NOT NULL REFERENCES organizations(id);
CREATE INDEX policy_organization_idx ON policy (organization_id);

CREATE TABLE action_policies (
  action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES policy(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, policy_id)
);
CREATE INDEX action_policies_policy_idx ON action_policies (policy_id);

COMMIT;
