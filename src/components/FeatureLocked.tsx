import { useOrganization } from '@/hooks/useOrganization';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useNavigate } from 'react-router-dom';
import { Lock, ArrowLeft } from 'lucide-react';

interface FeatureLockedProps {
  featureName?: string;
}

export function FeatureLocked({ featureName }: FeatureLockedProps) {
  const { organization } = useOrganization();
  const navigate = useNavigate();

  const displayName = featureName 
    ? `The "${featureName}" module` 
    : 'This module';

  const orgName = organization?.name || 'your organization';

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md shadow-2xl border border-muted-foreground/10 transition-all duration-300">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-16 h-16 rounded-full bg-orange-500/10 border border-orange-500/30 flex items-center justify-center mb-4 text-orange-600 animate-pulse">
            <Lock className="h-8 w-8" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Access Restricted</CardTitle>
          <CardDescription className="text-sm mt-1">
            This feature is currently disabled.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-4 text-center">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {displayName} is not enabled for this account.
          </p>
          <p className="text-xs text-muted-foreground/80 italic bg-muted p-2.5 rounded border border-border">
            Contact Mae or Stefan discuss getting access.
          </p>
          <div className="flex flex-col gap-2 pt-2">
            <Button onClick={() => navigate('/')} className="w-full gap-2">
              <ArrowLeft className="h-4 w-4" />
              Return to Dashboard
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
