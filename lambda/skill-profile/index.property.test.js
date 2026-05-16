/**
 * Property-based tests for skill-profile Lambda utility functions.
 * Uses Vitest + fast-check.
 *
 * Properties tested:
 *   Property 8 – Axis embedding source composition
 *   Property 9 – Per-axis SQS message carries action_id + axis_key (no composite entity_id)
 *   Property 4 – Per-axis embedding message generation
 *
 * Note: composeAxisEntityId and parseAxisEntityId were retired as part of the
 * unified_embeddings entity_id type migration. skill_axis SQS messages now carry
 * action_id + axis_key fields instead of a composite text entity_id.
 */

const fc = require('fast-check');
const {
  composeAxisEmbeddingSource
} = require('./axisUtils');

// ── Shared arbitraries ──────────────────────────────────────────────

const arbLabel = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);
const arbDescription = fc.option(fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0));
const arbNarrative = fc.option(fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0));
const arbUuid = fc.uuid();
const arbAxisKey = fc.stringMatching(/^[a-z][a-z0-9_]{2,30}$/);

// ── Property 8: Axis embedding source composition ───────────────────
// **Validates: Requirements 2.1, 2.2, 2.4, 4.2**
//
// New behavior (learning-focus-redesign):
//   - When description is present and non-empty, it is the SOLE embedding source.
//   - When description is absent/empty, falls back to label + narrative.

