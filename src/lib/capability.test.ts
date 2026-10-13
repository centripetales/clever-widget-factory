/**
 * Unit Tests: Capability Computation Utility Functions
 *
 * Tests the shared utility functions extracted from lambda/capability/index.js:
 * - computeRecencyWeight: Time-bracket weighting for observations
 * - detectGap: Gap detection between requirement and capability levels
 * - buildEvidenceQuery: SQL query construction for evidence retrieval
 *
 * These functions are mirrored here because the Lambda uses /opt/nodejs/ imports
 * that can't be directly imported in Vitest (same pattern as skillProfile.test.ts).
 *
 * Validates: Requirements 3.6, 4.5
 */

import { describe, it, expect } from 'vitest';

// --- Mirror of computeRecencyWeight from lambda/capability/index.js ---

/**
 * Compute recency weight for an observation based on its capture date.
 * 0-30 days: 1.0, 30-90 days: 0.7, 90-180 days: 0.4, >180 days: 0.2
 */
function computeRecencyWeight(capturedAt: string | Date): number {
  const now = new Date();
  const captured = new Date(capturedAt);
  const daysDiff = (now.getTime() - captured.getTime()) / (1000 * 60 * 60 * 24);

  if (daysDiff <= 30) return 1.0;
  if (daysDiff <= 90) return 0.7;
  if (daysDiff <= 180) return 0.4;
  return 0.2;
}

// --- Mirror of detectGap from lambda/capability/index.js ---

/**
 * Detect whether a gap exists between requirement and capability levels.
 * Gap is detected when requirement - capability > threshold.
 */
function detectGap(requirementLevel: number, capabilityLevel: number, threshold = 0.3): boolean {
  return (requirementLevel - capabilityLevel) > threshold;
}

// --- buildEvidenceQuery extracted from inline SQL in handleIndividualCapability / handleOrganizationCapability ---

/**
 * Build the vector similarity search SQL query for retrieving observation evidence.
 * Extracted from the inline SQL in handleIndividualCapability and handleOrganizationCapability.
 */
function buildEvidenceQuery(
  skillProfileEmbedding: string,
  organizationId: string,
  userFilter?: { userId: string }
): string {
  const OBSERVATION_LIMIT = 50;

  const baseQuery = `SELECT
        entity_id,
        embedding_source,
        (1 - (embedding <=> '${skillProfileEmbedding}'::vector)) as similarity
      FROM unified_embeddings
      WHERE entity_type = 'state'
        AND organization_id = '${organizationId}'
      ORDER BY embedding <=> '${skillProfileEmbedding}'::vector
      LIMIT ${OBSERVATION_LIMIT}`;

  return baseQuery;
}

// --- Helper: create a date N days ago ---

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// --- Tests ---

describe('computeRecencyWeight', () => {
  describe('time bracket values', () => {
    it('returns 1.0 for observations captured today', () => {
      expect(computeRecencyWeight(new Date().toISOString())).toBe(1.0);
    });

    it('returns 1.0 for observations captured 15 days ago (within 0-30 bracket)', () => {
      expect(computeRecencyWeight(daysAgo(15).toISOString())).toBe(1.0);
    });

    it('returns 0.7 for observations captured 60 days ago (within 30-90 bracket)', () => {
      expect(computeRecencyWeight(daysAgo(60).toISOString())).toBe(0.7);
    });

    it('returns 0.4 for observations captured 120 days ago (within 90-180 bracket)', () => {
      expect(computeRecencyWeight(daysAgo(120).toISOString())).toBe(0.4);
    });

    it('returns 0.2 for observations captured 200 days ago (>180 bracket)', () => {
      expect(computeRecencyWeight(daysAgo(200).toISOString())).toBe(0.2);
    });

    it('returns 0.2 for observations captured 365 days ago', () => {
      expect(computeRecencyWeight(daysAgo(365).toISOString())).toBe(0.2);
    });
  });

  describe('boundary conditions', () => {
    it('returns 0.7 at 31 days (just past first bracket boundary)', () => {
      expect(computeRecencyWeight(daysAgo(31).toISOString())).toBe(0.7);
    });

    it('returns 0.4 at 91 days (just past second bracket boundary)', () => {
      expect(computeRecencyWeight(daysAgo(91).toISOString())).toBe(0.4);
    });

    it('returns 0.2 at 181 days (just past third bracket boundary)', () => {
      expect(computeRecencyWeight(daysAgo(181).toISOString())).toBe(0.2);
    });
  });

  describe('monotonicity', () => {
    it('more recent observations always get weight >= older observations', () => {
      const weights = [0, 15, 30, 31, 60, 90, 91, 120, 180, 181, 365].map(days =>
        computeRecencyWeight(daysAgo(days).toISOString())
      );

      for (let i = 0; i < weights.length - 1; i++) {
        expect(weights[i]).toBeGreaterThanOrEqual(weights[i + 1]);
      }
    });
  });

  describe('input formats', () => {
    it('accepts ISO string input', () => {
      expect(computeRecencyWeight(daysAgo(10).toISOString())).toBe(1.0);
    });

    it('accepts Date object input', () => {
      expect(computeRecencyWeight(daysAgo(10))).toBe(1.0);
    });
  });
});

