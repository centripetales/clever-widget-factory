import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { learningObjectivesQueryKey, evaluationStatusQueryKey } from '@/lib/queryKeys';
import type { QuestionType } from '@/lib/progressionUtils';

// --- Types ---

export interface PriorLearningMatch {
  similarityScore: number;  // 0.0–1.0
  sourceText: string;
}

export interface LearningObjective {
  id: string;
  text: string;
  similarityScore: number;           // Best match similarity (0.0–1.0)
  matchedObjectiveText: string | null; // Text of best match, or null
  priorLearning: PriorLearningMatch[]; // Top 5 matches
  status: 'not_started' | 'in_progress' | 'completed';
  completionType: 'quiz' | 'demonstrated' | null;
}

export interface LearningAxis {
  axisKey: string;
  axisLabel: string;
  requiredLevel: number;
  currentLevel: number;
  continuousScore: number;
  progressionLevel: string;
  objectives: LearningObjective[];
}

export interface LearningObjectivesResponse {
  axes: LearningAxis[];
}

export interface QuizGenerationRequest {
  actionId: string;
  userId: string;
  axisKey: string;
  objectiveIds: string[];
  previousAnswers: {
    objectiveId: string;
    questionText: string;
    selectedAnswer: string;
    correctAnswer: string;
    wasCorrect: boolean;
  }[];
}

export interface QuizQuestion {
  id: string;
  objectiveId: string;
  type: string;
  questionType: QuestionType;
  bloomLevel: number;
  text: string;
  photoUrl: string | null;
  options: {
    index: number;
    text: string;
    explanation: string;
  }[] | null;
  correctIndex: number | null;
  idealAnswer: string | null;
  conceptName?: string | null;
  conceptAuthor?: string | null;
}

export interface QuizGenerationResponse {
  questions: QuizQuestion[];
}

export interface ObservationVerificationRequest {
  actionId: string;
  observationId: string;
  selfAssessedObjectiveIds: string[];
  userId: string;
}

export interface VerificationResponse {
  confirmed: string[];
  unconfirmed: string[];
  aiDetected: string[];
}

export interface QuizEvaluationRequest {
  actionId: string;
  stateId: string;
  responseText: string;
  idealAnswer: string;
  questionType: string;
  objectiveText: string;
  questionText: string;
}

export interface EvaluationStatusItem {
  stateId: string;
  status: 'pending' | 'evaluated' | 'error' | 'not_found' | 'unknown';
  score?: number;
  sufficient?: boolean;
  reasoning?: string;
  demonstratedLevel?: number;
  conceptDemonstrated?: string;
  nextLevelHint?: string;
}

export interface EvaluationStatusResponse {
  evaluations: EvaluationStatusItem[];
}

// --- Hooks ---

/**
 * Query hook to fetch learning objectives for a user on an action.
 * GET /api/learning/:actionId/:userId/objectives
 * Enabled only when both actionId and userId are truthy.
 * Requirements: 3.5.1
 */
export function useLearningObjectives(
  actionId: string | undefined,
  userId: string | undefined
) {
  return useQuery({
    queryKey: learningObjectivesQueryKey(actionId!, userId!),
    queryFn: async () => {
      try {
        const result = await apiService.get<{ data: LearningObjectivesResponse }>(
          `/learning/${actionId}/${userId}/objectives`
        );
        return result.data;
      } catch (err: any) {
        // 404 means no objectives exist yet — treat as empty, not an error
        if (err?.status === 404 || err?.message?.includes('404')) return null;
        throw err;
      }
    },
    enabled: !!(actionId && userId),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Mutation hook to generate quiz questions for selected learning objectives.
 * POST /api/learning/:actionId/quiz/generate
 * Requirements: 4.1
 */
export function useQuizGeneration() {
  return useMutation({
    mutationFn: async (variables: QuizGenerationRequest) => {
      const { actionId, ...body } = variables;
      const result = await apiService.post<{ data: QuizGenerationResponse }>(
        `/learning/${actionId}/quiz/generate`,
        body
      );
      return result.data;
    },
    onError: (error) => {
      console.error('Failed to generate quiz questions:', error);
    },
  });
}

/**
 * Mutation hook to verify an observation against learning objectives.
 * POST /api/learning/:actionId/verify
 * On success, invalidates the learning objectives query cache.
 * Requirements: 9.3
 */
export function useObservationVerification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: ObservationVerificationRequest) => {
      const { actionId, ...body } = variables;
      const result = await apiService.post<{ data: VerificationResponse }>(
        `/learning/${actionId}/verify`,
        body
      );
      return result.data;
    },
    onSuccess: (_data, variables) => {
      // Invalidate learning objectives cache so progress updates are reflected
      queryClient.invalidateQueries({
        queryKey: learningObjectivesQueryKey(variables.actionId, variables.userId),
      });
    },
    onError: (error) => {
      console.error('Failed to verify observation:', error);
    },
  });
}

/**
 * Mutation hook to trigger async evaluation of an open-form response.
 * POST /api/learning/:actionId/quiz/evaluate
 * Returns 202 Accepted — evaluation runs asynchronously.
 * Requirements: 3.1, 7.6
 */
export function useQuizEvaluation() {
  return useMutation({
    mutationFn: async (variables: QuizEvaluationRequest) => {
      const { actionId, ...body } = variables;
      const result = await apiService.post<void>(
        `/learning/${actionId}/quiz/evaluate`,
        body
      );
      return result;
    },
    onError: (error) => {
      console.error('Failed to trigger quiz evaluation:', error);
    },
  });
}

/**
 * Query hook to poll evaluation status for one or more knowledge states.
 * GET /api/learning/:actionId/:userId/evaluation-status?stateIds=...
 * Polling is disabled by default; enabled when stateIds are provided.
 * Requirements: 7.6, 8.1
 */
export function useEvaluationStatus(
  actionId: string | undefined,
  userId: string | undefined,
  stateIds: string[],
  refetchInterval: number | false = false
) {
  return useQuery({
    queryKey: evaluationStatusQueryKey(actionId!, userId!, stateIds),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('stateIds', stateIds.join(','));
      const result = await apiService.get<{ data: EvaluationStatusResponse }>(
        `/learning/${actionId}/${userId}/evaluation-status?${params.toString()}`
      );
      return result.data;
    },
    enabled: !!(actionId && userId && stateIds.length > 0),
    refetchInterval,
  });
}
