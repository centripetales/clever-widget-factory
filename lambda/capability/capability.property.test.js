/**
 * Property-based tests for capability Lambda functions.
 * Uses Vitest + fast-check.
 *
 * Properties tested:
 *   Property 1 – Evidence pool contains all user-authored states regardless of action assignment
 *   Property 2 – Evidence pool is scoped to the user's organisation
 *   Property 3 (existing) – Evidence search scoped to user and organization
 *   Property 3 (spec) – Prefix-excluded states never appear in the evidence pool
 *   Property 4 – Evidence items are returned in descending similarity order
 *   Property 5 – Evidence count per axis never exceeds the configured limit
 *
 * Also tests:
 *   determineEvidenceType – quiz vs observation classification
 */

const fc = require('fast-check');
const { determineEvidenceType, determineEvidenceTypeEnriched, scopeEvidenceResults } = require('./capabilityUtils');

// ── Shared arbitraries ──────────────────────────────────────────────

const arbUserId = fc.uuid();
const arbOrgId = fc.uuid();
const arbStateText = fc.string({ minLength: 1, maxLength: 200 });

// ── Evidence pool predicate (mirrors the SQL WHERE clause after the change) ──
// A state is eligible when:
//   captured_by = userId
//   organization_id = orgId
//   state_text NOT LIKE '[capability_profile]%'
//   state_text NOT LIKE '[learning_objective]%'
// No state_links row is required.
function isEligible(state, userId, orgId) {
  return (
    state.captured_by === userId &&
    state.organization_id === orgId &&
    !state.state_text.startsWith('[capability_profile]') &&
    !state.state_text.startsWith('[learning_objective]')
  );
}

function applyEvidencePool(states, userId, orgId) {
  return states.filter(s => isEligible(s, userId, orgId));
}

// ── Property 1: Evidence pool contains all user-authored states regardless of action assignment ──
// Feature: experience-based-capability-evidence, Property 1
// **Validates: Requirements 1.1, 1.5, 2.1**

