/**
 * Centralized API Service for AWS API Gateway
 * 
 * Automatically adds Authorization header with Cognito JWT token
 * Handles token refresh and error responses
 * Automatically updates TanStack Query cache on mutations
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import { QueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import { getWebSocketConnectionId } from '@/hooks/useWebSocket';
import { 
  toolsQueryKey, 
  actionsQueryKey,
  completedActionsQueryKey,
  allActionsQueryKey,
  missionsQueryKey,
  partsOrdersQueryKey,
  explorationsQueryKey,
  experiencesQueryKey
} from './queryKeys';

// Global query client instance for cache updates
let globalQueryClient: QueryClient | null = null;

export function setQueryClient(queryClient: QueryClient) {
  globalQueryClient = queryClient;
}

// Active organization override — when set, all API requests include X-Organization-Id header
let activeOrganizationId: string | null = null;

export function setActiveOrganizationId(orgId: string | null) {
  activeOrganizationId = orgId;
}

export function getActiveOrganizationId(): string | null {
  return activeOrganizationId;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// Validate API_BASE_URL configuration
if (API_BASE_URL.endsWith('/api')) {
  console.error(
    '❌ CONFIGURATION ERROR: VITE_API_BASE_URL should NOT end with "/api"\n' +
    `   Current value: ${API_BASE_URL}\n` +
    `   Should be: ${API_BASE_URL.replace(/\/api$/, '')}\n` +
    '   The apiService automatically adds /api prefix to endpoints.'
  );
}

export interface ApiError {
  message: string;
  status: number;
  statusText: string;
  error?: any;
}

/**
 * Get the current Cognito ID token with caching
 */
let cachedToken: string | null = null;
let tokenExpiry: number = 0;
let lastTokenFetchTime: number = 0;

/**
 * Clear the token cache (useful for testing)
 */
export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
  lastTokenFetchTime = 0;
}

async function getIdToken(): Promise<string | null> {
  try {
    // Return cached token if still valid (with 5 min buffer)
    if (cachedToken && Date.now() < tokenExpiry - 300000) {
      return cachedToken;
    }
    
    // Avoid hammering Cognito - if we just fetched a token and it was empty, wait a bit
    const timeSinceLastFetch = Date.now() - lastTokenFetchTime;
    if (timeSinceLastFetch < 1000 && !cachedToken) {
      console.warn('Token fetch attempted too soon after previous empty result');
      return null;
    }
    
    lastTokenFetchTime = Date.now();
    
    const session = await fetchAuthSession({ forceRefresh: false });
    
    // Handle different token formats
    let idToken: string | null = null;
    
    if (session.tokens?.idToken) {
      // idToken might be a string or an object with toString()
      if (typeof session.tokens.idToken === 'string') {
        idToken = session.tokens.idToken;
      } else if (session.tokens.idToken.toString) {
        idToken = session.tokens.idToken.toString();
      } else {
        console.warn('idToken is not a string and has no toString method:', typeof session.tokens.idToken);
      }
    }
    
    if (!idToken || !idToken.trim()) {
      console.warn('No ID token received from Cognito session', {
        hasSession: !!session,
        hasTokens: !!session.tokens,
        hasIdToken: !!session.tokens?.idToken,
        idTokenType: typeof session.tokens?.idToken,
        idTokenValue: idToken ? `${idToken.substring(0, 20)}...` : 'null'
      });
      cachedToken = null;
      tokenExpiry = 0;
      return null;
    }
    
    // Validate token format (should be JWT with 3 parts)
    const tokenParts = idToken.split('.');
    if (tokenParts.length !== 3) {
      console.error('Invalid token format - expected JWT with 3 parts, got:', tokenParts.length, {
        tokenPreview: `${idToken.substring(0, 50)}...`
      });
      cachedToken = null;
      tokenExpiry = 0;
      return null;
    }
    
    cachedToken = idToken;
    // JWT exp is in seconds, convert to ms
    try {
      const payload = JSON.parse(atob(tokenParts[1]));
      tokenExpiry = payload.exp * 1000;
    } catch (decodeErr) {
      console.warn('Failed to decode JWT payload:', decodeErr);
      tokenExpiry = Date.now() + 3600000; // Assume 1 hour expiry
    }
    
    return idToken;
  } catch (error) {
    console.error('Failed to get ID token:', error);
    cachedToken = null;
    tokenExpiry = 0;
    return null;
  }
}

/**
 * Make an authenticated API request
 */
