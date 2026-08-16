BEGIN;

-- Child table for the AZOLLA_STATE perspective: an objective-specific
-- synthesis of a single state's growing-context (coverage, water/vessel
-- condition, nutrient estimates), scoped to azolla growing conditions
-- specifically, not a general-purpose state-synthesis mechanism — see
-- docs/specs/azolla-impact-power-model.md §7 for why the narrower name
-- was chosen (same reasoning as azolla_duckweed_observation_perspectives).
-- Computed per-state (not per-pair) since experiences chain — a state's
-- context is reused as whichever endpoint (initial or final) an experience
-- needs. Built to be recomputed over time as later states recontextualize
-- earlier ones: multiple rows per state are allowed (state_perspectives
-- has no uniqueness constraint on state_id+perspective_type), ordered by
-- state_perspectives.created_at — most recent is current. Recompute is
-- manual for now (see spec); estimated fields (phosphorus, ph) must carry
-- their basis alongside them — never presented indistinguishably from a
-- measured value.
CREATE TABLE azolla_state_perspectives (
    id UUID PRIMARY KEY REFERENCES state_perspectives(id) ON DELETE CASCADE,
    coverage_percent_estimate NUMERIC(5, 2),
    water_color TEXT,
    vessel_condition TEXT,
    phosphorus_ppm_estimate NUMERIC(6, 2),
    phosphorus_estimate_basis TEXT,
    ph_estimate NUMERIC(4, 2),
    ph_estimate_basis TEXT,
    summary TEXT,
    uncertainty_flags JSONB,
    content JSONB NOT NULL
);

-- Child table for the ACTION_HYPOTHESIS perspective: candidate human
-- action(s) the LLM infers happened between two specific states, with
-- confidence per hypothesis. Unlike AZOLLA_STATE, this is inherently
-- pair-specific — attached (via state_perspectives.state_id) to the LATER
-- state of the pair, with prior_state_id identifying the earlier one.
-- Actions always correspond to a real human action: no_action_found=true
-- means the LLM found no describable human action in the text (e.g. pure
-- biological growth between check-ins) — this is a valid, honest result,
-- not an error, and the backfill commit step must not synthesize a
-- placeholder action for it.
CREATE TABLE action_hypothesis_perspectives (
    id UUID PRIMARY KEY REFERENCES state_perspectives(id) ON DELETE CASCADE,
    prior_state_id UUID NOT NULL REFERENCES states(id),
    no_action_found BOOLEAN NOT NULL DEFAULT FALSE,
    hypotheses JSONB NOT NULL, -- [{ title, description, confidence }], empty array when no_action_found
    content JSONB NOT NULL
);

CREATE INDEX idx_action_hypothesis_prior_state ON action_hypothesis_perspectives(prior_state_id);

COMMIT;
