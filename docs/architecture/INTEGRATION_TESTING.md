# Integration test setup

**Status:** current-state reference — keep this accurate.
**Last verified:** 2026-08-01, against `package.json`, `vitest.config.ts`, and
the actual test files.

This replaces two previous docs (root `INTEGRATION_TEST_SETUP.md` and this
file's predecessor) that both described a fuller integration-test harness
than actually exists — `npm run test:integration`, `npm run setup:test-user`,
`node scripts/_temp/setup-test-user.js`, and similar. **None of those exist
today.** `package.json` only has `dev`, `build`, `preview`, `test`,
`test:run`, `test:ui`, `test:coverage`.

## What actually runs

- `npm run test:run` runs the vitest suite once (this is what CI and the
  `pr-prep` skill use).
- `vitest.config.ts` **fully excludes** `src/tests/exploration-data-collection/**`
  from the run — those tests aren't fixed-and-passing, they're not executed
  at all. Don't be surprised they don't show up in results.
- Inside `src/hooks/__tests__/integration/`, tests split into two real
  patterns:
  - **Mock-based** (e.g. `assetCheckoutValidation.mock.test.tsx`) — actually
    run as part of `test:run`, mock `apiService` with `vi.mock`, no network
    calls, no auth needed.
  - **Hardcoded `describe.skip()`** (e.g. `toolCreationIntegration.test.tsx`)
    — these are written to hit real Lambda endpoints but are skipped
    unconditionally in source, not gated by an environment variable check
    that would let you opt in. To actually run one, you'd currently need to
    edit the file to remove `.skip`.

## If you need to write a new test

Prefer the mock pattern — it's what's actually wired into CI:
```typescript
import { vi } from 'vitest';

vi.mock('@/lib/apiService', () => ({
  apiService: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(apiService.post).mockResolvedValue({ data: mockData });
});
```

## Known drift to be aware of

`src/hooks/__tests__/integration/README.md` (and `README-tool-creation.md`
in the same directory) describe a considerably more built-out integration
test harness than exists today — real Cognito test-user provisioning,
`npm run test:cleanup`, performance benchmarking scripts, a
`toolCheckoutWorkflows.test.tsx` file that isn't actually present. Treat
those two files with the same skepticism this doc was written to replace —
they weren't rewritten as part of this pass and are a good candidate for a
follow-up cleanup using the same verify-against-code approach used here.
