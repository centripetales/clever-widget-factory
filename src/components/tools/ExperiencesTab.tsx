/**
 * ExperiencesTab
 *
 * A container's experiences, in four sections:
 * - Complete: the full S -> A -> S' shape — at least one initial state, one
 *   action, AND one final state.
 * - Reviewed: has both an initial and a final state, but no action attached
 *   yet. A decline is exactly as valid a result as growth here — "reviewed"
 *   describes the write-up, not that the outcome was new information to the
 *   person who lived it.
 * - In progress: everything else that's still a real row in the database —
 *   missing an initial state, a final state, or both. Without this, a
 *   just-started write-up (or an abandoned "New experience" click) is
 *   invisible: not Complete, not Reviewed, and easy to mistake for deleted.
 * - Actions: confirmed actions with no full write-up yet. Defaults to the
 *   last week (they accumulate fast) with an explicit "show all" to see
 *   older ones.
 *
 * Complete, Reviewed, and In progress are mutually exclusive (an experience
 * appears in exactly one). Complete and Reviewed are collapsed by default,
 * shown above In progress — they're usually the longest lists and the ones
 * least often acted on.
 *
 * Experiences are written up by a person, starting from a specific
 * observation or action they already recognize as worth sharing (the "Draft
 * Experience" button on those, elsewhere in the app) — not from an ambient,
 * system-wide AI sweep.
 */

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ChevronDown, Edit, Plus, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { useExperiences } from '@/hooks/useExperiences';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { actionService, type ActionResponse } from '@/services/actionService';
import { apiService, deleteExperience } from '@/lib/apiService';
import { useToast } from '@/hooks/use-toast';
import { toolHistoryQueryKey, experiencesQueryKey } from '@/lib/queryKeys';
import type { Experience, ExperienceComponent } from '@/types/experiences';
import { PhotoThumb } from '@/components/shared/PhotoThumb';
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';

/** One line describing a leg's first component for the summary row. Many
 *  states are photo-only (no state_text at all) — falling straight back to
 *  state_text made the line just vanish for those, even though the leg
 *  genuinely has content, which read as "some show a final, others an
 *  initial, others nothing" with no visible reason why. */
const summarizeStateComponent = (comp?: ExperienceComponent): string | null => {
  if (!comp?.state) return null;
  if (comp.state.state_text) return comp.state.state_text;
  // A photo's own description is often where the actual meaningful text
  // lives for a photo-only observation — check every photo, not just
  // whether photos exist, before calling it undescribed.
  const photoDescription = comp.state.photos?.map((p) => p.photo_description).find(Boolean);
  if (photoDescription) return photoDescription;
  if (comp.state.metrics?.length) return comp.state.metrics.map((m) => `${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ''}`).join(', ');
  const photoCount = comp.state.photos?.length || 0;
  if (photoCount > 0) return `${photoCount} photo${photoCount === 1 ? '' : 's'}, no description`;
  return null;
};

/**
 * Effective date(s) for one state: its photos' own captured dates when any
 * were extracted, else the state row's own captured_at. Preferring photo
 * dates matters for a synthesized/linked-photo state, whose own captured_at
 * is just when the write-up was made, not when the observation happened.
 */
const stateEffectiveDates = (c: ExperienceComponent): string[] => {
  const photoDates = (c.state?.photos || []).map((p) => p.captured_at).filter(Boolean) as string[];
  if (photoDates.length) return photoDates;
  return c.state?.captured_at ? [c.state.captured_at] : [];
};
/** Earliest / latest effective date across a leg, for the date range display. */
const capturedAts = (comps?: ExperienceComponent[]) =>
  (comps || []).flatMap(stateEffectiveDates);
const firstCapturedAt = (comps?: ExperienceComponent[]) =>
  capturedAts(comps).sort()[0] || null;
const lastCapturedAt = (comps?: ExperienceComponent[]) => {
  const sorted = capturedAts(comps).sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
};

