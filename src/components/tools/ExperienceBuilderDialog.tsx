/**
 * ExperienceBuilderDialog
 *
 * Person-driven write-up of an experience (S -> A(s) -> S'): pick/confirm
 * an initial state from this container's own history, attach one or more
 * already-confirmed actions, and describe the final state in the person's
 * own words with fresh or candidate photos. Unlike ExperienceCreationDialog
 * (which only links three already-existing rows), this creates the final
 * state itself — there's no requirement that the outcome was already
 * captured as its own observation.
 *
 * Also doubles as the edit dialog for an existing experience (pass
 * `experience`): initial state can be repointed to a different existing
 * state, attached actions can be added/removed freely, and the final
 * state's own text/photos are edited in place via updateState — the same
 * mechanism AddObservation.tsx's edit mode already uses — rather than
 * creating a new state each time.
 */

import { useState, useMemo, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, X, ArrowRight } from 'lucide-react';
import { useCreateExperience, useUpdateExperience } from '@/hooks/useExperiences';
import { useStates } from '@/hooks/useStates';
import { useFileUpload } from '@/hooks/useFileUpload';
import { stateService } from '@/services/stateService';
import { PhotoUploadPanel, type PhotoItem } from '@/components/shared/PhotoUploadPanel';
import { format } from 'date-fns';
import type { Observation } from '@/types/observations';
import type { ActionResponse } from '@/services/actionService';
import type { Experience } from '@/types/experiences';

interface ExperienceBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'tool' | 'part';
  entityId: string;
  entityName?: string;
  organizationId: string;
  // All actions on this container not yet attached to an experience.
  openActions: ActionResponse[];
  // Preselected when opened from a specific "Open" action's card.
  preselectedActionId?: string;
  // When set, edits this experience in place instead of creating a new one.
  // Its currently-attached action(s) don't need to be in openActions — they're
  // merged in automatically so they still show up checked and toggleable.
  experience?: Experience;
  onSuccess?: () => void;
}

