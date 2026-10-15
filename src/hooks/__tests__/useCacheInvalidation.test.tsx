import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCacheInvalidation } from '../useCacheInvalidation';

const handlers: Record<string, (payload: unknown) => void> = {};
vi.mock('../useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe: (type: string, fn: (payload: unknown) => void) => {
      handlers[type] = fn;
      return () => {};
    },
  }),
}));

describe('useCacheInvalidation: Positive Sum', () => {
  let queryClient: QueryClient;
  const mine = ['positive_sum', 'mine', 'ps'];
  const stale = () => queryClient.getQueryState(mine)?.isInvalidated;
  const action = (entityId: string, mutationType = 'updated') =>
    handlers['cache:invalidate']({ entityType: 'action', entityId, mutationType });

  beforeEach(() => {
    queryClient = new QueryClient();
    queryClient.setQueryData(mine, { offers: [{ id: 'practices', rewards: [] }], goals: [], challenges: [] });
    renderHook(() => useCacheInvalidation(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
  });

  it('reloads the page for an action it shows', () => {
    action('practices');
    expect(stale()).toBe(true);
  });

  it('reloads it for a new action, which may be a new offer', () => {
    action('elsewhere', 'created');
    expect(stale()).toBe(true);
  });

  it('leaves it for a change to an action it does not show', () => {
    action('elsewhere');
    expect(stale()).toBe(false);
  });
});
