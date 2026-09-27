/**
 * CORS Test Suite
 * 
 * Tests that all API endpoints properly handle CORS:
 * 1. OPTIONS preflight requests return correct CORS headers
 * 2. Actual requests return CORS headers in responses
 * 
 * This test can be run against:
 * - Local development server (http://localhost:3001)
 * - AWS API Gateway (production/staging)
 * 
 * Usage:
 *   # Test against default production API
 *   npm test apiService.cors.test.ts
 * 
 *   # Test against local development server
 *   VITE_API_BASE_URL=http://localhost:3001 npm test apiService.cors.test.ts
 * 
 *   # Test against staging (works in both local and CI)
 *   VITE_API_BASE_URL=https://staging-api.example.com/api npm test apiService.cors.test.ts
 *   API_BASE_URL=https://staging-api.example.com/api npm test apiService.cors.test.ts
 * 
 * GitHub Actions:
 *   The workflow automatically sets VITE_API_BASE_URL to the production API.
 *   To test against a different environment, add it to the workflow's env section.
 * 
 * Note: Some tests may fail if endpoints require authentication. This is expected
 * and the test will still verify that CORS headers are present even in error responses.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Get API base URL from environment
// In Vitest/Node.js: process.env takes precedence (for CI/CD)
// In Vite/Browser: import.meta.env is used (for local dev)
// Fallback to production API if neither is set
const API_BASE_URL = 
  process.env.VITE_API_BASE_URL || 
  process.env.API_BASE_URL || 
  import.meta.env.VITE_API_BASE_URL || 
  'https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api';

// Required CORS headers
const REQUIRED_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': expect.stringContaining('GET'),
  'Access-Control-Allow-Headers': expect.stringContaining('Content-Type'),
};

// All API endpoints to test
// Format: { path: string, methods: string[], requiresAuth?: boolean }
const API_ENDPOINTS = [
  // Health and schema
  { path: '/health', methods: ['GET', 'OPTIONS'] },
  { path: '/schema', methods: ['GET', 'OPTIONS'] },
  
  // Tools
  { path: '/tools', methods: ['GET', 'OPTIONS'] },
  { path: '/tools/00000000-0000-0000-0000-000000000001', methods: ['PUT', 'OPTIONS'], requiresAuth: true },
  
  // Parts
  { path: '/parts', methods: ['GET', 'OPTIONS'] },
  { path: '/parts/00000000-0000-0000-0000-000000000001', methods: ['PUT', 'OPTIONS'], requiresAuth: true },
  { path: '/parts_history', methods: ['GET', 'POST', 'OPTIONS'] },
  
  // Actions
  { path: '/actions', methods: ['GET', 'POST', 'OPTIONS'] },
  { path: '/actions/00000000-0000-0000-0000-000000000001', methods: ['PUT', 'DELETE', 'OPTIONS'], requiresAuth: true },
  { path: '/action_implementation_updates', methods: ['GET', 'POST', 'OPTIONS'] },
  
  // Organization
  { path: '/organization_members', methods: ['GET', 'POST', 'OPTIONS'] },
  { path: '/profiles', methods: ['GET', 'POST', 'OPTIONS'] },
  
  // Issues
  { path: '/issues', methods: ['GET', 'POST', 'OPTIONS'] },
  { path: '/issues/00000000-0000-0000-0000-000000000001', methods: ['GET', 'PUT', 'OPTIONS'], requiresAuth: true },
  { path: '/issue_history', methods: ['POST', 'OPTIONS'] },
  
  // Parts Orders
  { path: '/parts_orders', methods: ['GET', 'OPTIONS'] },
  
  // Query endpoint
  { path: '/query', methods: ['POST', 'OPTIONS'], requiresAuth: true },
];

/**
 * Test OPTIONS preflight request for CORS
 */
async function testOptionsPreflight(url: string): Promise<Response> {
  const response = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://localhost:8080',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Content-Type,Authorization',
    },
  });
  return response;
}

/**
 * Test actual request for CORS headers
 */
