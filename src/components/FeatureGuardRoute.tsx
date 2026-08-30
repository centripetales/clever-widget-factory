import React from 'react';
import { Loader2 } from 'lucide-react';
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
  const { isFeatureEnabled, isLoading } = useFeatureFlag();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isFeatureEnabled(featureKey)) {
    return <FeatureLocked featureName={featureName} />;
  }

  return <>{children}</>;
}