async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit & { optimisticId?: string } = {},
  _isRetry: boolean = false
): Promise<T> {
  // Handle absolute URLs
  if (endpoint.startsWith('http')) {
    // Absolute URL - use as-is
    var url = endpoint;
  } else {
    // Relative endpoint - construct full URL
    // Combine with base URL (base URL should not have trailing slash)
    const baseUrl = API_BASE_URL.endsWith('/') 
      ? API_BASE_URL.slice(0, -1) 
      : API_BASE_URL;
    
    // Check if base URL already ends with /api
    const baseUrlHasApi = baseUrl.endsWith('/api');
    
    // Normalize endpoint
    let normalizedEndpoint: string;
    if (endpoint.startsWith('/api/')) {
      // Endpoint already has /api/, use it directly
      normalizedEndpoint = endpoint;
    } else if (endpoint.startsWith('/')) {
      // Endpoint starts with /, add /api prefix only if base URL doesn't already have it
      normalizedEndpoint = baseUrlHasApi ? endpoint : `/api${endpoint}`;
    } else {
      // Endpoint has no leading slash, add /api/ prefix only if base URL doesn't already have it
      normalizedEndpoint = baseUrlHasApi ? `/${endpoint}` : `/api/${endpoint}`;
    }
    
    url = `${baseUrl}${normalizedEndpoint}`;
  }

  // Get ID token for Authorization header
  const idToken = await getIdToken();
  
  // Build headers
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add Authorization header if token is available
  if (idToken && idToken.trim()) {
    headers['Authorization'] = `Bearer ${idToken}`;
  } else {
    console.error('❌ CRITICAL: No valid ID token available for request', {
      url,
      method: options.method,
      hasToken: !!idToken,
      tokenLength: idToken?.length || 0,
      tokenTrimmed: idToken?.trim() || 'N/A'
    });
    // Don't set Authorization header if token is empty - let it fail with proper error
  }

  // Add X-Organization-Id header if an active org is set
  // Callers can opt out by passing skipOrgHeader: true in options
  if (activeOrganizationId && !(options as any)?.skipOrgHeader) {
    (headers as Record<string, string>)['X-Organization-Id'] = activeOrganizationId;
    console.log('[apiService] Adding X-Organization-Id:', activeOrganizationId, url);
  } else if (activeOrganizationId && (options as any)?.skipOrgHeader) {
    console.log('[apiService] Skipping X-Organization-Id for:', url);
  }

  // Add X-Connection-Id header so the backend can exclude this client
  // from WebSocket cache invalidation broadcasts (avoids redundant refetch)
  const connectionId = getWebSocketConnectionId();
  if (connectionId) {
    (headers as Record<string, string>)['X-Connection-Id'] = connectionId;
  }

  // Make the request
  const response = await fetch(url, {
    ...options,
    headers,
  });

  // Handle errors
  if (!response.ok) {
    let errorMessage = `Request failed: ${response.statusText}`;
    let errorData: any = null;

    try {
      errorData = await response.json();
      errorMessage = errorData.error || errorData.message || errorMessage;
    } catch {
      // If response is not JSON, use status text
    }

    const error: ApiError = {
      message: errorMessage,
      status: response.status,
      statusText: response.statusText,
      error: errorData,
    };

    // Handle 401 Unauthorized - token expired, refresh and retry once
    if (response.status === 401 && !_isRetry) {
      console.warn('Unauthorized - refreshing session and retrying request');
      try {
        clearTokenCache();
        await fetchAuthSession({ forceRefresh: true });
        toast({
          title: 'Session refreshed',
          description: '401 Unauthorized received. Token refreshed, retrying your request now.',
        });
        // Retry the request once with the fresh token
        return await apiRequest<T>(endpoint, options, true);
      } catch (refreshError) {
        console.error('Token refresh failed, redirecting to login');
        toast({
          title: 'Session expired',
          description: '401 Unauthorized received. Token refresh failed — please sign in again.',
          variant: 'destructive',
        });
        window.location.href = '/login';
      }
    }

    // Handle 401 on retry - refresh didn't help
    if (response.status === 401 && _isRetry) {
      console.error('Still unauthorized after token refresh');
      toast({
        title: 'Session expired',
        description: '401 Unauthorized received again after token refresh — please sign in again.',
        variant: 'destructive',
      });
      window.location.href = '/login';
    }

    // Handle 403 Forbidden - user doesn't have permission
    if (response.status === 403) {
      console.warn('Forbidden - user does not have permission');
    }

    throw error;
  }

  // Parse response
  try {
    const data = await response.json();
    
    // Auto-update cache for mutations (POST, PUT, DELETE)
    if (globalQueryClient && ['POST', 'PUT', 'DELETE'].includes(options.method || '')) {
      updateCacheFromResponse(endpoint, options.method || '', data, options.optimisticId);
    }
    
    return data;
  } catch (error) {
    // If response is not JSON, return empty object
    return {} as T;
  }
}