async function testActualRequest(url: string, method: string = 'GET', body?: any): Promise<Response> {
  const options: RequestInit = {
    method,
    headers: {
      'Origin': 'http://localhost:8080',
      'Content-Type': 'application/json',
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  return response;
}

/**
 * Check if response has required CORS headers
 */
function checkCorsHeaders(response: Response, endpoint: string) {
  const headers = response.headers;
  
  // Check Access-Control-Allow-Origin
  const allowOrigin = headers.get('Access-Control-Allow-Origin');
  expect(allowOrigin, `${endpoint}: Missing or invalid Access-Control-Allow-Origin header`).toBeTruthy();
  expect(allowOrigin, `${endpoint}: Access-Control-Allow-Origin should be * or specific origin`).toMatch(/^\*$|^https?:\/\/.+/);
  
  // For OPTIONS requests, check additional headers
  if (response.status === 200 && allowOrigin) {
    const allowMethods = headers.get('Access-Control-Allow-Methods');
    const allowHeaders = headers.get('Access-Control-Allow-Headers');
    
    if (allowMethods) {
      expect(allowMethods, `${endpoint}: Access-Control-Allow-Methods should include common methods`).toMatch(/GET|POST|PUT|DELETE|OPTIONS/);
    }
    
    if (allowHeaders) {
      expect(allowHeaders, `${endpoint}: Access-Control-Allow-Headers should include Content-Type`).toMatch(/Content-Type/i);
    }
  }
  
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': headers.get('Access-Control-Allow-Methods'),
    'Access-Control-Allow-Headers': headers.get('Access-Control-Allow-Headers'),
  };
}

describe('CORS Configuration Tests', () => {
  beforeAll(() => {
    console.log(`Testing CORS against: ${API_BASE_URL}`);
  });

  describe('OPTIONS Preflight Requests', () => {
    API_ENDPOINTS.forEach(({ path, methods }) => {
      if (!methods.includes('OPTIONS')) {
        return;
      }

      it(`should handle OPTIONS preflight for ${path}`, async () => {
        const url = `${API_BASE_URL}${path}`;
        const response = await testOptionsPreflight(url);
        
        // OPTIONS should return 200 or 403 (403 is acceptable for endpoints that require auth)
        // The important thing is that CORS headers are present
        expect([200, 403]).toContain(response.status);
        
        // Check CORS headers (should be present even in 403 responses)
        const corsHeaders = checkCorsHeaders(response, path);
        
        expect(corsHeaders['Access-Control-Allow-Origin'], `${path}: Must have Access-Control-Allow-Origin`).toBeTruthy();
      }, 10000); // 10 second timeout for network requests
    });
  });

  describe('Actual Request CORS Headers', () => {
    // Test GET requests (most common, least likely to require auth)
    API_ENDPOINTS.forEach(({ path, methods, requiresAuth }) => {
      if (!methods.includes('GET')) {
        return;
      }

      it(`should include CORS headers in GET response for ${path}`, async () => {
        const url = `${API_BASE_URL}${path}`;
        
        try {
          const response = await testActualRequest(url, 'GET');
          
          // Even if the request fails (401, 403, etc.), CORS headers should be present
          const corsHeaders = checkCorsHeaders(response, path);
          
          expect(corsHeaders['Access-Control-Allow-Origin'], `${path}: GET response must have Access-Control-Allow-Origin`).toBeTruthy();
        } catch (error) {
          // Network errors are acceptable for this test - we're testing CORS, not connectivity
          if (error instanceof TypeError && error.message.includes('fetch')) {
            console.warn(`Skipping ${path}: Network error (endpoint may not be accessible)`);
            return;
          }
          throw error;
        }
      }, 10000);
    });

    // Test POST requests for endpoints that support them
    API_ENDPOINTS.forEach(({ path, methods, requiresAuth }) => {
      if (!methods.includes('POST')) {
        return;
      }

      it(`should include CORS headers in POST response for ${path}`, async () => {
        const url = `${API_BASE_URL}${path}`;
        
        // Use minimal valid body for POST requests
        const testBody = path.includes('query') 
          ? { sql: 'SELECT 1', params: [] }
          : path.includes('profiles')
          ? { user_id: 'test-user-id' }
          : {};
        
        try {
          const response = await testActualRequest(url, 'POST', testBody);
          
          // Even if the request fails (401, 403, 400, etc.), CORS headers should be present
          const corsHeaders = checkCorsHeaders(response, path);
          
          expect(corsHeaders['Access-Control-Allow-Origin'], `${path}: POST response must have Access-Control-Allow-Origin`).toBeTruthy();
        } catch (error) {
          // Network errors are acceptable for this test
          if (error instanceof TypeError && error.message.includes('fetch')) {
            console.warn(`Skipping ${path}: Network error (endpoint may not be accessible)`);
            return;
          }
          throw error;
        }
      }, 10000);
    });
  });

  describe('CORS Header Consistency', () => {
    it('should have consistent CORS headers across all endpoints', async () => {
      const corsHeadersMap = new Map<string, Set<string>>();
      
      // Test a sample of endpoints
      const sampleEndpoints = API_ENDPOINTS.slice(0, 5);
      
      for (const { path } of sampleEndpoints) {
        const url = `${API_BASE_URL}${path}`;
        try {
          const response = await testOptionsPreflight(url);
          const allowOrigin = response.headers.get('Access-Control-Allow-Origin');
          
          if (allowOrigin) {
            if (!corsHeadersMap.has('Access-Control-Allow-Origin')) {
              corsHeadersMap.set('Access-Control-Allow-Origin', new Set());
            }
            corsHeadersMap.get('Access-Control-Allow-Origin')!.add(allowOrigin);
          }
        } catch (error) {
          // Skip network errors
          if (error instanceof TypeError && error.message.includes('fetch')) {
            continue;
          }
        }
      }
      
      // All endpoints should use the same Access-Control-Allow-Origin value
      const allowOriginValues = corsHeadersMap.get('Access-Control-Allow-Origin');
      if (allowOriginValues && allowOriginValues.size > 0) {
        expect(allowOriginValues.size, 'All endpoints should use the same Access-Control-Allow-Origin value').toBeLessThanOrEqual(1);
      }
    }, 30000);
  });

  describe('CORS Error Response Handling', () => {
    it('should include CORS headers even in error responses (401, 403, 404, 500)', async () => {
      // Test that error responses still include CORS headers
      const testEndpoints = [
        '/actions/invalid-id-12345', // Should return 404 or 400
        '/tools/invalid-id-12345',    // Should return 404 or 400
      ];

      for (const path of testEndpoints) {
        const url = `${API_BASE_URL}${path}`;
        try {
          const response = await testActualRequest(url, 'GET');
          
          // Even error responses should have CORS headers
          const allowOrigin = response.headers.get('Access-Control-Allow-Origin');
          expect(allowOrigin, `${path}: Error responses must include CORS headers`).toBeTruthy();
        } catch (error) {
          // Network errors are acceptable
          if (error instanceof TypeError && error.message.includes('fetch')) {
            console.warn(`Skipping ${path}: Network error`);
            continue;
          }
          throw error;
        }
      }
    }, 20000);
  });
});