export function ExperienceBuilderDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityName,
  organizationId,
  openActions,
  preselectedActionId,
  experience,
  onSuccess,
}: ExperienceBuilderDialogProps) {
  const isEditMode = !!experience;
  const { toast } = useToast();
  const createExperience = useCreateExperience();
  const updateExperience = useUpdateExperience(entityType, entityId);
  const { uploadFiles } = useFileUpload();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: states, isLoading: isLoadingStates } = useStates(organizationId, {
    entity_type: entityType,
    entity_id: entityId,
  });

  const [initialStateId, setInitialStateId] = useState('');
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([]);
  const [finalStateText, setFinalStateText] = useState('');
  const [photos, setPhotos] = useState<PhotoItem[]>([]);

  // In edit mode, the checklist needs to include this experience's already-
  // attached actions even if they're not "open" (unattached) anymore.
  const selectableActions = useMemo(() => {
    if (!isEditMode) return openActions;
    const attached = (experience.components?.actions || [])
      .map((c) => c.action)
      .filter((a): a is NonNullable<typeof a> => !!a);
    const byId = new Map(openActions.map((a) => [a.id, a]));
    for (const a of attached) if (!byId.has(a.id)) byId.set(a.id, a as unknown as ActionResponse);
    return [...byId.values()];
  }, [isEditMode, experience, openActions]);

  useEffect(() => {
    if (!open) return;
    if (isEditMode && experience) {
      const initialStateComp = experience.components?.initial_state;
      const finalStateComp = experience.components?.final_state;
      setInitialStateId(initialStateComp?.state_id || '');
      setSelectedActionIds((experience.components?.actions || []).map((c) => c.action_id).filter((id): id is string => !!id));
      setFinalStateText(finalStateComp?.state?.state_text || '');
      const existingPhotos: PhotoItem[] = (finalStateComp?.state?.photos || []).map((p) => ({
        id: p.id,
        photo_url: p.photo_url,
        photo_description: p.photo_description || '',
        photo_order: 0,
        previewUrl: p.photo_url,
        isExisting: true,
      }));
      setPhotos(existingPhotos);
    } else {
      setSelectedActionIds(preselectedActionId ? [preselectedActionId] : []);
      setFinalStateText('');
      setPhotos([]);
      // Default the initial state to this container's most recent state
      // before the earliest selected action, if determinable — otherwise
      // leave it for the person to pick.
      setInitialStateId('');
    }
  }, [open, preselectedActionId, isEditMode, experience]);

  const sortedStates = useMemo(
    () => [...(states || [])].sort((a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()),
    [states]
  );

  const formatStateDisplay = (state: Observation): string => {
    const date = format(new Date(state.captured_at), 'MMM d, yyyy');
    const text = state.observation_text || 'No description';
    const preview = text.length > 60 ? `${text.substring(0, 60)}...` : text;
    return `${date} - ${preview}`;
  };

  const toggleAction = (actionId: string) => {
    setSelectedActionIds((prev) =>
      prev.includes(actionId) ? prev.filter((id) => id !== actionId) : [...prev, actionId]
    );
  };

  const handleEagerUpload = async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  };

  const handleSubmit = async () => {
    if (!initialStateId) {
      toast({ title: 'Initial state required', description: 'Pick where this experience started.', variant: 'destructive' });
      return;
    }
    if (!finalStateText.trim() && photos.length === 0) {
      toast({ title: 'Final state required', description: 'Describe the outcome or attach a photo.', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      const finalPhotos = photos
        .filter((p) => p.photo_url)
        .map((p, idx) => ({
          photo_url: p.photo_url!,
          photo_description: p.photo_description,
          photo_order: idx,
          client_captured_at: p.client_captured_at,
          capture_method: p.capture_method,
        }));

      if (isEditMode && experience) {
        const finalStateId = experience.components?.final_state?.state_id;
        if (finalStateId) {
          // Edits the state's own text/photos in place — the same mechanism
          // AddObservation.tsx's edit mode uses — rather than creating a new state.
          await stateService.updateState(finalStateId, {
            state_text: finalStateText.trim() || undefined,
            photos: finalPhotos,
          });
        }
        await updateExperience.mutateAsync({
          experienceId: experience.id,
          updates: {
            initial_state_id: initialStateId,
            action_ids: selectedActionIds,
          },
        });
        toast({ title: 'Experience updated' });
      } else {
        const finalState = await stateService.createState({
          state_text: finalStateText.trim() || undefined,
          photos: finalPhotos,
          links: [{ entity_type: entityType, entity_id: entityId }],
        });

        await createExperience.mutateAsync({
          entity_type: entityType,
          entity_id: entityId,
          initial_state_id: initialStateId,
          final_state_id: finalState.id,
          action_ids: selectedActionIds.length > 0 ? selectedActionIds : undefined,
        });

        toast({ title: 'Experience saved', description: 'The write-up has been recorded.' });
      }
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      console.error('Error building experience:', err);
      toast({ title: 'Error', description: 'Failed to save this experience.', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit experience' : 'Build experience'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? `Update what's recorded for ${entityName || 'this container'} — a decline is just as valuable a result as growth.`
              : `Write up what happened for ${entityName || 'this container'} — a decline is just as valuable a result as growth.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="initial_state_id">
              Initial state (S) <span className="text-destructive">*</span>
            </Label>
            <Select value={initialStateId} onValueChange={setInitialStateId} disabled={isLoadingStates}>
              <SelectTrigger id="initial_state_id">
                <SelectValue placeholder="Select where this experience started..." />
              </SelectTrigger>
              <SelectContent>
                {sortedStates.map((state) => (
                  <SelectItem key={state.id} value={state.id}>
                    {formatStateDisplay(state)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-center">
            <ArrowRight className="h-6 w-6 text-muted-foreground" />
          </div>

          <div className="space-y-2">
            <Label>Action(s) confirmed for this experience</Label>
            {selectableActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No confirmed actions to attach yet — this experience can still be written up without one.</p>
            ) : (
              <div className="space-y-2 rounded-md border p-3">
                {selectableActions.map((action) => (
                  <label key={action.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={selectedActionIds.includes(action.id)}
                      onCheckedChange={() => toggleAction(action.id)}
                    />
                    <span>
                      <span className="font-medium">{action.title}</span>
                      {action.completed_at && (
                        <span className="text-muted-foreground"> — {format(new Date(action.completed_at), 'MMM d, yyyy')}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-center">
            <ArrowRight className="h-6 w-6 text-muted-foreground" />
          </div>

          <div className="space-y-2">
            <Label>
              Final state (S') <span className="text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              Describe the outcome in your own words. Attach a fresh photo, or one already in this container's history.
            </p>
            <PhotoUploadPanel photos={photos} onPhotosChange={setPhotos} onEagerUpload={handleEagerUpload} showDescriptions />
            <Textarea
              placeholder="What was the result?"
              value={finalStateText}
              onChange={(e) => setFinalStateText(e.target.value)}
              rows={4}
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {isSubmitting ? 'Saving...' : isEditMode ? 'Save changes' : 'Save experience'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
