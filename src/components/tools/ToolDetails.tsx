import { ArrowLeft, Zap, MapPin, Maximize2, Camera, Edit, Trash2, Loader2, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Tool } from "@/hooks/tools/useToolsData";
import { HistoryEntry, AssetHistoryEntry, ObservationHistoryEntry } from "@/hooks/tools/useToolHistory";
import { ToolStatusBadge } from "./ToolStatusBadge";
import { ExperiencesTab } from "./ExperiencesTab";
import { useExperiences } from "@/hooks/useExperiences";
import { useEffect, useMemo, useState } from "react";
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';
import { PhotoThumb } from "@/components/shared/PhotoThumb";
import { GroupCoverageGrid } from "@/components/shared/GroupCoverageGrid";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useCognitoAuth";
import { useOrganization } from "@/hooks/useOrganization";
import { useStateMutations } from "@/hooks/useStates";
import { useToast } from "@/hooks/use-toast";
import { apiService, deleteExperience } from "@/lib/apiService";
import { useQueryClient } from "@tanstack/react-query";
import { toolHistoryQueryKey, experiencesQueryKey } from "@/lib/queryKeys";

interface ToolDetailsProps {
  tool: Tool;
  toolHistory: HistoryEntry[];
  // Optional: while true, the History tab shows a spinner instead of the
  // (indistinguishable-from-empty) list — toolHistory starts as [] before
  // the fetch resolves, so without this a "no history" message flashed for
  // several seconds on every open, even when history did exist.
  toolHistoryLoading?: boolean;
  onBack: () => void;
  // Controlled tab: the caller owns which tab is active (typically synced to
  // a URL search param) so that navigating away and back — e.g. to edit an
  // observation — restores the same tab instead of resetting to "details".
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export const ToolDetails = ({
  tool,
  toolHistory,
  toolHistoryLoading = false,
  onBack,
  activeTab,
  onTabChange,
}: ToolDetailsProps) => {
  const [expandedAiPhotos, setExpandedAiPhotos] = useState<Set<string>>(new Set());
  // AlertDialog-based confirm, not window.confirm() — native dialogs are
  // suppressed in some embedded/preview browser contexts, where confirm()
  // silently returns false and the delete never fires.
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: 'observation' | 'action' | 'experience'; id: string } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { organization, isAdmin } = useOrganization();
  const { deleteState } = useStateMutations(organization?.id || '');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // This container's own tab appears only when it's actually share-granted
  // somewhere (POST /shares) — the tab surfaces where that share leads, not a
  // hardcoded program name, so it works for whichever org(s) this container
  // happens to be shared into.
  const [shares, setShares] = useState<{ target_org_id: string; target_org_name: string }[]>([]);
  useEffect(() => {
    apiService.get<{ shares: { target_org_id: string; target_org_name: string }[] }>(`/shares/tool/${tool.id}`)
      .then((res) => setShares(res.shares || []))
      .catch(() => setShares([]));
  }, [tool.id]);

  // Experiences this history feed's observations/actions may already belong
  // to — used only to badge/link them in place, not to filter them out. The
  // History tab stays a complete record; Experiences is the write-up view.
  const { data: experiencesRes } = useExperiences({ entity_type: 'tool', entity_id: tool.id });
  const experiences = useMemo(() => experiencesRes?.data || [], [experiencesRes]);
  // Role kept alongside the experience id so a group can always be ordered
  // initial state → action → final state, regardless of which photo or note
  // was actually captured/uploaded first (an initial-state photo is often
  // added after the fact).
  const stateToExperience = useMemo(() => {
    const map = new Map<string, { experienceId: string; role: 'initial_state' | 'final_state' }>();
    experiences.forEach((exp) => {
      (exp.components?.initial_states || []).forEach((c) => {
        if (c.state_id) map.set(c.state_id, { experienceId: exp.id, role: 'initial_state' });
      });
      (exp.components?.final_states || []).forEach((c) => {
        if (c.state_id) map.set(c.state_id, { experienceId: exp.id, role: 'final_state' });
      });
    });
    return map;
  }, [experiences]);
  const stateToExperienceId = useMemo(() => {
    const map = new Map<string, string>();
    stateToExperience.forEach(({ experienceId }, stateId) => map.set(stateId, experienceId));
    return map;
  }, [stateToExperience]);
  const actionToExperienceId = useMemo(() => {
    const map = new Map<string, string>();
    experiences.forEach((exp) => {
      (exp.components?.actions || []).forEach((c) => {
        if (c.action_id) map.set(c.action_id, exp.id);
      });
    });
    return map;
  }, [experiences]);

