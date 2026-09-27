import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { BaseAction } from '@/types/actions';

// Debug information interface for observability
interface MutationDebugInfo {
  mutationId: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'pending' | 'retrying' | 'failed' | 'succeeded';
  retryCount: number;
  errors: Array<{
    timestamp: number;
    error: Error;
    isRetryable: boolean;
  }>;
  rollbacks: Array<{
    timestamp: number;
    reason: string;
    affectedCaches: string[];
  }>;
  queueInfo?: {
    queuedAt: number;
    queuePosition: number;
    executedAt?: number;
  };
}

// Mutation context for rollback scenarios with enhanced state tracking
interface ActionMutationContext {
  previousActions: BaseAction[] | undefined;
  previousTools?: any | undefined;
  mutationId: string;
  debugInfo: MutationDebugInfo;
  affectedCaches: string[]; // Track which caches were optimistically updated
  rollbackStrategy: 'full' | 'partial' | 'none'; // Strategy for handling failures
}

// Error classification helper with enhanced categorization
function classifyError(error: any): { 
  isRetryable: boolean; 
  isValidation: boolean; 
  isNetwork: boolean; 
  isAuthorization: boolean;
  isPermanent: boolean;
  category: 'network' | 'validation' | 'authorization' | 'server' | 'unknown';
} {
  const status = error?.response?.status || error?.status;
  const message = error?.message || '';
  
  // Network errors (retryable)
  if (!status || status >= 500 || message.includes('timeout') || message.includes('network') || message.includes('ECONNREFUSED')) {
    return { 
      isRetryable: true, 
      isValidation: false, 
      isNetwork: true, 
      isAuthorization: false,
      isPermanent: false,
      category: 'network'
    };
  }
  
  // Validation errors (non-retryable, permanent)
  if (status === 400 || status === 422) {
    return { 
      isRetryable: false, 
      isValidation: true, 
      isNetwork: false, 
      isAuthorization: false,
      isPermanent: true,
      category: 'validation'
    };
  }
  
  // Authorization errors (non-retryable, permanent)
  if (status === 401 || status === 403) {
    return { 
      isRetryable: false, 
      isValidation: false, 
      isNetwork: false, 
      isAuthorization: true,
      isPermanent: true,
      category: 'authorization'
    };
  }
  
  // Server errors (potentially retryable)
  if (status >= 500) {
    return { 
      isRetryable: true, 
      isValidation: false, 
      isNetwork: false, 
      isAuthorization: false,
      isPermanent: false,
      category: 'server'
    };
  }
  
  // Default to non-retryable for unknown errors (permanent failure)
  return { 
    isRetryable: false, 
    isValidation: false, 
    isNetwork: false, 
    isAuthorization: false,
    isPermanent: true,
    category: 'unknown'
  };
}

// Global debug tracking with enhanced management
const mutationDebugMap = new Map<string, MutationDebugInfo>();

// Helper function to clean up old debug entries to prevent memory leaks
function cleanupOldDebugEntries() {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  for (const [mutationId, debugInfo] of mutationDebugMap.entries()) {
    if (now - debugInfo.startTime > maxAge) {
      mutationDebugMap.delete(mutationId);
    }
  }
}

// Helper function to get mutation metrics for observability
function getMutationMetrics(): {
  totalMutations: number;
  successfulMutations: number;
  failedMutations: number;
  retryingMutations: number;
  averageResponseTime: number;
  retryRate: number;
  rollbackRate: number;
} {
  const allMutations = Array.from(mutationDebugMap.values());
  const totalMutations = allMutations.length;
  
  if (totalMutations === 0) {
    return {
      totalMutations: 0,
      successfulMutations: 0,
      failedMutations: 0,
      retryingMutations: 0,
      averageResponseTime: 0,
      retryRate: 0,
      rollbackRate: 0
    };
  }
  
  const successfulMutations = allMutations.filter(m => m.status === 'succeeded').length;
  const failedMutations = allMutations.filter(m => m.status === 'failed').length;
  const retryingMutations = allMutations.filter(m => m.status === 'retrying').length;
  
  const completedMutations = allMutations.filter(m => m.duration !== undefined);
  const averageResponseTime = completedMutations.length > 0 
    ? completedMutations.reduce((sum, m) => sum + (m.duration || 0), 0) / completedMutations.length
    : 0;
  
  const mutationsWithRetries = allMutations.filter(m => m.retryCount > 0).length;
  const retryRate = totalMutations > 0 ? mutationsWithRetries / totalMutations : 0;
  
  const mutationsWithRollbacks = allMutations.filter(m => m.rollbacks.length > 0).length;
  const rollbackRate = totalMutations > 0 ? mutationsWithRollbacks / totalMutations : 0;
  
  return {
    totalMutations,
    successfulMutations,
    failedMutations,
    retryingMutations,
    averageResponseTime,
    retryRate,
    rollbackRate
  };
}