interface ExperiencesTabProps {
  entityType: 'tool' | 'part';
  entityId: string;
  entityName?: string;
  organizationId: string;
  disabled?: boolean;
}

export function ExperiencesTab({ entityType, entityId, entityName, organizationId, disabled }: ExperiencesTabProps) {
  const { data: experiencesRes, isLoading: loadingExperiences } = useExperiences({ entity_type: entityType, entity_id: entityId });

  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [openActions, setOpenActions] = useState<ActionResponse[]>([]);
  const [loadingOpenActions, setLoadingOpenActions] = useState(false);
  // AlertDialog-based confirm, not window.confirm() — native dialogs are
  // suppressed in some embedded/preview browser contexts, where confirm()
  // silently returns false and the delete never fires.
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: 'action' | 'experience'; id: string } | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Actions without a write-up accumulate fast — default to the last week
  // so the list stays scannable, with an explicit opt-in to see older ones.
  const [showAllActions, setShowAllActions] = useState(false);
  const [reviewedOpen, setReviewedOpen] = useState(false);

  const experiences = experiencesRes?.data || [];

  const attachedActionIds = useMemo(() => {
    const ids = new Set<string>();
    experiences.forEach((exp) => (exp.components?.actions || []).forEach((c) => c.action_id && ids.add(c.action_id)));
    return ids;
  }, [experiences]);

  const fetchOpenActions = async () => {
    if (entityType !== 'tool') return;
    setLoadingOpenActions(true);
    try {
      const actions = await actionService.listActions({ asset_id: entityId, status: 'completed' });
      setOpenActions(actions);
    } catch (err) {
      console.error('Failed to load actions:', err);
    } finally {
      setLoadingOpenActions(false);
    }
  };

  useEffect(() => {
    fetchOpenActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  const handleDeleteAction = async (actionId: string) => {
    try {
      // The backend also deletes this action's experience_components row
      // and, if that was the experience's last remaining component, the
      // now-empty experience itself — so the experiences cache needs
      // invalidating here too, not just the open-actions list and history.
      await apiService.delete(`/actions/${actionId}`);
      setOpenActions((prev) => prev.filter((a) => a.id !== actionId));
      // The History tab (ToolDetails.tsx) reads this same action from its own
      // cached query — without this it keeps showing the deleted action until
      // something else happens to invalidate it.
      if (entityType === 'tool') {
        queryClient.invalidateQueries({ queryKey: toolHistoryQueryKey(entityId) });
      }
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey({ entity_type: entityType, entity_id: entityId }) });
      toast({ title: 'Action deleted', description: 'The action has been deleted successfully.' });
    } catch (err) {
      console.error('Failed to delete action:', err);
      toast({ title: 'Error', description: 'Failed to delete action. Please try again.', variant: 'destructive' });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleDeleteExperience = async (experienceId: string) => {
    try {
      await deleteExperience(experienceId);
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey({ entity_type: entityType, entity_id: entityId }) });
      if (entityType === 'tool') {
        queryClient.invalidateQueries({ queryKey: toolHistoryQueryKey(entityId) });
      }
      toast({ title: 'Experience deleted', description: 'The states and actions themselves are untouched.' });
    } catch (err) {
      console.error('Failed to delete experience:', err);
      toast({ title: 'Error', description: 'Failed to delete experience. Please try again.', variant: 'destructive' });
    } finally {
      setDeleteConfirm(null);
    }
  };

  const trulyOpenActions = openActions.filter((a) => !attachedActionIds.has(a.id));
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentOpenActions = trulyOpenActions.filter(
    (a) => a.completed_at && new Date(a.completed_at).getTime() >= oneWeekAgo
  );
  const olderOpenActionsCount = trulyOpenActions.length - recentOpenActions.length;
  const visibleOpenActions = showAllActions ? trulyOpenActions : recentOpenActions;

  // Complete = the full S -> A -> S' shape. Reviewed = has both a starting
  // condition and an observed outcome, but no action attached yet — still a
  // real write-up, just not tied to a logged action. Mutually exclusive.
  const hasInitial = (exp: Experience) => !!exp.components?.initial_states?.length;
  const hasFinal = (exp: Experience) => !!exp.components?.final_states?.length;
  const hasAction = (exp: Experience) => !!exp.components?.actions?.length;
  const completeExperiences = experiences.filter((exp) => hasInitial(exp) && hasAction(exp) && hasFinal(exp));
  const reviewedExperiences = experiences.filter((exp) => hasInitial(exp) && hasFinal(exp) && !hasAction(exp));
  // Anything missing an initial or a final state falls through both filters
  // above — without this, a just-started write-up (or an empty shell from a
  // "New experience" click that got abandoned) is a real row in the
  // database that never appears anywhere in this tab.
  const inProgressExperiences = experiences.filter((exp) => !(hasInitial(exp) && hasFinal(exp)));

  const renderExperienceRow = (exp: Experience) => {
    const firstInitial = summarizeStateComponent(exp.components?.initial_states?.[0]);
    const actions = exp.components?.actions || [];
    const firstFinal = summarizeStateComponent(exp.components?.final_states?.[0]);
    const initialPhotoUrl = exp.components?.initial_states?.[0]?.state?.photos?.[0]?.photo_url;
    const finalPhotoUrl = exp.components?.final_states?.[0]?.state?.photos?.[0]?.photo_url;
    return (
      <div key={exp.id} className="rounded-md border-2 border-[#8b5a2b] bg-[#8b5a2b]/5 p-3 space-y-1">
        <div className="flex items-center justify-between gap-2">
          {/* Legs are plural — span the whole experience, earliest
              initial state to latest final state. */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {firstCapturedAt(exp.components?.initial_states) && (
              <span>{format(new Date(firstCapturedAt(exp.components?.initial_states)!), 'MMM d, yyyy')}</span>
            )}
            <span>&rarr;</span>
            {lastCapturedAt(exp.components?.final_states) && (
              <span>{format(new Date(lastCapturedAt(exp.components?.final_states)!), 'MMM d, yyyy')}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(`/experiences/${exp.id}`)}
              className="h-8 px-2"
              aria-label="Edit experience"
              title="Edit experience"
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteConfirm({ kind: 'experience', id: exp.id })}
              className="h-8 px-2 text-muted-foreground/60 hover:text-red-600 hover:bg-red-50"
              aria-label="Delete experience"
              title="Delete experience — the states and actions themselves are untouched"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {/* A summary, not the full record — just enough of the S -> A -> S'
            shape to recognize which experience this is without opening it.
            Any leg can have more than one component; only the first of each
            is shown here, each with its own photo (initial above, final
            below) rather than one shared thumbnail for the whole card. */}
        <div className="space-y-2">
          {firstInitial && (
            <div className="flex gap-3">
              {initialPhotoUrl && (
                <PhotoThumb
                  href={getOriginalUrl(initialPhotoUrl) || getImageUrl(initialPhotoUrl) || ''}
                  src={getThumbnailUrl(initialPhotoUrl) || getImageUrl(initialPhotoUrl) || ''}
                  alt="Initial state photo"
                  className="w-16 h-16 flex-shrink-0 rounded border"
                />
              )}
              <p className="text-sm text-muted-foreground min-w-0">
                <span className="font-medium text-foreground">Initial: </span>{firstInitial}
              </p>
            </div>
          )}
          {actions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {actions.map((c) => (
                <Badge
                  key={c.id}
                  variant="secondary"
                  className="bg-purple-50 text-purple-900 border border-purple-200 hover:bg-purple-50"
                >
                  {c.action?.title || 'Untitled action'}
                </Badge>
              ))}
            </div>
          )}
          {firstFinal && (
            <div className="flex gap-3">
              {finalPhotoUrl && (
                <PhotoThumb
                  href={getOriginalUrl(finalPhotoUrl) || getImageUrl(finalPhotoUrl) || ''}
                  src={getThumbnailUrl(finalPhotoUrl) || getImageUrl(finalPhotoUrl) || ''}
                  alt="Final state photo"
                  className="w-16 h-16 flex-shrink-0 rounded border"
                />
              )}
              <p className="text-sm min-w-0">
                <span className="font-medium">Final: </span>{firstFinal}
              </p>
            </div>
          )}
          {!firstInitial && actions.length === 0 && !firstFinal && (
            <p className="text-sm text-muted-foreground italic">Nothing added yet.</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <Collapsible open={completeOpen} onOpenChange={setCompleteOpen}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 cursor-pointer select-none">
              <CardTitle className="text-base flex items-center gap-2">
                Complete
                {completeExperiences.length > 0 && (
                  <Badge variant="secondary" className="font-normal">{completeExperiences.length}</Badge>
                )}
              </CardTitle>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${completeOpen ? 'rotate-180' : ''}`} />
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-2">
              {loadingExperiences ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : completeExperiences.length === 0 ? (
                <p className="text-sm text-muted-foreground">No complete write-ups yet — initial state, action, and final state all present.</p>
              ) : (
                completeExperiences.map(renderExperienceRow)
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Collapsible open={reviewedOpen} onOpenChange={setReviewedOpen}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 cursor-pointer select-none">
              <CardTitle className="text-base flex items-center gap-2">
                Reviewed
                {reviewedExperiences.length > 0 && (
                  <Badge variant="secondary" className="font-normal">{reviewedExperiences.length}</Badge>
                )}
              </CardTitle>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${reviewedOpen ? 'rotate-180' : ''}`} />
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-2">
              {loadingExperiences ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : reviewedExperiences.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reviewed write-ups yet.</p>
              ) : (
                reviewedExperiences.map(renderExperienceRow)
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            In progress
            {inProgressExperiences.length > 0 && (
              <Badge variant="secondary" className="font-normal">{inProgressExperiences.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingExperiences ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : inProgressExperiences.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing started yet.</p>
          ) : (
            inProgressExperiences.map(renderExperienceRow)
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Actions</CardTitle>
          <Button
            size="sm"
            onClick={() => navigate(`/experiences/new?entity_type=${entityType}&entity_id=${entityId}`)}
            disabled={disabled}
          >
            <Plus className="h-4 w-4 mr-2" />
            New experience
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingOpenActions ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : trulyOpenActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing confirmed yet without a write-up.</p>
          ) : visibleOpenActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing in the last week.{' '}
              <button type="button" onClick={() => setShowAllActions(true)} className="underline hover:text-foreground">
                Show all {trulyOpenActions.length}
              </button>
            </p>
          ) : (
            visibleOpenActions.map((action) => (
              <div key={action.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="font-medium text-sm">{action.title}</p>
                  {action.completed_at && (
                    <p className="text-xs text-muted-foreground">{format(new Date(action.completed_at), 'MMM d, yyyy')}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/experiences/new?entity_type=${entityType}&entity_id=${entityId}&action_id=${action.id}`)}
                  >
                    Review
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteConfirm({ kind: 'action', id: action.id })}
                    className="h-8 px-2 text-muted-foreground/60 hover:text-red-600 hover:bg-red-50"
                    aria-label="Delete action"
                    title="Delete action"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
          {!showAllActions && olderOpenActionsCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllActions(true)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Show {olderOpenActionsCount} older
            </button>
          )}
          {showAllActions && olderOpenActionsCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllActions(false)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Show last week only
            </button>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteConfirm?.kind === 'experience' ? 'Delete experience' : 'Delete action'}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.kind === 'experience'
                ? 'This removes the write-up only — the observations and actions it references are untouched. This cannot be undone.'
                : 'Are you sure you want to delete this action? This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteConfirm) return;
                if (deleteConfirm.kind === 'experience') handleDeleteExperience(deleteConfirm.id);
                else handleDeleteAction(deleteConfirm.id);
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
}
