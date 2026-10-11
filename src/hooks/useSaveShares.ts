import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, errorMessage } from '@/lib/apiService';
import { offlineMutationConfig } from '@/lib/queryConfig';
import { partsQueryKey, shareStatusQueryKey, toolSharesQueryKey, toolsQueryKey } from '@/lib/queryKeys';
import { useOrganization } from '@/hooks/useOrganization';
import { useAuth } from '@/hooks/useCognitoAuth';
import { toast } from '@/hooks/use-toast';
import type { EntityShare, ShareEntityType, ShareStatus } from '@/hooks/useSharedStatus';

export interface ShareTarget {
  id: string;
  name: string;
}

export interface SaveShares {
  existing: EntityShare[]; // what it is shared with now
  targets: ShareTarget[]; // every org it should be shared with after saving
  note: string;
}

/**
 * What saving changes: orgs to share with and shares to remove. A changed note
 * replaces the share (the note is the share's text), so it is both.
 */
export function diffShares({ existing, targets, note }: SaveShares) {
  const kept = (s: EntityShare) => targets.some(t => t.id === s.target_org_id) && (s.note || '') === note;
  return {
    toAdd: targets.filter(t => !existing.some(s => s.target_org_id === t.id && kept(s))),
    toRemove: existing.filter(s => !kept(s)),
  };
}

type Listed = { id: string; is_shared_outbound?: boolean };

/**
 * Saves who an action, tool or stock item is shared with. Optimistic: the
 * share list, the tool's shares and the asset list's "shared" flag change at
 * once and roll back if the save fails; all are refetched once it settles.
 */
export function useSaveShares({ entityType, entityId, entityName, onSaved }: {
  entityType: ShareEntityType;
  entityId: string;
  entityName: string;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const { organization } = useOrganization();
  const { user } = useAuth();

  const statusKey = shareStatusQueryKey(entityType, entityId);
  const toolSharesKey = toolSharesQueryKey(entityId);
  // The asset lists carry the server-computed "shared" flag; actions have none.
  const listKey = entityType === 'tool' ? toolsQueryKey() : entityType === 'part' ? partsQueryKey() : null;
  const keys = [statusKey, toolSharesKey, ...(listKey ? [listKey] : [])];

  return useMutation({
    mutationFn: async (save: SaveShares) => {
      const note = save.note.trim();
      const { toAdd, toRemove } = diffShares({ ...save, note });
      await Promise.all([
        ...toAdd.map(target => apiService.post('/api/shares', {
          entity_type: entityType,
          entity_id: entityId,
          target_org_id: target.id,
          note,
          source_org_id: organization?.id,
          cognito_user_id: user?.userId,
          entity_name: entityName,
          target_org_name: target.name,
        })),
        ...toRemove.map(share => apiService.delete(`/api/shares/${share.state_id}`)),
      ]);
      return { added: toAdd.length, removed: toRemove.length };
    },

    onMutate: async ({ existing, targets, note }) => {
      await Promise.all(keys.map(queryKey => queryClient.cancelQueries({ queryKey })));
      const previous = keys.map(queryKey => [queryKey, queryClient.getQueryData(queryKey)] as const);

      const shares: EntityShare[] = targets.map(t =>
        existing.find(s => s.target_org_id === t.id && (s.note || '') === note.trim())
          ?? { state_id: `optimistic-${t.id}`, target_org_id: t.id, target_org_name: t.name, note: note.trim() });
      queryClient.setQueryData<ShareStatus>(statusKey, { isShared: shares.length > 0, shares });
      if (entityType === 'tool') queryClient.setQueryData(toolSharesKey, shares);
      if (listKey) {
        queryClient.setQueryData<Listed[]>(listKey, old =>
          old?.map(item => (item.id === entityId ? { ...item, is_shared_outbound: shares.length > 0 } : item)));
      }
      return { previous };
    },

    onError: (error, _save, context) => {
      context?.previous.forEach(([queryKey, data]) => queryClient.setQueryData(queryKey, data));
      toast({ title: 'Could not save sharing', description: errorMessage(error), variant: 'destructive' });
    },

    onSuccess: ({ added, removed }) => {
      const parts = [
        added > 0 && `Shared with ${added} org${added > 1 ? 's' : ''}`,
        removed > 0 && `Removed from ${removed} org${removed > 1 ? 's' : ''}`,
      ].filter(Boolean);
      toast({ title: 'Saved', description: parts.join(', ') || 'No changes made.' });
      onSaved?.();
    },

    // Server-computed: real share ids and the asset list's "shared" flag.
    onSettled: () => {
      keys.forEach(queryKey => queryClient.invalidateQueries({ queryKey }));
    },

    ...offlineMutationConfig,
  });
}
