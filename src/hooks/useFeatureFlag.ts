import { useOrganization } from './useOrganization';

export function useFeatureFlag() {
  const { organization } = useOrganization();

  const enabledFeatures = organization?.settings?.enabled_features as string[] | undefined;

  const CORE_FEATURES = ['observations', 'assets', 'actions'];

  const isFeatureEnabled = (featureKey?: string): boolean => {
    // Core features/actions without a featureKey are always enabled
    if (!featureKey) return true;
    
    // Core features are always visible regardless of loading state
    if (CORE_FEATURES.includes(featureKey)) return true;

    // While organization is loading, hide non-core features to prevent flash
    if (!organization) return false;
    if (!enabledFeatures) return true;
    
    return enabledFeatures.includes(featureKey);
  };

  return {
    isFeatureEnabled,
    enabledFeatures: enabledFeatures ?? null,
  };
}
