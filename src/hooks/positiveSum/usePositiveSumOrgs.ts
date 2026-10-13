import { useOrganization } from '@/hooks/useOrganization';
import { orgHasFeature } from '@/hooks/useFeatureFlag';

// The Positive Sum orgs the person takes part in, whichever org is currently
// active: their own orgs that have it turned on (settings.enabled_features
// includes 'positive_sum'), and the orgs their orgs are members of that do
// (member_organizations) — the same rule the Dashboard card uses.
export function usePositiveSumOrgs(): { id: string; name: string }[] {
  const { accessibleOrganizations } = useOrganization();
  const candidates = accessibleOrganizations.flatMap(org => [org, ...(org.member_of ?? [])]);
  return candidates
    .filter(org => orgHasFeature(org, 'positive_sum'))
    .filter((org, i, all) => all.findIndex(other => other.id === org.id) === i)
    .map(org => ({ id: org.id, name: org.name }));
}
