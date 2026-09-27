/**
 * AI Content Service
 * 
 * Provides AI-assisted content generation for exploration data collection
 * Generates summary policy text, exploration suggestions, and policy drafts
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import { apiService } from '../lib/apiService';

export interface SummaryPolicyRequest {
  state_text: string;
  policy_text?: string;
  action_context?: {
    title?: string;
    location?: string;
    assigned_to?: string;
    priority?: string;
  };
}

export interface ExplorationSuggestionRequest {
  action_id: string;
  state_text: string;
  policy_text?: string;
  summary_policy_text?: string;
  existing_exploration_notes?: string;
  existing_metrics?: string;
}

export interface ExpectedStateRequest {
  title: string;
  description?: string;
  asset_name?: string;
}

export interface ExpectedStateResponse {
  expected_state: string;
}

export interface PolicyDraftRequest {
  exploration_data: {
    exploration_code: string;
    exploration_notes_text: string;
    metrics_text: string;
    action_title: string;
    state_text: string;
  };
  similar_policies?: Array<{
    title: string;
    description_text: string;
    status: string;
  }>;
}

export interface AIContentResponse<T> {
  content: T;
  confidence: number;
  model_used: string;
  generated_at: string;
  context_used: string[];
}

export interface SummaryPolicyResponse {
  summary_policy_text: string;
  key_points: string[];
  safety_considerations: string[];
}

export interface ExplorationSuggestionResponse {
  exploration_notes_text: string;
  metrics_text: string;
  suggested_measurements: string[];
  comparison_areas: string[];
  documentation_tips: string[];
}

export interface PolicyDraftResponse {
  title: string;
  description_text: string;
  key_procedures: string[];
  safety_requirements: string[];
  documentation_requirements: string[];
  effective_conditions: string[];
}

export class AIContentService {
  private readonly baseUrl = '/ai';
  private readonly defaultModel = 'gpt-4';
  private readonly fallbackEnabled = true;

  /**
   * Generate summary policy text from state and policy information
   * Requirements: 8.1, 8.6
   */
  async generateSummaryPolicy(
    request: SummaryPolicyRequest
  ): Promise<AIContentResponse<SummaryPolicyResponse> | null> {
    try {
      const prompt = this.buildSummaryPolicyPrompt(request);
      
      const response = await apiService.post(`${this.baseUrl}/generate-summary-policy`, {
        prompt,
        model: this.defaultModel,
        max_tokens: 500,
        temperature: 0.3, // Lower temperature for more consistent policy text
        context: {
          type: 'summary_policy_generation',
          state_text: request.state_text,
          policy_text: request.policy_text,
          action_context: request.action_context
        }
      });

      if (!response.data || !response.data.content) {
        if (this.fallbackEnabled) {
          return this.generateFallbackSummaryPolicy(request);
        }
        return null;
      }

      return {
        content: this.parseSummaryPolicyResponse(response.data.content),
        confidence: response.data.confidence || 0.8,
        model_used: response.data.model || this.defaultModel,
        generated_at: new Date().toISOString(),
        context_used: ['state_text', 'policy_text', 'action_context']
      };
    } catch (error) {
      console.error('Failed to generate summary policy:', error);
      
      if (this.fallbackEnabled) {
        return this.generateFallbackSummaryPolicy(request);
      }
      
      return null;
    }
  }

  /**
   * Generate expected state (S') text from action context
   * Requirements: 1.4
   */
  async generateExpectedState(
    request: ExpectedStateRequest
  ): Promise<AIContentResponse<ExpectedStateResponse> | null> {
    try {
      const prompt = this.buildExpectedStatePrompt(request);

      const response = await apiService.post(`${this.baseUrl}/generate-summary-policy`, {
        prompt,
        model: this.defaultModel,
        max_tokens: 300,
        temperature: 0.3,
        context: {
          type: 'expected_state_generation',
          title: request.title,
          description: request.description,
          asset_name: request.asset_name
        }
      });

      if (!response.data || !response.data.content) {
        if (this.fallbackEnabled) {
          return this.generateFallbackExpectedState(request);
        }
        return null;
      }

      return {
        content: this.parseExpectedStateResponse(response.data.content),
        confidence: response.data.confidence || 0.8,
        model_used: response.data.model || this.defaultModel,
        generated_at: new Date().toISOString(),
        context_used: ['title', 'description', 'asset_name']
      };
    } catch (error) {
      console.error('Failed to generate expected state:', error);

      if (this.fallbackEnabled) {
        return this.generateFallbackExpectedState(request);
      }

      return null;
    }
  }

  /**
   * Generate exploration suggestions based on action context
   * Requirements: 8.2, 8.5
   */
  async generateExplorationSuggestions(
    request: ExplorationSuggestionRequest
  ): Promise<AIContentResponse<ExplorationSuggestionResponse> | null> {
    try {
      const prompt = this.buildExplorationSuggestionPrompt(request);
      
      const response = await apiService.post(`${this.baseUrl}/generate-exploration-suggestions`, {
        prompt,
        model: this.defaultModel,
        max_tokens: 800,
        temperature: 0.4, // Slightly higher for more creative suggestions
        context: {
          type: 'exploration_suggestions',
          action_id: request.action_id,
          state_text: request.state_text,
          policy_text: request.policy_text,
          existing_notes: request.existing_exploration_notes,
          existing_metrics: request.existing_metrics
        }
      });

      if (!response.data || !response.data.content) {
        if (this.fallbackEnabled) {
          return this.generateFallbackExplorationSuggestions(request);
        }
        return null;
      }

      return {
        content: this.parseExplorationSuggestionResponse(response.data.content),
        confidence: response.data.confidence || 0.7,
        model_used: response.data.model || this.defaultModel,
        generated_at: new Date().toISOString(),
        context_used: ['state_text', 'policy_text', 'existing_exploration_data']
      };
    } catch (error) {
      console.error('Failed to generate exploration suggestions:', error);
      
      if (this.fallbackEnabled) {
        return this.generateFallbackExplorationSuggestions(request);
      }
      
      return null;
    }
  }

  /**
   * Generate policy draft from exploration data
   * Requirements: 3.2, 8.3
   */
  async generatePolicyDraft(
    request: PolicyDraftRequest
  ): Promise<AIContentResponse<PolicyDraftResponse> | null> {
    try {
      const prompt = this.buildPolicyDraftPrompt(request);
      
      const response = await apiService.post(`${this.baseUrl}/generate-policy-draft`, {
        prompt,
        model: this.defaultModel,
        max_tokens: 1000,
        temperature: 0.2, // Very low temperature for consistent policy language
        context: {
          type: 'policy_draft_generation',
          exploration_code: request.exploration_data.exploration_code,
          exploration_notes: request.exploration_data.exploration_notes_text,
          metrics: request.exploration_data.metrics_text,
          similar_policies_count: request.similar_policies?.length || 0
        }
      });

      if (!response.data || !response.data.content) {
        if (this.fallbackEnabled) {
          return this.generateFallbackPolicyDraft(request);
        }
        return null;
      }

      return {
        content: this.parsePolicyDraftResponse(response.data.content),
        confidence: response.data.confidence || 0.8,
        model_used: response.data.model || this.defaultModel,
        generated_at: new Date().toISOString(),
        context_used: ['exploration_data', 'similar_policies', 'action_context']
      };
    } catch (error) {
      console.error('Failed to generate policy draft:', error);
      
      if (this.fallbackEnabled) {
        return this.generateFallbackPolicyDraft(request);
      }
      
      return null;
    }
  }

  /**
   * Check if AI services are available
   * Requirements: 8.6
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await apiService.get(`${this.baseUrl}/health`);
      return response.status === 200 || response.statusCode === 200;
    } catch (error) {
      console.warn('AI service health check failed:', error);
      return false;
    }
  }

  /**
   * Get AI service capabilities and model information
   */
  async getCapabilities(): Promise<{
    available_models: string[];
    features: string[];
    rate_limits: {
      requests_per_minute: number;
      tokens_per_minute: number;
    };
  } | null> {
    try {
      const response = await apiService.get(`${this.baseUrl}/capabilities`);
      return response.data || null;
    } catch (error) {
      console.error('Failed to get AI capabilities:', error);
      return null;
    }
  }

  // Private helper methods

  private buildSummaryPolicyPrompt(request: SummaryPolicyRequest): string {
    const context = request.action_context;
    const contextInfo = context ? 
      `Action Context: ${context.title || 'N/A'} at ${context.location || 'N/A'}, Priority: ${context.priority || 'N/A'}` : '';

    return `Generate a concise summary policy text based on the following information:

State/Description: ${request.state_text}
${request.policy_text ? `Existing Policy: ${request.policy_text}` : ''}
${contextInfo}

Requirements:
- Create a clear, actionable summary that combines the key elements
- Focus on safety, documentation, and procedural requirements
- Keep it concise but comprehensive (2-3 sentences)
- Use professional, clear language suitable for field workers
- Include specific safety considerations if applicable

Format the response as JSON with the following structure:
{
  "summary_policy_text": "Main summary text",
  "key_points": ["point1", "point2", "point3"],
  "safety_considerations": ["safety1", "safety2"]
}`;
  }

  private buildExplorationSuggestionPrompt(request: ExplorationSuggestionRequest): string {
    return `Generate exploration suggestions based on the following action information:

Action State: ${request.state_text}
${request.policy_text ? `Policy: ${request.policy_text}` : ''}
${request.summary_policy_text ? `Summary Policy: ${request.summary_policy_text}` : ''}
${request.existing_exploration_notes ? `Existing Notes: ${request.existing_exploration_notes}` : ''}
${request.existing_metrics ? `Existing Metrics: ${request.existing_metrics}` : ''}

Requirements:
- Suggest detailed exploration notes that would help document this work
- Recommend specific metrics to measure and track
- Include suggestions for measurements, comparisons, and documentation
- Focus on practical, actionable suggestions for field work
- Consider what would be valuable for future policy development

Format the response as JSON with the following structure:
{
  "exploration_notes_text": "Suggested exploration notes",
  "metrics_text": "Suggested metrics to track",
  "suggested_measurements": ["measurement1", "measurement2"],
  "comparison_areas": ["area1", "area2"],
  "documentation_tips": ["tip1", "tip2", "tip3"]
}`;
  }

  private buildPolicyDraftPrompt(request: PolicyDraftRequest): string {
    const exploration = request.exploration_data;
    const similarPolicies = request.similar_policies || [];
    
    const similarPolicyContext = similarPolicies.length > 0 ? 
      `Similar Existing Policies:\n${similarPolicies.map(p => `- ${p.title}: ${p.description_text.substring(0, 200)}...`).join('\n')}` : '';

    return `Generate a policy draft based on the following exploration data:

Exploration Code: ${exploration.exploration_code}
Action Title: ${exploration.action_title}
State Description: ${exploration.state_text}
Exploration Notes: ${exploration.exploration_notes_text}
Metrics: ${exploration.metrics_text}

${similarPolicyContext}

Requirements:
- Create a comprehensive policy that could be implemented organization-wide
- Base the policy on the lessons learned from this exploration
- Include specific procedures, safety requirements, and documentation needs
- Make it actionable and measurable
- Consider how this policy would prevent issues and improve outcomes
- Ensure it's practical for field implementation

Format the response as JSON with the following structure:
{
  "title": "Policy Title",
  "description_text": "Main policy description and purpose",
  "key_procedures": ["procedure1", "procedure2", "procedure3"],
  "safety_requirements": ["safety1", "safety2"],
  "documentation_requirements": ["doc1", "doc2"],
  "effective_conditions": ["condition1", "condition2"]
}`;
  }

  private buildExpectedStatePrompt(request: ExpectedStateRequest): string {
    const contextParts = [];
    if (request.title) contextParts.push(`Action Title: ${request.title}`);
    if (request.description) contextParts.push(`Current State/Description: ${request.description}`);
    if (request.asset_name) contextParts.push(`Asset: ${request.asset_name}`);

    return `Based on the following action context, describe the expected outcome — where we want to get to when this action is complete. Be specific, measurable, and concise (2-3 sentences).

${contextParts.join('\n')}

Requirements:
- Describe the desired end state, not the process
- Be specific about what "done" looks like
- Include measurable or observable criteria when possible
- Keep it concise and actionable

Format the response as JSON:
{
  "expected_state": "Description of the expected outcome"
}`;
  }

  private parseSummaryPolicyResponse(content: string): SummaryPolicyResponse {
    try {
      const parsed = JSON.parse(content);
      return {
        summary_policy_text: parsed.summary_policy_text || '',
        key_points: parsed.key_points || [],
        safety_considerations: parsed.safety_considerations || []
      };
    } catch (error) {
      // Fallback parsing if JSON is malformed
      return {
        summary_policy_text: content.substring(0, 500),
        key_points: [],
        safety_considerations: []
      };
    }
  }

  private parseExplorationSuggestionResponse(content: string): ExplorationSuggestionResponse {
    try {
      const parsed = JSON.parse(content);
      return {
        exploration_notes_text: parsed.exploration_notes_text || '',
        metrics_text: parsed.metrics_text || '',
        suggested_measurements: parsed.suggested_measurements || [],
        comparison_areas: parsed.comparison_areas || [],
        documentation_tips: parsed.documentation_tips || []
      };
    } catch (error) {
      return {
        exploration_notes_text: content.substring(0, 300),
        metrics_text: '',
        suggested_measurements: [],
        comparison_areas: [],
        documentation_tips: []
      };
    }
  }

  private parsePolicyDraftResponse(content: string): PolicyDraftResponse {
    try {
      const parsed = JSON.parse(content);
      return {
        title: parsed.title || 'Generated Policy',
        description_text: parsed.description_text || '',
        key_procedures: parsed.key_procedures || [],
        safety_requirements: parsed.safety_requirements || [],
        documentation_requirements: parsed.documentation_requirements || [],
        effective_conditions: parsed.effective_conditions || []
      };
    } catch (error) {
      return {
        title: 'Generated Policy',
        description_text: content.substring(0, 500),
        key_procedures: [],
        safety_requirements: [],
        documentation_requirements: [],
        effective_conditions: []
      };
    }
  }

  private parseExpectedStateResponse(content: string): ExpectedStateResponse {
    try {
      const parsed = JSON.parse(content);
      return {
        expected_state: parsed.expected_state || ''
      };
    } catch (error) {
      return {
        expected_state: content.substring(0, 500)
      };
    }
  }

  // Fallback methods for when AI service is unavailable

  private generateFallbackSummaryPolicy(request: SummaryPolicyRequest): AIContentResponse<SummaryPolicyResponse> {
    const fallbackText = request.policy_text 
      ? `Follow established procedures: ${request.policy_text.substring(0, 100)}...`
      : `Document all activities and follow safety protocols for: ${request.state_text.substring(0, 100)}...`;

    return {
      content: {
        summary_policy_text: fallbackText,
        key_points: ['Follow safety protocols', 'Document all activities', 'Report any issues'],
        safety_considerations: ['Use appropriate PPE', 'Follow established procedures']
      },
      confidence: 0.5,
      model_used: 'fallback',
      generated_at: new Date().toISOString(),
      context_used: ['fallback_generation']
    };
  }

  private generateFallbackExplorationSuggestions(request: ExplorationSuggestionRequest): AIContentResponse<ExplorationSuggestionResponse> {
    return {
      content: {
        exploration_notes_text: `Document observations and outcomes for: ${request.state_text.substring(0, 100)}...`,
        metrics_text: 'Record relevant measurements, time taken, resources used, and outcomes achieved.',
        suggested_measurements: ['Time to completion', 'Resource usage', 'Quality metrics'],
        comparison_areas: ['Before/after comparison', 'Alternative methods'],
        documentation_tips: ['Take photos', 'Record timestamps', 'Note environmental conditions']
      },
      confidence: 0.4,
      model_used: 'fallback',
      generated_at: new Date().toISOString(),
      context_used: ['fallback_generation']
    };
  }

  private generateFallbackPolicyDraft(request: PolicyDraftRequest): AIContentResponse<PolicyDraftResponse> {
    const exploration = request.exploration_data;
    
    return {
      content: {
        title: `Policy for ${exploration.action_title}`,
        description_text: `Standard procedures based on exploration ${exploration.exploration_code}. ${exploration.exploration_notes_text.substring(0, 200)}...`,
        key_procedures: ['Follow established safety protocols', 'Document all activities', 'Report outcomes'],
        safety_requirements: ['Use appropriate PPE', 'Follow safety guidelines'],
        documentation_requirements: ['Record all activities', 'Take photos when appropriate', 'Submit reports'],
        effective_conditions: ['When similar conditions exist', 'With proper training', 'With adequate resources']
      },
      confidence: 0.3,
      model_used: 'fallback',
      generated_at: new Date().toISOString(),
      context_used: ['fallback_generation']
    };
  }

  private generateFallbackExpectedState(request: ExpectedStateRequest): AIContentResponse<ExpectedStateResponse> {
    const titlePart = request.title ? `"${request.title}"` : 'this action';
    const fallbackText = `${titlePart} is completed successfully with all requirements met and results documented.`;

    return {
      content: {
        expected_state: fallbackText
      },
      confidence: 0.3,
      model_used: 'fallback',
      generated_at: new Date().toISOString(),
      context_used: ['fallback_generation']
    };
  }
}

// Export singleton instance
export const aiContentService = new AIContentService();