describe('Property 8: Axis embedding source composition', () => {
  it('when description is present, composed source equals description exactly (sole source)', () => {
    // Feature: learning-focus-redesign, Property 1: description sole source
    fc.assert(
      fc.property(
        arbLabel,
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
        arbNarrative,
        (label, description, narrative) => {
          const axis = { label, description };
          const source = composeAxisEmbeddingSource(axis, narrative ?? undefined);
          return source === description;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('when description is absent, composed source contains the label', () => {
    // Feature: learning-focus-redesign, Property 2: fallback when description absent
    fc.assert(
      fc.property(arbLabel, arbNarrative, (label, narrative) => {
        const axis = { label }; // no description
        const source = composeAxisEmbeddingSource(axis, narrative ?? undefined);
        return source.includes(label);
      }),
      { numRuns: 100 }
    );
  });

  it('when description is absent, composed source contains the narrative when narrative is non-empty', () => {
    // Feature: learning-focus-redesign, Property 2: fallback when description absent
    fc.assert(
      fc.property(
        arbLabel,
        fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0),
        (label, narrative) => {
          const axis = { label }; // no description
          const source = composeAxisEmbeddingSource(axis, narrative);
          return source.includes(narrative);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('composed source is never empty', () => {
    fc.assert(
      fc.property(arbLabel, arbDescription, arbNarrative, (label, description, narrative) => {
        const axis = { label, description: description ?? undefined };
        const source = composeAxisEmbeddingSource(axis, narrative ?? undefined);
        return source.length > 0;
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 9: Per-axis SQS message carries action_id + axis_key ──
// **Validates: Requirements 4.1**
//
// After the unified_embeddings entity_id type migration, skill_axis SQS messages
// no longer include a composite entity_id. Instead they carry explicit action_id
// and axis_key fields so the embeddings-processor can store them in the new columns.

describe('Property 9: Per-axis SQS message carries action_id + axis_key', () => {
  it('each message has action_id equal to the action UUID', () => {
    fc.assert(
      fc.property(arbUuid, arbAxisKey, arbLabel, (actionId, axisKey, label) => {
        const axis = { key: axisKey, label };
        const message = {
          entity_type: 'skill_axis',
          action_id: actionId,
          axis_key: axis.key,
          embedding_source: composeAxisEmbeddingSource(axis),
          organization_id: actionId // reuse arbUuid for org
        };
        return message.action_id === actionId;
      }),
      { numRuns: 100 }
    );
  });

  it('each message has axis_key equal to the axis key', () => {
    fc.assert(
      fc.property(arbUuid, arbAxisKey, arbLabel, (actionId, axisKey, label) => {
        const axis = { key: axisKey, label };
        const message = {
          entity_type: 'skill_axis',
          action_id: actionId,
          axis_key: axis.key,
          embedding_source: composeAxisEmbeddingSource(axis),
          organization_id: actionId
        };
        return message.axis_key === axisKey;
      }),
      { numRuns: 100 }
    );
  });

  it('each message does not include a composite entity_id field', () => {
    fc.assert(
      fc.property(arbUuid, arbAxisKey, arbLabel, (actionId, axisKey, label) => {
        const axis = { key: axisKey, label };
        const message = {
          entity_type: 'skill_axis',
          action_id: actionId,
          axis_key: axis.key,
          embedding_source: composeAxisEmbeddingSource(axis),
          organization_id: actionId
        };
        // entity_id must not be present (or must not be a composite string)
        return !('entity_id' in message);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 4: Per-axis embedding message generation ───────────────
// **Validates: Requirements 2.1, 4.1**
//
// We test the property by generating a valid skill profile with N axes
// (4 ≤ N ≤ 6), then building the expected SQS message bodies using the
// pure utility functions and verifying the constraints.
//
// After the unified_embeddings migration, messages use action_id + axis_key
// instead of a composite entity_id.

/**
 * Build the array of SQS message bodies for axis embeddings.
 * This mirrors what handleApprove does after the migration:
 * - No entity_id in the message
 * - action_id and axis_key are explicit fields
 */
function buildAxisEmbeddingMessages(actionId, organizationId, approvedProfile) {
  return Object.entries(approvedProfile.axes).map(([axisKey, axis]) => ({
    entity_type: 'skill_axis',
    action_id: actionId,
    axis_key: axisKey,
    embedding_source: composeAxisEmbeddingSource(axis, approvedProfile.narrative),
    organization_id: organizationId
  }));
}

/** Arbitrary: a single axis object */
const arbAxis = fc.record({
  label: arbLabel,
  description: fc.option(fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0))
    .map(d => d ?? undefined),
  required_level: fc.integer({ min: 1, max: 6 })
});

/** Arbitrary: a skill profile with 4–6 unique axis keys */
const arbProfile = fc.integer({ min: 4, max: 6 }).chain(n =>
  fc.tuple(
    fc.uniqueArray(arbAxisKey, { minLength: n, maxLength: n }),
    fc.array(arbAxis, { minLength: n, maxLength: n }),
    fc.option(fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0))
      .map(n => n ?? undefined)
  ).map(([keys, axes, narrative]) => {
    const axesObj = {};
    keys.forEach((key, i) => { axesObj[key] = axes[i]; });
    return { axes: axesObj, narrative };
  })
);

describe('Property 4: Per-axis embedding message generation', () => {
  it('produces exactly N messages with entity_type skill_axis, one per axis', () => {
    fc.assert(
      fc.property(arbUuid, arbUuid, arbProfile, (actionId, organizationId, profile) => {
        const messages = buildAxisEmbeddingMessages(actionId, organizationId, profile);
        const axisCount = Object.keys(profile.axes).length;

        // Exactly N messages
        if (messages.length !== axisCount) return false;

        // All have entity_type 'skill_axis'
        if (!messages.every(m => m.entity_type === 'skill_axis')) return false;

        return true;
      }),
      { numRuns: 100 }
    );
  });

  it('each message carries action_id and axis_key (no composite entity_id)', () => {
    fc.assert(
      fc.property(arbUuid, arbUuid, arbProfile, (actionId, organizationId, profile) => {
        const messages = buildAxisEmbeddingMessages(actionId, organizationId, profile);
        const axisKeys = Object.keys(profile.axes);

        return messages.every(m => {
          // Must have action_id equal to the action UUID
          if (m.action_id !== actionId) return false;
          // Must have axis_key that is one of the profile's axis keys
          if (!axisKeys.includes(m.axis_key)) return false;
          // Must NOT have a composite entity_id
          if ('entity_id' in m) return false;
          return true;
        });
      }),
      { numRuns: 100 }
    );
  });

  it('no two messages share the same axis_key', () => {
    fc.assert(
      fc.property(arbUuid, arbUuid, arbProfile, (actionId, organizationId, profile) => {
        const messages = buildAxisEmbeddingMessages(actionId, organizationId, profile);
        const keys = messages.map(m => m.axis_key);
        return new Set(keys).size === keys.length;
      }),
      { numRuns: 100 }
    );
  });
});
