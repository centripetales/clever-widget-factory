/**
 * ExplorationService
 * 
 * Handles exploration CRUD operations and management
 * Supports exploration filtering, listing, and AI-assisted content generation
 * 
 * Requirements: 2.4, 2.6, 2.7, 2.8, 6.6, 5.1, 5.2, 5.3, 8.2, 8.5
 */

import { apiService, getApiData } from '../lib/apiService';
import { explorationCodeGenerator } from './explorationCodeGenerator';
import { embeddingQueue } from './embeddingQueue';

export interface CreateExplorationRequest {
  exploration_code?: string;
  exploration_notes_text?: string;
  metrics_text?: string;
  public_flag?: boolean;
}

export interface UpdateExplorationRequest {
  exploration_code?: string;
  exploration_notes_text?: string;
  metrics_text?: string;
  public_flag?: boolean;
  key_photos?: string[];
}

export interface ExplorationResponse {
  id: number;
  action_id: string;
  exploration_code: string;
  exploration_notes_text?: string;
  metrics_text?: string;
  public_flag: boolean;
  key_photos: string[];
  created_at: string;
  updated_at: string;
}

export interface ExplorationFilters {
  date_range?: { start: Date; end: Date };
  location?: string;
  explorer?: string; // user_id
  public_flag?: boolean;
  limit?: number;
  offset?: number;
}

export interface ExplorationListItem {
  exploration_code: string;
  name?: string;
  state_text: string;
  summary_policy_text?: string;
  exploration_notes_text?: string;
  metrics_text?: string;
  key_photos: string[]; // URLs or identifiers
  action_id: string;
  exploration_id: number;
  created_at: string;
  explorer_name?: string;
  public_flag: boolean;
}

export interface ExplorationSuggestions {
  exploration_notes_text?: string;
  metrics_text?: string;
}

export class ExplorationService {
  /**
   * Create a new exploration record
   * @param data - Exploration creation data
   * @returns Promise<ExplorationResponse> - The created exploration
   */
  async createExploration(data: CreateExplorationRequest): Promise<ExplorationResponse> {
    try {
      // Generate exploration code if not provided
      const exploration_code = data.exploration_code || 
        await explorationCodeGenerator.generateCode(new Date());

      const explorationData = {
        ...data,
        exploration_code,
        public_flag: data.public_flag ?? false
      };

      const response = await apiService.post('/explorations', explorationData);
      const result = response.data || response;

      // Enqueue embedding jobs after successful creation
      try {
        await embeddingQueue.enqueueExplorationEmbeddings(result.id.toString(), {
          exploration_notes_text: result.exploration_notes_text,
          metrics_text: result.metrics_text
        });
      } catch (embeddingError) {
        console.warn('Failed to enqueue exploration embeddings:', embeddingError);
        // Don't fail the exploration creation if embedding fails
      }

      return result;
    } catch (error) {
      console.error('Error creating exploration:', error);
      throw error;
    }
  }

  /**
   * Update an existing exploration by ID
   * @param id - Exploration ID
   * @param data - Exploration update data
   * @returns Promise<ExplorationResponse> - The updated exploration
   */
  async updateExploration(id: number, data: UpdateExplorationRequest): Promise<ExplorationResponse> {
    try {
      const response = await apiService.put(`/explorations/${id}`, data);
      const result = response.data || response;

      // Enqueue embedding jobs if text fields were updated
      const hasTextUpdates = data.exploration_notes_text !== undefined || 
                           data.metrics_text !== undefined;
      
      if (hasTextUpdates) {
        try {
          await embeddingQueue.enqueueExplorationEmbeddings(id.toString(), {
            exploration_notes_text: result.exploration_notes_text,
            metrics_text: result.metrics_text
          });
        } catch (embeddingError) {
          console.warn('Failed to enqueue exploration embeddings after update:', embeddingError);
          // Don't fail the update if embedding fails
        }
      }

      return result;
    } catch (error) {
      console.error('Error updating exploration:', error);
      throw error;
    }
  }

