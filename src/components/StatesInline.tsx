import { useState, useCallback, useEffect, useRef } from 'react';
import { useStates, useStateMutations } from '@/hooks/useStates';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { perspectivesProcessingMap, perspectivesProcessingListeners } from '@/hooks/useCacheInvalidation';
import { useLearningObjectives, useObservationVerification } from '@/hooks/useLearning';
import type { VerificationResponse, LearningObjective } from '@/hooks/useLearning';
import { getImageUrl, getThumbnailUrl, getOriginalUrl } from '@/lib/imageUtils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
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
import { Plus, Edit2, Trash2, Loader2, CheckCircle2, XCircle, Search, Sparkles, Handshake, Link } from 'lucide-react';
import { format } from 'date-fns';
import type { CreateObservationData, Observation } from '@/types/observations';
import { PhotoUploadPanel, type PhotoItem } from '@/components/shared/PhotoUploadPanel';
import { PhotoGalleryDialog } from '@/components/shared/PhotoGalleryDialog';
import { generateObservationUrl, copyToClipboard } from '@/lib/urlUtils';

interface StatesInlineProps {
  entity_type: 'action' | 'part' | 'tool' | 'issue' | 'policy';
  entity_id: string;
  /** The organization_id that owns this entity. When different from the active org, observations are fetched cross-org. */
  source_organization_id?: string;
}

