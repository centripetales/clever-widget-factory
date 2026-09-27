import { useOrganization } from '@/hooks/useOrganization';

// Associations the person belongs to (orgs marked settings.is_association).
// Positive Sum is available to anyone in at least one, whichever org is active.
export function useAssociations() {
  const { accessibleOrganizations } = useOrganization();
  const associations = accessibleOrganizations.filter(org => org.settings?.is_association === true);
  return { associations, isAssociationMember: associations.length > 0 };
}
