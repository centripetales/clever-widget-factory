import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionCard } from '@/components/ActionCard';
import { Button } from "@/components/ui/button";
import { Plus } from 'lucide-react';
import { useToast } from "@/hooks/use-toast";
import { BaseAction, Profile } from '@/types/actions';

interface MissionActionListProps {
  missionId: string;
  profiles: Profile[];
  canEdit?: boolean;
  missionNumber?: number;
}

export function MissionActionList({ missionId, profiles, canEdit = false, missionNumber }: MissionActionListProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [actions, setActions] = useState<BaseAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial load of actions for this mission
    fetchActions();
  }, [missionId]);

  const fetchActions = async () => {
    setLoading(true);
    
    try {
      const { apiService, getApiData } = await import('@/lib/apiService');
      const response = await apiService.get<{ data: any[] }>('/actions');
      const allActions = getApiData(response) || [];
      
      // Filter by mission_id
      const missionActions = allActions.filter(action => action.mission_id === missionId);
      
      const actions = missionActions.map(action => ({
        ...action,
        required_stock: Array.isArray(action.required_stock) ? action.required_stock : []
      }) as unknown as BaseAction);

      setActions(actions);
    } catch (error) {
      console.error('Error fetching actions:', error);
      toast({
        title: "Error",
        description: "Failed to load actions",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAction = () => {
    navigate(`/actions/new?missionId=${missionId}`);
  };

  const handleEditAction = (action: BaseAction) => {
    navigate(`/actions/${action.id}`);
  };

  if (loading) {
    return <div className="text-center py-4">Loading actions...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Actions</h3>
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreateAction}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Action
          </Button>
        )}
      </div>

      {actions.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <p>No actions defined for this project.</p>
          {canEdit && (
            <p className="text-sm mt-2">Add actions to break down the project into manageable steps.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              profiles={profiles}
              onUpdate={fetchActions}
              onEdit={canEdit ? () => handleEditAction(action) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}