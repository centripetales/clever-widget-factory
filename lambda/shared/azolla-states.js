// The most basic version of the azolla state model (2026-09-06) — replaces
// the earlier multi-lane taxonomy (STATE_LANES, deleted) entirely. Per
// design conversation: manure/compost application etc. are ACTIONS (they
// already exist as real `actions` rows attached to experiences) — they
// were wrongly being double-counted as their own state dimension too.
// States themselves are reduced to the simplest possible signal: is the
// situation getting better or worse. Not azolla-specific vs
// duckweed-specific — one overall verdict per observation, since a
// person's own words (see the CLAIM_ATOMIC exploration) usually describe
// the whole container's trajectory together ("declining duckweed and
// azolla"), not each species in isolation.
//
// Deliberately just 2 states — "let people's own words surface the states"
// means starting minimal and letting real classification results tell us
// if/where finer distinctions are actually needed, not pre-guessing a
// taxonomy.
const STATE_VALUES = {
  increasing: 'The azolla and/or duckweed are increasing, growing, spreading, or improving',
  decreasing: 'The azolla and/or duckweed are decreasing, declining, shrinking, or getting worse',
};

module.exports = { STATE_VALUES };
