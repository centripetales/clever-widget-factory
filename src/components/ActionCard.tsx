import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, Clock, User } from 'lucide-react';
import { getActionBorderStyle } from '@/lib/utils';
import { BaseAction } from '@/types/actions';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useActionObservationCount } from '@/hooks/useActionObservationCount';
import { useOrganization } from '@/hooks/useOrganization';

interface Profile {
  id: string;
  user_id: string;
  full_name: string;
  role: string;
}

interface ActionCardProps {
  action: BaseAction;
  profiles: Profile[];
  onUpdate: () => void;
  onEdit?: () => void;
}

export function ActionCard({ action, profiles, onEdit }: ActionCardProps) {
  const { favoriteColor } = useProfile();
  const { user } = useAuth();
  const { organization } = useOrganization();
  
  // Derive observation count from TanStack cache (preferred over database count)
  const derivedCount = useActionObservationCount(organization?.id ?? '', action.id);

  const getStatusIcon = () => {
    if (action.status === 'completed') {
      return <CheckCircle className="w-4 h-4 text-emerald-600" />;
    }
    
    const isAssigned = Boolean(action.assigned_to);
    const hasContent = action.policy?.trim() || action.observations?.trim();
    
    if (isAssigned && hasContent) {
      return <Clock className="w-4 h-4 text-blue-600" />;
    }
    
    if (isAssigned) {
      return <User className="w-4 h-4 text-amber-600" />;
    }
    
    return <Clock className="w-4 h-4 text-muted-foreground" />;
  };

  const getStatusBadge = () => {
    if (action.status === 'completed') {
      return <Badge variant="default" className="bg-emerald-600 text-white">Completed</Badge>;
    }
    
    const isAssigned = Boolean(action.assigned_to);
    const hasContent = action.policy?.trim() || action.observations?.trim();
    
    if (isAssigned && hasContent) {
      return <Badge variant="default" className="bg-blue-600 text-white">In Progress</Badge>;
    }
    
    if (isAssigned) {
      return <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">Assigned</Badge>;
    }
    
    return <Badge variant="outline">Not Started</Badge>;
  };

  const theme = getActionBorderStyle(action, derivedCount);

  return (
    <Card 
      className={`${theme.bgColor} ${theme.borderColor} ${theme.textColor} cursor-pointer hover:bg-muted/50 transition-colors`}
      onClick={onEdit}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <div className="flex items-center gap-3">
            {getStatusIcon()}
            <span className="font-medium">{action.title}</span>
            {getStatusBadge()}
          </div>
        </CardTitle>
        <div className="space-y-1">
          {action.assigned_to ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="w-3 h-3" />
              <span>
                {(() => {
                  const assignedProfile = profiles.find(p => p.user_id === action.assigned_to);
                  if (assignedProfile) {
                    const isCurrentUser = user?.userId === action.assigned_to;
                    const nameColor = isCurrentUser ? favoriteColor : '#6B7280';
                    
                    return (
                      <span style={{ color: nameColor }}>
                        {assignedProfile.full_name}
                      </span>
                    );
                  }
                  return 'Assigned (Loading...)';
                })()}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="w-3 h-3" />
              <span>Unassigned</span>
            </div>
          )}
          {action.updated_at && (
            <div className="text-xs text-muted-foreground">
              Updated: {new Date(action.updated_at).toLocaleDateString('en-US', { 
                month: 'numeric', 
                day: 'numeric', 
                year: '2-digit',
                hour: 'numeric',
                minute: '2-digit'
              })}
            </div>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}
