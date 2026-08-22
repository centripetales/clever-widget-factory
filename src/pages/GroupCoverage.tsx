import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/hooks/useOrganization';
import { GroupCoverageGrid } from '@/components/shared/GroupCoverageGrid';

// Standalone view of the same group chart embedded as a tab on a shared
// container's own page (ToolDetails.tsx) — useful for jumping straight to the
// group view for whichever org is currently active, without going through a
// specific container first.
export default function GroupCoverage() {
  const navigate = useNavigate();
  const { organization } = useOrganization();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/dashboard')}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Dashboard
        </Button>
      </div>

      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Users className="h-7 w-7" /> Group Coverage
        </h1>
        <p className="text-muted-foreground">
          Coverage % across every container shared into {organization?.name || 'this organization'}
        </p>
      </div>

      {organization?.id && <GroupCoverageGrid orgId={organization.id} />}
    </div>
  );
}
