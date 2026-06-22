import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { History, TrendingUp, TrendingDown, Edit, Plus, ExternalLink, Camera } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { apiService } from '@/lib/apiService';
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';

interface HistoryEntry {
  id: string;
  change_type: string;
  old_quantity: number | null;
  new_quantity: number | null;
  quantity_change: number | null;
  changed_by: string;
  changed_by_name?: string;
  change_reason: string | null;
  changed_at: string;
  mission_id?: string;
  mission_number?: number;
  mission_title?: string;
  usage_description?: string;
  action_id?: string | null;
  action_title?: string | null;
  action_status?: string | null;
}

interface Observation {
  id: string;
  observation_text: string | null;
  observed_by: string;
  observed_by_name: string;
  observed_at: string;
  photos?: Array<{ id: string; photo_url: string; photo_description: string | null }>;
  metrics?: Array<{ snapshot_id: string; metric_name: string; value: number; unit: string | null }>;
}

interface InventoryHistoryContentProps {
  partId: string;
  observationsOnly?: boolean;
}

export function InventoryHistoryContent({ partId, observationsOnly = false }: InventoryHistoryContentProps) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchHistory = async () => {
      setLoading(true);
      try {
        const result = await apiService.get(`/history/parts/${partId}`);
        const data = result.data || {};

        const partsHistory: HistoryEntry[] = data.history || [];
        const observationsData: Observation[] = data.observations || [];

        const historyMap = new Map<string, HistoryEntry>();
        partsHistory.forEach((entry) => {
          const existing = historyMap.get(entry.id);
          if (!existing || new Date(entry.changed_at) > new Date(existing.changed_at)) {
            historyMap.set(entry.id, entry);
          }
        });

        setHistory(
          Array.from(historyMap.values()).sort(
            (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime()
          )
        );
        setObservations(
          observationsData.sort(
            (a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime()
          )
        );
      } catch (error) {
        console.error('Error fetching history:', error);
        toast({ title: 'Error', description: 'Failed to fetch inventory history', variant: 'destructive' });
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [partId]);

  const getChangeIcon = (changeType: string) => {
    switch (changeType) {
      case 'quantity_add': return <TrendingUp className="h-4 w-4 text-green-600" />;
      case 'quantity_remove': return <TrendingDown className="h-4 w-4 text-red-600" />;
      case 'mission_usage': return <TrendingDown className="h-4 w-4 text-orange-600" />;
      case 'manual_usage': return <TrendingDown className="h-4 w-4 text-purple-600" />;
      case 'update': return <Edit className="h-4 w-4 text-blue-600" />;
      case 'create': return <Plus className="h-4 w-4 text-green-600" />;
      default: return <History className="h-4 w-4 text-gray-600" />;
    }
  };

  const getChangeDescription = (entry: HistoryEntry) => {
    switch (entry.change_type) {
      case 'quantity_add': return `Added ${entry.quantity_change} items (${entry.old_quantity} → ${entry.new_quantity})`;
      case 'quantity_remove': return `Removed ${Math.abs(entry.quantity_change!)} items (${entry.old_quantity} → ${entry.new_quantity})`;
      case 'mission_usage': return `Used ${Math.abs(entry.quantity_change!)} items for mission`;
      case 'manual_usage': return `Used ${Math.abs(entry.quantity_change!)} items (manual usage)`;
      case 'update': return entry.change_reason || 'Updated item details';
      case 'create': return 'Created item';
      default: return 'Unknown change';
    }
  };

  const getChangeBadge = (changeType: string) => {
    switch (changeType) {
      case 'quantity_add': return <Badge variant="secondary" className="bg-green-100 text-green-800">Added</Badge>;
      case 'quantity_remove': return <Badge variant="secondary" className="bg-red-100 text-red-800">Removed</Badge>;
      case 'mission_usage': return <Badge variant="secondary" className="bg-orange-100 text-orange-800">Mission Usage</Badge>;
      case 'manual_usage': return <Badge variant="secondary" className="bg-purple-100 text-purple-800">Manual Usage</Badge>;
      case 'update': return <Badge variant="secondary" className="bg-blue-100 text-blue-800">Updated</Badge>;
      case 'create': return <Badge variant="secondary" className="bg-green-100 text-green-800">Created</Badge>;
      default: return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const usageEntries = history.filter(e => e.change_type === 'mission_usage' || e.change_type === 'manual_usage');
  const otherEntries = history.filter(e => e.change_type !== 'mission_usage' && e.change_type !== 'manual_usage');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if ((history.length === 0 && observations.length === 0) || (observationsOnly && observations.length === 0)) {
    return <div className="text-center py-8 text-muted-foreground">No history records found for this item.</div>;
  }

  return (
    <div className="space-y-6">
      {observations.length > 0 && (
        <div>
          <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
            <Badge variant="secondary" className="bg-blue-100 text-blue-800">{observations.length}</Badge>
            Observations
          </h3>
          <div className="space-y-3">
            {observations.map((observation) => (
              <Card key={observation.id} className="p-4 border-l-4 border-l-blue-400">
                <CardContent className="p-0">
                  <div className="flex items-start gap-3">
                    <Camera className="h-4 w-4 text-blue-600 mt-1 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{observation.observed_by_name}</span>
                          <Badge variant="secondary" className="bg-blue-100 text-blue-800">Observation</Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">{format(new Date(observation.observed_at), 'PPpp')}</span>
                      </div>
                      {observation.observation_text && (
                        <p className="text-sm text-blue-800 mb-2">{observation.observation_text}</p>
                      )}
                      {observation.metrics && observation.metrics.length > 0 && (
                        <div className="space-y-1 mt-2 bg-blue-50 p-2 rounded">
                          <p className="font-medium text-blue-900 text-xs">Metrics:</p>
                          {observation.metrics.map(metric => (
                            <div key={metric.snapshot_id} className="flex items-center gap-2 text-blue-800 text-sm w-full">
                              <span className="font-medium whitespace-nowrap">{metric.metric_name}:</span>
                              <span className="flex-1">{metric.value}</span>
                              {metric.unit && <span className="text-blue-600 whitespace-nowrap">{metric.unit}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      {observation.photos && observation.photos.length > 0 && (
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          {observation.photos.map(photo => (
                            <div key={photo.id} className="relative">
                              <a href={getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''} target="_blank" rel="noopener noreferrer" className="block">
                                <img
                                  src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                  alt={photo.photo_description || 'Observation photo'}
                                  className="w-full h-32 object-cover rounded border border-blue-200 hover:border-blue-400 transition-colors"
                                  onError={(e) => {
                                    const target = e.target as HTMLImageElement;
                                    const fullUrl = getImageUrl(photo.photo_url);
                                    if (fullUrl && target.src !== fullUrl) target.src = fullUrl;
                                  }}
                                />
                              </a>
                              {photo.photo_description && <p className="text-xs text-blue-700 mt-1">{photo.photo_description}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {!observationsOnly && usageEntries.length > 0 && (
        <div>
          <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
            <Badge variant="secondary" className="bg-orange-100 text-orange-800">{usageEntries.length}</Badge>
            Usage History
          </h3>
          <div className="space-y-3">
            {usageEntries.map((entry) => (
              <Card key={entry.id} className="p-4 border-l-4 border-l-orange-400">
                <CardContent className="p-0">
                  <div className="flex items-start gap-3 flex-1">
                    {getChangeIcon(entry.change_type)}
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        {getChangeBadge(entry.change_type)}
                        <span className="text-sm font-medium">{getChangeDescription(entry)}</span>
                      </div>
                      <div className="text-sm text-muted-foreground mb-2">{format(new Date(entry.changed_at), 'PPpp')}</div>
                      {entry.mission_id && (
                        <Button variant="outline" size="sm" onClick={() => window.open(`/missions#${entry.mission_id}`, '_blank')} className="h-8 text-xs">
                          <ExternalLink className="h-3 w-3 mr-1" />
                          Project #{entry.mission_number}: {entry.mission_title}
                        </Button>
                      )}
                      {entry.usage_description && <div className="text-sm text-muted-foreground mt-1 italic">"{entry.usage_description}"</div>}
                      {entry.action_id && entry.action_title && (
                        <div className="mt-2">
                          <Button variant="outline" size="sm" onClick={() => window.open(`/actions#${entry.action_id}`, '_blank')} className="h-8 text-xs">
                            <ExternalLink className="h-3 w-3 mr-1" />
                            View Action: {entry.action_title}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {!observationsOnly && otherEntries.length > 0 && (
        <div>
          <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
            <Badge variant="secondary" className="bg-blue-100 text-blue-800">{otherEntries.length}</Badge>
            Inventory Changes
          </h3>
          <div className="space-y-3">
            {otherEntries.map((entry) => (
              <Card key={entry.id} className="p-4">
                <CardContent className="p-0">
                  <div className="flex items-start gap-3">
                    {getChangeIcon(entry.change_type)}
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {getChangeBadge(entry.change_type)}
                        <span className="text-sm font-medium">{getChangeDescription(entry)}</span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        By {entry.changed_by_name || 'Unknown User'} • {format(new Date(entry.changed_at), 'PPpp')}
                      </div>
                      {entry.change_reason && (
                        <div className="text-sm text-muted-foreground mt-1">
                          {entry.change_type === 'update' ? (
                            <div><div className="font-medium mb-1">Changes:</div><div className="bg-gray-50 p-2 rounded text-xs font-mono">{entry.change_reason}</div></div>
                          ) : (
                            <div>Reason: {entry.change_reason}</div>
                          )}
                        </div>
                      )}
                      {entry.action_id && entry.action_title && (
                        <div className="mt-2">
                          <Button variant="outline" size="sm" onClick={() => window.open(`/actions#${entry.action_id}`, '_blank')} className="h-8 text-xs">
                            <ExternalLink className="h-3 w-3 mr-1" />
                            View Action: {entry.action_title}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
