import { useMemo } from 'react';

/**
 * Represents the resolved tenant context for the current request.
 * - type 'platform': the visitor is on the Centripetal ES public site
 * - type 'org': the visitor is on a farm portal (orgSlug identifies which farm)
 */
export interface TenantContext {
  type: 'platform' | 'org';
  orgSlug: string | null; // null when type === 'platform'
}

/**
 * Static map of known custom tenant domains to their org slugs.
 * Only this map needs updating when a tenant gets a custom domain.
 * Adding a new tenant via path (centripetales.com/new-farm) requires no change here.
 */
const KNOWN_TENANT_DOMAINS: Record<string, string> = {
  'stargazer-farm.com': 'stargazer-farm',
};

/**
 * Path segments that are reserved for platform routes and must NOT be
 * interpreted as org slugs.
 */
const RESERVED_SEGMENTS = new Set(['', 'about', 'contact', 'auth']);

/**
 * Resolves tenant context from hostname and pathname.
 * Pure function — no side effects, no API calls.
 *
 * Resolution rules (in priority order):
 * 1. If hostname is 'localhost' → org context, slug = 'stargazer-farm'
 * 2. If hostname matches a known tenant domain (e.g. stargazer-farm.com) → org context, slug from map
 * 3. If first path segment is a non-reserved slug (not '', 'about', 'contact', 'auth') → org context, slug = segment
 * 4. Otherwise → platform context
 */
export function resolveTenant(hostname: string, pathname: string): TenantContext {
  // Rule 1: localhost always resolves to the default dev org
  if (hostname === 'localhost') {
    return { type: 'org', orgSlug: 'stargazer-farm' };
  }

  // Rule 2: known custom tenant domain
  // Use Object.hasOwn to avoid prototype property collisions (e.g. 'valueOf', 'toString')
  const knownSlug = Object.hasOwn(KNOWN_TENANT_DOMAINS, hostname)
    ? KNOWN_TENANT_DOMAINS[hostname]
    : undefined;
  if (knownSlug) {
    return { type: 'org', orgSlug: knownSlug };
  }

  // Rule 3: first path segment as org slug (e.g. centripetales.com/stargazer-farm)
  // pathname is expected to start with '/', e.g. '/stargazer-farm/dashboard'
  const firstSegment = pathname.split('/')[1] ?? '';
  if (!RESERVED_SEGMENTS.has(firstSegment) && firstSegment.length > 0) {
    return { type: 'org', orgSlug: firstSegment };
  }

  // Rule 4: platform fallback
  return { type: 'platform', orgSlug: null };
}

/**
 * React hook — reads window.location at mount time and returns a stable TenantContext.
 * Memoized with an empty dependency array so it resolves once at mount and does not
 * re-run on client-side navigation.
 */
export function useTenantContext(): TenantContext {
  return useMemo(
    () => resolveTenant(window.location.hostname, window.location.pathname),
    [] // intentionally empty — resolves once at mount
  );
}
