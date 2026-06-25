import React from 'react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { FeatureLocked } from './FeatureLocked';

interface FeatureGuardRouteProps {
  featureKey: string;
  featureName?: string;
  children: React.ReactNode;
}

export default function FeatureGuardRoute({
  featureKey,
  featureName,
  children,
}: FeatureGuardRouteProps) {
  const { isFeatureEnabled } = useFeatureFlag();

  if (!isFeatureEnabled(featureKey)) {
    return <FeatureLocked featureName={featureName} />;
  }

  return <>{children}</>;
}
