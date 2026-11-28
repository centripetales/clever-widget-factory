/**
 * PolicyService
 * 
 * Handles policy CRUD operations and management
 * Supports policy creation, linking, and promotion from explorations
 * 
 * Requirements: 3.1, 3.3, 3.4, 3.6, 7.5, 3.5, 7.3, 3.2, 8.3
 */

import { apiService } from '../lib/apiService';
import { embeddingQueue } from './embeddingQueue';

export interface CreatePolicyRequest {
  title: string;
  description_text: string;
  status: 'active' | 'deprecated';
  effective_from?: Date;
  effective_to?: Date;
  link_to_action_id?: string; // Optional linking during creation
}

export interface UpdatePolicyRequest {
  title?: string;
  description_text?: string;
  status?: 'active' | 'deprecated';
  effective_from?: Date;
  effective_to?: Date;
}

export interface PolicyResponse {
  id: number;
  title: string;
  description_text: string;
  status: 'active' | 'deprecated';
  effective_from?: string;
  effective_to?: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface PolicyDraft {
  title: string;
  description_text: string;
}

export interface PolicyFilters {
  status?: 'active' | 'deprecated';
  crop?: string;
  created_by?: string;
  limit?: number;
  offset?: number;
}

export interface PolicySearchResponse {
  policies: PolicyResponse[];
  total: number;
}

export class PolicyService {
  /**
   * Create a new policy
   * @param data - Policy creation data
   * @returns Promise<PolicyResponse> - The created policy
   */
  async createPolicy(data: CreatePolicyRequest): Promise<PolicyResponse> {
    try {
      const policyData = {
        ...data,
        effective_from: data.effective_from?.toISOString(),
        effective_to: data.effective_to?.toISOString(),
      };

      const response = await apiService.post('/policies', policyData);
      const policy = response.data || response;

      // If link_to_action_id is provided, link the action to this policy
      if (data.link_to_action_id) {
        await this.linkActionToPolicy(data.link_to_action_id, policy.id);
      }

      // Enqueue embedding job after successful creation
      try {
        await embeddingQueue.enqueuePolicyEmbedding(
          policy.id.toString(), 
          'policy_description', 
          policy.description_text
        );
      } catch (embeddingError) {
        console.warn('Failed to enqueue policy embedding:', embeddingError);
        // Don't fail the policy creation if embedding fails
      }

      return policy;
    } catch (error) {
      console.error('Error creating policy:', error);
      throw error;
    }
  }

  /**
   * Update an existing policy
   * @param id - Policy ID
   * @param data - Policy update data
   * @returns Promise<PolicyResponse> - The updated policy
   */
  async updatePolicy(id: number, data: UpdatePolicyRequest): Promise<PolicyResponse> {
    try {
      const updateData = {
        ...data,
        effective_from: data.effective_from?.toISOString(),
        effective_to: data.effective_to?.toISOString(),
      };

      const response = await apiService.put(`/policies/${id}`, updateData);
      const result = response.data || response;

      // Enqueue embedding job if description was updated
      if (data.description_text !== undefined) {
        try {
          await embeddingQueue.enqueuePolicyEmbedding(
            id.toString(), 
            'policy_description', 
            result.description_text
          );
        } catch (embeddingError) {
          console.warn('Failed to enqueue policy embedding after update:', embeddingError);
          // Don't fail the update if embedding fails
        }
      }

      return result;
    } catch (error) {
      console.error('Error updating policy:', error);
      throw error;
    }
  }

  /**
   * Get a policy by ID
   * @param id - Policy ID
   * @returns Promise<PolicyResponse> - The policy
   */
  async getPolicy(id: number): Promise<PolicyResponse> {
    try {
      const response = await apiService.get(`/policies/${id}`);
      return response.data || response;
    } catch (error) {
      console.error('Error fetching policy:', error);
      throw error;
    }
  }

  /**
   * List policies with optional filters
   * @param filters - Optional filters
   * @returns Promise<PolicyResponse[]> - List of policies
   */
  async listPolicies(filters: PolicyFilters = {}): Promise<PolicyResponse[]> {
    try {
      const queryParams = new URLSearchParams();
      
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          queryParams.append(key, String(value));
        }
      });

