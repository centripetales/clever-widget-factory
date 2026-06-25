import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useEnabledMembers } from '@/hooks/useOrganizationMembers';
import { ActionForm } from '@/components/UnifiedActionDialog';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createMissionAction, createAssetAction } from '@/types/actions';
import { ActionCreationContext } from '@/types/actions';

export default function ActionPage() {
  const { actionId } = useParams<{ actionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { members: profiles } = useEnabledMembers();

  const isNew = actionId === 'new' || !actionId;
  const missionId = searchParams.get('missionId');
  const assetId = searchParams.get('assetId');

  // Build context for new actions
  const context: ActionCreationContext | undefined = isNew
    ? {
        type: (missionId ? 'mission' : 'asset') as 'mission' | 'asset',
        parentId: missionId || assetId || undefined,
        prefilledData: missionId
          ? createMissionAction(missionId)
          : assetId
          ? createAssetAction(assetId)
          : undefined,
      }
    : undefined;

  const handleBack = () => {
    if (missionId) {
      navigate(`/missions`);
    } else {
      navigate('/actions');
    }
  };

  const handleSaved = () => {
    handleBack();
  };

  return (
    <div className="container mx-auto p-3 sm:p-6 max-w-4xl">
      <div className="mb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>
      <ActionForm
        open={true}
        onOpenChange={(open) => {
          if (!open) handleBack();
        }}
        actionId={isNew ? undefined : actionId}
        context={context}
        profiles={profiles}
        onActionSaved={handleSaved}
        isCreating={isNew}
      />
    </div>
  );
}
