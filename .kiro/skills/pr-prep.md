---
inclusion: manual
---

# PR Prep Skill

When the user invokes this skill, run through each step below in order. Report results as you go. Stop and flag any blockers.

## Step 1: Run Tests

```bash
npm run test:run
```

If tests fail, report which tests failed and stop. Do not proceed until the user acknowledges.

## Step 2: Security Scan

Search the codebase for hardcoded secrets. Check all staged and modified files for:
- Hardcoded passwords: `password=`, `PASSWORD=`, `DB_PASSWORD=`, `PGPASSWORD=`
- AWS credentials: `AKIA[0-9A-Z]{16}`, `AWS_SECRET`
- JWT tokens: `eyJraWQiOiJ`, `Bearer eyJ`
- Any string that looks like a real secret (not a placeholder or env var reference)

Verify `.env.local` and `.env.production` are in `.gitignore` and not staged.

Report: ✅ Clean or ⚠️ list each finding with file and line number.

## Step 3: Flag Temporary/WIP Files

Check for files that shouldn't be in a PR:
- Root directory: `*_FEATURE.md`, `*_WORKING.md`, `*_WIP.md`, `*_TEMP.md`, `*_DRAFT.md`
- Root directory: `test-*.sh`, `temp-*.sh`, `wip-*.sh`, `draft-*.sh`
- Any `TASK_*` or `FIX_*` markdown files in root (these are working docs)
- Untracked large markdown files in root that aren't permanent docs

Permanent docs to ignore: `README.md`, `ENGINEERING_GUIDE.md`, `ARCHITECTURE_DIAGRAM.md`, `CURRENT_ARCHITECTURE.md`, and anything under `docs/` (see `docs/README.md` for the index)

Report: ✅ Clean or ⚠️ list files that should be removed or added to `.gitignore`.

## Step 4: Console Log Cleanup

Search `src/` and `lambda/` for debug logging:
- `console.log` (flag these)
- `console.debug` (flag these)
- Ignore: `console.error`, `console.warn` (intentional)

Report: ✅ Clean or ⚠️ list files with debug logs.

## Step 4b: Pattern Alignment

Review only what this branch changed (`git diff main --name-only -- 'src/' 'lambda/'`, plus untracked files) against existing app patterns. For each finding, cite the file and line, and name the existing file that shows the established pattern. Judge by reading the neighbors, not just grepping — a hit is a prompt to look, not automatically a violation.

- **Server state goes through TanStack Query.** Flag new `apiService.get/post/put/delete` calls inside components or pages (especially in `useEffect` + `useState`, or with hand-rolled loading/error state). Expected: a hook in `src/hooks/` using `useQuery`/`useMutation` (see `hooks/metrics/useMetrics.ts`, `hooks/useMemberSettings.ts`).
- **Query keys are centralized.** New keys should come from `src/lib/queryKeys.ts`, not inline arrays.
- **Mutations update the cache.** A mutation should invalidate (or optimistically update) every query showing the same data, not patch component-local state.
- **Load-time cost.** Data a screen always needs on open should be prefetchable/cached (see the prefetch in `pages/Dashboard.tsx`), so tabs and lists don't pop in or flash spinners on every visit.
- **Shared code, not copies.** Before accepting a new helper/component, search for an existing one (`src/components/shared/`, `src/lib/`, `src/hooks/`) that already does the job (e.g. `PhotoThumb`, `imageUtils`).
- **File placement and size.** Pure logic (data shaping, formatting, chart building) belongs in `src/lib/` or a hook, not inline in a large component file. Flag new or grown files that mix fetching, data shaping and rendering, and pure logic added with no test.
- **Typing.** No new `any` / `as any` (CLAUDE.md); flag each one added.
- **Styling.** Theme tokens and existing `ui/*` components, not hard-coded colors (`text-slate-*`, `text-white`, `bg-[#...]`) where the surrounding UI uses tokens. Layouts must work at mobile width (this app is used in the field).
- **Domain rules.** Flag hard-coded org/pilot-specific dates, metric names or IDs in shared components; they should be data or config.
- **Database changes.** Smart diffing only (update/delete/insert); no delete-all-then-reinsert (CLAUDE.md).

Report: ✅ Aligned or ⚠️ list each divergence with file:line and the pattern it departs from. Divergences are warnings for the user to accept or fix, not automatic blockers.

## Step 5: RDS Backup

Always run the backup script before any PR:

```bash
bash scripts/cron/backup-rds-daily.sh
```

Wait for the "Snapshot created successfully" confirmation before proceeding. If it fails, stop and report the error.

Report: ✅ Snapshot `cwf-manual-{DATE}` created or ❌ Backup failed.

## Step 6: Check for Database Changes

Check if any migration files were added or modified in this branch:

```bash
git diff main --name-only -- 'migrations/'
```

If migrations were detected:

### 6a: Update Schema Diagram

```bash
python3 scripts/generate-db-diagram.py > docs/architecture/DATABASE_SCHEMA.md
```

Verify the file was generated and report what tables/relationships changed.

If no migrations detected, skip this step and report: ✅ No DB changes.

## Step 7: Build Check

```bash
npm run build
```

If the build fails, report the errors and stop. Do not proceed until the user acknowledges.

Report: ✅ Build succeeded or ❌ Build failed with errors.

## Step 8: Summary

Provide a final checklist:

```
PR Prep Summary
───────────────
Tests:          ✅ / ❌
Build:          ✅ / ❌
Security:       ✅ / ⚠️
Temp Files:     ✅ / ⚠️
Console Logs:   ✅ / ⚠️
Patterns:       ✅ / ⚠️
DB Backup:      ✅ / ❌
Schema Diagram: ✅ / ⏭️ (skipped - no migrations)
```

If all checks pass, say "Ready for PR." If any issues, list what needs to be fixed before opening the PR.
