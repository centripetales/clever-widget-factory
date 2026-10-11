import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDeleteGoal } from './usePositiveSum';
import { apiService } from '@/lib/apiService';
import { positiveSumMineQueryKey } from '@/lib/queryKeys';
import type { MyPositiveSum } from '@/types/positiveSum';

vi.mock('@/lib/apiService', () => ({
  apiService: { post: vi.fn() },
  getApiData: (r: { data?: unknown }) => r.data,
}));

const ORG = 'positive-sum';
const goal = (id: string) => ({ id, title: id, options: [] }) as unknown as MyPositiveSum['goals'][number];

describe('useDeleteGoal', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const goalIds = () => queryClient.getQueryData<MyPositiveSum>(positiveSumMineQueryKey(ORG))!.goals.map(g => g.id);

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<MyPositiveSum>(positiveSumMineQueryKey(ORG), { goals: [goal('store'), goal('seeds')], ready: [] });
  });

  it('takes the desired state off the list at once and deletes it in the page\'s org', async () => {
    let finish!: () => void;
    vi.mocked(apiService.post).mockReturnValue(new Promise<void>(resolve => { finish = () => resolve(); }));
    const { result } = renderHook(() => useDeleteGoal(ORG), { wrapper });

    result.current.mutate('store');

    await waitFor(() => expect(goalIds()).toEqual(['seeds']));
    expect(apiService.post).toHaveBeenCalledWith('/positive-sum/goals', { organization_id: ORG, delete: { id: 'store' } });
    finish();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('puts it back when the delete fails', async () => {
    vi.mocked(apiService.post).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useDeleteGoal(ORG), { wrapper });

    result.current.mutate('store');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(goalIds()).toEqual(['store', 'seeds']);
  });
});
