import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';

interface SavedQuestion {
  id: string;
  question: string;
  response: string;
  captured_at: string;
}

export function useMaxwellStarterQuestions() {
  const queryClient = useQueryClient();

  const { data: savedQuestions = [], isLoading } = useQuery({
    queryKey: ['maxwell-questions'],
    queryFn: () => apiService.get<SavedQuestion[]>('/maxwell/interactions'),
    staleTime: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (questionId: string) =>
      apiService.delete(`/maxwell/interactions/${questionId}`),
    onSuccess: (_, questionId) => {
      queryClient.setQueryData<SavedQuestion[]>(
        ['maxwell-questions'],
        (old) => old?.filter(q => q.id !== questionId) ?? []
      );
    },
  });

  return {
    savedQuestions,
    isLoading: isLoading,
    deleteQuestion: deleteMutation.mutate,
  };
}
