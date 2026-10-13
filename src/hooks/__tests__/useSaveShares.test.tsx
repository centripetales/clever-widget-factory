import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { diffShares, useSaveShares } from '../useSaveShares';
import { apiService } from '@/lib/apiService';
import { shareStatusQueryKey, toolsQueryKey } from '@/lib/queryKeys';
import type { EntityShare } from '../useSharedStatus';

vi.mock('@/lib/apiService', () => ({
  apiService: { post: vi.fn(), delete: vi.fn() },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => ({ organization: { id: 'stargazer' } }) }));
vi.mock('@/hooks/useCognitoAuth', () => ({ useAuth: () => ({ user: { userId: 'stefan' } }) }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast }));

const POSITIVE_SUM = { id: 'positive-sum', name: 'Positive Sum' };
const PASTOR = { id: 'pastor', name: 'Pastor' };
const share = (org: { id: string; name: string }, note = 'Bring it back dry'): EntityShare =>
  ({ state_id: `share-${org.id}`, target_org_id: org.id, target_org_name: org.name, note });

describe('diffShares', () => {
  it('adds new orgs and removes deselected ones', () => {
    const { toAdd, toRemove } = diffShares({ existing: [share(PASTOR)], targets: [POSITIVE_SUM], note: 'Bring it back dry' });
    expect(toAdd).toEqual([POSITIVE_SUM]);
    expect(toRemove).toEqual([share(PASTOR)]);
  });

  it('leaves an unchanged share alone', () => {
    expect(diffShares({ existing: [share(PASTOR)], targets: [PASTOR], note: 'Bring it back dry' }))
      .toEqual({ toAdd: [], toRemove: [] });
  });

  it('replaces a share whose note changed', () => {
    const { toAdd, toRemove } = diffShares({ existing: [share(PASTOR)], targets: [PASTOR], note: 'Any time' });
    expect(toAdd).toEqual([PASTOR]);
    expect(toRemove).toEqual([share(PASTOR)]);
  });
});

describe('useSaveShares', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const sharedFlag = () => queryClient.getQueryData<{ id: string; is_shared_outbound?: boolean }[]>(toolsQueryKey())![0].is_shared_outbound;
  const save = () => renderHook(() => useSaveShares({ entityType: 'tool', entityId: 'saw', entityName: 'Branch saw' }), { wrapper });

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(toolsQueryKey(), [{ id: 'saw', is_shared_outbound: false }, { id: 'drill', is_shared_outbound: false }]);
    queryClient.setQueryData(shareStatusQueryKey('tool', 'saw'), { isShared: false, shares: [] });
  });

  it('marks the tool as shared at once, before the server answers', async () => {
    let finish!: () => void;
    vi.mocked(apiService.post).mockReturnValue(new Promise<void>(resolve => { finish = () => resolve(); }));
    const { result } = save();

    result.current.mutate({ existing: [], targets: [POSITIVE_SUM], note: 'Bring it back dry' });

    await waitFor(() => expect(sharedFlag()).toBe(true));
    expect(queryClient.getQueryData(shareStatusQueryKey('tool', 'saw'))).toMatchObject({
      isShared: true, shares: [{ target_org_id: 'positive-sum', note: 'Bring it back dry' }],
    });
    expect(queryClient.getQueryData<{ id: string; is_shared_outbound?: boolean }[]>(toolsQueryKey())![1].is_shared_outbound).toBe(false);

    finish();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiService.post).toHaveBeenCalledWith('/api/shares', expect.objectContaining({
      entity_type: 'tool', entity_id: 'saw', target_org_id: 'positive-sum', note: 'Bring it back dry',
    }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved', description: 'Shared with 1 org' }));
  });

  it('puts everything back and says so when the save fails', async () => {
    vi.mocked(apiService.post).mockRejectedValue(new Error('offline'));
    const { result } = save();

    result.current.mutate({ existing: [], targets: [POSITIVE_SUM], note: '' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(sharedFlag()).toBe(false);
    expect(queryClient.getQueryData(shareStatusQueryKey('tool', 'saw'))).toEqual({ isShared: false, shares: [] });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not save sharing', variant: 'destructive' }));
  });

  it('removes a share and clears the flag when no org is left', async () => {
    vi.mocked(apiService.delete).mockResolvedValue({});
    queryClient.setQueryData(toolsQueryKey(), [{ id: 'saw', is_shared_outbound: true }]);
    const { result } = save();

    result.current.mutate({ existing: [share(PASTOR)], targets: [], note: 'Bring it back dry' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiService.delete).toHaveBeenCalledWith('/api/shares/share-pastor');
    expect(apiService.post).not.toHaveBeenCalled();
  });
});