  /**
   * Update an existing exploration by action ID
   * @param actionId - Action ID
   * @param data - Exploration update data (can include exploration_code)
   * @returns Promise<ExplorationResponse> - The updated exploration
   */
  async updateExplorationByActionId(actionId: string, data: UpdateExplorationRequest): Promise<ExplorationResponse> {
    try {
      const response = await apiService.put('/explorations', {
        action_id: actionId,
        ...data
      });
      const result = response.data || response;

      // Enqueue embedding jobs if text fields were updated
      const hasTextUpdates = data.exploration_notes_text !== undefined || 
                           data.metrics_text !== undefined;
      
      if (hasTextUpdates) {
        try {
          await embeddingQueue.enqueueExplorationEmbeddings(result.id.toString(), {
            exploration_notes_text: result.exploration_notes_text,
            metrics_text: result.metrics_text
          });
        } catch (embeddingError) {
          console.warn('Failed to enqueue exploration embeddings after update:', embeddingError);
          // Don't fail the update if embedding fails
        }
      }

      return result;
    } catch (error) {
      console.error('Error updating exploration by action ID:', error);
      throw error;
    }
  }

  /**
   * Get an exploration by ID
   * @param id - Exploration ID
   * @returns Promise<ExplorationResponse> - The exploration
   */
  async getExploration(id: number): Promise<ExplorationResponse> {
    try {
      const response = await apiService.get(`/explorations/${id}`);
      return response.data || response;
    } catch (error) {
      console.error('Error fetching exploration:', error);
      throw error;
    }
  }

  /**
   * Get exploration by action ID
   * @param actionId - Action ID
   * @returns Promise<ExplorationResponse | null> - The exploration or null if not found
   */
  async getExplorationByActionId(actionId: string): Promise<ExplorationResponse | null> {
    try {
      const response = await apiService.get(`/explorations?action_id=${actionId}`);
      
      // Handle both { data: [...] } and direct array responses
      let explorations = Array.isArray(response) ? response : (response.data || response || []);
      
      if (Array.isArray(explorations) && explorations.length > 0) {
        return explorations[0];
      }
      
      return null;
    } catch (error) {
      console.error('Error fetching exploration by action ID:', error);
      return null;
    }
  }

  /**
   * Generate a unique exploration code for the given date
   * @param date - The date for the exploration
   * @param farmCode - Optional farm code (defaults to 'SF')
   * @param suffix - Optional suffix (defaults to 'EX'). Examples: 'EX', 'CT' (curry tree)
   * @returns Promise<string> - The generated exploration code
   */
  async generateExplorationCode(date: Date, farmCode?: string, suffix?: string): Promise<string> {
    return explorationCodeGenerator.generateCode(date, { farmCode, suffix });
  }

  /**
   * Generate AI-assisted exploration suggestions
   * @param actionId - Action ID to generate suggestions for
   * @returns Promise<ExplorationSuggestions> - Generated suggestions
   */
  async generateExplorationSuggestions(actionId: string): Promise<ExplorationSuggestions> {
    try {
      const response = await apiService.post('/ai/generate-exploration-suggestions', {
        action_id: actionId
      });

      return {
        exploration_notes_text: response.exploration_notes_text || response.data?.exploration_notes_text || '',
        metrics_text: response.metrics_text || response.data?.metrics_text || ''
      };
    } catch (error) {
      console.error('Error generating exploration suggestions:', error);
      // Return empty suggestions if AI service fails - feature should be optional
      return {
        exploration_notes_text: '',
        metrics_text: ''
      };
    }
  }

  /**
   * List explorations with optional filters
   * @param filters - Optional filters
   * @returns Promise<ExplorationListItem[]> - List of explorations with action data
   */
  async listExplorations(filters: ExplorationFilters = {}): Promise<ExplorationListItem[]> {
    try {
      const queryParams = new URLSearchParams();
      
      // Add filters to query params
      if (filters.date_range) {
        queryParams.append('start_date', filters.date_range.start.toISOString());
        queryParams.append('end_date', filters.date_range.end.toISOString());
      }
      if (filters.location) {
        queryParams.append('location', filters.location);
      }
      if (filters.explorer) {
        queryParams.append('explorer', filters.explorer);
      }
      if (filters.public_flag !== undefined) {
        queryParams.append('public_flag', String(filters.public_flag));
      }
      if (filters.limit) {
        queryParams.append('limit', String(filters.limit));
      }
      if (filters.offset) {
        queryParams.append('offset', String(filters.offset));
      }

      const endpoint = queryParams.toString() 
        ? `/explorations/list?${queryParams.toString()}`
        : '/explorations/list';

      const response = await apiService.get(endpoint);
      return response.data || response || [];
    } catch (error) {
      console.error('Error listing explorations:', error);
      throw error;
    }
  }

