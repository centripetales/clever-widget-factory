/**
 * Bug Condition Exploration Tests — apiService
 *
 * These tests encode the EXPECTED (correct) behavior.
 * They MUST FAIL on unfixed code — failure confirms the bug exists.
 * They will PASS after the fix is applied.
 *
 * Property 1b — Auth Redirect (Bug 3)
 *
 * Bug condition: response.status === 401 AND (tokenRefreshFailed OR isRetry)
 * Expected behavior: window.location.href === '/auth'
 * Current (buggy) behavior: window.location.href === '/login'
 *
 * Counterexample: window.location.href set to '/login' instead of '/auth'
 *
 * Requirements: 1.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiService, clearTokenCache } from './apiService';
import { fetchAuthSession } from 'aws-amplify/auth';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  getWebSocketConnectionId: vi.fn(() => null),
}));

global.fetch = vi.fn();

// ── Property 1b — Auth Redirect ───────────────────────────────────────────────
// **Validates: Requirements 1.3**
//
// This test MUST FAIL on unfixed code.
// Counterexample: window.location.href === '/login' instead of '/auth'

describe('Property 1b — Auth Redirect on unrecoverable 401', () => {
  // Capture window.location.href assignments
  let locationHref: string | undefined;
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
    locationHref = undefined;

    // Mock window.location so we can capture href assignments
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        get href() {
          return locationHref ?? '/';
        },
        set href(value: string) {
          locationHref = value;
        },
      },
    });

    // Provide a valid JWT so the initial request proceeds
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = btoa(JSON.stringify({ exp: futureExp }));
    const validJWT = `header.${payload}.signature`;

    vi.mocked(fetchAuthSession).mockResolvedValue({
      tokens: {
        idToken: { toString: () => validJWT },
      },
    } as any);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it('redirects to /auth (not /login) when token refresh fails on 401', async () => {
    // First fetch: 401 Unauthorized — triggers token refresh attempt
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Token expired' }),
    } as Response);

    // Token refresh fails
    vi.mocked(fetchAuthSession).mockRejectedValueOnce(new Error('Refresh failed'));

    // Make the request — it will hit 401, try to refresh, fail, then redirect
    try {
      await apiService.get('/skill-profiles/generate');
    } catch {
      // Expected to throw after redirect
    }

    // Assert redirect goes to /auth, not /login
    // FAILS on unfixed code: locationHref === '/login'
    // PASSES after fix:      locationHref === '/auth'
    expect(locationHref).toBe('/auth');
  });

  it('redirects to /auth (not /login) when retry also returns 401', async () => {
    // First fetch: 401 — triggers refresh + retry
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Token expired' }),
    } as Response);

    // Token refresh succeeds (returns a new valid token)
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = btoa(JSON.stringify({ exp: futureExp }));
    const refreshedJWT = `header.${payload}.refreshed`;
    vi.mocked(fetchAuthSession)
      .mockResolvedValueOnce({
        tokens: { idToken: { toString: () => refreshedJWT } },
      } as any)
      // Second call for the retry request
      .mockResolvedValueOnce({
        tokens: { idToken: { toString: () => refreshedJWT } },
      } as any);

    // Retry fetch: also 401 — triggers final redirect
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Still unauthorized' }),
    } as Response);

    // Make the request — it will hit 401, refresh, retry, hit 401 again, then redirect
    try {
      await apiService.get('/skill-profiles/generate');
    } catch {
      // Expected to throw after redirect
    }

    // Assert redirect goes to /auth, not /login
    // FAILS on unfixed code: locationHref === '/login'
    // PASSES after fix:      locationHref === '/auth'
    expect(locationHref).toBe('/auth');
  });
});