/**
 * Automatically update TanStack Query cache based on API response
 * Supports optimistic updates by replacing temp items with real data
 */
function updateCacheFromResponse(endpoint: string, method: string, responseData: any, optimisticId?: string) {
  if (!globalQueryClient) return;
  
  // Extract the actual data (handle { data: ... } wrapper)
  const data = responseData?.data || responseData;
  if (!data) return;
  
  // Determine which cache to update based on endpoint
  if (endpoint.includes('/tools')) {
    if (method === 'POST') {
      if (optimisticId) {
        // Replace optimistic temp item with real data
        globalQueryClient.setQueryData(toolsQueryKey(), (old: any[] = []) => 
          old.map(item => item.id === optimisticId ? data : item)
        );
      } else {
        // Add new tool to cache (non-optimistic)
        globalQueryClient.setQueryData(toolsQueryKey(), (old: any[] = []) => [...old, data]);
      }
    } else if (method === 'PUT') {
      // Update existing tool in cache
      globalQueryClient.setQueryData(toolsQueryKey(), (old: any[] = []) => 
        old.map(item => item.id === data.id ? data : item)
      );
    } else if (method === 'DELETE') {
      // Remove tool from cache
      const toolId = endpoint.split('/').pop();
      globalQueryClient.setQueryData(toolsQueryKey(), (old: any[] = []) => 
        old.filter(item => item.id !== toolId)
      );
    }
  } else if (endpoint.includes('/actions')) {
    if (method === 'POST') {
      // New actions are unresolved by default — add to ['actions'] cache
      if (optimisticId) {
        globalQueryClient.setQueryData(actionsQueryKey(), (old: any[] = []) => 
          old.map(item => item.id === optimisticId ? data : item)
        );
      } else {
        globalQueryClient.setQueryData(actionsQueryKey(), (old: any[] = []) => [...old, data]);
      }
      // Also update ['actions_all'] if it exists
      globalQueryClient.setQueryData(allActionsQueryKey(), (old: any[] | undefined) => 
        old ? [...old, data] : undefined
      );
    } else if (method === 'PUT') {
      const isCompleted = data.status === 'completed';
      if (isCompleted) {
        // Move from unresolved to completed cache
        globalQueryClient.setQueryData(actionsQueryKey(), (old: any[] = []) => 
          old.filter(item => item.id !== data.id)
        );
        globalQueryClient.setQueryData(completedActionsQueryKey(), (old: any[] | undefined) => {
          if (!old) return undefined; // Don't create cache if not yet loaded
          const exists = old.some(item => item.id === data.id);
          return exists ? old.map(item => item.id === data.id ? data : item) : [data, ...old];
        });
      } else {
        // Update in unresolved cache; if it was previously completed, move it back
        globalQueryClient.setQueryData(actionsQueryKey(), (old: any[] = []) => {
          const exists = old.some(item => item.id === data.id);
          return exists ? old.map(item => item.id === data.id ? data : item) : [...old, data];
        });
        globalQueryClient.setQueryData(completedActionsQueryKey(), (old: any[] | undefined) => 
          old ? old.filter(item => item.id !== data.id) : undefined
        );
      }
      // Also update ['actions_all'] if it exists
      globalQueryClient.setQueryData(allActionsQueryKey(), (old: any[] | undefined) => 
        old ? old.map(item => item.id === data.id ? data : item) : undefined
      );
    } else if (method === 'DELETE') {
      const actionId = endpoint.split('/').pop();
      // Remove from both caches
      globalQueryClient.setQueryData(actionsQueryKey(), (old: any[] = []) => 
        old.filter(item => item.id !== actionId)
      );
      globalQueryClient.setQueryData(completedActionsQueryKey(), (old: any[] | undefined) => 
        old ? old.filter(item => item.id !== actionId) : undefined
      );
      globalQueryClient.setQueryData(allActionsQueryKey(), (old: any[] | undefined) => 
        old ? old.filter(item => item.id !== actionId) : undefined
      );
    }
  } else if (endpoint.includes('/missions')) {
    if (method === 'POST') {
      if (optimisticId) {
        globalQueryClient.setQueryData(missionsQueryKey(), (old: any[] = []) => 
          old.map(item => item.id === optimisticId ? data : item)
        );
      } else {
        globalQueryClient.setQueryData(missionsQueryKey(), (old: any[] = []) => [...old, data]);
      }
    } else if (method === 'PUT') {
      globalQueryClient.setQueryData(missionsQueryKey(), (old: any[] = []) => 
        old.map(item => item.id === data.id ? data : item)
      );
    }
  } else if (endpoint.includes('/explorations') || endpoint.includes('/exploration')) {
    if (method === 'POST') {
      if (optimisticId) {
        globalQueryClient.setQueryData(explorationsQueryKey(), (old: any[] = []) => 
          old.map(item => item.id === optimisticId ? data : item)
        );
      } else {
        globalQueryClient.setQueryData(explorationsQueryKey(), (old: any[] = []) => [...old, data]);
      }
    } else if (method === 'PUT') {
      globalQueryClient.setQueryData(explorationsQueryKey(), (old: any[] = []) => 
        old.map(item => item.id === data.id ? data : item)
      );
    }
  } else if (endpoint.includes('/experiences')) {
    if (method === 'POST') {
      if (optimisticId) {
        globalQueryClient.setQueryData(experiencesQueryKey(), (old: any[] = []) => 
          old.map(item => item.id === optimisticId ? data : item)
        );
      } else {
        globalQueryClient.setQueryData(experiencesQueryKey(), (old: any[] = []) => [...old, data]);
      }
      // Also invalidate entity-specific queries if we have entity info
      if (data.entity_type && data.entity_id) {
        globalQueryClient.invalidateQueries({ 
          queryKey: experiencesQueryKey({ entity_type: data.entity_type, entity_id: data.entity_id }) 
        });
      }
    } else if (method === 'PUT') {
      globalQueryClient.setQueryData(experiencesQueryKey(), (old: any[] = []) => 
        old.map(item => item.id === data.id ? data : item)
      );
      // Also invalidate entity-specific queries
      if (data.entity_type && data.entity_id) {
        globalQueryClient.invalidateQueries({ 
          queryKey: experiencesQueryKey({ entity_type: data.entity_type, entity_id: data.entity_id }) 
        });
      }
    } else if (method === 'DELETE') {
      const experienceId = endpoint.split('/').pop();
      globalQueryClient.setQueryData(experiencesQueryKey(), (old: any[] = []) => 
        old.filter(item => item.id !== experienceId)
      );
    }
  }
}

