# Observations system — design history

**Status:** superseded by implementation — this is a historical record, not a
live spec. For the current schema, see
[`docs/architecture/DATABASE_SCHEMA.md`](../architecture/DATABASE_SCHEMA.md).
**Last verified:** 2026-08-01.

## What this originally proposed

A roadmap for a photo-first observation system: `observations` +
`observation_photos` + `observation_links` tables, with per-photo
descriptions, polymorphic links to tools/parts/actions/issues, AI analysis
on every observation, and a "proactivity metric" (target: 40% of updates
being standalone observations rather than reactive action updates).

## What actually shipped

The schema was built and then **renamed**: `observations` → `states`,
`observation_photos` → `state_photos`, `observation_links` → `state_links`,
via `migrations/002-rename-observations-to-states.sql` ("for RL alignment
... aligns with both actions and observations" — the rename broadened the
concept to cover both). This roadmap doc never mentioned the rename and, if
read on its own, describes tables that no longer exist under these names.

The AI-analysis-on-every-observation part shipped as the Reality
Stratification Pipeline — see
[`docs/architecture/LAMBDA_ARCHITECTURE.md`](../architecture/LAMBDA_ARCHITECTURE.md)
and `lambda/rsp-worker/`. It extracts three "perspectives" per observation
(Claim, Significance, Entropy), not the single free-text `observation_text`
originally sketched here — a richer result than planned, via a different
mechanism.

**Not verified as implemented**: the "proactivity metric" (40% target) and
automatic issue-creation from high-impact observations. A repo-wide search
found no code referencing either concept — if they matter to you, treat them
as never built rather than assume they're tracked somewhere.

## One live bug found while cross-checking this doc

`lambda/core/index.js`'s `/tools/{id}/history` handler still queries the old,
pre-rename table names directly (`observations`/`observation_photos`/
`observation_links`) — see the "Known drift" section in
`docs/architecture/LAMBDA_ARCHITECTURE.md` for status.
