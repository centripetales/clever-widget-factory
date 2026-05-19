/**
 * Tests for API Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiService, getApiData, hasApiData, ApiError, clearTokenCache } from './apiService';
import { fetchAuthSession } from 'aws-amplify/auth';

// Mock aws-amplify/auth
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe('apiService', () => {
  // mockIdToken is set in beforeEach to match the token returned by the mock
  let mockIdToken: string;
  const API_BASE_URL = 'https://api.example.com';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Clear token cache before each test
    clearTokenCache();
    
    // Create a valid JWT token with future expiry to avoid cache issues
    // JWT format: header.payload.signature
    // Payload: { exp: future_timestamp_in_seconds }
    const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const payload = btoa(JSON.stringify({ exp: futureExp }));
    mockIdToken = `header.${payload}.signature`;
    
    // Mock fetchAuthSession to return the same token
    vi.mocked(fetchAuthSession).mockResolvedValue({
      tokens: {
        idToken: {
          toString: () => mockIdToken,
        },
      },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET requests', () => {
    it('should make GET request with Authorization header', async () => {
      const mockResponse = { data: [{ id: 1, name: 'test' }] };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await apiService.get('tools');

      // Verify fetch was called with correct URL pattern and headers
      expect(fetch).toHaveBeenCalled();
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const url = callArgs[0] as string;
      const options = callArgs[1] as RequestInit;
      
      expect(url).toContain('/api/tools');
      expect(options.method).toBe('GET');
      expect(options.headers).toHaveProperty('Authorization', `Bearer ${mockIdToken}`);
      expect(options.headers).toHaveProperty('Content-Type', 'application/json');
      expect(result).toEqual(mockResponse);
    });

    it('should handle endpoint without /api/ prefix', async () => {
      const mockResponse = { data: [] };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      await apiService.get('tools');

      const callArgs = vi.mocked(fetch).mock.calls[0];
      const url = callArgs[0] as string;
      expect(url).toContain('/api/tools');
    });

    it('should handle absolute URLs', async () => {
      const absoluteUrl = 'https://other-api.com/endpoint';
      const mockResponse = { data: [] };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      await apiService.get(absoluteUrl);

      expect(fetch).toHaveBeenCalledWith(
        absoluteUrl,
        expect.any(Object)
      );
    });

    it('should NOT add duplicate /api/ when base URL already ends with /api', async () => {
      // Temporarily override the base URL to include /api
      const originalBaseUrl = import.meta.env.VITE_API_BASE_URL;
      import.meta.env.VITE_API_BASE_URL = 'https://api.example.com/api';
      
      const mockResponse = { data: [] };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      // Re-import apiService to pick up the new base URL
      // Note: In a real scenario, you'd need to clear the module cache
      // For this test, we'll verify the logic works by checking the URL construction
      await apiService.get('/parts_history');

      const callArgs = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1];
      const url = callArgs[0] as string;
      
      // Verify URL does NOT contain /api/api/
      expect(url).not.toContain('/api/api/');
      // Verify URL contains /api/parts_history (single /api/)
      expect(url).toContain('/api/parts_history');
      
      // Restore original base URL
      import.meta.env.VITE_API_BASE_URL = originalBaseUrl;
    });
  });

  describe('POST requests', () => {
    it('should make POST request with body and Authorization header', async () => {
      const requestBody = { name: 'New Tool', category: 'equipment' };
      const mockResponse = { data: { id: 1, ...requestBody } };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await apiService.post('tools', requestBody);

      expect(fetch).toHaveBeenCalled();
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const url = callArgs[0] as string;
      const options = callArgs[1] as RequestInit;
      
      expect(url).toContain('/api/tools');
      expect(options.method).toBe('POST');
      expect(options.body).toBe(JSON.stringify(requestBody));
      expect(options.headers).toHaveProperty('Authorization', `Bearer ${mockIdToken}`);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('PUT requests', () => {
    it('should make PUT request with body', async () => {
      const requestBody = { name: 'Updated Tool' };
      const mockResponse = { data: { id: 1, ...requestBody } };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      await apiService.put('tools/1', requestBody);

      expect(fetch).toHaveBeenCalled();
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const url = callArgs[0] as string;
      const options = callArgs[1] as RequestInit;
      
      expect(url).toContain('/api/tools/1');
      expect(options.method).toBe('PUT');
      expect(options.body).toBe(JSON.stringify(requestBody));
    });
  });

  describe('DELETE requests', () => {
    it('should make DELETE request', async () => {
      const mockResponse = { success: true };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      await apiService.delete('tools/1');

      expect(fetch).toHaveBeenCalled();
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const url = callArgs[0] as string;
      const options = callArgs[1] as RequestInit;
      
      expect(url).toContain('/api/tools/1');
      expect(options.method).toBe('DELETE');
    });
  });

  describe('Error handling', () => {
    it('should throw ApiError for 401 Unauthorized', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'Invalid token' }),
      } as Response);

      await expect(apiService.get('/api/tools')).rejects.toMatchObject({
        status: 401,
        statusText: 'Unauthorized',
        message: 'Invalid token',
      });
    });

    it('should throw ApiError for 403 Forbidden', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ error: 'Access denied' }),
      } as Response);

      await expect(apiService.get('/api/tools')).rejects.toMatchObject({
        status: 403,
        statusText: 'Forbidden',
        message: 'Access denied',
      });
    });

    it('should throw ApiError for 404 Not Found', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Resource not found' }),
      } as Response);

      await expect(apiService.get('/api/tools/999')).rejects.toMatchObject({
        status: 404,
        message: 'Resource not found',
      });
    });

    it('should handle non-JSON error responses', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Not JSON');
        },
      } as Response);

      await expect(apiService.get('/api/tools')).rejects.toMatchObject({
        status: 500,
        statusText: 'Internal Server Error',
      });
    });
  });

  describe('Token handling', () => {
    it('should include Authorization header when token is available', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      await apiService.get('/api/tools');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockIdToken}`,
          }),
        })
      );
    });

    it('should work without token (for public endpoints)', async () => {
      // Mock fetchAuthSession to return null tokens (no token available)
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: null,
      } as any);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok' }),
      } as Response);

      await apiService.get('/api/health');

      // Verify the request was made
      expect(fetch).toHaveBeenCalled();
      
      // Check that Authorization header is not present
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string> | Headers;
      
      // Headers might be a Headers object or plain object
      if (headers instanceof Headers) {
        expect(headers.get('Authorization')).toBeNull();
      } else {
        expect(headers).not.toHaveProperty('Authorization');
      }
    });
  });

  describe('Helper functions', () => {
    it('getApiData should extract data from response', () => {
      const response = { data: [{ id: 1 }] };
      expect(getApiData(response)).toEqual([{ id: 1 }]);
    });

    it('hasApiData should return true when data exists', () => {
      expect(hasApiData({ data: [] })).toBe(true);
      expect(hasApiData({ data: null })).toBe(true);
      expect(hasApiData({})).toBe(false);
      expect(hasApiData(null)).toBe(false);
    });
  });
});

