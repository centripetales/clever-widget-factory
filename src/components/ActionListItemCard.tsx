import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { User, Handshake } from "lucide-react";
import { cn, getActionBorderStyle } from "@/lib/utils";
import { BaseAction, Profile } from "@/types/actions";
import { ScoreButton } from "./ScoreButton";
import { useActionObservationCount } from "@/hooks/useActionObservationCount";
import { apiService } from "@/lib/apiService";
import { useToast } from "@/hooks/use-toast";
import { actionsQueryKey, completedActionsQueryKey, allActionsQueryKey, actionQueryKey } from "@/lib/queryKeys";
import { ShareConfigurationDialog } from "./ShareConfigurationDialog";
import { useOrganization } from "@/hooks/useOrganization";

interface ActionListItemCardProps {
  action: BaseAction;
  profiles: Profile[];
  onClick?: (action: BaseAction) => void;
  onScoreAction?: (action: BaseAction, e: React.MouseEvent) => void;
  getUserColor?: (userId: string) => string;
  showScoreButton?: boolean;
  className?: string;
}

export function ActionListItemCard({
  action,
  profiles,
  onClick,
  onScoreAction,
  getUserColor = () => '#6B7280',
  showScoreButton = false,
  className
}: ActionListItemCardProps) {
  // Derive observation count from TanStack cache (preferred over database count)
  const { organization } = useOrganization();
  const derivedCount = useActionObservationCount(organization?.id ?? '', action.id);
  const borderStyle = getActionBorderStyle(action, derivedCount);

  const handleClick = () => {
    onClick?.(action);
  };

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showShareDialog, setShowShareDialog] = useState(false);
  const isShared = action.shared_with_partners ?? false;

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowShareDialog(true);
  };

  const handleScoreClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onScoreAction?.(action, e);
  };

  return (
    <Card
      className={cn(
        "hover:shadow-md transition-shadow cursor-pointer overflow-hidden",
        borderStyle.borderColor,
        borderStyle.bgColor,
        borderStyle.textColor,
        className
      )}
      onClick={handleClick}
    >
      <CardContent className="p-3 sm:p-4 md:p-6">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold break-words leading-tight break-all">
                {action.title}
              </h3>
              <div className="text-xs text-muted-foreground mt-1">
                <div className="flex flex-col sm:flex-row sm:flex-wrap gap-x-4 gap-y-1">
                  <span>
                    Updated: {(() => {
                      const updatedDate = new Date(action.updated_at);
                      if (isNaN(updatedDate.getTime())) {
                        return 'Unknown';
                      }
                      return updatedDate.toLocaleDateString('en-US', {
                        year: '2-digit',
                        month: 'numeric',
                        day: 'numeric'
                      }) + ' ' + updatedDate.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                      });
                    })()}
                  </span>
                  {action.estimated_completion_date && (() => {
                    const expectedDate = new Date(action.estimated_completion_date);
                    if (isNaN(expectedDate.getTime())) {
                      return null;
                    }
                    return (
                      <span>
                        Expected: {expectedDate.toLocaleDateString('en-US', {
                          year: '2-digit',
                          month: 'numeric',
                          day: 'numeric'
                        }) + ' ' + expectedDate.toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true
                        })}
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={handleShareClick}
                className={`h-7 w-7 p-0 transition-colors duration-200 ${isShared ? 'bg-green-100 text-green-600 border-green-300' : 'hover:text-emerald-600 hover:bg-emerald-50 bg-white dark:bg-zinc-900'}`}
                title="Share with partner organizations"
              >
                <Handshake className="h-4 w-4" />
              </Button>
              {showScoreButton && onScoreAction && (
                <ScoreButton action={action} onScoreAction={handleScoreClick} />
              )}
            </div>
          </div>

          {action.description && (
            <p className="text-muted-foreground break-words break-all">
              {action.description}
            </p>
          )}

          <div className="flex flex-wrap gap-2 overflow-hidden">
            {/* Action Type Indicator */}
            {action.asset ? (
              <Badge variant="outline" className="bg-blue-100 text-blue-600 border-blue-300 max-w-full overflow-hidden">
                <span className="truncate">
                  Asset: {(action.asset.name?.length ?? 0) > 10 
                    ? `${action.asset.name?.substring(0, 10)}...` 
                    : (action.asset.name ?? 'Unknown')}
                </span>
              </Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2 overflow-hidden">
            {action.mission && (
              <Badge variant="outline" className="bg-indigo-100 text-indigo-800 max-w-full overflow-hidden">
                <span className="truncate">
                  Project #{action.mission.mission_number}: {(action.mission.title?.length ?? 0) > 15 
                    ? `${action.mission.title?.substring(0, 15)}...` 
                    : (action.mission.title ?? 'Untitled')}
                </span>
              </Badge>
            )}

            {action.assigned_to ? (
              <Badge
                variant="outline"
                className="flex items-center gap-1 max-w-full overflow-hidden"
              >
                <User className="h-3 w-3 flex-shrink-0" />
                <span
                  className="truncate max-w-[80px]"
                  style={{ color: action.assigned_to_color || getUserColor(action.assigned_to) }}
                >
                  {action.assigned_to_name || 
                   profiles.find(p => p.user_id === action.assigned_to)?.full_name || 
                   'Unknown User'}
                </span>
              </Badge>
            ) : (
              <Badge variant="outline" className="text-orange-600">
                Unassigned
              </Badge>
            )}

            {action.participants_details && action.participants_details.length > 0 && (
              action.participants_details.map(participant => (
                <Badge
                  key={participant.user_id}
                  variant="secondary"
                  className="flex items-center gap-1 max-w-full overflow-hidden"
                  style={{
                    borderColor: participant.favorite_color || getUserColor(participant.user_id),
                    color: participant.favorite_color || getUserColor(participant.user_id)
                  }}
                >
                  <User className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate max-w-[80px]">{participant.full_name}</span>
                </Badge>
              ))
            )}
          </div>
        </div>
      </CardContent>
      {showShareDialog && (
        <ShareConfigurationDialog 
          open={showShareDialog} 
          onOpenChange={setShowShareDialog} 
          entityId={action.id} 
          entityType="action" 
          entityName={action.title}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['actions'] });
            queryClient.invalidateQueries({ queryKey: ['action', action.id] });
          }}
        />
      )}
    </Card>
  );
}

