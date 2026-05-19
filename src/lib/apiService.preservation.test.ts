/**
 * Preservation Property Tests — apiService
 *
 * These tests capture CURRENT CORRECT behavior on unfixed code.
 * They MUST PASS now and MUST STILL PASS after the fixes are applied (no regressions).
 *
 * Property 2a — Non-401 API Responses Unchanged
 *
 * Preservation requirement: For all API responses with status 200–399 or 403,
 * apiRequest produces no redirect and processes the response normally.
 *
 * Requirements: 3.4, 3.8
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
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

// ── Property 2a — Non-401 API Responses Unchanged ────────────────────────────
// **Validates: Requirements 3.4, 3.8**
//
// For all responses with status 200–399 or 403, window.location.href is never
// set to '/login' or '/auth'. The response is processed normally.
//
// This test MUST PASS on unfixed code (baseline preservation).

describe('Property 2a — Non-401 API Responses: no redirect occurs', () => {
  let locationHref: string | undefined;
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
    locationHref = undefined;

    // Mock window.location so we can detect any href assignments
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

    // Provide a valid JWT so requests proceed
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

  it('status 200 — no redirect, response returned normally', async () => {
    const mockData = { data: { id: 'action-1', narrative: 'AI narrative' } };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => mockData,
    } as Response);

    const result = await apiService.get('/skill-profiles/generate');

    expect(locationHref).toBeUndefined();
    expect(result).toEqual(mockData);
  });

  it('status 201 — no redirect, response returned normally', async () => {
    const mockData = { data: { created: true } };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => mockData,
    } as Response);

    const result = await apiService.post('/skill-profiles/approve', { action_id: 'a1' });

    expect(locationHref).toBeUndefined();
    expect(result).toEqual(mockData);
  });

  it('status 400 — no redirect, ApiError thrown', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'action_id is required' }),
    } as Response);

    await expect(apiService.post('/skill-profiles/generate', {})).rejects.toMatchObject({
      status: 400,
    });

    // No redirect should have occurred
    expect(locationHref).toBeUndefined();
  });

  it('status 403 — no redirect, ApiError thrown', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'Access denied' }),
    } as Response);

    await expect(apiService.get('/skill-profiles/generate')).rejects.toMatchObject({
      status: 403,
    });

    // No redirect should have occurred
    expect(locationHref).toBeUndefined();
  });

  it('status 500 — no redirect, ApiError thrown', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Internal error' }),
    } as Response);

    await expect(apiService.get('/skill-profiles/generate')).rejects.toMatchObject({
      status: 500,
    });

    // No redirect should have occurred
    expect(locationHref).toBeUndefined();
  });

  it('property-based: for all 2xx status codes, no redirect occurs', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate status codes in the 200–299 range (successful responses)
        fc.integer({ min: 200, max: 299 }),
        async (status) => {
          vi.clearAllMocks();
          clearTokenCache();
          locationHref = undefined;

          // Re-mock auth for each iteration
          const futureExp = Math.floor(Date.now() / 1000) + 3600;
          const payload = btoa(JSON.stringify({ exp: futureExp }));
          const validJWT = `header.${payload}.signature`;
          vi.mocked(fetchAuthSession).mockResolvedValue({
            tokens: { idToken: { toString: () => validJWT } },
          } as any);

          const mockData = { data: { status: 'ok' } };
          vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            status,
            statusText: 'OK',
            json: async () => mockData,
          } as Response);

          await apiService.get('/skill-profiles/generate');

          // No redirect should occur for any 2xx response
          expect(locationHref).toBeUndefined();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('property-based: for all 3xx-5xx non-401 error status codes, no redirect to /login or /auth', async () => {
    // Status codes that are NOT 401 — no auth redirect should occur
    const nonAuthErrorStatuses = [400, 403, 404, 409, 422, 500, 502, 503, 504];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...nonAuthErrorStatuses),
        async (status) => {
          vi.clearAllMocks();
          clearTokenCache();
          locationHref = undefined;

          const futureExp = Math.floor(Date.now() / 1000) + 3600;
          const payload = btoa(JSON.stringify({ exp: futureExp }));
          const validJWT = `header.${payload}.signature`;
          vi.mocked(fetchAuthSession).mockResolvedValue({
            tokens: { idToken: { toString: () => validJWT } },
          } as any);

          vi.mocked(fetch).mockResolvedValueOnce({
            ok: false,
            status,
            statusText: 'Error',
            json: async () => ({ error: `Error ${status}` }),
          } as Response);

          try {
            await apiService.get('/skill-profiles/generate');
          } catch {
            // Expected to throw for error status codes
          }

          // No redirect to /login or /auth should occur for non-401 responses
          expect(locationHref).not.toBe('/login');
          expect(locationHref).not.toBe('/auth');
        }
      ),
      { numRuns: nonAuthErrorStatuses.length }
    );
  });
});
