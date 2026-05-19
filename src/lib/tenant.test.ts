/**
 * Tests for src/lib/tenant.ts
 *
 * Covers:
 *   - Unit tests for all resolveTenant() resolution branches (Task 1.4)
 *   - Property-based tests for Properties 1, 2, and 3 (Task 1.5)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveTenant, type TenantContext } from './tenant';

// ---------------------------------------------------------------------------
// Unit Tests (Task 1.4)
// ---------------------------------------------------------------------------

describe('resolveTenant — unit tests', () => {
  // Rule 1: localhost
  describe('localhost', () => {
    it('resolves localhost to stargazer-farm org context', () => {
      const result = resolveTenant('localhost', '/');
      expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
    });

    it('resolves localhost with any pathname to stargazer-farm org context', () => {
      expect(resolveTenant('localhost', '/dashboard')).toEqual({
        type: 'org',
        orgSlug: 'stargazer-farm',
      });
      expect(resolveTenant('localhost', '/about')).toEqual({
        type: 'org',
        orgSlug: 'stargazer-farm',
      });
    });
  });

  // Rule 2: known tenant hostname
  describe('known tenant hostname', () => {
    it('resolves stargazer-farm.com to stargazer-farm org context', () => {
      const result = resolveTenant('stargazer-farm.com', '/');
      expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
    });

    it('resolves stargazer-farm.com with a path to stargazer-farm org context', () => {
      const result = resolveTenant('stargazer-farm.com', '/dashboard');
      expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
    });
  });

  // Rule 3: path-based org slug
  describe('path-based org slug on platform hostname', () => {
    it('resolves centripetales.com + org path segment to org context', () => {
      const result = resolveTenant('centripetales.com', '/stargazer-farm');
      expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
    });

    it('resolves centripetales.com + org path with trailing slash to org context', () => {
      const result = resolveTenant('centripetales.com', '/stargazer-farm/');
      expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
    });

    it('extracts first segment from nested path correctly', () => {
      const result = resolveTenant('centripetales.com', '/stargazer-farm/dashboard/actions');
      expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
    });
  });

  // Rule 4: platform fallback
  describe('platform context fallback', () => {
    it('resolves centripetales.com with no org path to platform context', () => {
      const result = resolveTenant('centripetales.com', '/');
      expect(result).toEqual({ type: 'platform', orgSlug: null });
    });

    it('resolves unknown hostname with no org path to platform context', () => {
      const result = resolveTenant('unknown-host.example.com', '/');
      expect(result).toEqual({ type: 'platform', orgSlug: null });
    });

    it('resolves unknown hostname to platform context (safe fallback)', () => {
      const result = resolveTenant('some-random-host.io', '/');
      expect(result).toEqual({ type: 'platform', orgSlug: null });
    });
  });

  // Reserved path segments
  describe('reserved path segments → platform context', () => {
    it('treats /about as platform context', () => {
      expect(resolveTenant('centripetales.com', '/about')).toEqual({
        type: 'platform',
        orgSlug: null,
      });
    });

    it('treats /contact as platform context', () => {
      expect(resolveTenant('centripetales.com', '/contact')).toEqual({
        type: 'platform',
        orgSlug: null,
      });
    });

    it('treats /auth as platform context', () => {
      expect(resolveTenant('centripetales.com', '/auth')).toEqual({
        type: 'platform',
        orgSlug: null,
      });
    });

    it('treats empty path segment (root /) as platform context', () => {
      expect(resolveTenant('centripetales.com', '/')).toEqual({
        type: 'platform',
        orgSlug: null,
      });
    });

    it('treats /about/something as platform context (first segment is reserved)', () => {
      expect(resolveTenant('centripetales.com', '/about/something')).toEqual({
        type: 'platform',
        orgSlug: null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Property-Based Tests (Task 1.5)
// ---------------------------------------------------------------------------

/**
 * Checks that a value is a valid TenantContext:
 * - not null/undefined
 * - type is 'platform' or 'org'
 * - if type is 'platform', orgSlug is null
 * - if type is 'org', orgSlug is a non-empty string
 */
function isValidTenantContext(ctx: unknown): ctx is TenantContext {
  if (ctx === null || ctx === undefined) return false;
  const c = ctx as TenantContext;
  if (c.type !== 'platform' && c.type !== 'org') return false;
  if (c.type === 'platform' && c.orgSlug !== null) return false;
  if (c.type === 'org' && (typeof c.orgSlug !== 'string' || c.orgSlug.length === 0)) return false;
  return true;
}

/** Non-reserved slug: alphanumeric + hyphens, not in the reserved set */
const RESERVED = new Set(['', 'about', 'contact', 'auth']);

const arbNonReservedSlug = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/)
  .filter((s) => !RESERVED.has(s));

describe('Feature: centripetal-es-website — Property-Based Tests', () => {
  /**
   * Property 1: Deterministic and total
   * Validates: Requirements 1.5, 1.6
   */
  it('Property 1: resolveTenant is total — always returns a valid TenantContext for any input', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (hostname, pathname) => {
        /** Validates: Requirements 1.5, 1.6 */
        let result: TenantContext | undefined;
        expect(() => {
          result = resolveTenant(hostname, pathname);
        }).not.toThrow();
        expect(isValidTenantContext(result)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 2: Localhost invariant
   * Validates: Requirements 1.7
   */
  it('Property 2: localhost always resolves to { type: "org", orgSlug: "stargazer-farm" }', () => {
    fc.assert(
      fc.property(fc.string(), (pathname) => {
        /** Validates: Requirements 1.7 */
        const result = resolveTenant('localhost', pathname);
        expect(result).toEqual({ type: 'org', orgSlug: 'stargazer-farm' });
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 3: Path-based org resolution round-trips
   * Validates: Requirements 1.3, 1.5
   */
  it('Property 3: non-reserved path slug on centripetales.com resolves to org context with that slug', () => {
    fc.assert(
      fc.property(arbNonReservedSlug, (slug) => {
        /** Validates: Requirements 1.3, 1.5 */
        const result = resolveTenant('centripetales.com', '/' + slug);
        expect(result).toEqual({ type: 'org', orgSlug: slug });
      }),
      { numRuns: 200 }
    );
  });
});
