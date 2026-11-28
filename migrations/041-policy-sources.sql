-- A policy can rest on observations (states) and experiences: any number of
-- each, and one of them can support several policies. Each row is one source.
-- Policies are also now only 'active' or 'deprecated': something still being
-- tried is an action's own policy text, not a draft policy. This stops if a
-- draft policy exists, so that what it should become is decided first.

BEGIN;

CREATE TABLE policy_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES policy(id) ON DELETE CASCADE,
  state_id uuid REFERENCES states(id) ON DELETE CASCADE,
  experience_id uuid REFERENCES experiences(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(state_id, experience_id) = 1),
  UNIQUE (policy_id, state_id),
  UNIQUE (policy_id, experience_id)
);
CREATE INDEX policy_sources_state_idx ON policy_sources (state_id);
CREATE INDEX policy_sources_experience_idx ON policy_sources (experience_id);

ALTER TABLE policy DROP CONSTRAINT policy_status_check;
ALTER TABLE policy ADD CONSTRAINT policy_status_check CHECK (status IN ('active', 'deprecated'));
ALTER TABLE policy ALTER COLUMN status SET DEFAULT 'active';

COMMIT;
