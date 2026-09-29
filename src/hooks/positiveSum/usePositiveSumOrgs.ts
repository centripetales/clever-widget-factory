import { useOrganization } from '@/hooks/useOrganization';
import { orgHasFeature } from '@/hooks/useFeatureFlag';

// The person's orgs that have Positive Sum turned on (settings.enabled_features
// includes 'positive_sum'), whichever org is currently active.
export function usePositiveSumOrgs() {
  const { accessibleOrganizations } = useOrganization();
  return accessibleOrganizations.filter(org => orgHasFeature(org, 'positive_sum'));
}
