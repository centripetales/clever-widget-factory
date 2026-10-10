import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { similarOrganizationsQueryKey, transactionActionQueryKey } from '@/lib/queryKeys';
import type { NamedOrganization, NewTransactionAction, TransactionAction, TransactionDraft } from '@/types/positiveSum';

/**
 * The action behind a transaction — made only when someone uses the reward
 * flow on it — with the LLM draft and the save that creates it.
 * GET/POST /api/financial-records/{id}/action, POST .../action/draft
 */
export function useTransactionAction(recordId: string) {
  const queryClient = useQueryClient();
  const path = `/financial-records/${recordId}/action`;

  const query = useQuery<TransactionAction | null>({
    queryKey: transactionActionQueryKey(recordId),
    queryFn: async () => getApiData(await apiService.get(path)) ?? null,
    enabled: !!recordId,
  });

  const draft = useMutation({
    mutationFn: async () => getApiData<TransactionDraft>(await apiService.post(`${path}/draft`, {})),
  });

  const create = useMutation({
    mutationFn: async (action: NewTransactionAction) => getApiData<TransactionAction>(await apiService.post(path, action)),
    onSuccess: created => queryClient.setQueryData(transactionActionQueryKey(recordId), created),
  });

  return { ...query, draft, create };
}

/**
 * Organizations with a similar name, from all organizations (names only), and
 * creating one that isn't there yet.
 * GET/POST /api/positive-sum/organizations
 */
export function useSimilarOrganizations(name: string) {
  const queryClient = useQueryClient();
  const wanted = name.trim();

  const query = useQuery<NamedOrganization[]>({
    queryKey: similarOrganizationsQueryKey(wanted),
    queryFn: async () =>
      getApiData(await apiService.get(`/positive-sum/organizations?name=${encodeURIComponent(wanted)}`)) ?? [],
    enabled: wanted.length >= 3,
  });

  const create = useMutation({
    mutationFn: async (newName: string) =>
      getApiData<NamedOrganization>(await apiService.post('/positive-sum/organizations', { name: newName })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: similarOrganizationsQueryKey('').slice(0, 2) }),
  });

  return { ...query, create };
}
