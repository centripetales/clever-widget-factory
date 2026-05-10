import { useState, useEffect, forwardRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { History, Edit, Plus, AlertTriangle, Clock, LogOut, LogIn, Loader2, ExternalLink, Zap, Target, Camera, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useToolHistory, HistoryEntry, AssetHistoryEntry, CheckoutHistory, ObservationHistoryEntry } from "@/hooks/tools/useToolHistory";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useCognitoAuth";
import { getImageUrl, getThumbnailUrl, getOriginalUrl } from '@/lib/imageUtils';
import { useStateMutations } from "@/hooks/useStates";
import { MaxwellInlinePanel } from "@/components/MaxwellInlinePanel";
import { PrismIcon } from "@/components/icons/PrismIcon";

// Type guard functions
const isAssetHistory = (entry: HistoryEntry): entry is AssetHistoryEntry => {
  return 'change_type' in entry && 'changed_at' in entry && 'changed_by' in entry;
};

const isCheckoutHistory = (entry: HistoryEntry): entry is CheckoutHistory => {
  return 'checkout_date' in entry && 'is_returned' in entry;
};

const isObservation = (entry: HistoryEntry): entry is ObservationHistoryEntry => {
  const result = 'observation_text' in entry && 'observed_at' in entry;
  return result;
};

interface AssetHistoryDialogProps {
  assetId: string;
  assetName: string;
  children: React.ReactNode;
}

export const AssetHistoryDialog = forwardRef<HTMLDivElement, AssetHistoryDialogProps>(
  ({ assetId, assetName, children }, ref) => {
  const [open, setOpen] = useState(false);
  const [isMaxwellOpen, setIsMaxwellOpen] = useState(false);
  const { toast } = useToast();
  const { toolHistory, assetInfo, loading, fetchToolHistory } = useToolHistory();
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { deleteState, isDeleting } = useStateMutations();
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      fetchToolHistory(assetId);
    } else {
      setIsMaxwellOpen(false);
    }
  }, [open, assetId, fetchToolHistory]);

  /**
   * Check if the current user can edit an observation
   * @param observation - The observation to check permissions for
   * @returns true if user is the creator or has admin permissions
   */
  const canEditObservation = (observation: ObservationHistoryEntry): boolean => {
    if (!user) return false;
    const isCreator = user.userId === observation.observed_by;
    return isCreator || isAdmin;
  };

  /**
   * Check if the current user can delete an asset history entry
   * @param entry - The asset history entry to check permissions for
   * @returns true if user is the creator or has admin permissions
   */
  const canDeleteAssetHistory = (entry: AssetHistoryEntry): boolean => {
    if (!user) return false;
    const isCreator = user.userId === entry.changed_by;
    return isCreator || isAdmin;
  };

  /**
   * Handle deleting an observation
   */
  const handleDeleteObservation = async (observationId: string) => {
    if (!confirm('Are you sure you want to delete this observation? This action cannot be undone.')) {
      return;
    }

    try {
      await deleteState(observationId);
      toast({
        title: 'Observation deleted',
        description: 'The observation has been deleted successfully.'
      });
      // Refresh history
      fetchToolHistory(assetId);
    } catch (error) {
      console.error('Failed to delete observation:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete observation. Please try again.',
        variant: 'destructive'
      });
    }
  };

  /**
   * Handle deleting an asset history entry
   */
  const handleDeleteAssetHistory = async (historyId: string) => {
    if (!confirm('Are you sure you want to delete this history entry? This action cannot be undone.')) {
      return;
    }

    setDeletingHistoryId(historyId);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/history/asset-history/${historyId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await (async () => {
            const { fetchAuthSession } = await import('aws-amplify/auth');
            const session = await fetchAuthSession();
            return session.tokens?.idToken?.toString() || '';
          })()}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to delete history entry');
      }

      toast({
        title: 'History entry deleted',
        description: 'The history entry has been deleted successfully.'
      });
      // Refresh history and wait for it to complete
      await fetchToolHistory(assetId);
    } catch (error) {
      console.error('Failed to delete history entry:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete history entry. Please try again.',
        variant: 'destructive'
      });
    } finally {
      setDeletingHistoryId(null);
    }
  };

  const getChangeIcon = (entry: HistoryEntry) => {
    if (isAssetHistory(entry)) {
      switch (entry.change_type) {
        case 'created':
          return <Plus className="h-4 w-4 text-green-600" />;
        case 'updated':
          return <Edit className="h-4 w-4 text-blue-600" />;
        case 'status_change':
          return <AlertTriangle className="h-4 w-4 text-orange-600" />;
        case 'removed':
          return <AlertTriangle className="h-4 w-4 text-red-600" />;
        case 'action_created':
          return <Zap className="h-4 w-4 text-purple-600" />;
        default:
          return <History className="h-4 w-4 text-gray-600" />;
      }
    } else if (isCheckoutHistory(entry)) {
      return entry.is_returned ? <LogIn className="h-4 w-4 text-green-600" /> : <LogOut className="h-4 w-4 text-blue-600" />;
    } else if (isObservation(entry)) {
      return <Camera className="h-4 w-4 text-blue-600" />;
    }
    return <History className="h-4 w-4 text-gray-600" />;
  };

  const getChangeDescription = (entry: HistoryEntry) => {
    if (isAssetHistory(entry)) {
      switch (entry.change_type) {
        case 'created':
          return 'Asset created';
        case 'updated':
          return entry.field_changed ? `Updated ${entry.field_changed}` : 'Asset updated';
        case 'status_change':
          return `Status changed from ${entry.old_value || 'unknown'} to ${entry.new_value || 'unknown'}`;
        case 'removed':
          return 'Asset removed';
        case 'action_created':
          return entry.action_title || 'Action created';
        default:
          return 'Asset modified';
      }
    } else if (isCheckoutHistory(entry)) {
      return entry.is_returned ? 'Tool returned' : 'Tool checked out';
    } else if (isObservation(entry)) {
      return '';
    }
    return 'Activity recorded';
  };

  const getChangeBadge = (entry: HistoryEntry) => {
    if (isAssetHistory(entry)) {
      return entry.change_type === 'created' ? 'Created' :
             entry.change_type === 'status_change' ? 'Status Changed' :
             entry.change_type === 'action_created' ? 'Action' :
             entry.change_type === 'updated' ? 'Updated' : entry.change_type;
    } else if (isCheckoutHistory(entry)) {
      return entry.is_returned ? 'Returned' : 'Checked Out';
    } else if (isObservation(entry)) {
      return 'Observation';
    }
    return 'Activity';
  };

  const getChangeDate = (entry: HistoryEntry) => {
    if (isCheckoutHistory(entry)) {
      return entry.checkout_date || entry.created_at;
    } else if (isObservation(entry)) {
      return entry.observed_at;
    }
    return entry.changed_at;
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-2 pr-8">
            <History className="h-5 w-5 flex-shrink-0" />
            <DialogTitle className="flex-1">Asset History - {assetName}</DialogTitle>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setIsMaxwellOpen(v => !v)}
              className={`h-8 w-8 p-0 flex-shrink-0 [&_svg]:size-auto ${isMaxwellOpen ? 'bg-primary/10 text-primary' : ''}`}
              title="Ask Maxwell"
            >
              <PrismIcon size={28} />
            </Button>
          </div>
        </DialogHeader>

        {/* Maxwell inline panel */}
        <div
          className={`flex-shrink-0 grid transition-all duration-300 ease-in-out ${isMaxwellOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        >
          <div className="overflow-hidden">
            <div className="rounded-xl border overflow-hidden" style={{ height: '320px' }}>
              <MaxwellInlinePanel
                context={{
                  entityId: assetId,
                  entityType: 'tool',
                  entityName: assetName,
                  policy: '',
                  implementation: '',
                }}
                onClose={() => setIsMaxwellOpen(false)}
                className="h-full rounded-none border-0"
                hideHeader
                hidePrompts
              />
            </div>
          </div>
        </div>
        
        <div className="flex-1 min-h-0 overflow-y-auto pr-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading history...</p>
              </div>
            </div>
          ) : toolHistory.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No history records found for this asset.
            </div>
          ) : (
            <div className="space-y-4">
              {toolHistory.map((entry, index) => {
                return (
                <Card key={entry.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      {getChangeIcon(entry)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {isCheckoutHistory(entry) 
                              ? (entry.user_display_name || <span className="text-red-600">ERROR: User not found</span>)
                              : isObservation(entry)
                              ? entry.observed_by_name
                              : (entry.user_name || 'System')
                            }
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {getChangeBadge(entry)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">
                            {new Date(getChangeDate(entry)).toLocaleDateString()} {new Date(getChangeDate(entry)).toLocaleTimeString()}
                          </span>
                          {isAssetHistory(entry) && entry.change_type === 'updated' && canDeleteAssetHistory(entry) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteAssetHistory(entry.id)}
                              disabled={deletingHistoryId === entry.id}
                              className="h-6 px-2 text-red-600 hover:text-red-800 hover:bg-red-100"
                              aria-label="Delete history entry"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                      
                      <p className="text-sm text-muted-foreground mb-2">
                        {getChangeDescription(entry)}
                      </p>
                      
                      {/* Checkout context: Action link or intended usage */}
                      {isCheckoutHistory(entry) && (
                        <>
                          {/* Show action link if action_id exists */}
                          {entry.action_id && entry.action_title && (
                            <div className="text-sm bg-blue-50 border border-blue-200 p-2 rounded mt-2 mb-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-blue-900">Action:</span>
                                <Link
                                  to={`/actions/${entry.action_id}`}
                                  className="text-blue-600 hover:text-blue-800 underline flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {entry.action_title}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                              </div>
                            </div>
                          )}
                          
                          {/* Show intended usage if no action_id but intended_usage exists */}
                          {!entry.action_id && entry.intended_usage && (
                            <div className="text-sm bg-gray-50 border border-gray-200 p-2 rounded mt-2 mb-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-gray-900">Intended Usage:</span>
                                <span className="text-gray-700">{entry.intended_usage}</span>
                              </div>
                            </div>
                          )}
                          
                          {/* Show notes if present */}
                          {entry.notes && (
                            <div className="text-sm bg-muted p-2 rounded mt-2 mb-2">
                              <span className="font-medium">Notes:</span>{' '}
                              <span className="text-muted-foreground">{entry.notes}</span>
                            </div>
                          )}
                        </>
                      )}
                      
                      {isAssetHistory(entry) && entry.field_changed && entry.old_value !== undefined && entry.new_value !== undefined && (
                        <div className="text-sm bg-muted p-2 rounded">
                          <span className="font-medium">{entry.field_changed}:</span>{' '}
                          <span className="text-muted-foreground">{entry.old_value || '(empty)'}</span>
                          {' → '}
                          <span className="text-muted-foreground">{entry.new_value || '(empty)'}</span>
                        </div>
                      )}
                      
                      {isAssetHistory(entry) && entry.notes && (
                        <p className="text-sm text-muted-foreground mt-2">
                          {entry.notes}
                        </p>
                      )}

                      {isCheckoutHistory(entry) && entry.checkin && (
                        <div className="text-sm bg-muted p-2 rounded mt-2">
                          <p><span className="font-medium">Hours used:</span> {entry.checkin.hours_used || 'N/A'}</p>
                          {entry.checkin.problems_reported && (
                            <p><span className="font-medium">Problems reported:</span> {entry.checkin.problems_reported}</p>
                          )}
                          {entry.checkin.notes && (
                            <p><span className="font-medium">Notes:</span> {entry.checkin.notes}</p>
                          )}
                        </div>
                      )}

                      {/* Action display section */}
                      {isAssetHistory(entry) && entry.change_type === 'action_created' && (
                        <div className="text-sm bg-purple-50 border border-purple-200 p-3 rounded mt-2">
                          <div className="flex items-center gap-2 mb-2">
                            <Zap className="h-4 w-4 text-purple-600" />
                            <span className="font-medium text-purple-900">Action Details:</span>
                            {entry.action_status && (
                              <Badge 
                                variant={entry.action_status === 'completed' ? 'default' : 'outline'} 
                                className="text-xs"
                              >
                                {entry.action_status}
                              </Badge>
                            )}
                          </div>
                          {entry.action_title && (
                            <div className="text-purple-800 mb-2">
                              <p className="font-medium mb-1">Action:</p>
                              <p>{entry.action_title}</p>
                            </div>
                          )}
                          {entry.notes && (
                            <div className="text-sm text-purple-700">
                              <p className="font-medium mb-1">Details:</p>
                              <p>{entry.notes}</p>
                            </div>
                          )}
                          {entry.action_id && (
                            <Link
                              to={`/actions/${entry.action_id}`}
                              className="text-purple-600 hover:text-purple-800 underline flex items-center gap-1 mt-2 text-sm"
                              onClick={(e) => e.stopPropagation()}
                            >
                              View Action
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          )}
                        </div>
                      )}

                      {/* Observation display section */}
                      {isObservation(entry) && (
                        <div className="text-sm bg-blue-50 border border-blue-200 p-3 rounded mt-2">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex-1">
                              {entry.observation_text ? (
                                <p className="text-blue-800">{entry.observation_text}</p>
                              ) : entry.metrics && entry.metrics.length > 0 ? (
                                <p className="text-blue-600 italic">Observation (metrics only)</p>
                              ) : (
                                <p className="text-blue-600 italic">Observation</p>
                              )}
                            </div>
                            {canEditObservation(entry) && (
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => navigate(`/observations/edit/${entry.id}`)}
                                  className="h-8 px-2 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                                  aria-label="Edit observation"
                                >
                                  <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDeleteObservation(entry.id)}
                                  disabled={isDeleting}
                                  className="h-8 px-2 text-red-600 hover:text-red-800 hover:bg-red-100"
                                  aria-label="Delete observation"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>
                          {entry.metrics && entry.metrics.length > 0 && (
                            <div className="space-y-1 mt-2 bg-blue-100 p-2 rounded">
                              <p className="font-medium text-blue-900 text-xs">Metrics:</p>
                              {entry.metrics.map(metric => (
                                <div key={metric.snapshot_id} className="flex items-center gap-2 text-blue-800">
                                  <span className="font-medium">{metric.metric_name}:</span>
                                  <span>{metric.value}</span>
                                  {metric.unit && <span className="text-blue-600">{metric.unit}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                          {entry.photos && entry.photos.length > 0 && (
                            <div className="grid grid-cols-2 gap-2 mt-2">
                              {entry.photos.map(photo => (
                                <div key={photo.id} className="relative group">
                                  <a 
                                    href={getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block"
                                  >
                                    <img 
                                      src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                      alt={photo.photo_description || 'Observation photo'}
                                      className="w-full h-32 object-cover rounded border border-blue-200 hover:border-blue-400 transition-colors"
                                      onError={(e) => {
                                        const target = e.target as HTMLImageElement;
                                        const fullUrl = getImageUrl(photo.photo_url);
                                        if (fullUrl && target.src !== fullUrl) {
                                          target.src = fullUrl;
                                        }
                                      }}
                                    />
                                  </a>
                                  {photo.photo_description && (
                                    <p className="text-xs text-blue-700 mt-1">
                                      {photo.photo_description}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              );
              })}
              
              {/* Asset Creation Info */}
              {assetInfo && (
                <Card className="p-4 bg-muted/50 border-dashed">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      <Plus className="h-4 w-4 text-green-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">System</span>
                          <Badge variant="outline" className="text-xs">
                            Created
                          </Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {new Date(assetInfo.created_at).toLocaleDateString()} {new Date(assetInfo.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Asset created
                      </p>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});

AssetHistoryDialog.displayName = "AssetHistoryDialog";
