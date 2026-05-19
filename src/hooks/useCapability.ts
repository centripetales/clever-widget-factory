import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { capabilityProfileQueryKey, organizationCapabilityQueryKey } from '@/lib/queryKeys';

// Capability profile types matching the design document schema

export interface ObservationEvidence {
  observation_id: string;
  action_id: string;
  action_title: string;
  text_excerpt: string;
  photo_urls: string[];
  captured_at: string;
  relevance_score: number;
}

export interface AxisEvidence {
  observation_id: string;
  text_excerpt: string;
  similarity_score: number;
  evidence_type: 'quiz' | 'observation';
  source_action_title: string;
}

export interface CapabilityAxis {
  key: string;
  label: string;
  level: number;
  evidence_count: number;
  evidence: ObservationEvidence[];
  axis_evidence: AxisEvidence[];
  axis_narrative: string;
}

export interface CapabilityProfile {
  user_id: string;
  user_name: string;
  action_id: string;
  narrative: string;
  axes: CapabilityAxis[];
  total_evidence_count: number;
  computed_at: string;
}

/**
 * Query hook to fetch the current user's capability profile relative to an action.
 * GET /api/capability/:actionId
 * userId always comes from auth context — the logged-in user is always the subject.
 * Only enabled when actionId is provided and the action has an approved skill profile.
 * Requirements: 3.1
 */
export function useCapabilityProfile(
  actionId: string | undefined,
  hasApprovedSkillProfile: boolean = false
) {
  return useQuery({
    queryKey: capabilityProfileQueryKey(actionId!),
    queryFn: async () => {
      const result = await apiService.get<{ data: CapabilityProfile }>(
        `/capability/${actionId}`
      );
      return result.data;
    },
    enabled: !!(actionId && hasApprovedSkillProfile),
    staleTime: 60000, // 1 minute — capability profiles are computed on-demand
  });
}

/**
 * Query hook to fetch the organization's capability profile for an action.
 * GET /api/capability/:actionId/organization
 * Only enabled when actionId is provided and the action has an approved skill profile.
 * Requirements: 6.1
 * @deprecated Organization capability view is not yet implemented in the current iteration.
 */
export function useOrganizationCapability(
  actionId: string | undefined,
  hasApprovedSkillProfile: boolean = false
) {
  return useQuery({
    queryKey: organizationCapabilityQueryKey(actionId!),
    queryFn: async () => {
      const result = await apiService.get<{ data: CapabilityProfile }>(
        `/capability/${actionId}/organization`
      );
      return result.data;
    },
    enabled: !!(actionId && hasApprovedSkillProfile),
    staleTime: 60000,
  });
}
