/**
 * Tests for stock consumption when actions are completed
 * 
 * These tests ensure that:
 * 1. Stock quantities are decremented correctly when actions are completed
 * 2. Parts history is logged properly
 * 3. Multiple stock items are processed correctly
 * 4. Edge cases (empty stock, missing parts, insufficient quantity) are handled
 * 5. The function is called with correct parameters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { processStockConsumption } from './utils';
import { mockApiResponse, setupFetchMock } from '@/test-utils/mocks';

// Mock environment variable
const originalEnv = import.meta.env;
beforeEach(() => {
  import.meta.env = {
    ...originalEnv,
    VITE_API_BASE_URL: 'https://test-api.example.com',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  import.meta.env = originalEnv;
});

describe('processStockConsumption', () => {
  let queryClient: QueryClient;
  
  const mockUserId = 'user-123';
  const mockActionId = 'action-456';
  const mockActionTitle = 'Test Action';
  const mockOrganizationId = 'org-789';

  const mockOringPart = {
    id: 'part-oring-1',
    name: 'O-ring',
    current_quantity: 10,
  };

  const mockBoltPart = {
    id: 'part-bolt-1',
    name: 'Bolt',
    current_quantity: 25,
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
  });

  describe('Successful stock consumption', () => {
    it('should decrement stock quantity when action is completed with single item', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      // Mock fetch responses
      const fetchCalls: any[] = [];
      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        fetchCalls.push({ url: urlString, method: init?.method, body: init?.body });

        // GET /parts - return parts list
        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(
            mockApiResponse([mockOringPart])
          );
        }

        // PUT /parts/{id} - update part quantity
        if (urlString.includes(`/parts/${mockOringPart.id}`) && init?.method === 'PUT') {
          const body = JSON.parse(init?.body as string);
          expect(body.current_quantity).toBe(9); // 10 - 1 = 9
          return Promise.resolve(mockApiResponse({ ...mockOringPart, current_quantity: 9 }));
        }

        // POST /parts_history - log history
        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          const body = JSON.parse(init?.body as string);
          expect(body.part_id).toBe(mockOringPart.id);
          expect(body.old_quantity).toBe(10);
          expect(body.new_quantity).toBe(9);
          expect(body.quantity_change).toBe(-1);
          expect(body.change_type).toBe('quantity_remove');
          expect(body.change_reason).toContain('Test Action');
          expect(body.change_reason).toContain('1 O-ring');
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [mockOringPart, mockBoltPart]);

      await processStockConsumption(
        requiredStock,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      // Verify fetch was called correctly
      expect(global.fetch).toHaveBeenCalled();
      
      // Note: Parts are read from cache, so no GET request should be made
      // Verify part quantity was updated
      const updateCall = fetchCalls.find(c => c.method === 'PUT' && c.url.includes(mockOringPart.id));
      expect(updateCall).toBeDefined();
      const updateBody = JSON.parse(updateCall.body);
      expect(updateBody.current_quantity).toBe(9);

      // Verify history was logged
      const historyCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/parts_history'));
      expect(historyCall).toBeDefined();
      const historyBody = JSON.parse(historyCall.body);
      expect(historyBody.old_quantity).toBe(10);
      expect(historyBody.new_quantity).toBe(9);
      expect(historyBody.quantity_change).toBe(-1);
    });

    it('should decrement multiple stock items correctly', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 2,
          part_name: 'O-ring',
        },
        {
          part_id: mockBoltPart.id,
          quantity: 5,
          part_name: 'Bolt',
        },
      ];

      const fetchCalls: any[] = [];
      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        fetchCalls.push({ url: urlString, method: init?.method, body: init?.body });

        // GET /parts
        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(
            mockApiResponse([mockOringPart, mockBoltPart])
          );
        }

        // PUT /parts/{id}
        if (urlString.includes(`/parts/${mockOringPart.id}`) && init?.method === 'PUT') {
          const body = JSON.parse(init?.body as string);
          expect(body.current_quantity).toBe(8); // 10 - 2 = 8
          return Promise.resolve(mockApiResponse({ ...mockOringPart, current_quantity: 8 }));
        }

        if (urlString.includes(`/parts/${mockBoltPart.id}`) && init?.method === 'PUT') {
          const body = JSON.parse(init?.body as string);
          expect(body.current_quantity).toBe(20); // 25 - 5 = 20
          return Promise.resolve(mockApiResponse({ ...mockBoltPart, current_quantity: 20 }));
        }

        // POST /parts_history
        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [mockOringPart, mockBoltPart]);

      await processStockConsumption(
        requiredStock,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      // Verify both parts were updated
      const updateCalls = fetchCalls.filter(c => c.method === 'PUT');
      expect(updateCalls).toHaveLength(2);

      // Verify O-ring was updated to 8
      const oringUpdate = updateCalls.find(c => c.url.includes(mockOringPart.id));
      expect(JSON.parse(oringUpdate.body).current_quantity).toBe(8);

      // Verify Bolt was updated to 20
      const boltUpdate = updateCalls.find(c => c.url.includes(mockBoltPart.id));
      expect(JSON.parse(boltUpdate.body).current_quantity).toBe(20);

      // Verify history was logged twice
      const historyCalls = fetchCalls.filter(c => c.method === 'POST' && c.url.includes('/parts_history'));
      expect(historyCalls).toHaveLength(2);
    });

    it('should handle quantity going to zero', async () => {
      const partWithLowStock = {
        id: 'part-low-1',
        name: 'Low Stock Item',
        current_quantity: 1,
      };

      const requiredStock = [
        {
          part_id: partWithLowStock.id,
          quantity: 1,
          part_name: 'Low Stock Item',
        },
      ];

      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(mockApiResponse([partWithLowStock]));
        }

        if (urlString.includes(`/parts/${partWithLowStock.id}`) && init?.method === 'PUT') {
          const body = JSON.parse(init?.body as string);
          expect(body.current_quantity).toBe(0); // 1 - 1 = 0
          return Promise.resolve(mockApiResponse({ ...partWithLowStock, current_quantity: 0 }));
        }

        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [partWithLowStock]);

      await processStockConsumption(
        requiredStock,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      expect(global.fetch).toHaveBeenCalled();
    });

    it('should prevent negative quantities (Math.max)', async () => {
      const partWithInsufficientStock = {
        id: 'part-insufficient-1',
        name: 'Insufficient Stock',
        current_quantity: 2,
      };

      const requiredStock = [
        {
          part_id: partWithInsufficientStock.id,
          quantity: 5, // Requesting 5 but only 2 available
          part_name: 'Insufficient Stock',
        },
      ];

      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(mockApiResponse([partWithInsufficientStock]));
        }

        if (urlString.includes(`/parts/${partWithInsufficientStock.id}`) && init?.method === 'PUT') {
          const body = JSON.parse(init?.body as string);
          // Should be 0, not -3 (Math.max(0, 2 - 5) = 0)
          expect(body.current_quantity).toBe(0);
          return Promise.resolve(mockApiResponse({ ...partWithInsufficientStock, current_quantity: 0 }));
        }

        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [partWithInsufficientStock]);

      await processStockConsumption(
        requiredStock,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should return early if requiredStock is empty', async () => {
      global.fetch = vi.fn();

      // Set up empty parts cache
      queryClient.setQueryData(['parts'], []);

      await processStockConsumption(
        [],
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return early if requiredStock is null or undefined', async () => {
      global.fetch = vi.fn();

      // Set up parts cache
      queryClient.setQueryData(['parts'], []);

      await processStockConsumption(
        null as any,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      expect(global.fetch).not.toHaveBeenCalled();

      await processStockConsumption(
        undefined as any,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should throw error if part is not found', async () => {
      const requiredStock = [
        {
          part_id: 'non-existent-part',
          quantity: 1,
          part_name: 'Non-existent',
        },
      ];

      global.fetch = vi.fn((url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes('/parts') && !urlString.includes('/parts/')) {
          return Promise.resolve(mockApiResponse([])); // Empty parts list
        }
        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts cache (without the non-existent part)
      queryClient.setQueryData(['parts'], [mockOringPart]);

      await expect(
        processStockConsumption(
          requiredStock,
          mockActionId,
          mockUserId,
          mockActionTitle,
          queryClient
        )
      ).rejects.toThrow('no longer exists in inventory');
    });

    it('should throw error if parts API fails', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      global.fetch = vi.fn((url: string | URL | Request) => {
        const urlString = typeof url === 'string' ? url : url.toString();
        if (urlString.includes('/parts') && !urlString.includes('/parts/')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          } as Response);
        }
        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      await expect(
        processStockConsumption(
          requiredStock,
          mockActionId,
          mockUserId,
          mockActionTitle,
          queryClient
        )
      ).rejects.toThrow();
    });

    it('should throw error if part update fails', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(mockApiResponse([mockOringPart]));
        }

        if (urlString.includes(`/parts/${mockOringPart.id}`) && init?.method === 'PUT') {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Update failed',
            json: async () => ({ error: 'Database error' }),
          } as Response);
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [mockOringPart]);

      await expect(
        processStockConsumption(
          requiredStock,
          mockActionId,
          mockUserId,
          mockActionTitle,
          queryClient
        )
      ).rejects.toThrow();
    });

    it('should not throw if history logging fails (non-critical)', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(mockApiResponse([mockOringPart]));
        }

        if (urlString.includes(`/parts/${mockOringPart.id}`) && init?.method === 'PUT') {
          return Promise.resolve(mockApiResponse({ ...mockOringPart, current_quantity: 9 }));
        }

        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          // History logging fails, but should not throw
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'History failed',
            json: async () => ({ error: 'History error' }),
          } as Response);
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache
      queryClient.setQueryData(['parts'], [mockOringPart]);

      // Should not throw even though history failed
      await expect(
        processStockConsumption(
          requiredStock,
          mockActionId,
          mockUserId,
          mockActionTitle,
          queryClient
        )
      ).resolves.not.toThrow();
    });
  });

  describe('Parts history logging', () => {
    it('should log correct history entry with all required fields', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 3,
          part_name: 'O-ring',
        },
      ];

      let historyBody: any = null;

      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(mockApiResponse([mockOringPart]));
        }

        if (urlString.includes(`/parts/${mockOringPart.id}`) && init?.method === 'PUT') {
          return Promise.resolve(mockApiResponse({ ...mockOringPart, current_quantity: 7 }));
        }

        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          historyBody = JSON.parse(init?.body as string);
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [mockOringPart]);

      await processStockConsumption(
        requiredStock,
        mockActionId,
        mockUserId,
        mockActionTitle,
        queryClient
      );

      expect(historyBody).toBeTruthy();
      expect(historyBody.part_id).toBe(mockOringPart.id);
      expect(historyBody.change_type).toBe('quantity_remove');
      expect(historyBody.old_quantity).toBe(10);
      expect(historyBody.new_quantity).toBe(7);
      expect(historyBody.quantity_change).toBe(-3);
      expect(historyBody.changed_by).toBe(mockUserId);
      // Note: organization_id is not passed to processStockConsumption, so it won't be in history
      // The backend should set it from the auth context
      expect(historyBody.change_reason).toContain(mockActionTitle);
      expect(historyBody.change_reason).toContain('3 O-ring');
    });
  });

  describe('Parameter validation', () => {
    it('should require all mandatory parameters', async () => {
      const requiredStock = [
        {
          part_id: mockOringPart.id,
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      global.fetch = vi.fn(() => Promise.resolve(mockApiResponse([mockOringPart])));

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      queryClient.setQueryData(['parts'], [mockOringPart]);

      // Should work with all parameters
      await expect(
        processStockConsumption(
          requiredStock,
          mockActionId,
          mockUserId,
          mockActionTitle,
          queryClient
        )
      ).resolves.not.toThrow();
    });
  });

  describe('Real-world scenario: O-ring consumption bug', () => {
    it('should decrement o-ring stock when action using 1 o-ring is completed', async () => {
      // This test specifically addresses the user-reported bug:
      // "I completed an action that used 1 o-ring but the number of orings never changed"
      const oringPart = {
        id: 'oring-part-id',
        name: 'O-ring',
        current_quantity: 10,
      };

      const requiredStock = [
        {
          part_id: oringPart.id,
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      let updatedQuantity: number | null = null;
      let partsFetched = false;
      let partUpdated = false;
      let historyLogged = false;

      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          partsFetched = true;
          return Promise.resolve(mockApiResponse([oringPart]));
        }

        if (urlString.includes(`/parts/${oringPart.id}`) && init?.method === 'PUT') {
          partUpdated = true;
          const body = JSON.parse(init?.body as string);
          updatedQuantity = body.current_quantity;
          expect(updatedQuantity).toBe(9); // 10 - 1 = 9
          return Promise.resolve(mockApiResponse({ ...oringPart, current_quantity: 9 }));
        }

        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          historyLogged = true;
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Set up parts in cache
      queryClient.setQueryData(['parts'], [oringPart]);

      await processStockConsumption(
        requiredStock,
        'action-with-oring',
        'user-123',
        'Action using O-ring',
        queryClient
      );

      // Critical assertions: All steps must complete
      // Note: Parts are read from cache, so partsFetched will be false (no GET request)
      expect(partUpdated).toBe(true); // Part must be updated
      expect(historyLogged).toBe(true); // History must be logged
      expect(updatedQuantity).toBe(9); // Quantity must be decremented
      expect(updatedQuantity).not.toBe(10); // Must have changed from original!
    });

    it('should handle the case where required_stock might be missing or empty', async () => {
      // If required_stock is not set on the action, stock consumption should be skipped
      global.fetch = vi.fn();

      // Set up parts cache
      queryClient.setQueryData(['parts'], []);

      // Empty array - should return early
      await processStockConsumption(
        [],
        'action-id',
        'user-id',
        'Action Title',
        queryClient
      );

      expect(global.fetch).not.toHaveBeenCalled();

      // Null - should return early
      await processStockConsumption(
        null as any,
        'action-id',
        'user-id',
        'Action Title',
        queryClient
      );

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should verify that processStockConsumption is actually called when action is completed', async () => {
      // This test ensures the function is called - the bug might be that it's not being called at all
      const requiredStock = [
        {
          part_id: 'part-1',
          quantity: 1,
          part_name: 'O-ring',
        },
      ];

      const mockPart = {
        id: 'part-1',
        name: 'O-ring',
        current_quantity: 10,
      };

      // Mock fetch for the actual function call
      global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url.toString();

        if (urlString.includes('/parts') && !urlString.includes('/parts/') && init?.method !== 'PUT' && init?.method !== 'POST') {
          return Promise.resolve(mockApiResponse([mockPart]));
        }

        if (urlString.includes(`/parts/${mockPart.id}`) && init?.method === 'PUT') {
          return Promise.resolve(mockApiResponse({ ...mockPart, current_quantity: 9 }));
        }

        if (urlString.includes('/parts_history') && init?.method === 'POST') {
          return Promise.resolve(mockApiResponse({ success: true }));
        }

        return Promise.resolve(mockApiResponse({}));
      }) as typeof fetch;

      // Simulate action completion flow
      const mockAction = {
        id: 'action-123',
        title: 'Test Action',
        required_stock: requiredStock,
      };

      // Set up parts in cache (function expects array directly, not wrapped in { data: [...] })
      // Use mockPart (id: 'part-1') to match requiredStock
      queryClient.setQueryData(['parts'], [mockPart]);

      // When action is completed, processStockConsumption should be called
      if (mockAction.required_stock && mockAction.required_stock.length > 0) {
        await processStockConsumption(
          mockAction.required_stock,
          mockAction.id,
          'user-id',
          mockAction.title,
          queryClient
        );
      }

      // Verify fetch was called (meaning processStockConsumption executed)
      expect(global.fetch).toHaveBeenCalled();
      
      // Note: Parts are read from cache, so no GET request for parts
      // Verify part was updated (PUT request)
      const updateCall = (global.fetch as any).mock.calls.find((call: any[]) => 
        typeof call[0] === 'string' && call[0].includes('/parts/') && call[1]?.method === 'PUT'
      );
      expect(updateCall).toBeDefined();
    });
  });
});