export function useActionMutations() {
  const queryClient = useQueryClient();

  const updateAction = useMutation({
    mutationFn: async (data: { id: string; updates: Partial<BaseAction> }) => {
      const result = await apiService.put(`/actions/${data.id}`, data.updates);
      // Return the full response including affectedResources
      return result;
    },
    
    // Retry configuration for network errors
    retry: (failureCount, error) => {
      const { isRetryable } = classifyError(error);
      return isRetryable && failureCount < 3;
    },
    
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
    
    onMutate: async (variables): Promise<ActionMutationContext> => {
      // Generate unique mutation ID for debugging
      const mutationId = `action-update-${variables.id}-${Date.now()}`;
      
      // Initialize debug info
      const debugInfo: MutationDebugInfo = {
        mutationId,
        startTime: Date.now(),
        status: 'pending',
        retryCount: 0,
        errors: [],
        rollbacks: []
      };
      
      mutationDebugMap.set(mutationId, debugInfo);
      
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: ['actions'] });
      
      // Snapshot previous state for rollback - only capture what we might modify
      const previousActions = queryClient.getQueryData<BaseAction[]>(['actions']);
      const previousTools = queryClient.getQueryData(['tools']);
      
      // Track which caches we're about to modify for safer rollback
      const affectedCaches: string[] = ['actions'];
      
      // Determine rollback strategy based on update type
      let rollbackStrategy: 'full' | 'partial' | 'none' = 'full';
      
      // For certain updates, we might want partial rollback to avoid cache corruption
      if (variables.updates.status === 'completed' || variables.updates.required_tools) {
        // These updates might affect tools, so we need careful rollback handling
        rollbackStrategy = 'partial';
      }
      
      // Optimistic update for immediate UI feedback (offline-first)
      queryClient.setQueryData<BaseAction[]>(['actions'], (old) => {
        if (!old) return old;
        return old.map(action => 
          action.id === variables.id 
            ? { ...action, ...variables.updates }
            : action
        );
      });
      
      return { 
        previousActions, 
        previousTools,
        mutationId,
        debugInfo,
        affectedCaches,
        rollbackStrategy
      };
    },
    
    onSuccess: (response, _variables, context) => {
      // Update debug info
      const debugInfo = mutationDebugMap.get(context.mutationId);
      if (debugInfo) {
        debugInfo.endTime = Date.now();
        debugInfo.duration = debugInfo.endTime - debugInfo.startTime;
        debugInfo.status = 'succeeded';
      }
      
      // Update cache with server response
      const updatedAction = getApiData(response);
      if (updatedAction) {
        queryClient.setQueryData<BaseAction[]>(['actions'], (old) => {
          if (!old) return old;
          return old.map(action => 
            action.id === updatedAction.id 
              ? { ...action, ...updatedAction }
              : action
          );
        });
      }
      
    },
    
    onError: (error, _variables, context) => {
      if (!context) return;
      
      const { isRetryable, isPermanent, category } = classifyError(error);
      
      // Update debug info
      const debugInfo = mutationDebugMap.get(context.mutationId);
      if (debugInfo) {
        debugInfo.errors.push({
          timestamp: Date.now(),
          error: error as Error,
          isRetryable
        });
        
        if (isRetryable) {
          debugInfo.status = 'retrying';
          debugInfo.retryCount++;
        } else {
          debugInfo.status = 'failed';
          debugInfo.endTime = Date.now();
          debugInfo.duration = debugInfo.endTime - debugInfo.startTime;
        }
      }
      
      // Handle permanent failures (non-network errors) by restoring previous state
      // Requirement 3.5: Handle permanent failures by restoring previous state
      if (isPermanent || !isRetryable) {
        // Implement graceful rollback strategy to avoid cache corruption
        // Requirement 4.5: Handle partial failures gracefully without corrupting cache state
        
        if (context.rollbackStrategy === 'full') {
          // Full rollback - restore all optimistically updated caches
          if (context.previousActions) {
            queryClient.setQueryData(['actions'], context.previousActions);
          }
          
          // Track rollback for debugging
          if (debugInfo) {
            debugInfo.rollbacks.push({
              timestamp: Date.now(),
              reason: `${category} error - full rollback`,
              affectedCaches: context.affectedCaches
            });
          }
          
        } else if (context.rollbackStrategy === 'partial') {
          // Partial rollback - only rollback actions cache, leave related caches untouched
          // Requirement 4.4: NOT affect related resource caches during rollback scenarios
          if (context.previousActions) {
            queryClient.setQueryData(['actions'], context.previousActions);
          }
          
          // Do NOT rollback tools or checkouts cache to avoid corruption
          // These will be handled by server response or background refresh
          
          if (debugInfo) {
            debugInfo.rollbacks.push({
              timestamp: Date.now(),
              reason: `${category} error - partial rollback (actions only)`,
              affectedCaches: ['actions'] // Only actions cache rolled back
            });
          }
        }
        // 'none' strategy means no rollback - preserve optimistic updates
        
      } else {
        // Network errors - preserve optimistic updates for offline support
      }
    }
  });

  // Expose debug information for observability
  const getMutationDebugInfo = (mutationId?: string) => {
    // Clean up old entries periodically
    cleanupOldDebugEntries();
    
    if (mutationId) {
      return mutationDebugMap.get(mutationId);
    }
    return Array.from(mutationDebugMap.values());
  };
  
  // Mutation status indicators for UI debugging
  const getMutationStatus = () => ({
    isPending: updateAction.isPending,
    isError: updateAction.isError,
    isSuccess: updateAction.isSuccess,
    error: updateAction.error,
    failureCount: updateAction.failureCount,
    failureReason: updateAction.failureReason
  });

  // Enhanced error context for better debugging
  const getErrorContext = () => {
    const currentError = updateAction.error;
    if (!currentError) return null;
    
    const classification = classifyError(currentError);
    return {
      error: currentError,
      classification,
      canRetry: classification.isRetryable,
      shouldRollback: classification.isPermanent,
      userActionRequired: classification.isValidation || classification.isAuthorization
    };
  };

  // Mutation metrics for observability
  const getMetrics = getMutationMetrics;

  return { 
    updateAction,
    getMutationDebugInfo,
    getMutationStatus,
    getErrorContext,
    getMetrics
  };
}
