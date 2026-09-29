import { useOrganization } from './useOrganization';

// Features an org only has when its settings list them explicitly. Other
// features are on for orgs that have no enabled_features list at all.
const OPT_IN_FEATURES = ['positive_sum'];

/** Whether a given org (not just the active one) has a feature turned on. */
export function orgHasFeature(org: { settings?: { enabled_features?: string[] } | null } | null | undefined, featureKey: string): boolean {
  const enabled = org?.settings?.enabled_features;
  if (!enabled) return !OPT_IN_FEATURES.includes(featureKey);
  return enabled.includes(featureKey);
}

export function useFeatureFlag() {
  const { organization, loading } = useOrganization();

  const enabledFeatures = organization?.settings?.enabled_features as string[] | undefined;

  const CORE_FEATURES = ['observations', 'assets', 'actions'];

  const isFeatureEnabled = (featureKey?: string): boolean => {
    // Core features/actions without a featureKey are always enabled
    if (!featureKey) return true;
    
    // Core features are always visible regardless of loading state
    if (CORE_FEATURES.includes(featureKey)) return true;

    // While organization is loading, hide non-core features to prevent flash
    if (!organization) return false;
    return orgHasFeature(organization, featureKey);
  };

  return {
    isFeatureEnabled,
    enabledFeatures: enabledFeatures ?? null,
    isLoading: loading,
  };
}