      const endpoint = queryParams.toString() 
        ? `/policies?${queryParams.toString()}`
        : '/policies';

      const response = await apiService.get(endpoint);
      return response.data || response || [];
    } catch (error) {
      console.error('Error listing policies:', error);
      throw error;
    }
  }

  /**
   * Link an action to an existing policy
   * @param actionId - Action ID
   * @param policyId - Policy ID
   * @returns Promise<void>
   */
  async linkActionToPolicy(actionId: string, policyId: number): Promise<void> {
    try {
      await apiService.put(`/actions/${actionId}`, {
        policy_id: policyId
      });
    } catch (error) {
      console.error('Error linking action to policy:', error);
      throw error;
    }
  }

  /**
   * Generate a policy draft from exploration data
   * @param explorationId - Exploration ID
   * @returns Promise<PolicyDraft> - Generated policy draft
   */
  async generatePolicyFromExploration(explorationId: number): Promise<PolicyDraft> {
    try {
      const response = await apiService.post('/ai/generate-policy-from-exploration', {
        exploration_id: explorationId
      });

      return {
        title: response.title || response.data?.title || '',
        description_text: response.description_text || response.data?.description_text || ''
      };
    } catch (error) {
      console.error('Error generating policy from exploration:', error);
      // Return empty draft if AI service fails - feature should be optional
      return {
        title: '',
        description_text: ''
      };
    }
  }

  /**
   * Search policies by query string
   * @param query - Search query
   * @param filters - Optional filters
   * @returns Promise<PolicySearchResponse> - Search results
   */
  async searchPolicies(query: string, filters?: PolicyFilters): Promise<PolicySearchResponse> {
    try {
      const queryParams = new URLSearchParams();
      queryParams.append('q', query);
      
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            queryParams.append(key, String(value));
          }
        });
      }

      const response = await apiService.get(`/policies/search?${queryParams.toString()}`);
      return {
        policies: response.data || response.policies || [],
        total: response.total || 0
      };
    } catch (error) {
      console.error('Error searching policies:', error);
      throw error;
    }
  }

  /**
   * Delete a policy (with validation)
   * @param id - Policy ID
   * @returns Promise<void>
   */
  async deletePolicy(id: number): Promise<void> {
    try {
      // Check if policy is linked to any actions
      const linkedActions = await apiService.get(`/actions?policy_id=${id}`);
      const actions = linkedActions.data || linkedActions || [];
      
      if (actions.length > 0) {
        throw new Error(`Cannot delete policy: ${actions.length} actions are linked to this policy`);
      }

      await apiService.delete(`/policies/${id}`);
    } catch (error) {
      console.error('Error deleting policy:', error);
      throw error;
    }
  }

  /**
   * Validate policy status transition
   * @param currentStatus - Current policy status
   * @param newStatus - New policy status
   * @returns boolean - True if transition is valid
   */
  static validateStatusTransition(
    currentStatus: 'active' | 'deprecated',
    newStatus: 'active' | 'deprecated'
  ): boolean {
    // Valid transitions:
    // active -> deprecated
    // deprecated -> active (allowed for reactivation)
    // Same status is always allowed

    if (currentStatus === newStatus) {
      return true;
    }

    const validTransitions = {
      active: ['deprecated'],
      deprecated: ['active'] // Allow reactivation
    };
    
    return validTransitions[currentStatus]?.includes(newStatus) || false;
  }

  /**
   * Validate effective date range
   * @param effectiveFrom - Start date
   * @param effectiveTo - End date
   * @returns boolean - True if date range is valid
   */
  static validateDateRange(effectiveFrom?: Date, effectiveTo?: Date): boolean {
    if (!effectiveFrom || !effectiveTo) {
      return true; // Null dates are allowed
    }
    
    return effectiveFrom <= effectiveTo;
  }
}

// Export a singleton instance for convenience
export const policyService = new PolicyService();