export function StatesInline({ entity_type, entity_id, source_organization_id }: StatesInlineProps) {
  const { toast } = useToast();
  const { uploadFiles } = useFileUpload();
  const { user } = useAuth();
  const { organization } = useOrganization();
  const orgId = organization?.id ?? '';

  const handleEagerUpload = useCallback(async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  }, [uploadFiles]);

  // When entity belongs to a different org, pass view_shared to include cross-org observations
  const isSharedEntity = source_organization_id && source_organization_id !== orgId;
  const viewShared = isSharedEntity ? `${orgId},${source_organization_id}` : undefined;

  // Fetch states for this entity
  const { data: states, isLoading, error } = useStates(orgId, {
    entity_type,
    entity_id,
    ...(viewShared ? { view_shared: viewShared } : {}),
  });

  // Fetch learning objectives when entity is an action
  const { data: learningData } = useLearningObjectives(
    entity_type === 'action' ? entity_id : undefined,
    entity_type === 'action' ? user?.userId : undefined
  );

  // Observation verification mutation
  const verificationMutation = useObservationVerification();

  // Mutations
  const { createState, updateState, deleteState, isCreating, isUpdating, isDeleting } =
    useStateMutations(orgId, { entity_type, entity_id });

  // Live countdown for perspectives:processing WS events
  // Returns remaining seconds for a given stateId, or null if not processing
  const [perspectivesTick, setPerspectivesTick] = useState(0);
  useEffect(() => {
    const listener = () => setPerspectivesTick(t => t + 1);
    perspectivesProcessingListeners.add(listener);
    return () => { perspectivesProcessingListeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (perspectivesProcessingMap.size === 0) return;
    const interval = setInterval(() => setPerspectivesTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [perspectivesTick]);
  const getPerspectivesRemaining = useCallback((stateId: string): number | null => {
    const entry = perspectivesProcessingMap.get(stateId);
    if (!entry) return null;
    const elapsed = (Date.now() - entry.startedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(entry.estimatedSeconds - elapsed));
    return remaining;
  }, [perspectivesTick]);

  // UI state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingStateId, setEditingStateId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');

  // Copy-to-clipboard state for perspectives
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({});
  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMap(prev => ({ ...prev, [key]: true }));
    setTimeout(() => {
      setCopiedMap(prev => ({ ...prev, [key]: false }));
    }, 2000);
  }, []);

  const [linkCopiedMap, setLinkCopiedMap] = useState<Record<string, boolean>>({});
  const [togglingSharedMap, setTogglingSharedMap] = useState<Record<string, boolean>>({});

  const handleCopyLink = useCallback(async (stateId: string) => {
    const url = generateObservationUrl(stateId);
    const success = await copyToClipboard(url);
    if (success) {
      setLinkCopiedMap(prev => ({ ...prev, [stateId]: true }));
      toast({
        title: "Link copied!",
        description: "Observation link has been copied to your clipboard",
      });
      setTimeout(() => {
        setLinkCopiedMap(prev => ({ ...prev, [stateId]: false }));
      }, 2000);
    } else {
      toast({
        title: "Could not copy automatically",
        description: url,
        duration: 10000,
      });
    }
  }, [toast]);

  const handleToggleShared = useCallback(async (observation: Observation) => {
    if (togglingSharedMap[observation.id]) return;
    setTogglingSharedMap(prev => ({ ...prev, [observation.id]: true }));
    const nextShared = !observation.shared_with_partners;
    try {
      await updateState({
        id: observation.id,
        data: {
          shared_with_partners: nextShared
        }
      });
      toast({
        title: nextShared ? "Sharing activated" : "Sharing restricted",
        description: nextShared
          ? "Observation details are now safely shared with trusted partners."
          : "Sharing revoked. Observation details are now private.",
      });
    } catch (error) {
      console.error('Error toggling observation sharing state:', error);
      toast({
        title: "Error",
        description: "Failed to update observation sharing policy.",
        variant: "destructive"
      });
    } finally {
      setTogglingSharedMap(prev => ({ ...prev, [observation.id]: false }));
    }
  }, [updateState, togglingSharedMap, toast]);

  // Form state
  const [stateText, setStateText] = useState('');
  const [photos, setPhotos] = useState<PhotoItem[]>([]);

  // Demonstration checklist state
  const [selectedObjectiveIds, setSelectedObjectiveIds] = useState<Set<string>>(new Set());
  const [verificationResults, setVerificationResults] = useState<VerificationResponse | null>(null);

  // Photo gallery state
  const [galleryPhotos, setGalleryPhotos] = useState<Array<{ photo_url: string; photo_description?: string | null }>>([]);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);

  // Expanded photos state — tracks which observation cards show all photos
  const [expandedPhotoStates, setExpandedPhotoStates] = useState<Set<string>>(new Set());
  const [expandedAiPhotos, setExpandedAiPhotos] = useState<Set<string>>(new Set());

  const toggleExpandedPhotos = (stateId: string) => {
    setExpandedPhotoStates(prev => {
      const next = new Set(prev);
      if (next.has(stateId)) {
        next.delete(stateId);
      } else {
        next.add(stateId);
      }
      return next;
    });
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



  const openGallery = (photos: Array<{ photo_url: string; photo_description?: string | null }>, index: number) => {
    setGalleryPhotos(photos);
    setGalleryIndex(index);
    setGalleryOpen(true);
  };

  // Derive incomplete learning objectives from all axes
  const incompleteObjectives: LearningObjective[] = learningData?.axes
    ?.flatMap(axis => axis.objectives.filter(obj => obj.status !== 'completed'))
    ?? [];

  // Show demonstration checklist only for actions with incomplete objectives (not when editing)
  const showDemonstrationChecklist = entity_type === 'action' && incompleteObjectives.length > 0 && !editingStateId;

  const toggleObjective = (objectiveId: string) => {
    setSelectedObjectiveIds(prev => {
      const next = new Set(prev);
      if (next.has(objectiveId)) {
        next.delete(objectiveId);
      } else {
        next.add(objectiveId);
      }
      return next;
    });
  };

  // States are automatically cached by TanStack Query
  // Components can derive counts using useActionObservationCount hook
  // No need to notify parent components of count changes

  const resetForm = () => {
    // Clean up preview URLs (only for new photos with blob URLs, not existing S3 URLs)
    photos.forEach(p => {
      if (!p.isExisting && p.previewUrl && p.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(p.previewUrl);
      }
    });
    setStateText('');
    setPhotos([]);
    setEditingStateId(null);
    setShowAddForm(false);
    setSelectedObjectiveIds(new Set());
    setVerificationResults(null);
  };

  const handleSubmit = async () => {
    // Validate: require at least one of (text OR photo)
    if (stateText.trim().length === 0 && photos.length === 0) {
      toast({
        title: 'Validation Error',
        description: 'Please add observation text or at least one photo',
        variant: 'destructive'
      });
      return;
    }

    try {
      setUploadingPhotos(true);

      // CRITICAL: Store current photos state to preserve blob URLs during upload
      const photosSnapshot = [...photos];

      // Process photos: upload new ones, keep existing ones
      let uploadedPhotos: Array<{ photo_url: string; photo_description: string; photo_order: number }> = [];

      if (photosSnapshot.length > 0) {
        const newPhotos = photosSnapshot.filter(p => !p.isExisting && p.file && !p.photo_url);
        const readyPhotos = photosSnapshot.filter(p => p.photo_url);

        if (newPhotos.length > 0) {
          setUploadProgress(`Uploading ${newPhotos.length} new photo${newPhotos.length > 1 ? 's' : ''}...`);
        }

        // Upload new photos that haven't been eagerly uploaded yet
        for (let i = 0; i < newPhotos.length; i++) {
          const photo = newPhotos[i];
          if (!photo.file) {
            console.error('New photo missing file object:', photo);
            continue;
          }

          setUploadProgress(`Uploading photo ${i + 1} of ${newPhotos.length}...`);

          try {
            const uploadResults = await uploadFiles([photo.file], { bucket: 'mission-attachments' });
            const resultsArray = Array.isArray(uploadResults) ? uploadResults : [uploadResults];
            const photoUrl = resultsArray[0].url;

            uploadedPhotos.push({
              photo_url: photoUrl,
              photo_description: photo.photo_description || '',
              photo_order: uploadedPhotos.length
            });
          } catch (uploadErr) {
            console.error('Failed to upload photo on save:', photo.file.name, uploadErr);
            // Continue with other photos instead of failing the whole save
          }
        }

        // Add all photos that already have URLs (existing + eagerly uploaded)
        readyPhotos.forEach(photo => {
          uploadedPhotos.push({
            photo_url: photo.photo_url!,
            photo_description: photo.photo_description || '',
            photo_order: uploadedPhotos.length
          });
        });
      }

      setUploadProgress('Saving observation...');

      if (editingStateId) {
        // Update existing observation
        await updateState({
          id: editingStateId,
          data: {
            state_text: stateText.trim() || undefined,
            photos: uploadedPhotos
          }
        });

        toast({
          title: 'Observation updated',
          description: 'Your observation has been updated successfully.'
        });

        // Reset form and clean up preview URLs after update
        photosSnapshot.forEach(p => {
          if (!p.isExisting && p.previewUrl && p.previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(p.previewUrl);
          }
        });
        setStateText('');
        setPhotos([]);
        setShowAddForm(false);
        setEditingStateId(null);
        return;
      } else {
        // Create new observation with uploaded photos
        const data: CreateObservationData = {
          state_text: stateText.trim() || undefined,
          photos: uploadedPhotos,
          links: [{
            entity_type,
            entity_id
          }]
        };

        const savedObservation = await createState(data);

        toast({
          title: 'Observation saved',
          description: 'Your observation has been saved successfully.'
        });

        // Clean up blob preview URLs before resetting form
        photosSnapshot.forEach(p => {
          if (!p.isExisting && p.previewUrl && p.previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(p.previewUrl);
          }
        });

        // Reset form immediately — do NOT block on verification
        setStateText('');
        setPhotos([]);
        setEditingStateId(null);
        setShowAddForm(false);
        setSelectedObjectiveIds(new Set());

        // Trigger verification in the background if objectives were selected
        if (selectedObjectiveIds.size > 0 && savedObservation?.id && user?.userId) {
          // Capture values before form reset clears them
          const objectiveIds = Array.from(selectedObjectiveIds);
          verificationMutation.mutate(
            {
              actionId: entity_id,
              observationId: savedObservation.id,
              selfAssessedObjectiveIds: objectiveIds,
              userId: user.userId,
            },
            {
              onSuccess: (results) => {
                setVerificationResults(results);
                // Re-open the form area to display verification results
                setShowAddForm(true);
              },
              onError: (verifyError) => {
                console.error('Failed to verify observation:', verifyError);
                toast({
                  title: 'Verification unavailable',
                  description: 'Observation saved, but skill verification could not be completed. You can try again later.',
                });
              },
            }
          );
        }

        // Return early — form is already reset above
        return;
      }

    } catch (error) {
      console.error('Failed to save observation:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save observation. Please try again.',
        variant: 'destructive'
      });
    } finally {
      setUploadingPhotos(false);
      setUploadProgress('');
    }
  };

  const handleEdit = (state: Observation) => {
    // Load the observation data for editing
    setEditingStateId(state.id);
    setStateText(state.observation_text || '');

    // Load existing photos into PhotoItem format
    const existingPhotos: PhotoItem[] = (state.photos || []).map((photo, index) => ({
      id: `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      photo_url: photo.photo_url,
      photo_description: photo.photo_description || '',
      photo_order: index,
      previewUrl: photo.photo_url, // Use S3 URL as preview
      isExisting: true,
      isUploading: false,
    }));
    setPhotos(existingPhotos);

    setShowAddForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteState(id);
      toast({
        title: 'Observation deleted',
        description: 'The observation has been deleted successfully.'
      });
      setDeleteConfirmId(null);
    } catch (error) {
      console.error('Failed to delete observation:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete observation. Please try again.',
        variant: 'destructive'
      });
    }
  };

  // Get labels based on entity type
  const textLabel = entity_type === 'action' ? 'Action and Reasoning' : 'Observation Text';
  const textPlaceholder = entity_type === 'action'
    ? 'What did you do, and why?'
    : 'Describe what you observed...';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center p-8 text-destructive">
        <p>Failed to load observations</p>
      </div>
    );
  }

  const renderForm = (isEdit: boolean) => (
    <Card data-edit-form={isEdit ? "true" : undefined} className={`border-2 ${isEdit ? "border-amber-400" : "border-primary"}`}>
          <CardContent className="pt-6 space-y-4">
            {editingStateId && (
              <div className="bg-primary/10 p-3 rounded-md mb-4">
                <p className="text-sm font-medium">✏️ Editing observation</p>
                <p className="text-xs text-muted-foreground mt-1">You can edit text, remove photos, edit descriptions, or add new photos.</p>
              </div>
            )}

            <div>
              <Label>Photos</Label>
              <PhotoUploadPanel
                photos={photos}
                onPhotosChange={setPhotos}
                onEagerUpload={handleEagerUpload}
                showDescriptions={true}
                disabled={isCreating || isUpdating}
              />
            </div>

            <div>
              <Label htmlFor="state-text">{textLabel}</Label>
              <Textarea
                id="state-text"
                placeholder={textPlaceholder}
                value={stateText}
                onChange={(e) => setStateText(e.target.value)}
                rows={3}
              />
            </div>

            {/* Demonstration Checklist — shown below observation form for actions with incomplete objectives */}
            {showDemonstrationChecklist && showAddForm && !verificationResults && (
              <div className="border rounded-lg p-4 bg-muted/30">
                <Label className="text-sm font-medium">Demonstrate Skills</Label>
                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  Check off objectives this observation demonstrates
                </p>
                <div className="space-y-2">
                  {incompleteObjectives.map((objective) => (
                    <label
                      key={objective.id}
                      className="flex items-start gap-2 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedObjectiveIds.has(objective.id)}
                        onCheckedChange={() => toggleObjective(objective.id)}
                        disabled={isCreating || uploadingPhotos}
                        className="mt-0.5"
                      />
                      <span className="text-sm leading-tight">{objective.text}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Verification Results */}
            {verificationResults && (
              <Card className="border-2 border-muted">
                <CardContent className="pt-4 space-y-3">
                  <Label className="text-sm font-medium">Verification Results</Label>

                  {verificationResults.confirmed.length > 0 && (
                    <div className="space-y-1">
                      {verificationResults.confirmed.map((id) => {
                        const obj = incompleteObjectives.find(o => o.id === id);
                        return (
                          <div key={id} className="flex items-start gap-2">
                            <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                            <span className="text-sm">{obj?.text ?? id}</span>
                            <Badge className="bg-green-100 text-green-800 border-green-200 ml-auto shrink-0">Confirmed ✓</Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {verificationResults.unconfirmed.length > 0 && (
                    <div className="space-y-1">
                      {verificationResults.unconfirmed.map((id) => {
                        const obj = incompleteObjectives.find(o => o.id === id);
                        return (
                          <div key={id} className="flex items-start gap-2">
                            <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                            <span className="text-sm">{obj?.text ?? id}</span>
                            <Badge variant="destructive" className="ml-auto shrink-0">Unconfirmed ✗</Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {verificationResults.aiDetected.length > 0 && (
                    <div className="space-y-1">
                      {verificationResults.aiDetected.map((id) => {
                        const obj = learningData?.axes
                          ?.flatMap(a => a.objectives)
                          .find(o => o.id === id);
                        return (
                          <div key={id} className="flex items-start gap-2">
                            <Search className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                            <span className="text-sm">{obj?.text ?? id}</span>
                            <Badge className="bg-blue-100 text-blue-800 border-blue-200 ml-auto shrink-0">AI-detected 🔍</Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetForm}
                    className="w-full mt-2"
                  >
                    Done
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Form buttons — hidden when showing verification results */}
            {!verificationResults && (
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={resetForm}
                  disabled={isCreating || isUpdating || uploadingPhotos}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={isCreating || isUpdating || uploadingPhotos || verificationMutation.isPending || (stateText.trim().length === 0 && photos.length === 0)}
                >
                  {uploadingPhotos ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {uploadProgress}
                    </>
                  ) : verificationMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Verifying skills...
                    </>
                  ) : isCreating || isUpdating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {editingStateId ? 'Updating...' : 'Saving...'}
                    </>
                  ) : (
                    editingStateId ? 'Update Observation' : 'Save Observation'
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
  );

  return (
    <div className="space-y-4">
      {/* Add Form */}
      {showAddForm && !editingStateId ? (
        renderForm(false)
      ) : !editingStateId ? (
        <Button
          variant="outline"
          onClick={() => setShowAddForm(true)}
          className="w-full"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Observation
        </Button>
      ) : null}

      {/* States List */}
      {/* Non-blocking verification indicator — shown while background verification is in progress */}
      {verificationMutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>Verifying skill demonstration in the background…</span>
        </div>
      )}

      {/* States List */}
      {states && states.length > 0 ? (
        <div className="space-y-3">
          {states.map((state) => state.id === editingStateId ? (
            <div key={state.id}>{renderForm(true)}</div>
          ) : (
            <Card key={state.id}>
              <CardContent className="pt-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <span>{state.captured_by_name || 'Unknown'} • {format(new Date(state.captured_at), 'MMM d, yyyy h:mm a')}</span>
                    {entity_type !== 'action' && state.shared_with_partners && (
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900/50 py-0 px-1.5 text-[10px]">
                        Shared
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopyLink(state.id)}
                      className={`h-7 w-7 p-0 ${linkCopiedMap[state.id] ? 'border-green-500 border-2' : ''}`}
                      title="Copy observation link"
                    >
                      {linkCopiedMap[state.id] ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <Link className="h-4 w-4" />
                      )}
                    </Button>

                    {entity_type !== 'action' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleToggleShared(state)}
                        disabled={togglingSharedMap[state.id]}
                        className={`h-7 w-7 p-0 transition-colors duration-200 ${state.shared_with_partners
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900/50'
                            : 'hover:text-emerald-600 hover:bg-emerald-50'
                          }`}
                        title={state.shared_with_partners ? "Stop sharing with trusted partners" : "Share with trusted partners"}
                      >
                        {togglingSharedMap[state.id] ? (
                          <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        ) : (
                          <Handshake className="h-4 w-4" />
                        )}
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(state)}
                      disabled={isDeleting}
                      title="Edit observation"
                      className="h-7 w-7 p-0"
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteConfirmId(state.id)}
                      disabled={isDeleting}
                      title="Delete observation"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Content: Photo on left, text on right */}
                <div className="flex gap-3">
                  {/* Photos — compact (first only) or expanded (all) */}
                  {state.photos && state.photos.length > 0 && !expandedPhotoStates.has(state.id) && (
                    <div className="flex-shrink-0 w-1/3 relative group/img-container">
                      <img
                        src={getThumbnailUrl(state.photos[0].photo_url) || ''}
                        alt={state.photos[0].photo_description || 'Photo'}
                        className="w-full aspect-square object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={() => state.photos.length > 1 ? toggleExpandedPhotos(state.id) : openGallery(state.photos, 0)}
                        title={state.photos.length > 1 ? 'Tap to see all photos' : 'Tap to view full size'}
                        onError={(e) => {
                          const originalUrl = getImageUrl(state.photos[0].photo_url);
                          if (e.currentTarget.src !== originalUrl && originalUrl) {
                            e.currentTarget.src = originalUrl;
                          } else {
                            e.currentTarget.style.display = 'none';
                          }
                        }}
                      />
                      {/* AI Description badge moved to inline accordion */}
                      {state.photos.length > 1 && (
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline text-center mt-1 w-full"
                          onClick={() => toggleExpandedPhotos(state.id)}
                        >
                          +{state.photos.length - 1} more
                        </button>
                      )}
                    </div>
                  )}

                  {/* Text content */}
                  <div className="flex-1 min-w-0">
                    {state.observation_text ? (
                      <p className="text-sm whitespace-pre-wrap">
                        {state.observation_text.replace(/<[^>]*>/g, '').trim()}
                      </p>
                    ) : state.photos?.find((p: any) => p.photo_description?.trim())?.photo_description ? (
                      <p className="text-sm whitespace-pre-wrap italic text-muted-foreground">
                        {state.photos.find((p: any) => p.photo_description?.trim())!.photo_description}
                      </p>
                    ) : null}

                    {/* Unified photo descriptions block — hidden when expanded photo view is active */}
                    {state.photos && state.photos.length > 0 && !expandedPhotoStates.has(state.id) && (
                      <div className="mt-2 space-y-1.5 border-t border-muted/30 pt-2">
                        {state.photos.map((photo, idx) => {
                          const hasHuman = !!photo.photo_description?.trim();
                          const hasAi = !!photo.transcription?.trim();
                          if (!hasHuman && !hasAi) return null;
                          return (
                            <div key={photo.id || idx} className="text-xs text-muted-foreground">
                              <div className="flex flex-wrap items-center gap-y-1">
                                <span className="font-medium mr-1">📷 {state.photos.length > 1 ? `${idx + 1}. ` : ''}</span>
                                {hasHuman && (
                                  <span className="text-foreground">{photo.photo_description}</span>
                                )}
                              </div>
                              {hasAi && (
                                <div className="flex flex-col mt-1 pl-0.5">
                                  <div className="flex items-center">
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => toggleExpandedAi(photo.id)}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpandedAi(photo.id); }}
                                      className="relative group cursor-pointer inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-muted/50 text-muted-foreground/60 border border-muted-foreground/10 hover:bg-muted dark:bg-zinc-800/35 dark:text-zinc-400 dark:border-zinc-700/30 dark:hover:bg-zinc-800/60 transition-all select-none mr-1.5 flex-shrink-0"
                                    >
                                      <span>AI Description</span>
                                      <span className={`absolute ${idx % 2 === 0 ? 'left-0' : 'right-0'} bottom-full mb-2 w-[280px] xs:w-[340px] sm:w-[420px] p-3 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-2xl hidden group-hover:block z-30 normal-case not-italic text-xs text-zinc-700 dark:text-zinc-350 leading-normal text-left`} onClick={(e) => e.stopPropagation()}>
                                        <div className="flex items-center justify-between mb-2 border-b border-zinc-100 dark:border-zinc-800 pb-1">
                                          <span className="font-semibold text-zinc-900 dark:text-white">AI Description</span>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              const rawText = photo.transcription?.replace(/^\[photo_analysis\]\s*/, '') || '';
                                              handleCopy(rawText, `${photo.id}-AI`);
                                            }}
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-950/40 transition-all cursor-pointer select-none border border-transparent"
                                          >
                                            {copiedMap[`${photo.id}-AI`] ? (
                                              <>
                                                <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                                <span className="text-green-500 font-bold">Copied!</span>
                                              </>
                                            ) : (
                                              <>
                                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" strokeWidth="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" strokeWidth="2"/></svg>
                                                <span>Copy</span>
                                              </>
                                            )}
                                          </button>
                                        </div>
                                        <span className="block bg-indigo-50/30 dark:bg-indigo-950/15 p-2 rounded text-zinc-850 dark:text-zinc-250 leading-relaxed text-xs border border-indigo-100/50 dark:border-indigo-900/20 text-left font-normal mb-2">
                                          {photo.transcription?.replace(/^\[photo_analysis\]\s*/, '')}
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
                                              <span className="block bg-zinc-50 dark:bg-zinc-950 p-2 rounded italic text-[10px] leading-relaxed border border-zinc-150 dark:border-zinc-850 max-h-[140px] overflow-y-auto whitespace-pre-line text-zinc-650 dark:text-zinc-350">
                                                {(photo as any).system_prompt || 'No active prompt registered.'}
                                              </span>
                                            </div>
                                          </div>
                                        </details>
                                      </span>
                                    </div>
                                  </div>
                                  {expandedAiPhotos.has(photo.id) && (
                                    <p className="italic text-muted-foreground/65 dark:text-muted-foreground/50 font-normal text-xs leading-relaxed mt-1">
                                      {photo.transcription?.replace(/^\[photo_analysis\]\s*/, '')}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    
                    {/* Perspectives Badge */}
                    {(() => {
                      const wsRemaining = getPerspectivesRemaining(state.id);
                      const isPending = state.perspectives && state.perspectives.length > 0 && state.perspectives[0].status === 'PENDING';

                      if (wsRemaining !== null) {
                        // WS-driven: worker has started, show live countdown
                        return (
                          <div className="mt-2 flex items-center">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-zinc-100/60 text-zinc-400 border border-zinc-200/50 dark:bg-zinc-800/30 dark:text-zinc-500 dark:border-zinc-700/30 select-none">
                              <svg className="animate-spin h-2.5 w-2.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                              {wsRemaining > 0 ? `~${wsRemaining}s remaining` : 'Finishing…'}
                            </span>
                          </div>
                        );
                      }

                      if (isPending) {
                        // Optimistic: mutation fired but worker hasn't started yet
                        return (
                          <div className="mt-2 flex items-center">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-zinc-100/60 text-zinc-400 border border-zinc-200/50 dark:bg-zinc-800/30 dark:text-zinc-500 dark:border-zinc-700/30 select-none">
                              <svg className="animate-spin h-2.5 w-2.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                              Generating perspectives…
                            </span>
                          </div>
                        );
                      }

                      if (state.perspectives && state.perspectives.length > 0 && state.perspectives.some(p => p.content)) {
                        return (
                          <div className="mt-2 flex items-center">
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  className="relative cursor-pointer inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-indigo-50/50 text-indigo-600/70 border border-indigo-200/50 hover:bg-indigo-100/50 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-800/30 dark:hover:bg-indigo-900/40 transition-all select-none flex-shrink-0"
                                >
                                  <span>Perspectives</span>
                                </button>
                              </PopoverTrigger>
                              <PopoverContent 
                                className="p-3 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-2xl z-50 text-left"
                                style={{ width: '400px', maxWidth: '90vw' }}
                              >
                                <div className="flex items-center justify-between mb-2 border-b border-zinc-100 dark:border-zinc-800 pb-1">
                                  <span className="font-semibold text-zinc-900 dark:text-white text-xs">Perspectives</span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const allText = ['CLAIM', 'SIGNIFICANCE', 'ENTROPY']
                                        .map(type => {
                                          const p = state.perspectives!.find(x => x.perspective_type === type);
                                          return p && p.content ? `${type}:\n${p.content}` : '';
                                        })
                                        .filter(Boolean)
                                        .join('\n\n');
                                      handleCopy(allText, `${state.id}-ALL`);
                                    }}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-950/40 transition-all cursor-pointer select-none border border-transparent"
                                  >
                                    {copiedMap[`${state.id}-ALL`] ? (
                                      <>
                                        <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                        <span className="text-green-500 font-bold">All Copied!</span>
                                      </>
                                    ) : (
                                      <>
                                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" strokeWidth="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" strokeWidth="2"/></svg>
                                        <span>Copy All</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                                <div className="space-y-2.5">
                                  {['CLAIM', 'SIGNIFICANCE', 'ENTROPY'].map(type => {
                                    const perspective = state.perspectives!.find(p => p.perspective_type === type);
                                    if (!perspective || !perspective.content) return null;
                                    const copyKey = `${state.id}-${type}`;
                                    const isCopied = !!copiedMap[copyKey];
                                    return (
                                      <div key={type}>
                                        <div className="flex items-center justify-between mb-0.5">
                                          <span className="block text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">{type}</span>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleCopy(perspective.content, copyKey);
                                            }}
                                            className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-[9px] font-medium text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all cursor-pointer select-none border border-transparent"
                                          >
                                            {isCopied ? (
                                              <>
                                                <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                                <span className="text-green-500 font-semibold">Copied!</span>
                                              </>
                                            ) : (
                                              <>
                                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" strokeWidth="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" strokeWidth="2"/></svg>
                                                <span>Copy</span>
                                              </>
                                            )}
                                          </button>
                                        </div>
                                        <span className="block bg-indigo-50/30 dark:bg-indigo-950/15 p-2 rounded text-zinc-850 dark:text-zinc-250 leading-relaxed text-xs border border-indigo-100/50 dark:border-indigo-900/20 text-left font-normal">
                                          {perspective.content}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        );
                      }

                      return null;
                    })()}

                  </div>
                </div>

                {/* Expanded photo list — edit-view style, thumbnails clickable for high-res */}
                {expandedPhotoStates.has(state.id) && state.photos && state.photos.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {state.photos.map((photo, idx) => (
                      <div key={photo.id} className="flex gap-2 items-stretch border rounded p-2">
                        <div className="flex-shrink-0 w-24 relative group/img-container">
                          <img
                            src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                            alt={photo.photo_description || `Photo ${idx + 1}`}
                            className="w-full aspect-square object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={() => openGallery(state.photos, idx)}
                            onError={(e) => {
                              const fullUrl = getImageUrl(photo.photo_url);
                              if (fullUrl && e.currentTarget.src !== fullUrl) {
                                e.currentTarget.src = fullUrl;
                              } else {
                                e.currentTarget.style.display = 'none';
                              }
                            }}
                          />
                          {/* AI badge removed in favor of inline accordion */}
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                          {photo.photo_description?.trim() && (
                            <div className="text-sm text-foreground">
                              <span>{photo.photo_description}</span>
                            </div>
                          )}
                          {photo.transcription?.trim() ? (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center">
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => toggleExpandedAi(photo.id)}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpandedAi(photo.id); }}
                                  className="relative group cursor-pointer inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-muted/50 text-muted-foreground/60 border border-muted-foreground/10 hover:bg-muted dark:bg-zinc-800/35 dark:text-zinc-400 dark:border-zinc-700/30 dark:hover:bg-zinc-800/60 transition-all select-none mr-1.5 flex-shrink-0"
                                >
                                  <span>AI Description</span>
                                  <span className={`absolute ${idx % 2 === 0 ? 'left-0' : 'right-0'} bottom-full mb-2 w-[280px] xs:w-[340px] sm:w-[420px] p-3 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-2xl hidden group-hover:block z-30 normal-case not-italic text-xs text-zinc-700 dark:text-zinc-350 leading-normal text-left`} onClick={(e) => e.stopPropagation()}>
                                    <div className="flex items-center justify-between mb-2 border-b border-zinc-100 dark:border-zinc-800 pb-1">
                                      <span className="font-semibold text-zinc-900 dark:text-white">AI Description</span>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          const rawText = photo.transcription?.replace(/^\[photo_analysis\]\s*/, '') || '';
                                          handleCopy(rawText, `${photo.id}-AI`);
                                        }}
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-950/40 transition-all cursor-pointer select-none border border-transparent"
                                      >
                                        {copiedMap[`${photo.id}-AI`] ? (
                                          <>
                                            <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                            <span className="text-green-500 font-bold">Copied!</span>
                                          </>
                                        ) : (
                                          <>
                                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" strokeWidth="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" strokeWidth="2"/></svg>
                                            <span>Copy</span>
                                          </>
                                        )}
                                      </button>
                                    </div>
                                    <span className="block bg-indigo-50/30 dark:bg-indigo-950/15 p-2 rounded text-zinc-850 dark:text-zinc-250 leading-relaxed text-xs border border-indigo-100/50 dark:border-indigo-900/20 text-left font-normal mb-2">
                                      {photo.transcription?.replace(/^\[photo_analysis\]\s*/, '')}
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
                                </div>
                              </div>
                              {expandedAiPhotos.has(photo.id) && (
                                <span className="italic text-muted-foreground/65 dark:text-muted-foreground/50 font-normal text-xs leading-relaxed">
                                  {photo.transcription?.replace(/^\[photo_analysis\]\s*/, '')}
                                </span>
                              )}
                            </div>
                          ) : !photo.photo_description?.trim() && (
                            <p className="text-xs text-muted-foreground italic">No description</p>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline w-full text-center"
                      onClick={() => toggleExpandedPhotos(state.id)}
                    >
                      Show less
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        !showAddForm && (
          <div className="text-center p-8 text-muted-foreground">
            <p>No observations yet</p>
          </div>
        )
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Observation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this observation? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Photo Gallery Dialog */}
      <PhotoGalleryDialog
        photos={galleryPhotos}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
      />
    </div>
  );
}