describe('detectGap', () => {
  describe('gap detection with default threshold (0.3)', () => {
    it('detects gap when requirement - capability > 0.3', () => {
      expect(detectGap(0.8, 0.4)).toBe(true); // diff = 0.4
    });

    it('does not detect gap when requirement - capability < 0.3', () => {
      expect(detectGap(0.5, 0.4)).toBe(false); // diff = 0.1
    });

    it('does not detect gap when requirement - capability = 0.3 (boundary)', () => {
      expect(detectGap(0.6, 0.3)).toBe(false); // diff = 0.3 exactly
    });

    it('does not detect gap when capability exceeds requirement', () => {
      expect(detectGap(0.3, 0.8)).toBe(false); // diff = -0.5
    });

    it('does not detect gap when capability equals requirement', () => {
      expect(detectGap(0.5, 0.5)).toBe(false); // diff = 0.0
    });
  });

  describe('boundary conditions at default threshold', () => {
    it('detects gap at 0.31 difference (just above threshold)', () => {
      expect(detectGap(0.61, 0.3)).toBe(true); // diff = 0.31
    });

    it('does not detect gap at 0.30 difference (exactly at threshold)', () => {
      expect(detectGap(0.60, 0.3)).toBe(false); // diff = 0.30
    });

    it('does not detect gap at 0.29 difference (just below threshold)', () => {
      expect(detectGap(0.59, 0.3)).toBe(false); // diff = 0.29
    });
  });

  describe('extreme values', () => {
    it('detects gap when requirement is 1.0 and capability is 0.0', () => {
      expect(detectGap(1.0, 0.0)).toBe(true); // diff = 1.0
    });

    it('does not detect gap when both are 0.0', () => {
      expect(detectGap(0.0, 0.0)).toBe(false); // diff = 0.0
    });

    it('does not detect gap when both are 1.0', () => {
      expect(detectGap(1.0, 1.0)).toBe(false); // diff = 0.0
    });

    it('does not detect gap when requirement is 0.0 and capability is 1.0', () => {
      expect(detectGap(0.0, 1.0)).toBe(false); // diff = -1.0
    });
  });

  describe('custom threshold', () => {
    it('detects gap with custom threshold of 0.1', () => {
      expect(detectGap(0.5, 0.3, 0.1)).toBe(true); // diff = 0.2 > 0.1
    });

    it('does not detect gap at custom threshold boundary', () => {
      expect(detectGap(0.6, 0.4, 0.2)).toBe(false); // diff = 0.2 = threshold
    });

    it('detects gap with custom threshold of 0.5', () => {
      expect(detectGap(1.0, 0.4, 0.5)).toBe(true); // diff = 0.6 > 0.5
    });

    it('does not detect gap with custom threshold of 0.5 at boundary', () => {
      expect(detectGap(0.8, 0.3, 0.5)).toBe(false); // diff = 0.5 = threshold
    });

    it('detects gap with threshold of 0', () => {
      expect(detectGap(0.5, 0.4, 0)).toBe(true); // diff = 0.1 > 0
    });

    it('does not detect gap with threshold of 0 when equal', () => {
      expect(detectGap(0.5, 0.5, 0)).toBe(false); // diff = 0.0 = threshold
    });
  });
});

describe('buildEvidenceQuery', () => {
  const mockEmbedding = '[0.1,0.2,0.3]';
  const orgId = 'org-123';

  it('returns a SQL query string', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(typeof query).toBe('string');
  });

  it('queries the unified_embeddings table', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain('unified_embeddings');
  });

  it('filters by entity_type state', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain("entity_type = 'state'");
  });

  it('scopes by organization_id for multi-tenant isolation', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain(`organization_id = '${orgId}'`);
  });

  it('includes the skill profile embedding for vector similarity', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain(mockEmbedding);
  });

  it('limits results to 50 observations', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain('LIMIT 50');
  });

  it('selects entity_id, embedding_source, and similarity score', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain('entity_id');
    expect(query).toContain('embedding_source');
    expect(query).toContain('similarity');
  });

  it('orders by vector distance for relevance ranking', () => {
    const query = buildEvidenceQuery(mockEmbedding, orgId);
    expect(query).toContain('ORDER BY');
    expect(query).toContain('<=>');
  });

  it('uses different organization IDs correctly', () => {
    const query1 = buildEvidenceQuery(mockEmbedding, 'org-aaa');
    const query2 = buildEvidenceQuery(mockEmbedding, 'org-bbb');
    expect(query1).toContain("organization_id = 'org-aaa'");
    expect(query2).toContain("organization_id = 'org-bbb'");
  });
});