describe('Property 1: Evidence pool contains all user-authored states regardless of action assignment', () => {
  // Arbitrary for a state that is eligible (captured_by = userId, correct org, no excluded prefix)
  const arbEligibleStateText = fc.string({ minLength: 1, maxLength: 200 }).filter(
    s => !s.startsWith('[capability_profile]') && !s.startsWith('[learning_objective]')
  );

  // Arbitrary for a state_links configuration — presence or absence of learning_objective links
  // should not affect eligibility
  const arbStateLinkConfig = fc.record({
    hasLearningObjectiveLink: fc.boolean(),
    hasActionLink: fc.boolean(),
    hasOtherLink: fc.boolean()
  });

  it('every captured_by=userId state in the correct org appears in the pool regardless of state_links', () => {
    // Feature: experience-based-capability-evidence, Property 1
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            captured_by: arbUserId,
            organization_id: arbOrgId,
            state_text: arbEligibleStateText,
            // state_links config is tracked but does NOT affect pool membership
            links: arbStateLinkConfig
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, candidateStates) => {
          // Build a pool of states: some belong to the target user+org, some don't
          const states = candidateStates.map(s => ({
            id: s.id,
            captured_by: targetUserId, // all are authored by the target user
            organization_id: targetOrgId,
            state_text: s.state_text,
            links: s.links
          }));

          const pool = applyEvidencePool(states, targetUserId, targetOrgId);

          // Every state authored by the target user in the target org must appear in the pool
          // regardless of whether it has a learning_objective link
          return states.every(s => pool.some(p => p.id === s.id));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('states with no learning_objective link are included in the pool', () => {
    // Feature: experience-based-capability-evidence, Property 1
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbEligibleStateText
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, stateShapes) => {
          // States with NO learning_objective link at all
          const states = stateShapes.map(s => ({
            id: s.id,
            captured_by: targetUserId,
            organization_id: targetOrgId,
            state_text: s.state_text,
            links: { hasLearningObjectiveLink: false, hasActionLink: false, hasOtherLink: false }
          }));

          const pool = applyEvidencePool(states, targetUserId, targetOrgId);

          // All states must appear — absence of learning_objective link is not a disqualifier
          return pool.length === states.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('quiz answer states (captured_by=userId) are included in the pool alongside observations', () => {
    // Feature: experience-based-capability-evidence, Property 1
    // Validates Requirement 2.1: quiz answers satisfy captured_by and must not be excluded
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            isQuiz: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, stateShapes) => {
          const states = stateShapes.map(s => ({
            id: s.id,
            captured_by: targetUserId,
            organization_id: targetOrgId,
            // Quiz answers contain "which was the correct answer"; observations are plain text
            state_text: s.isQuiz
              ? 'Selected option B which was the correct answer'
              : 'Observed the field conditions today',
            links: { hasLearningObjectiveLink: false }
          }));

          const pool = applyEvidencePool(states, targetUserId, targetOrgId);

          // Both quiz and observation states must appear
          return pool.length === states.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('states from other users are excluded even if they share the same org', () => {
    // Feature: experience-based-capability-evidence, Property 1
    fc.assert(
      fc.property(
        arbUserId,
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbEligibleStateText
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (targetUserId, otherUserId, targetOrgId, stateShapes) => {
          fc.pre(targetUserId !== otherUserId);

          const otherUserStates = stateShapes.map(s => ({
            id: s.id,
            captured_by: otherUserId,
            organization_id: targetOrgId,
            state_text: s.state_text
          }));

          const pool = applyEvidencePool(otherUserStates, targetUserId, targetOrgId);

          // States authored by a different user must not appear
          return pool.length === 0;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('states on actions the user is not assigned to are included when authored by the user', () => {
    // Feature: experience-based-capability-evidence, Property 1
    // Validates Requirement 1.5: authorship is the only eligibility criterion
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbEligibleStateText,
            // action_id represents an action the user is NOT assigned to
            action_id: fc.uuid()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, stateShapes) => {
          const states = stateShapes.map(s => ({
            id: s.id,
            captured_by: targetUserId,
            organization_id: targetOrgId,
            state_text: s.state_text,
            // The state is linked to an action the user is not assigned to
            // (no learning_objective link for the scored action)
            links: { hasLearningObjectiveLink: false, action_id: s.action_id }
          }));

          const pool = applyEvidencePool(states, targetUserId, targetOrgId);

          // All states must appear — action assignment is irrelevant
          return pool.length === states.length;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 2: Evidence pool is scoped to the user's organisation ──
// Feature: experience-based-capability-evidence, Property 2
// **Validates: Requirements 1.2**

describe('Property 2: Evidence pool is scoped to the user\'s organisation', () => {
  const arbEligibleStateText = fc.string({ minLength: 1, maxLength: 200 }).filter(
    s => !s.startsWith('[capability_profile]') && !s.startsWith('[learning_objective]')
  );

  it('no state from org B appears in the evidence pool for org A', () => {
    // Feature: experience-based-capability-evidence, Property 2
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            org: fc.boolean(), // true = org A, false = org B
            state_text: arbEligibleStateText
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (userId, orgAId, orgBId, stateShapes) => {
          fc.pre(orgAId !== orgBId);

          const states = stateShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: s.org ? orgAId : orgBId,
            state_text: s.state_text
          }));

          const pool = applyEvidencePool(states, userId, orgAId);

          // No state from org B must appear in the pool for org A
          return pool.every(s => s.organization_id === orgAId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('states authored by the user in org B are excluded from org A pool', () => {
    // Feature: experience-based-capability-evidence, Property 2
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbEligibleStateText
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (userId, orgAId, orgBId, stateShapes) => {
          fc.pre(orgAId !== orgBId);

          // All states are authored by the same user but belong to org B
          const orgBStates = stateShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgBId,
            state_text: s.state_text
          }));

          const pool = applyEvidencePool(orgBStates, userId, orgAId);

          // Even though the user authored these states, they are in org B and must not appear
          return pool.length === 0;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('only org A states appear when pool contains states from both orgs', () => {
    // Feature: experience-based-capability-evidence, Property 2
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbEligibleStateText
          }),
          { minLength: 1, maxLength: 10 }
        ),
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbEligibleStateText
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (userId, orgAId, orgBId, orgAShapes, orgBShapes) => {
          fc.pre(orgAId !== orgBId);

          const orgAStates = orgAShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgAId,
            state_text: s.state_text
          }));

          const orgBStates = orgBShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgBId,
            state_text: s.state_text
          }));

          const allStates = [...orgAStates, ...orgBStates];
          const pool = applyEvidencePool(allStates, userId, orgAId);

          // Pool must contain exactly the org A states and none from org B
          const allOrgA = pool.every(s => s.organization_id === orgAId);
          const countCorrect = pool.length === orgAStates.length;
          return allOrgA && countCorrect;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 3: Evidence search scoped to user and organization ─────
// **Validates: Requirements 1.5, 2.6, 3.5**

describe('Property 3: Evidence search scoped to user and organization', () => {
  it('all returned results have organization_id matching the target org', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(arbUserId, { minLength: 1, maxLength: 5 }),
        fc.array(arbOrgId, { minLength: 1, maxLength: 5 }),
        fc.array(
          fc.record({
            isTargetUser: fc.boolean(),
            isTargetOrg: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, otherUserIds, otherOrgIds, configs) => {
          const results = configs.map((config, i) => ({
            captured_by: config.isTargetUser
              ? targetUserId
              : otherUserIds[i % otherUserIds.length],
            organization_id: config.isTargetOrg
              ? targetOrgId
              : otherOrgIds[i % otherOrgIds.length]
          }));

          const scoped = scopeEvidenceResults(results, targetUserId, targetOrgId);
          return scoped.every((r) => r.organization_id === targetOrgId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all returned results have captured_by matching the target user', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(arbUserId, { minLength: 1, maxLength: 5 }),
        fc.array(arbOrgId, { minLength: 1, maxLength: 5 }),
        fc.array(
          fc.record({
            isTargetUser: fc.boolean(),
            isTargetOrg: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, otherUserIds, otherOrgIds, configs) => {
          const results = configs.map((config, i) => ({
            captured_by: config.isTargetUser
              ? targetUserId
              : otherUserIds[i % otherUserIds.length],
            organization_id: config.isTargetOrg
              ? targetOrgId
              : otherOrgIds[i % otherOrgIds.length]
          }));

          const scoped = scopeEvidenceResults(results, targetUserId, targetOrgId);
          return scoped.every((r) => r.captured_by === targetUserId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no results from other orgs or users appear', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(arbUserId, { minLength: 1, maxLength: 5 }),
        fc.array(arbOrgId, { minLength: 1, maxLength: 5 }),
        fc.array(
          fc.record({
            isTargetUser: fc.boolean(),
            isTargetOrg: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, otherUserIds, otherOrgIds, configs) => {
          const results = configs.map((config, i) => ({
            captured_by: config.isTargetUser
              ? targetUserId
              : otherUserIds[i % otherUserIds.length],
            organization_id: config.isTargetOrg
              ? targetOrgId
              : otherOrgIds[i % otherOrgIds.length]
          }));

          const scoped = scopeEvidenceResults(results, targetUserId, targetOrgId);

          // No result should have a different user or different org
          return scoped.every(
            (r) =>
              r.captured_by === targetUserId &&
              r.organization_id === targetOrgId
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('the count matches the expected number of matching results', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(arbUserId, { minLength: 1, maxLength: 5 }),
        fc.array(arbOrgId, { minLength: 1, maxLength: 5 }),
        fc.array(
          fc.record({
            isTargetUser: fc.boolean(),
            isTargetOrg: fc.boolean()
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (targetUserId, targetOrgId, otherUserIds, otherOrgIds, configs) => {
          const results = configs.map((config, i) => ({
            captured_by: config.isTargetUser
              ? targetUserId
              : otherUserIds[i % otherUserIds.length],
            organization_id: config.isTargetOrg
              ? targetOrgId
              : otherOrgIds[i % otherOrgIds.length]
          }));

          const scoped = scopeEvidenceResults(results, targetUserId, targetOrgId);

          const expectedCount = configs.filter(
            (c) => c.isTargetUser && c.isTargetOrg
          ).length;

          return scoped.length === expectedCount;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns empty array when no results match the target user and org', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            captured_by: arbUserId,
            organization_id: arbOrgId
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (targetUserId, targetOrgId, results) => {
          // Ensure none of the results match both target user and org
          const nonMatching = results.map((r) => ({
            captured_by: r.captured_by === targetUserId
              ? r.captured_by + '-other'
              : r.captured_by,
            organization_id: r.organization_id
          }));

          const scoped = scopeEvidenceResults(nonMatching, targetUserId, targetOrgId);
          return scoped.length === 0 ||
            scoped.every(
              (r) =>
                r.captured_by === targetUserId &&
                r.organization_id === targetOrgId
            );
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 3 (spec): Prefix-excluded states never appear in the evidence pool ──
// Feature: experience-based-capability-evidence, Property 3
// **Validates: Requirements 1.6**

describe('Property 3 (spec): Prefix-excluded states never appear in the evidence pool', () => {
  // Arbitrary for a state_text that starts with the [capability_profile] prefix
  const arbCapabilityProfileText = fc.string({ minLength: 0, maxLength: 180 }).map(
    s => '[capability_profile]' + s
  );

  // Arbitrary for a state_text that starts with the [learning_objective] prefix
  const arbLearningObjectiveText = fc.string({ minLength: 0, maxLength: 180 }).map(
    s => '[learning_objective]' + s
  );

  // Arbitrary for a normal (non-prefixed) state_text
  const arbNormalStateText = fc.string({ minLength: 1, maxLength: 200 }).filter(
    s => !s.startsWith('[capability_profile]') && !s.startsWith('[learning_objective]')
  );

  it('[capability_profile] prefixed states are never present in the evidence pool', () => {
    // Feature: experience-based-capability-evidence, Property 3
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbCapabilityProfileText
          }),
          { minLength: 1, maxLength: 20 }
        ),
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbNormalStateText
          }),
          { minLength: 0, maxLength: 20 }
        ),
        (userId, orgId, prefixedShapes, normalShapes) => {
          const prefixedStates = prefixedShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.state_text
          }));

          const normalStates = normalShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.state_text
          }));

          const allStates = [...prefixedStates, ...normalStates];
          const pool = applyEvidencePool(allStates, userId, orgId);

          // No [capability_profile] prefixed state must appear in the pool
          const prefixedIds = new Set(prefixedStates.map(s => s.id));
          return pool.every(s => !prefixedIds.has(s.id));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('[learning_objective] prefixed states are never present in the evidence pool', () => {
    // Feature: experience-based-capability-evidence, Property 3
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbLearningObjectiveText
          }),
          { minLength: 1, maxLength: 20 }
        ),
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbNormalStateText
          }),
          { minLength: 0, maxLength: 20 }
        ),
        (userId, orgId, prefixedShapes, normalShapes) => {
          const prefixedStates = prefixedShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.state_text
          }));

          const normalStates = normalShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.state_text
          }));

          const allStates = [...prefixedStates, ...normalStates];
          const pool = applyEvidencePool(allStates, userId, orgId);

          // No [learning_objective] prefixed state must appear in the pool
          const prefixedIds = new Set(prefixedStates.map(s => s.id));
          return pool.every(s => !prefixedIds.has(s.id));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('normal states are unaffected when mixed with prefixed states', () => {
    // Feature: experience-based-capability-evidence, Property 3
    // Verifies that excluding prefixed states does not accidentally remove normal states
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            prefix: fc.constantFrom('[capability_profile]', '[learning_objective]'),
            suffix: fc.string({ minLength: 0, maxLength: 180 })
          }),
          { minLength: 1, maxLength: 10 }
        ),
        fc.array(
          fc.record({
            id: fc.uuid(),
            state_text: arbNormalStateText
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (userId, orgId, prefixedShapes, normalShapes) => {
          const prefixedStates = prefixedShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.prefix + s.suffix
          }));

          const normalStates = normalShapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.state_text
          }));

          const allStates = [...prefixedStates, ...normalStates];
          const pool = applyEvidencePool(allStates, userId, orgId);

          // All normal states must appear in the pool
          const normalIds = new Set(normalStates.map(s => s.id));
          return normalStates.every(s => pool.some(p => p.id === s.id)) &&
            // Pool size equals the number of normal states (prefixed ones are excluded)
            pool.filter(p => normalIds.has(p.id)).length === normalStates.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('pool is empty when all states have excluded prefixes', () => {
    // Feature: experience-based-capability-evidence, Property 3
    fc.assert(
      fc.property(
        arbUserId,
        arbOrgId,
        fc.array(
          fc.record({
            id: fc.uuid(),
            prefix: fc.constantFrom('[capability_profile]', '[learning_objective]'),
            suffix: fc.string({ minLength: 0, maxLength: 180 })
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (userId, orgId, shapes) => {
          const states = shapes.map(s => ({
            id: s.id,
            captured_by: userId,
            organization_id: orgId,
            state_text: s.prefix + s.suffix
          }));

          const pool = applyEvidencePool(states, userId, orgId);

          // When every state has an excluded prefix, the pool must be empty
          return pool.length === 0;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 4: Evidence items are returned in descending similarity order ──
// Feature: experience-based-capability-evidence, Property 4
// **Validates: Requirements 1.3**

describe('Property 4: Evidence items are returned in descending similarity order', () => {
  // Pure sort function that mirrors the ORDER BY similarity DESC in the per-axis query.
  // Takes an array of evidence items and returns them sorted by similarity descending.
  function sortBySimilarityDesc(items) {
    return [...items].sort((a, b) => b.similarity - a.similarity);
  }

  // Arbitrary for a similarity score: a finite float in [0, 1] (cosine similarity range)
  const arbSimilarity = fc.float({ min: 0, max: 1, noNaN: true });

  // Arbitrary for an evidence item with an arbitrary similarity score
  const arbEvidenceItem = fc.record({
    entity_id: fc.uuid(),
    state_text: fc.string({ minLength: 1, maxLength: 200 }),
    similarity: arbSimilarity
  });

  it('sorted result satisfies similarity_score[i] >= similarity_score[i+1] for all adjacent pairs', () => {
    // Feature: experience-based-capability-evidence, Property 4
    fc.assert(
      fc.property(
        fc.array(arbEvidenceItem, { minLength: 2, maxLength: 30 }),
        (items) => {
          const sorted = sortBySimilarityDesc(items);

          // Check every adjacent pair
          for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i].similarity < sorted[i + 1].similarity) {
              return false;
            }
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('single-item list is trivially ordered', () => {
    // Feature: experience-based-capability-evidence, Property 4
    fc.assert(
      fc.property(
        arbEvidenceItem,
        (item) => {
          const sorted = sortBySimilarityDesc([item]);
          return sorted.length === 1 && sorted[0].similarity === item.similarity;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty list produces an empty sorted result', () => {
    // Feature: experience-based-capability-evidence, Property 4
    const sorted = sortBySimilarityDesc([]);
    return sorted.length === 0;
  });

  it('sort is stable with respect to item count — no items are lost or duplicated', () => {
    // Feature: experience-based-capability-evidence, Property 4
    fc.assert(
      fc.property(
        fc.array(arbEvidenceItem, { minLength: 0, maxLength: 30 }),
        (items) => {
          const sorted = sortBySimilarityDesc(items);
          return sorted.length === items.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('highest similarity item is always first after sorting', () => {
    // Feature: experience-based-capability-evidence, Property 4
    fc.assert(
      fc.property(
        fc.array(arbEvidenceItem, { minLength: 1, maxLength: 30 }),
        (items) => {
          const sorted = sortBySimilarityDesc(items);
          const maxSimilarity = Math.max(...items.map(i => i.similarity));
          return sorted[0].similarity === maxSimilarity;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('lowest similarity item is always last after sorting', () => {
    // Feature: experience-based-capability-evidence, Property 4
    fc.assert(
      fc.property(
        fc.array(arbEvidenceItem, { minLength: 1, maxLength: 30 }),
        (items) => {
          const sorted = sortBySimilarityDesc(items);
          const minSimilarity = Math.min(...items.map(i => i.similarity));
          return sorted[sorted.length - 1].similarity === minSimilarity;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 5: Evidence count per axis never exceeds the configured limit ──
// Feature: experience-based-capability-evidence, Property 5
// **Validates: Requirement 1.4**

describe('Property 5: Evidence count per axis never exceeds the configured limit', () => {
  // Pure function that mirrors the LIMIT clause in the per-axis SQL query.
  // Takes a pool of eligible evidence items and a limit, and returns at most `limit` items.
  function applyEvidenceLimit(pool, limit) {
    return pool.slice(0, limit);
  }

  // Arbitrary for a positive integer evidence_limit (1–50, matching realistic aiConfig values)
  const arbEvidenceLimit = fc.integer({ min: 1, max: 50 });

  // Arbitrary for a single evidence item
  const arbEvidenceItem = fc.record({
    entity_id: fc.uuid(),
    state_text: fc.string({ minLength: 1, maxLength: 200 }),
    similarity: fc.float({ min: 0, max: 1, noNaN: true })
  });

  it('returned count is always <= evidence_limit for any pool size and limit', () => {
    // Feature: experience-based-capability-evidence, Property 5
    fc.assert(
      fc.property(
        arbEvidenceLimit,
        fc.array(arbEvidenceItem, { minLength: 0, maxLength: 100 }),
        (limit, pool) => {
          const result = applyEvidenceLimit(pool, limit);
          return result.length <= limit;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returned count is always <= evidence_limit when pool is larger than the limit', () => {
    // Feature: experience-based-capability-evidence, Property 5
    // Specifically exercises the case where the pool exceeds the limit
    fc.assert(
      fc.property(
        arbEvidenceLimit,
        fc.integer({ min: 1, max: 50 }).chain(extra =>
          fc.integer({ min: 1, max: 50 }).map(limit => ({ extra, limit }))
        ),
        fc.array(arbEvidenceItem, { minLength: 0, maxLength: 1 }),
        (limit, { extra }, _ignored) => {
          // Build a pool that is guaranteed to be larger than the limit
          const poolSize = limit + extra;
          const pool = Array.from({ length: poolSize }, (_, i) => ({
            entity_id: `entity-${i}`,
            state_text: `State text ${i}`,
            similarity: (poolSize - i) / poolSize
          }));

          const result = applyEvidenceLimit(pool, limit);
          return result.length <= limit;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returned count equals min(pool.length, evidence_limit)', () => {
    // Feature: experience-based-capability-evidence, Property 5
    // The limit is a ceiling: if the pool is smaller than the limit, all items are returned
    fc.assert(
      fc.property(
        arbEvidenceLimit,
        fc.array(arbEvidenceItem, { minLength: 0, maxLength: 100 }),
        (limit, pool) => {
          const result = applyEvidenceLimit(pool, limit);
          return result.length === Math.min(pool.length, limit);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no items are lost when pool is smaller than the limit', () => {
    // Feature: experience-based-capability-evidence, Property 5
    // When pool.length < limit, all pool items must be present in the result
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }).chain(limit =>
          fc.array(arbEvidenceItem, { minLength: 0, maxLength: limit - 1 }).map(pool => ({ limit, pool }))
        ),
        ({ limit, pool }) => {
          const result = applyEvidenceLimit(pool, limit);
          return result.length === pool.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('limit of 1 always returns at most 1 item regardless of pool size', () => {
    // Feature: experience-based-capability-evidence, Property 5
    fc.assert(
      fc.property(
        fc.array(arbEvidenceItem, { minLength: 0, maxLength: 50 }),
        (pool) => {
          const result = applyEvidenceLimit(pool, 1);
          return result.length <= 1;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 6: Evidence type classification is total and consistent ──
// Feature: experience-based-capability-evidence, Property 6
// **Validates: Requirements 2.2**

describe('Property 6: Evidence type classification is total and consistent', () => {
  // Known open-form question types
  const OPEN_FORM_TYPES = ['bridging', 'self_explanation', 'application', 'analysis', 'synthesis'];

  // Arbitrary for a recognition-pattern state text
  const arbRecognitionText = fc.string({ minLength: 0, maxLength: 100 }).map(
    prefix => prefix + ' which was the correct answer'
  );

  // Arbitrary for an open-form state text with a specific question type and evaluation state
  const arbOpenFormText = fc.record({
    questionType: fc.constantFrom(...OPEN_FORM_TYPES),
    evaluationVariant: fc.constantFrom('pending', 'error', 'sufficient', 'insufficient', 'unrecognized')
  }).map(({ questionType, evaluationVariant }) => {
    let evaluation;
    if (evaluationVariant === 'pending') {
      evaluation = 'pending.';
    } else if (evaluationVariant === 'error') {
      evaluation = 'error.';
    } else if (evaluationVariant === 'sufficient') {
      evaluation = 'sufficient (score: 3.5). Some reasoning text.';
    } else if (evaluationVariant === 'insufficient') {
      evaluation = 'insufficient (score: 1.2). Some reasoning text.';
    } else {
      // unrecognized evaluation portion — still matches open-form pattern
      evaluation = 'unrecognized evaluation format.';
    }
    return `For learning objective 'test objective' and ${questionType} question 'test question', I responded: 'my answer'. Ideal answer: 'ideal answer'. Evaluation: ${evaluation}`;
  });

  // Arbitrary for a random string (may or may not match any pattern)
  const arbRandomText = fc.oneof(
    fc.string({ minLength: 0, maxLength: 200 }),
    fc.constant(''),
    fc.constant(null),
    fc.constant(undefined)
  );

  // Helper: check structural validity of a result
  function isStructurallyValid(result) {
    // type must be exactly 'quiz' or 'observation'
    if (result.type !== 'quiz' && result.type !== 'observation') return false;

    if (result.type === 'observation') {
      // All other fields must be null
      return result.questionType === null &&
        result.continuousScore === null &&
        result.evaluationStatus === null;
    }

    // type === 'quiz'
    if (result.questionType === 'recognition') {
      // recognition: continuousScore and evaluationStatus must be null
      return result.continuousScore === null && result.evaluationStatus === null;
    }

    // open-form quiz: evaluationStatus must be one of the valid values or null
    const validEvalStatuses = new Set(['pending', 'sufficient', 'insufficient', 'error', null]);
    return validEvalStatuses.has(result.evaluationStatus);
  }

  it('returns a structurally valid result for recognition-pattern inputs', () => {
    // Feature: experience-based-capability-evidence, Property 6
    fc.assert(
      fc.property(
        arbRecognitionText,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return isStructurallyValid(result);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns a structurally valid result for open-form pattern inputs', () => {
    // Feature: experience-based-capability-evidence, Property 6
    fc.assert(
      fc.property(
        arbOpenFormText,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return isStructurallyValid(result);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns a structurally valid result for arbitrary random strings', () => {
    // Feature: experience-based-capability-evidence, Property 6
    fc.assert(
      fc.property(
        arbRandomText,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return isStructurallyValid(result);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('recognition inputs always produce type=quiz, questionType=recognition, nulls for score and status', () => {
    // Feature: experience-based-capability-evidence, Property 6
    fc.assert(
      fc.property(
        arbRecognitionText,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return result.type === 'quiz' &&
            result.questionType === 'recognition' &&
            result.continuousScore === null &&
            result.evaluationStatus === null;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('open-form inputs always produce type=quiz with a known open-form questionType', () => {
    // Feature: experience-based-capability-evidence, Property 6
    const knownOpenFormTypes = new Set(OPEN_FORM_TYPES);
    fc.assert(
      fc.property(
        arbOpenFormText,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return result.type === 'quiz' && knownOpenFormTypes.has(result.questionType);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('observation inputs always produce type=observation with all nulls', () => {
    // Feature: experience-based-capability-evidence, Property 6
    // Arbitrary for text that matches neither recognition nor open-form pattern
    const arbObservationText = fc.string({ minLength: 1, maxLength: 200 }).filter(s =>
      !s.toLowerCase().includes('which was the correct answer') &&
      !/^For learning objective '.+?' and \S+ question '.+?', I responded: '.+?'\. Ideal answer: '.+?'\. Evaluation: .+$/s.test(s)
    );
    fc.assert(
      fc.property(
        arbObservationText,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return result.type === 'observation' &&
            result.questionType === null &&
            result.continuousScore === null &&
            result.evaluationStatus === null;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('open-form inputs with pending evaluation have evaluationStatus=pending and null continuousScore', () => {
    // Feature: experience-based-capability-evidence, Property 6
    const arbPendingOpenForm = fc.constantFrom(...OPEN_FORM_TYPES).map(qt =>
      `For learning objective 'obj' and ${qt} question 'q', I responded: 'r'. Ideal answer: 'i'. Evaluation: pending.`
    );
    fc.assert(
      fc.property(
        arbPendingOpenForm,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return result.type === 'quiz' &&
            result.evaluationStatus === 'pending' &&
            result.continuousScore === null;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('open-form inputs with error evaluation have evaluationStatus=error and null continuousScore', () => {
    // Feature: experience-based-capability-evidence, Property 6
    const arbErrorOpenForm = fc.constantFrom(...OPEN_FORM_TYPES).map(qt =>
      `For learning objective 'obj' and ${qt} question 'q', I responded: 'r'. Ideal answer: 'i'. Evaluation: error.`
    );
    fc.assert(
      fc.property(
        arbErrorOpenForm,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return result.type === 'quiz' &&
            result.evaluationStatus === 'error' &&
            result.continuousScore === null;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('open-form inputs with scored evaluation have a numeric continuousScore and valid evaluationStatus', () => {
    // Feature: experience-based-capability-evidence, Property 6
    const arbScoredOpenForm = fc.record({
      questionType: fc.constantFrom(...OPEN_FORM_TYPES),
      verdict: fc.constantFrom('sufficient', 'insufficient'),
      score: fc.float({ min: 0, max: 5, noNaN: true })
    }).map(({ questionType, verdict, score }) =>
      `For learning objective 'obj' and ${questionType} question 'q', I responded: 'r'. Ideal answer: 'i'. Evaluation: ${verdict} (score: ${score.toFixed(1)}). Reasoning text.`
    );
    fc.assert(
      fc.property(
        arbScoredOpenForm,
        (stateText) => {
          const result = determineEvidenceTypeEnriched(stateText);
          return result.type === 'quiz' &&
            typeof result.continuousScore === 'number' &&
            (result.evaluationStatus === 'sufficient' || result.evaluationStatus === 'insufficient');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 7: Response shape is structurally complete for any valid input ──
// Feature: experience-based-capability-evidence, Property 7
// **Validates: Requirements 5.1**

describe('Property 7: Response shape is structurally complete for any valid input', () => {
  /**
   * Pure helper that mirrors the response construction logic in handlePerAxisCapability
   * and buildZeroCapabilityProfile. Given a skill profile, per-axis evidence map, and
   * a Bedrock result (or null for zero profile), it builds the capability response object.
   *
   * This is the pure-function equivalent of the Lambda response construction — no DB or
   * Bedrock calls needed. The test verifies the structural invariant holds for any valid input.
   */
  function buildCapabilityResponse(skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId) {
    const totalEvidenceCount = Object.values(perAxisEvidence).reduce(
      (sum, items) => sum + items.length,
      0
    );

    // Zero profile path: no evidence and no Bedrock result
    if (totalEvidenceCount === 0 && !bedrockResult) {
      return {
        user_id: userId,
        user_name: userName,
        action_id: actionId,
        narrative: 'No relevant evidence found.',
        axes: skillProfile.axes.map(axis => ({
          key: axis.key,
          label: axis.label,
          level: 0.0,
          evidence_count: 0,
          evidence: [],
          axis_narrative: ''
        })),
        total_evidence_count: 0,
        computed_at: new Date().toISOString()
      };
    }

    // Full profile path: Bedrock result available
    const axes = skillProfile.axes.map(skillAxis => {
      const aiAxis = bedrockResult
        ? bedrockResult.axes.find(a => a.key === skillAxis.key)
        : null;
      const rawLevel = aiAxis ? aiAxis.level : 0;
      const level = Math.round(Math.max(0, Math.min(5, rawLevel)) * 10) / 10;
      const axisEvidence = perAxisEvidence[skillAxis.key] || [];

      return {
        key: skillAxis.key,
        label: skillAxis.label,
        level,
        evidence_count: axisEvidence.length,
        evidence: axisEvidence.slice(0, 5),
        axis_narrative: aiAxis?.axis_narrative || ''
      };
    });

    return {
      user_id: userId,
      user_name: userName,
      action_id: actionId,
      narrative: bedrockResult?.narrative || 'Capability assessment completed.',
      axes,
      total_evidence_count: totalEvidenceCount,
      computed_at: new Date().toISOString()
    };
  }

  // ── Arbitraries ──

  const arbAxisKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/);
  const arbAxisLabel = fc.string({ minLength: 1, maxLength: 60 });

  // Arbitrary for a skill profile axis
  const arbSkillAxis = fc.record({
    key: arbAxisKey,
    label: arbAxisLabel,
    required_level: fc.integer({ min: 0, max: 5 }),
    description: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined })
  });

  // Arbitrary for a skill profile with 1–6 unique-keyed axes
  const arbSkillProfile = fc.array(arbSkillAxis, { minLength: 1, maxLength: 6 })
    .map(axes => {
      // Deduplicate axes by key — SQL queries require unique axis keys
      const seen = new Set();
      const uniqueAxes = axes.filter(a => {
        if (seen.has(a.key)) return false;
        seen.add(a.key);
        return true;
      });
      return {
        narrative: 'A skill profile for testing.',
        axes: uniqueAxes,
        approved_at: new Date().toISOString()
      };
    })
    .filter(sp => sp.axes.length >= 1);

  // Arbitrary for a single evidence item (mirrors the shape built in handlePerAxisCapability)
  const arbEvidenceItem = fc.record({
    observation_id: fc.uuid(),
    text_excerpt: fc.string({ minLength: 0, maxLength: 500 }),
    similarity_score: fc.float({ min: 0, max: 1, noNaN: true }),
    evidence_type: fc.constantFrom('quiz', 'observation'),
    question_type: fc.option(
      fc.constantFrom('recognition', 'bridging', 'self_explanation', 'application', 'analysis', 'synthesis'),
      { nil: null }
    ),
    continuous_score: fc.option(fc.float({ min: 0, max: 5, noNaN: true }), { nil: null }),
    evaluation_status: fc.option(
      fc.constantFrom('pending', 'sufficient', 'insufficient', 'error'),
      { nil: null }
    ),
    source_action_title: fc.string({ minLength: 0, maxLength: 100 })
  });

  // Arbitrary for a per-axis evidence map given a skill profile
  function arbPerAxisEvidence(skillProfile) {
    const axisKeys = skillProfile.axes.map(a => a.key);
    return fc.record(
      Object.fromEntries(
        axisKeys.map(key => [
          key,
          fc.array(arbEvidenceItem, { minLength: 0, maxLength: 10 })
        ])
      )
    );
  }

  // Arbitrary for a Bedrock result given a skill profile
  function arbBedrockResult(skillProfile) {
    return fc.record({
      narrative: fc.string({ minLength: 1, maxLength: 500 }),
      axes: fc.constant(
        skillProfile.axes.map(a => ({
          key: a.key,
          level: 0, // will be overridden per-test
          axis_narrative: ''
        }))
      )
    }).chain(base =>
      fc.record({
        narrative: fc.constant(base.narrative),
        axes: fc.array(
          fc.record({
            level: fc.float({ min: -1, max: 6, noNaN: true }), // intentionally out-of-range to test clamping
            axis_narrative: fc.string({ minLength: 0, maxLength: 300 })
          }),
          { minLength: skillProfile.axes.length, maxLength: skillProfile.axes.length }
        ).map(axisResults =>
          skillProfile.axes.map((a, i) => ({
            key: a.key,
            level: axisResults[i].level,
            axis_narrative: axisResults[i].axis_narrative
          }))
        )
      })
    );
  }

  // ── Structural validator ──

  function isValidResponseShape(response) {
    // Top-level required fields
    if (typeof response.user_id !== 'string') return false;
    if (typeof response.user_name !== 'string') return false;
    if (typeof response.action_id !== 'string') return false;
    if (typeof response.narrative !== 'string') return false;
    if (!Array.isArray(response.axes)) return false;
    if (typeof response.total_evidence_count !== 'number') return false;
    if (typeof response.computed_at !== 'string') return false;

    // Each axis must have the required fields with correct types and ranges
    for (const axis of response.axes) {
      if (typeof axis.key !== 'string') return false;
      if (typeof axis.label !== 'string') return false;
      if (typeof axis.level !== 'number') return false;
      if (axis.level < 0.0 || axis.level > 5.0) return false;
      if (typeof axis.evidence_count !== 'number') return false;
      if (!Array.isArray(axis.evidence)) return false;
      if (typeof axis.axis_narrative !== 'string') return false;
    }

    return true;
  }

  it('zero-evidence response always has all required top-level fields and valid axes', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile,
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        (skillProfile, userId, userName, actionId) => {
          // Zero evidence: empty map for all axes
          const perAxisEvidence = Object.fromEntries(
            skillProfile.axes.map(a => [a.key, []])
          );

          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, null, userId, userName, actionId
          );

          return isValidResponseShape(response);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('full-evidence response always has all required top-level fields and valid axes', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            arbBedrockResult(sp)
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          return isValidResponseShape(response);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('axes array length always equals the number of axes in the skill profile', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            fc.option(arbBedrockResult(sp), { nil: null })
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          return response.axes.length === skillProfile.axes.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('axis keys in response always match the skill profile axis keys', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            fc.option(arbBedrockResult(sp), { nil: null })
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          const profileKeys = skillProfile.axes.map(a => a.key);
          const responseKeys = response.axes.map(a => a.key);
          return profileKeys.every((k, i) => k === responseKeys[i]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('level is always clamped to [0.0, 5.0] even when Bedrock returns out-of-range values', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            arbBedrockResult(sp)
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          return response.axes.every(axis => axis.level >= 0.0 && axis.level <= 5.0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('total_evidence_count equals the sum of evidence items across all axes', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            fc.option(arbBedrockResult(sp), { nil: null })
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          const expectedTotal = Object.values(perAxisEvidence).reduce(
            (sum, items) => sum + items.length,
            0
          );

          return response.total_evidence_count === expectedTotal;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('evidence array per axis never exceeds 5 items (top-5 slice)', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            fc.option(arbBedrockResult(sp), { nil: null })
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          return response.axes.every(axis => axis.evidence.length <= 5);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('user_id, user_name, and action_id in response always match the inputs', () => {
    // Feature: experience-based-capability-evidence, Property 7
    fc.assert(
      fc.property(
        arbSkillProfile.chain(sp =>
          fc.tuple(
            fc.constant(sp),
            arbPerAxisEvidence(sp),
            fc.option(arbBedrockResult(sp), { nil: null })
          )
        ),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.uuid(),
        ([skillProfile, perAxisEvidence, bedrockResult], userId, userName, actionId) => {
          const response = buildCapabilityResponse(
            skillProfile, perAxisEvidence, bedrockResult, userId, userName, actionId
          );

          return response.user_id === userId &&
            response.user_name === userName &&
            response.action_id === actionId;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── determineEvidenceType tests ─────────────────────────────────────

describe('determineEvidenceType', () => {
  it('returns "quiz" for state texts containing "which was the correct answer"', () => {
    fc.assert(
      fc.property(
        arbStateText,
        (prefix) => {
          const stateText = prefix + ' which was the correct answer';
          return determineEvidenceType(stateText) === 'quiz';
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns "observation" for all other texts', () => {
    fc.assert(
      fc.property(
        arbStateText.filter(
          (s) => !s.toLowerCase().includes('which was the correct answer')
        ),
        (stateText) => {
          return determineEvidenceType(stateText) === 'observation';
        }
      ),
      { numRuns: 100 }
    );
  });

  it('is case-insensitive for the correct answer marker', () => {
    fc.assert(
      fc.property(
        arbStateText,
        fc.constantFrom(
          'which was the correct answer',
          'Which Was The Correct Answer',
          'WHICH WAS THE CORRECT ANSWER',
          'Which was the Correct Answer'
        ),
        (prefix, marker) => {
          const stateText = prefix + ' ' + marker;
          return determineEvidenceType(stateText) === 'quiz';
        }
      ),
      { numRuns: 100 }
    );
  });
});
