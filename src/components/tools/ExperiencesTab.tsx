/**
 * ExperiencesTab
 *
 * A container's experiences, in two sections:
 * - In progress: everything still missing an initial state, an action, a
 *   final state, or more than one. Shown first, above Complete — this is
 *   the list a person actually needs to act on, so it shouldn't be buried
 *   below the (usually much longer) Complete list. Without this bucket, a
 *   just-started write-up (or an abandoned "New experience" click) is
 *   invisible: not Complete, and easy to mistake for deleted.
 * - Complete: the full S -> A -> S' shape — at least one initial state, one
 *   action, AND one final state. A decline is exactly as valid a result as
 *   growth here — "complete" describes the write-up's shape, not that the
 *   outcome was new information to the person who lived it. Sorted most
 *   recent first, by the final state's own date. Collapsed by default —
 *   it's usually the longest list and the one least often acted on.
 *
 * Complete and In progress are mutually exclusive (an experience appears in
 * exactly one).
 *
 * Deliberately no "has initial + final, no action yet" bucket (a prior
 * "Reviewed" section did this) — experiences here are meant to stay
 * human-curated, not partially accepted on their way to Complete. Something
 * without an action just sits in In progress until a person finishes it.
 *
 * Deliberately no list of "confirmed actions with no write-up yet" either (a
 * prior "Actions" section did this, nudging toward writing every action up)
 * — starting a new experience is a deliberate choice a person makes, not a
 * queue to clear. "New experience" always starts from a blank card; picking
 * an existing action for it happens inside that flow (Add from {container}),
 * not from a pre-filtered list here.
 *
 * Experiences are written up by a person, starting from a specific
 * observation or action they already recognize as worth sharing (the "Draft
 * Experience" button on those, elsewhere in the app) — not from an ambient,
 * system-wide AI sweep.
 */

import { useState } from 'react';
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
import { deleteExperience } from '@/lib/apiService';
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
  // AlertDialog-based confirm, not window.confirm() — native dialogs are
  // suppressed in some embedded/preview browser contexts, where confirm()
  // silently returns false and the delete never fires.
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string } | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);

  const experiences = experiencesRes?.data || [];

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

  // Complete = the full S -> A -> S' shape. Everything else -- missing an
  // initial state, an action, a final state, or more than one -- is In
  // progress; without that fallback, a just-started write-up (or an empty
  // shell from a "New experience" click that got abandoned) is a real row
  // in the database that never appears anywhere in this tab.
  const hasInitial = (exp: Experience) => !!exp.components?.initial_states?.length;
  const hasFinal = (exp: Experience) => !!exp.components?.final_states?.length;
  const hasAction = (exp: Experience) => !!exp.components?.actions?.length;
  // Most recent first, by the final state's own date -- the moment the
  // experience actually concluded, not when its write-up was saved.
  const completeExperiences = experiences
    .filter((exp) => hasInitial(exp) && hasAction(exp) && hasFinal(exp))
    .sort((a, b) => {
      const aDate = lastCapturedAt(a.components?.final_states);
      const bDate = lastCapturedAt(b.components?.final_states);
      return (bDate ? new Date(bDate).getTime() : 0) - (aDate ? new Date(aDate).getTime() : 0);
    });
  const inProgressExperiences = experiences.filter((exp) => !(hasInitial(exp) && hasAction(exp) && hasFinal(exp)));

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
              onClick={() => setDeleteConfirm({ id: exp.id })}
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
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/experiences/new?entity_type=${entityType}&entity_id=${entityId}`)}
          disabled={disabled}
        >
          <Plus className="h-4 w-4 mr-2" />
          New experience
        </Button>
      </div>

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

      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete experience</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the write-up only — the observations and actions it references are untouched. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteConfirm) return;
                handleDeleteExperience(deleteConfirm.id);
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