  const canEditObservation = (record: ObservationHistoryEntry): boolean => {
    if (!user) return false;
    return user.userId === record.observed_by || isAdmin;
  };

  const handleDeleteObservation = async (observationId: string) => {
    try {
      await deleteState(observationId);
      // deleteState's own invalidation depends on the deleted state already
      // sitting in the per-state query cache, which is never populated by
      // this History-tab flow — so it silently no-ops here. Invalidate
      // explicitly, same as handleDeleteAction below. Also covers
      // experiences, since a deleted observation can be a state member of
      // one (the "Part of experience" grouping above).
      queryClient.invalidateQueries({ queryKey: toolHistoryQueryKey(tool.id) });
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey({ entity_type: 'tool', entity_id: tool.id }) });
      toast({ title: 'Observation deleted', description: 'The observation has been deleted successfully.' });
    } catch (error) {
      console.error('Failed to delete observation:', error);
      toast({ title: 'Error', description: 'Failed to delete observation. Please try again.', variant: 'destructive' });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleDeleteAction = async (actionId: string) => {
    try {
      // The backend also deletes this action's experience_components row
      // and, if that was the experience's last remaining component, the
      // now-empty experience itself — so the experiences cache needs
      // invalidating here too, not just tool history.
      await apiService.delete(`/actions/${actionId}`);
      queryClient.invalidateQueries({ queryKey: toolHistoryQueryKey(tool.id) });
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey({ entity_type: 'tool', entity_id: tool.id }) });
      toast({ title: 'Action deleted', description: 'The action has been deleted successfully.' });
    } catch (error) {
      console.error('Failed to delete action:', error);
      toast({ title: 'Error', description: 'Failed to delete action. Please try again.', variant: 'destructive' });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleDeleteExperience = async (experienceId: string) => {
    try {
      await deleteExperience(experienceId);
      queryClient.invalidateQueries({ queryKey: toolHistoryQueryKey(tool.id) });
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey({ entity_type: 'tool', entity_id: tool.id }) });
      toast({ title: 'Experience deleted', description: 'The states and actions themselves are untouched.' });
    } catch (error) {
      console.error('Failed to delete experience:', error);
      toast({ title: 'Error', description: 'Failed to delete experience. Please try again.', variant: 'destructive' });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const toggleExpandedAi = (photoId: string) => {
    setExpandedAiPhotos(prev => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  };

  const isAssetHistory = (record: HistoryEntry): record is AssetHistoryEntry => {
    return (record as AssetHistoryEntry).type === 'asset_change';
  };

  const isObservation = (record: HistoryEntry): record is ObservationHistoryEntry => {
    return (record as ObservationHistoryEntry).type === 'observation';
  };

  const getToolCardStyle = (record: HistoryEntry) => {
    if (isObservation(record)) {
      return 'border-2 border-blue-500 shadow-blue-200/50 shadow-lg';
    }
    if (isAssetHistory(record)) {
      switch (record.change_type) {
        case 'created':
          return 'border-2 border-emerald-500 shadow-emerald-200/50 shadow-lg';
        case 'action_created':
          return 'border-2 border-purple-500 shadow-purple-200/50 shadow-lg';
        case 'status_change':
          return 'border-2 border-orange-500 shadow-orange-200/50 shadow-lg';
        case 'updated':
          return 'border-2 border-blue-500 shadow-blue-200/50 shadow-lg';
        default:
          return 'border-2 border-slate-200 shadow-sm';
      }
    }
    return 'border-2 border-slate-200 shadow-sm';
  };

  // An experience's state/action/state don't have to be chronologically
  // adjacent in the feed (an action can be from days before its final
  // state) — so instead of only boxing runs that happen to sit next to each
  // other, every record belonging to one experience is pulled into a single
  // group wherever it appears, positioned by its most recent member's date.
  type TimelineItem =
    | { kind: 'single'; record: HistoryEntry; date: number }
    | { kind: 'group'; experienceId: string; records: HistoryEntry[]; date: number };

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const recordDate = (r: HistoryEntry) =>
      new Date('observed_at' in r ? r.observed_at : 'shared_at' in r ? r.shared_at : r.changed_at).getTime();
    // Within a group, always initial state → action → final state — a
    // person can add or edit the initial-state photo well after the fact,
    // so capture date is not a reliable stand-in for narrative order.
    const roleRank = (r: HistoryEntry): number => {
      if (isObservation(r)) return stateToExperience.get(r.id)?.role === 'final_state' ? 2 : 0;
      return 1;
    };
    const groups = new Map<string, HistoryEntry[]>();
    const singles: HistoryEntry[] = [];

    toolHistory.forEach((record) => {
      const experienceId = isObservation(record)
        ? stateToExperienceId.get(record.id)
        : isAssetHistory(record) && record.action_id
        ? actionToExperienceId.get(record.action_id)
        : undefined;
      if (experienceId) {
        if (!groups.has(experienceId)) groups.set(experienceId, []);
        groups.get(experienceId)!.push(record);
      } else {
        // History is meant to read as observations and human actions — a
        // standalone action that's either bare (no evidence attached) or
        // was written by the batch extraction script doesn't belong here.
        // Both stay real rows in the database either way (an auto-generated
        // action can still feed things like a coverage-over-time chart) —
        // this only keeps them out of this feed. Once grouped into an
        // experience (handled above, before reaching this branch), a
        // person has deliberately adopted it into a real write-up, so it's
        // exempt from both checks.
        const isBareAction =
          isAssetHistory(record) &&
          record.change_type === 'action_created' &&
          !(record.action_linked_observations && record.action_linked_observations.length > 0);
        const isAutoGeneratedAction =
          isAssetHistory(record) &&
          record.change_type === 'action_created' &&
          !!record.action_is_auto_generated;
        if (!isBareAction && !isAutoGeneratedAction) singles.push(record);
      }
    });

    const items: TimelineItem[] = singles.map((record) => ({
      kind: 'single',
      record,
      date: recordDate(record),
    }));
    groups.forEach((records, experienceId) => {
      const sorted = [...records].sort((a, b) => {
        const rankDiff = roleRank(a) - roleRank(b);
        return rankDiff !== 0 ? rankDiff : recordDate(a) - recordDate(b);
      });
      items.push({
        kind: 'group',
        experienceId,
        records: sorted,
        date: Math.max(...records.map(recordDate)),
      });
    });

    items.sort((a, b) => b.date - a.date);
    return items;
  }, [toolHistory, stateToExperienceId, actionToExperienceId, stateToExperience]);

  // The earliest EXIF/file date among a record's evidence photos, when any
  // were extracted — used only for records shown inside an experience box,
  // where the record's own logged timestamp can be weeks after the event
  // (e.g. a photo taken in the field, entered into the system much later).
  const earliestPhotoDate = (record: HistoryEntry): string | undefined => {
    if (isObservation(record)) {
      const dates = (record.photos || []).map((p) => p.captured_at).filter(Boolean) as string[];
      return dates.sort()[0];
    }
    if (isAssetHistory(record) && record.change_type === 'action_created') {
      return record.action_earliest_photo_captured_at || undefined;
    }
    return undefined;
  };

  const renderHistoryRecord = (record: HistoryEntry, displayDate?: string, insideGroup?: boolean) => (
                <Card className={`hover:shadow-md transition-shadow overflow-hidden bg-background ${getToolCardStyle(record)}`}>
                  <CardContent className="p-4">
                    {isAssetHistory(record) ? (
                      <>
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-start gap-2">
                            {record.change_type === 'action_created' ? (
                              <Zap className="h-4 w-4 mt-0.5 text-purple-600" />
                            ) : (
                              <div className="h-4 w-4 mt-0.5 rounded-full bg-blue-100 flex items-center justify-center">
                                <div className="h-2 w-2 rounded-full bg-blue-600" />
                              </div>
                            )}
                            <div>
                              <p className="font-medium">{record.user_name}</p>
                              <p className="text-sm text-muted-foreground">
                                {new Date(displayDate || record.changed_at).toLocaleDateString()} {new Date(displayDate || record.changed_at).toLocaleTimeString()}
                              </p>
                            </div>
                          </div>
                          <Badge variant="outline" className="capitalize">
                            {record.change_type === 'created' ? 'Created' :
                              record.change_type === 'action_created' ? 'Action' :
                                record.change_type === 'status_change' ? 'Status Changed' :
                                  record.change_type === 'updated' ? 'Updated' : record.change_type}
                          </Badge>
                        </div>

                        {record.change_type === 'action_created' && record.action_title && (
                          <div className="text-sm bg-purple-50 border border-purple-200 p-3 rounded mt-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="font-medium text-purple-900 mb-1">Action:</p>
                                {record.action_id ? (
                                  <Link
                                    to={`/actions/${record.action_id}`}
                                    state={{ from: `${location.pathname}${location.search}` }}
                                    className="text-purple-600 hover:text-purple-800 underline"
                                  >
                                    {record.action_title}
                                  </Link>
                                ) : (
                                  <p className="text-purple-800">{record.action_title}</p>
                                )}
                              </div>
                              {record.action_id && (
                                <div className="flex gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => navigate(`/actions/${record.action_id}`, { state: { from: `${location.pathname}${location.search}` } })}
                                    className="h-8 px-2 text-purple-700 hover:text-purple-900 hover:bg-purple-100"
                                    aria-label="Edit action"
                                    title="Edit action"
                                  >
                                    <Edit className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => navigate(`/experiences/new?entity_type=tool&entity_id=${tool.id}&draft_action_id=${record.action_id}`)}
                                    className="h-8 px-2 text-purple-700 hover:text-purple-900 hover:bg-purple-100"
                                    aria-label="Draft Experience"
                                    title="Draft Experience"
                                  >
                                    <Route className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setDeleteConfirm({ kind: 'action', id: record.action_id! })}
                                    className="h-8 px-2 text-muted-foreground/60 hover:text-red-600 hover:bg-red-50"
                                    aria-label="Delete action"
                                    title="Delete action"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              )}
                            </div>
                            {record.action_status && (
                              <Badge variant="outline" className="mt-1 text-xs">{record.action_status}</Badge>
                            )}
                            {/* This action's own evidence — observations linked to it
                                are deliberately not shown as separate standalone
                                entries above, so without this their content (often
                                the actual notes/photos from the day) is invisible.
                                Suppressed inside an experience group: this action can
                                be linked to evidence from many other points in its
                                history, but the group's own initial/final state cards
                                already show what's actually part of this write-up —
                                showing all of it here made the action look like it had
                                more attached to this experience than it really does. */}
                            {!insideGroup && (record.action_linked_observations || []).map((obs) => (
                              (obs.state_text || (obs.metrics && obs.metrics.length > 0) || (obs.photos && obs.photos.length > 0)) && (
                                <div key={obs.id} className="mt-2 pt-2 border-t border-purple-200 space-y-1">
                                  {obs.metrics && obs.metrics.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {obs.metrics.map((m, idx) => (
                                        <Badge key={idx} variant="secondary" className="text-xs">
                                          {m.name}: {m.value}{m.unit ? ` ${m.unit}` : ''}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                  {/* Falls back to each photo's own description when the
                                      observation has no text of its own — common for a
                                      measurement-shaped or photo-only entry. Multiple
                                      photos can carry different captions (e.g. one per
                                      reading), so every distinct one gets its own line
                                      instead of only ever showing the first. */}
                                  {(() => {
                                    const captions = obs.state_text
                                      ? [obs.state_text]
                                      : Array.from(new Set((obs.photos || []).map((p) => p.photo_description).filter(Boolean) as string[]));
                                    return captions.map((c, i) => (
                                      <p key={i} className="text-sm text-purple-900">{c}</p>
                                    ));
                                  })()}
                                  {obs.photos && obs.photos.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {obs.photos.map((photo, idx) => (
                                        <PhotoThumb
                                          key={idx}
                                          href={getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                          src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                          alt={photo.photo_description || 'Action evidence photo'}
                                          className="w-14 h-14 rounded border border-purple-200"
                                        />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )
                            ))}
                          </div>
                        )}

                        {record.change_type !== 'action_created' && record.field_changed && (
                          <p className="text-sm mb-2">
                            <span className="font-medium">Field Changed:</span> {record.field_changed}
                            {record.old_value && record.new_value && (
                              <span className="text-muted-foreground">
                                {' '}({record.old_value} → {record.new_value})
                              </span>
                            )}
                          </p>
                        )}

                        {record.notes && record.change_type !== 'created' && record.change_type !== 'action_created' && (
                          <p className="text-sm text-muted-foreground">{record.notes}</p>
                        )}
                      </>
                    ) : isObservation(record) ? (
                      <>
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex items-center gap-2">
                            <Camera className="h-4 w-4 text-blue-600 flex-shrink-0" />
                            <div>
                              <p className="font-medium">{record.observed_by_name}</p>
                              <p className="text-sm text-muted-foreground">
                                {new Date(displayDate || record.created_at || record.observed_at).toLocaleDateString()} {new Date(displayDate || record.created_at || record.observed_at).toLocaleTimeString()}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">Observation</Badge>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/experiences/new?entity_type=tool&entity_id=${tool.id}&draft_state_id=${record.id}`)}
                              className="h-8 px-2 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                              aria-label="Draft Experience"
                              title="Draft Experience"
                            >
                              <Route className="h-4 w-4" />
                            </Button>
                            {canEditObservation(record) && (
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => navigate(`/observations/edit/${record.id}`)}
                                  className="h-8 px-2 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                                  aria-label="Edit observation"
                                >
                                  <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDeleteConfirm({ kind: 'observation', id: record.id })}
                                  className="h-8 px-2 text-red-600 hover:text-red-800 hover:bg-red-100"
                                  aria-label="Delete observation"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                        {record.observation_text && (
                          <p className="text-sm mb-2">{record.observation_text}</p>
                        )}
                        {record.metrics && record.metrics.length > 0 && (
                          <div className="space-y-1 mt-2 bg-blue-50 border border-blue-150 p-2 rounded">
                            <p className="font-medium text-blue-900 text-xs">Metrics:</p>
                            {record.metrics.map(metric => (
                              <div key={metric.snapshot_id} className="flex items-center gap-2 text-blue-800 text-sm">
                                <span className="font-medium">{metric.metric_name}:</span>
                                <span>{metric.value}</span>
                                {metric.unit && <span className="text-blue-600">{metric.unit}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {record.photos && record.photos.length > 0 && (
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-2 mt-2">
                            {record.photos.map((photo, photoIdx) => (
                              <div key={photo.id} className="flex gap-3 items-start">
                                <PhotoThumb
                                  href={getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                  src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                                  alt={photo.photo_description || 'Observation photo'}
                                  className="w-28 h-28 flex-shrink-0 rounded border border-blue-200 hover:border-blue-400 transition-colors"
                                  onError={(e) => {
                                    const target = e.target as HTMLImageElement;
                                    const fullUrl = getImageUrl(photo.photo_url);
                                    if (fullUrl && target.src !== fullUrl) {
                                      target.src = fullUrl;
                                    }
                                  }}
                                />
                                <div className="flex-1 min-w-0 pt-0.5">
                                {photo.photo_description?.trim() && (
                                  <div className="text-xs text-blue-700">
                                    <span>{photo.photo_description}</span>
                                  </div>
                                )}
                                {(photo as any).transcription?.trim() && (
                                  <div className="flex flex-col mt-1">
                                    <div className="flex items-center">
                                      <button
                                        type="button"
                                        onClick={() => toggleExpandedAi(photo.id)}
                                        className="relative group cursor-pointer inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-muted/50 text-muted-foreground/60 border border-muted-foreground/10 hover:bg-muted dark:bg-zinc-800/35 dark:text-zinc-400 dark:border-zinc-700/30 dark:hover:bg-zinc-800/60 transition-all select-none mr-1.5 flex-shrink-0"
                                      >
                                        <span>AI Description</span>
                                        <span className={`absolute ${photoIdx % 2 === 0 ? 'left-0' : 'right-0'} bottom-full mb-2 w-[280px] xs:w-[340px] sm:w-[420px] p-3 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-2xl hidden group-hover:block z-30 normal-case not-italic text-xs text-zinc-700 dark:text-zinc-350 leading-normal text-left`} onClick={(e) => e.stopPropagation()}>
                                          <span className="block font-semibold text-zinc-900 dark:text-white mb-0.5">AI Description:</span>
                                          <span className="block bg-indigo-50/30 dark:bg-indigo-950/15 p-2 rounded text-zinc-850 dark:text-zinc-250 leading-relaxed text-xs border border-indigo-100/50 dark:border-indigo-900/20 text-left font-normal mb-2">
                                            {(photo as any).transcription.replace(/^\[photo_analysis\]\s*/, '')}
                                          </span>
                                          <details className="text-[10px] text-muted-foreground/60 dark:text-muted-foreground/45 select-none cursor-pointer">
                                            <summary className="hover:text-foreground font-semibold flex items-center gap-1 focus:outline-none">
                                              <span>Metadata Details</span>
                                            </summary>
                                            <div className="mt-1.5 space-y-1 bg-zinc-50/50 dark:bg-zinc-800/10 p-2 rounded border border-zinc-200/50 dark:border-zinc-700/20 cursor-default">
                                              <div className="flex justify-between border-b border-zinc-150 dark:border-zinc-850 pb-1">
                                                <span className="font-semibold text-zinc-700 dark:text-zinc-350">Model:</span>
                                                <span className="font-mono text-indigo-650 dark:text-indigo-405">{(photo as any).model_id || 'us.amazon.nova-pro-v1:0'}</span>
                                              </div>
                                              <div>
                                                <span className="block font-semibold text-zinc-700 dark:text-zinc-350 mb-0.5">Prompt:</span>
                                                <span className="block bg-zinc-50 dark:bg-zinc-950 p-2 rounded italic text-[10px] leading-relaxed border border-zinc-150 dark:border-zinc-850 max-h-[120px] overflow-y-auto whitespace-pre-line text-zinc-650 dark:text-zinc-350">
                                                  {(photo as any).system_prompt || 'No active prompt registered.'}
                                                </span>
                                              </div>
                                            </div>
                                          </details>
                                        </span>
                                      </button>
                                    </div>
                                    {expandedAiPhotos.has(photo.id) && (
                                      <span className="italic text-muted-foreground/65 dark:text-muted-foreground/50 font-normal text-xs leading-relaxed mt-1">
                                        {(photo as any).transcription.replace(/^\[photo_analysis\]\s*/, '')}
                                      </span>
                                    )}
                                  </div>
                                )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : null}
                  </CardContent>
                </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Tools
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{tool.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <ToolStatusBadge status={tool.status} />
          </div>
        </div>
      </div>

      <div>
        <div>
          <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
            <TabsList className="grid w-full" style={{ gridTemplateColumns: `repeat(${3 + shares.length}, 1fr)` }}>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="history" className="w-full">History</TabsTrigger>
              <TabsTrigger value="experiences" className="w-full">Experiences</TabsTrigger>
              {shares.map((share) => (
                <TabsTrigger key={share.target_org_id} value={`group-${share.target_org_id}`} className="w-full">
                  {share.target_org_name}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="details" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Tool Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium">Category:</span> {tool.category || 'Uncategorized'}
                  </div>
                  <div>
                    <span className="font-medium">Description:</span> {tool.description || 'No description'}
                  </div>
                  <div>
                    <span className="font-medium">Serial Number:</span> {tool.serial_number || 'Not specified'}
                  </div>
                  {tool.parent_structure_name && (
                    <div>
                      <span className="font-medium">Area:</span> {tool.parent_structure_name}
                    </div>
                  )}
                  {tool.storage_location && (
                    <div>
                      <span className="font-medium">Specific Location:</span> {tool.storage_location}
                    </div>
                  )}
                  {tool.actual_location && (
                    <div>
                      <span className="font-medium">Actual Location:</span> {tool.actual_location}
                    </div>
                  )}
                  {tool.last_maintenance && (
                    <div>
                      <span className="font-medium">Last Maintenance:</span> {tool.last_maintenance}
                    </div>
                  )}
                  {tool.manual_url && (
                    <div>
                      <span className="font-medium">Manual:</span>{' '}
                      <a
                        href={tool.manual_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        View Manual
                      </a>
                    </div>
                  )}
                </CardContent>
              </Card>

              {tool.gps_latitude && tool.gps_longitude && (
                <Card className="relative group overflow-hidden">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button
                        size="icon"
                        variant="secondary"
                        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-[90vw] w-[90vw] h-[90vh] p-0 border-none bg-transparent overflow-hidden">
                      <iframe 
                        width="100%" 
                        height="100%" 
                        frameBorder="0" 
                        style={{ border: 0, borderRadius: 'var(--radius)' }}
                        src={`https://maps.google.com/maps?q=${tool.gps_latitude},${tool.gps_longitude}&hl=en&z=17&t=k&output=embed`}
                        allowFullScreen
                      ></iframe>
                    </DialogContent>
                  </Dialog>
                  <CardContent className="p-0 h-64">
                    <iframe 
                      width="100%" 
                      height="100%" 
                      frameBorder="0" 
                      style={{ border: 0 }}
                      src={`https://maps.google.com/maps?q=${tool.gps_latitude},${tool.gps_longitude}&hl=en&z=17&t=k&output=embed`}
                      allowFullScreen
                    ></iframe>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <div className="space-y-4">
                {toolHistoryLoading && toolHistory.length === 0 && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading history...
                  </div>
                )}
                {timelineItems.map((item) =>
                  item.kind === 'single' ? (
                    <div key={item.record.id}>{renderHistoryRecord(item.record)}</div>
                  ) : (
                    <div
                      key={`experience-${item.experienceId}`}
                      className="rounded-lg border-2 border-[#8b5a2b] bg-[#8b5a2b]/5 p-3 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <Link
                          to={`/experiences/${item.experienceId}`}
                          className="inline-block text-xs font-semibold text-[#8b5a2b] hover:text-[#6b4520] uppercase tracking-wide"
                        >
                          Experience
                        </Link>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/experiences/${item.experienceId}`)}
                            className="h-7 px-2 text-[#8b5a2b] hover:text-[#6b4520] hover:bg-[#8b5a2b]/10"
                            aria-label="Edit experience"
                            title="Edit experience"
                          >
                            <Edit className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteConfirm({ kind: 'experience', id: item.experienceId })}
                            className="h-7 px-2 text-muted-foreground/60 hover:text-red-600 hover:bg-red-50"
                            aria-label="Delete experience"
                            title="Delete experience — the states and actions themselves are untouched"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {item.records.map((record) => (
                        <div key={record.id}>{renderHistoryRecord(record, earliestPhotoDate(record), true)}</div>
                      ))}
                    </div>
                  )
                )}

                {!toolHistoryLoading && toolHistory.length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No history available.
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="experiences" className="space-y-4">
              <ExperiencesTab
                entityType="tool"
                entityId={tool.id}
                entityName={tool.name}
                organizationId={organization?.id || ''}
                disabled={tool.is_shared_inbound}
              />
            </TabsContent>

            {shares.map((share) => (
              <TabsContent key={share.target_org_id} value={`group-${share.target_org_id}`} className="space-y-4">
                <GroupCoverageGrid orgId={share.target_org_id} />
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>

      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteConfirm?.kind === 'action' ? 'Delete action' : deleteConfirm?.kind === 'experience' ? 'Delete experience' : 'Delete observation'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.kind === 'experience'
                ? 'Are you sure you want to delete this experience? The states and actions it links together are untouched — this only removes the write-up. This cannot be undone.'
                : `Are you sure you want to delete this ${deleteConfirm?.kind}? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteConfirm) return;
                if (deleteConfirm.kind === 'action') handleDeleteAction(deleteConfirm.id);
                else if (deleteConfirm.kind === 'experience') handleDeleteExperience(deleteConfirm.id);
                else handleDeleteObservation(deleteConfirm.id);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
