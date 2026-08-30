/**
 * Bug Condition Exploration Test — Task 1
 *
 * Property 1: Bug Condition — Maxwell JOIN Fails Without `::uuid` Cast
 *
 * CRITICAL: This test is EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bug condition holds: `::uuid` casts are present in
 * buildSubquery JOIN conditions, which means entity_id is still `text` and
 * the workaround is active rather than the proper fix.
 *
 * When the fix is applied (Task 9.1 — remove ::uuid casts), this test will PASS,
 * confirming the proper fix is in place.
 *
 * Validates: Requirements 1.2, 2.2
 *
 * Run with: npx vitest run --config vitest.config.js index.test.js
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Import the module under test.
// The vitest.config.js aliases /opt/nodejs/db and /opt/nodejs/sqlUtils to
// local __mocks__ files so index.js can be loaded without the Lambda layer.
// ---------------------------------------------------------------------------
import { buildSubquery, VALID_ENTITY_TYPES } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The entity types that have explicit JOIN conditions in buildSubquery.
 * These are the types that trigger the bug — each has a JOIN like:
 *   JOIN <table> t ON ue.entity_id::uuid = t.id
 */
const JOIN_ENTITY_TYPES = ['part', 'tool', 'action_policy', 'issue', 'policy', 'financial_record'];

/**
 * A representative embedding vector string (matches the format the handler
 * passes to buildSubquery after calling generateEmbeddingV1).
 */
const SAMPLE_VECTOR = "'[0.1,0.2,0.3]'::vector";

/** A representative org UUID (already escaped — no single-quotes). */
const SAMPLE_ORG_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Property 1: Bug Condition
//
// For each entity type that has an explicit JOIN, buildSubquery must produce
// a JOIN condition that does NOT contain `ue.entity_id::uuid`.
//
// On UNFIXED code (::uuid casts present) this assertion FAILS for every type,
// confirming the bug condition holds.
//
// On FIXED code (::uuid casts removed) this assertion PASSES for every type.
// ---------------------------------------------------------------------------

describe('Property 1: Bug Condition — buildSubquery JOIN must not cast entity_id to uuid', () => {
  /**
   * Validates: Requirements 1.2, 2.2
   *
   * The property: for any entity type in JOIN_ENTITY_TYPES, the SQL produced
   * by buildSubquery does NOT match /ue\.entity_id::uuid/.
   *
   * EXPECTED OUTCOME ON UNFIXED CODE: FAIL
   * Counterexample: buildSubquery('part', ...) returns SQL containing
   *   `JOIN parts p ON ue.entity_id::uuid = p.id`
   * instead of the correct (post-fix):
   *   `JOIN parts p ON ue.entity_id = p.id`
   */
  it('property: buildSubquery output for JOIN entity types must not contain ue.entity_id::uuid cast', () => {
    fc.assert(
      fc.property(
        // Generator: pick one of the JOIN entity types
        fc.constantFrom(...JOIN_ENTITY_TYPES),
        (entityType) => {
          const sql = buildSubquery(entityType, SAMPLE_VECTOR, SAMPLE_ORG_ID, 3);

          // The property we want to hold after the fix:
          // No ::uuid cast on entity_id in the JOIN condition.
          const hasCast = /ue\.entity_id::uuid/.test(sql);

          // Return false (property violation) when the cast IS present.
          // On unfixed code this will be false for every JOIN entity type,
          // causing fast-check to report a counterexample.
          return !hasCast;
        }
      ),
      { numRuns: JOIN_ENTITY_TYPES.length, verbose: true }
    );
  });

  /**
   * Concrete per-type assertions — one failing test per entity type makes
   * the counterexamples immediately visible in the test output.
   *
   * EXPECTED OUTCOME ON UNFIXED CODE: each assertion FAILS.
   */
  for (const entityType of JOIN_ENTITY_TYPES) {
    it(`buildSubquery('${entityType}', ...) must not contain ue.entity_id::uuid`, () => {
      const sql = buildSubquery(entityType, SAMPLE_VECTOR, SAMPLE_ORG_ID, 3);

      // Document the actual SQL so the counterexample is visible in output.
      // On unfixed code this will contain e.g.:
      //   JOIN parts p ON ue.entity_id::uuid = p.id
      // which is the bug condition.
      expect(sql, `SQL for entity type '${entityType}' must not cast entity_id to uuid`).not.toMatch(
        /ue\.entity_id::uuid/
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Sanity: VALID_ENTITY_TYPES export includes all JOIN entity types
// ---------------------------------------------------------------------------

describe('VALID_ENTITY_TYPES export', () => {
  it('includes all JOIN entity types', () => {
    for (const t of JOIN_ENTITY_TYPES) {
      expect(VALID_ENTITY_TYPES).toContain(t);
    }
  });
});
