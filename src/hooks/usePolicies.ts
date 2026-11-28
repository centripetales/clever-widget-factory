import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService, errorMessage } from '@/lib/apiService';
import { useToast } from '@/hooks/use-toast';
import type { Policy, PolicySource, PolicyStatus, PolicyText } from '@/types/policies';

export const policiesQueryKey = (organizationId?: string) => ['organization-policies', organizationId];

/** The active organization's policies. Claude changes them too, so they are read again on opening. */
export function usePolicies(organizationId?: string) {
  return useQuery({
    queryKey: policiesQueryKey(organizationId),
    // A service not yet updated sends neither sources nor a count
    queryFn: async () => (await apiService.get<{ policies: Policy[] }>('/policies')).policies
      .map((p) => ({ ...p, sources: p.sources ?? [], action_count: p.action_count ?? 0 })),
    enabled: !!organizationId,
    staleTime: 30 * 1000,
    refetchOnMount: true,
  });
}

export type PolicyChange =
  | { kind: 'create'; text: PolicyText }
  | { kind: 'edit'; id: string; text: PolicyText }
  /** The practice changed: a new policy, and the old one retired so past results are not mixed. */
  | { kind: 'replace'; id: string; text: PolicyText }
  | { kind: 'status'; id: string; status: PolicyStatus }
  | { kind: 'sources'; id: string; sources: PolicySource[] };

async function save(change: PolicyChange) {
  switch (change.kind) {
    case 'create':
      await apiService.post('/policies', change.text);
      return;
    case 'edit':
      await apiService.put(`/policies/${change.id}`, change.text);
      return;
    case 'replace':
      await apiService.post('/policies', change.text);
      try {
        await apiService.put(`/policies/${change.id}`, { status: 'deprecated' });
      } catch (error) {
        throw new Error(`The new policy was saved, but the old one was not retired: ${errorMessage(error)}`);
      }
      return;
    case 'status':
      await apiService.put(`/policies/${change.id}`, { status: change.status });
      return;
    case 'sources': {
      const ids = (type: PolicySource['type']) => change.sources.filter((s) => s.type === type).map((s) => s.id);
      await apiService.put(`/policies/${change.id}`, { observation_ids: ids('observation'), experience_ids: ids('experience') });
    }
  }
}

export function useSavePolicy(organizationId?: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: save,
    networkMode: 'always',
    retry: 0,
    onError: (error) => toast({ title: 'Could not save the policy', description: errorMessage(error), variant: 'destructive' }),
    // Also after a failure: a replacement can be half done
    onSettled: () => queryClient.invalidateQueries({ queryKey: policiesQueryKey(organizationId) }),
  });
}