/**
 * API Service with common HTTP methods
 */
export const apiService = {
  /**
   * GET request
   */
  async get<T = any>(endpoint: string, options?: RequestInit): Promise<T> {
    return apiRequest<T>(endpoint, {
      ...options,
      method: 'GET',
    });
  },

  /**
   * POST request
   * @param optimisticId - Optional temp ID for optimistic updates (will replace temp item with real data)
   */
  async post<T = any>(endpoint: string, body?: any, options?: RequestInit & { optimisticId?: string }): Promise<T> {
    return apiRequest<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  /**
   * PUT request
   */
  async put<T = any>(endpoint: string, body?: any, options?: RequestInit): Promise<T> {
    return apiRequest<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  /**
   * DELETE request
   */
  async delete<T = any>(endpoint: string, options?: RequestInit): Promise<T> {
    return apiRequest<T>(endpoint, {
      ...options,
      method: 'DELETE',
    });
  },

  /**
   * PATCH request
   */
  async patch<T = any>(endpoint: string, body?: any, options?: RequestInit): Promise<T> {
    return apiRequest<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
};

/**
 * Helper to get data from API response
 * Most API responses follow the pattern: { data: ... }
 */
export function getApiData<T>(response: { data?: T }): T {
  return response.data as T;
}

/**
 * Helper to check if API response has data
 */
export function hasApiData(response: any): boolean {
  return response !== null && response !== undefined && response.data !== undefined;
}

/**
 * Experience API Methods
 */
import type { 
  Experience, 
  CreateExperienceRequest, 
  ExperienceListParams, 
  ExperienceListResponse 
} from '@/types/experiences';

/**
 * Create a new experience
 */
export async function createExperience(
  request: CreateExperienceRequest
): Promise<{ data: Experience }> {
  return apiService.post<{ data: Experience }>('/experiences', request);
}

/**
 * List experiences with optional filters
 */
export async function listExperiences(
  params?: ExperienceListParams
): Promise<ExperienceListResponse> {
  const queryParams = new URLSearchParams();
  
  if (params?.entity_type) {
    queryParams.append('entity_type', params.entity_type);
  }
  if (params?.entity_id) {
    queryParams.append('entity_id', params.entity_id);
  }
  if (params?.limit !== undefined) {
    queryParams.append('limit', params.limit.toString());
  }
  if (params?.offset !== undefined) {
    queryParams.append('offset', params.offset.toString());
  }
  
  const queryString = queryParams.toString();
  const endpoint = queryString ? `/experiences?${queryString}` : '/experiences';
  
  return apiService.get<ExperienceListResponse>(endpoint);
}

/**
 * Get a single experience by ID
 */
export async function getExperience(
  experienceId: string
): Promise<{ data: Experience }> {
  return apiService.get<{ data: Experience }>(`/experiences/${experienceId}`);
}

