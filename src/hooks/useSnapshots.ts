import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { snapshotService, type CreateSnapshotData, type UpdateSnapshotData } from '../services/snapshotService';
import { toolHistoryQueryKey, partHistoryQueryKey } from '../lib/queryKeys';

export function useSnapshots(stateId: string | undefined) {
  return useQuery({
    queryKey: ['snapshots', stateId],
    queryFn: () => stateId ? snapshotService.getSnapshots(stateId) : Promise.resolve([]),
    enabled: !!stateId,
  });
}

export type SnapshotLinkedAsset = { type: 'tool' | 'part'; id: string };

// linkedAssets: the observation's linked tool/part(s) — a metric snapshot has
// no asset link of its own, it's the parent observation's link that
// determines whose History view needs to refresh. Same invalidation target
// as useStates.ts's updateState (toolHistoryQueryKey/partHistoryQueryKey) —
// kept consistent so a metric edit and an observation-text edit both refresh
// History the same way, rather than each having its own bespoke rule.
export function useSnapshotMutations(stateId: string, linkedAssets: SnapshotLinkedAsset[] = []) {
  const queryClient = useQueryClient();

  const invalidateHistory = () => {
    queryClient.invalidateQueries({ queryKey: ['snapshots', stateId] });
    linkedAssets.forEach((asset) => {
      queryClient.invalidateQueries({
        queryKey: asset.type === 'tool' ? toolHistoryQueryKey(asset.id) : partHistoryQueryKey(asset.id),
      });
    });
  };

  const createMutation = useMutation({
    mutationFn: (data: CreateSnapshotData) => snapshotService.createSnapshot(stateId, data),
    onSuccess: invalidateHistory,
  });

  const updateMutation = useMutation({
    mutationFn: ({ snapshotId, data }: { snapshotId: string; data: UpdateSnapshotData }) =>
      snapshotService.updateSnapshot(snapshotId, data),
    onSuccess: invalidateHistory,
  });

  const deleteMutation = useMutation({
    mutationFn: (snapshotId: string) => snapshotService.deleteSnapshot(snapshotId),
    onSuccess: invalidateHistory,
  });

  return {
    createSnapshot: createMutation.mutateAsync,
    updateSnapshot: updateMutation.mutateAsync,
    deleteSnapshot: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
