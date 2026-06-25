import { useOrganization } from './useOrganization';

export function useFeatureFlag() {
  const { organization } = useOrganization();

  const enabledFeatures = organization?.settings?.enabled_features as string[] | undefined;

  const isFeatureEnabled = (featureKey?: string): boolean => {
    // Core features/actions without a featureKey are always enabled
    if (!featureKey) return true;
    
    // If organization details are not loaded yet or settings aren't defined,
    // default to true to ensure existing features remain accessible.
    if (!organization) return true;
    if (!enabledFeatures) return true;
    
    return enabledFeatures.includes(featureKey);
  };

  return {
    isFeatureEnabled,
    enabledFeatures: enabledFeatures ?? null,
  };
}
