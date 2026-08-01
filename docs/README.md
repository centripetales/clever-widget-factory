# Documentation index

Every doc below has a **Status** line at the top stating whether it's a
current-state reference (keep accurate), a design/roadmap doc (point-in-time,
may be partially or fully superseded), or an archived historical record. If
you edit code that a doc here describes, check whether the doc needs
updating too — that's the failure mode this index and the status-line
convention exist to catch (a 2026-08-01 audit found ~15 docs across this repo
had silently drifted from what the code actually does).

## Start here

- [`../README.md`](../README.md) — project overview, local dev setup, API
  config, testing, deployment
- [`../CLAUDE.md`](../CLAUDE.md) — workspace behavior contract / working
  agreements
- [`../ENGINEERING_GUIDE.md`](../ENGINEERING_GUIDE.md) — engineering
  conventions and code quality practices

## `architecture/` — current-state technical references

Must stay accurate; these describe how the system actually works today.

- [`LAMBDA_ARCHITECTURE.md`](architecture/LAMBDA_ARCHITECTURE.md) — what's
  actually deployed vs. two historical plans that didn't fully happen;
  dependency resolution (shared layer vs. AWS runtime vs. own bundle); which
  deploy script to use; how to verify a live Lambda instead of guessing
- [`DATABASE_SCHEMA.md`](architecture/DATABASE_SCHEMA.md) — auto-generated
  ER diagram, regenerate with `python3 scripts/generate-db-diagram.py`
- [`DATABASE_BACKUP.md`](architecture/DATABASE_BACKUP.md) — backup/restore
  procedures (currently manual, not automated)
- [`API_GATEWAY.md`](architecture/API_GATEWAY.md) — checklist for adding
  endpoints, common mistakes, known CI script-path bug
- [`UPLOAD_PIPELINE.md`](architecture/UPLOAD_PIPELINE.md) — presigned-POST
  photo upload flow, client-side EXIF reinjection, server-side extraction
- [`INTEGRATION_TESTING.md`](architecture/INTEGRATION_TESTING.md) — what
  integration test scripts/patterns actually exist vs. what older docs
  claimed
- [`ACTION_UPDATES_MIGRATION_TO_STATES.md`](ACTION_UPDATES_MIGRATION_TO_STATES.md) —
  how action updates moved onto the `states` table (still at `docs/` root;
  verified accurate, not yet relocated)

## `design/` — point-in-time design and roadmap docs

May be partially or fully superseded by what actually got built — each
doc's status line says which.

- [`OBSERVATIONS_SYSTEM.md`](design/OBSERVATIONS_SYSTEM.md) — original
  roadmap; superseded by the `states`/`state_photos`/`state_links` schema
- [`PARTNER_AGENCY_RBAC.md`](design/PARTNER_AGENCY_RBAC.md) — authorizer
  code is live, database tables were never created; currently a no-op
- [`TODO-POLICY-ORG-ID.md`](design/TODO-POLICY-ORG-ID.md) — still open
- [`TODO-UNIFIED-IMAGES-TABLE.md`](design/TODO-UNIFIED-IMAGES-TABLE.md) —
  still open

## `archive/` — completed or superseded, kept for history

Not current-state references — don't trust these as describing live
behavior without checking the code.

- [`audit-system-requirements.md`](archive/audit-system-requirements.md) —
  tool audit system; implemented, this is the original spec

## Other reference docs (verified accurate as of the 2026-08-01 audit, not yet reorganized)

- [`EXPLORATION-CODE-FORMAT.md`](EXPLORATION-CODE-FORMAT.md)
- [`EXPLORATION-ENDPOINTS-FIX.md`](EXPLORATION-ENDPOINTS-FIX.md)
- [`SARI_SARI_CHAT_INTERFACE.md`](SARI_SARI_CHAT_INTERFACE.md) — correctly
  describes this feature as client-side demo/simulation only, no real
  backend wired up
- [`SELLABLE_TOGGLE_IMPLEMENTATION.md`](SELLABLE_TOGGLE_IMPLEMENTATION.md)
- [`VPC_COST_OPTIMIZATION.md`](VPC_COST_OPTIMIZATION.md)
- [`TEST-FIXES-SUMMARY.md`](TEST-FIXES-SUMMARY.md) — minor drift noted
  inline (a few one-off cleanup scripts it lists no longer exist)
- [`high_level_system_concepts.md`](high_level_system_concepts.md) —
  philosophy/vision, not a technical spec, nothing to verify against code

## Known bugs surfaced while writing this index (not fixed yet)

- `lambda/core/index.js`'s `/tools/{id}/history` handler queries pre-rename
  table names and would error if called — appears to be dead code, the
  frontend uses a different route. See `architecture/LAMBDA_ARCHITECTURE.md`.
- `.github/workflows/verify-api.yml` references
  `scripts/verify-api-authorizers.sh`, but the script is actually at
  `scripts/verify/verify-api-authorizers.sh` — the weekly CI job is likely
  failing. See `architecture/API_GATEWAY.md`.
- `src/hooks/__tests__/integration/README.md` and `README-tool-creation.md`
  describe integration-test tooling that doesn't exist (same pattern this
  audit fixed elsewhere) — not yet rewritten. See
  `architecture/INTEGRATION_TESTING.md`.