  /**
   * Check if an exploration code exists
   * @param code - The exploration code to check
   * @returns Promise<boolean> - True if code exists
   */
  async codeExists(code: string): Promise<boolean> {
    try {
      const response = await apiService.get(`/explorations/check-code/${encodeURIComponent(code)}`);
      return response.exists === true;
    } catch (error) {
      console.error('Error checking exploration code:', error);
      return false;
    }
  }

  /**
   * Get existing exploration codes by prefix
   * @param prefix - The prefix to search for
   * @returns Promise<string[]> - Array of existing codes
   */
  async getCodesByPrefix(prefix: string): Promise<string[]> {
    try {
      const response = await apiService.get(`/explorations/codes-by-prefix/${encodeURIComponent(prefix)}`);
      return response.codes || [];
    } catch (error) {
      console.error('Error fetching codes by prefix:', error);
      return [];
    }
  }

  /**
   * Delete an exploration
   * @param id - Exploration ID (UUID string)
   * @returns Promise<void>
   */
  async deleteExploration(id: string): Promise<void> {
    try {
      await apiService.delete(`/explorations/${id}`);
    } catch (error) {
      console.error('Error deleting exploration:', error);
      throw error;
    }
  }

  /**
   * Link an action to an exploration (many-to-many)
   * @param actionId - Action ID
   * @param explorationId - Exploration ID
   * @returns Promise<any> - Response with action and exploration data
   */
  async linkExploration(actionId: string, explorationId: string): Promise<any> {
    try {
      const response = await apiService.post(
        `/actions/${actionId}/explorations`,
        { exploration_ids: [explorationId] }
      );
      return response.data || response;
    } catch (error) {
      console.error('Error linking exploration:', error);
      throw error;
    }
  }

  /**
   * Link an action to multiple explorations (many-to-many)
   * @param actionId - Action ID
   * @param explorationIds - Array of exploration IDs
   * @returns Promise<any> - Response with action and exploration data
   */
  async linkExplorations(actionId: string, explorationIds: string[]): Promise<any> {
    try {
      const response = await apiService.post(
        `/actions/${actionId}/explorations`,
        { exploration_ids: explorationIds }
      );
      return response.data || response;
    } catch (error) {
      console.error('Error linking explorations:', error);
      throw error;
    }
  }

  /**
   * Unlink an action from an exploration
   * @param actionId - Action ID
   * @param explorationId - Exploration ID
   * @returns Promise<any> - Response with updated action
   */
  async unlinkExploration(actionId: string, explorationId: string): Promise<any> {
    try {
      const response = await apiService.delete(
        `/actions/${actionId}/explorations/${explorationId}`
      );
      return response.data || response;
    } catch (error) {
      console.error('Error unlinking exploration:', error);
      throw error;
    }
  }

  /**
   * Get non-integrated explorations for selection dialog
   * @returns Promise<any[]> - List of explorations with action_count
   */
  async getNonIntegratedExplorations(): Promise<any[]> {
    try {
      const response = await apiService.get('/explorations/list?status=in_progress,ready_for_analysis');
      return response.data || response || [];
    } catch (error) {
      console.error('Error fetching non-integrated explorations:', error);
      throw error;
    }
  }

  /**
   * Create a new exploration without requiring an action
   * @deprecated - Explorations should be created with manual code entry
   * Kept for backward compatibility if needed elsewhere
   * @returns Promise<any> - The created exploration
   */
  async createNewExploration(): Promise<any> {
    try {
      // Generate exploration code
      const exploration_code = await explorationCodeGenerator.generateCode(new Date());

      const response = await apiService.post('/explorations', {
        exploration_code,
        status: 'in_progress'
      });

      return response.data || response;
    } catch (error) {
      console.error('Error creating new exploration:', error);
      throw error;
    }
  }
}

// Export a singleton instance for convenience
export const explorationService = new ExplorationService();
