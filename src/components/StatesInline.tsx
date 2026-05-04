import { useState, useCallback } from 'react';
import { useStates, useStateMutations } from '@/hooks/useStates';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useLearningObjectives, useObservationVerification } from '@/hooks/useLearning';
import type { VerificationResponse, LearningObjective } from '@/hooks/useLearning';
import { getImageUrl, getThumbnailUrl, getOriginalUrl } from '@/lib/imageUtils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
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
import { Plus, Edit2, Trash2, Loader2, CheckCircle2, XCircle, Search } from 'lucide-react';
import { format } from 'date-fns';
import type { CreateObservationData, Observation } from '@/types/observations';
import { PhotoUploadPanel, type PhotoItem } from '@/components/shared/PhotoUploadPanel';
import { PhotoGalleryDialog } from '@/components/shared/PhotoGalleryDialog';

interface StatesInlineProps {
  entity_type: 'action' | 'part' | 'tool' | 'issue' | 'policy';
  entity_id: string;
}

export function StatesInline({ entity_type, entity_id }: StatesInlineProps) {
  const { toast } = useToast();
  const { uploadFiles } = useFileUpload();
  const { user } = useAuth();
  
  const handleEagerUpload = useCallback(async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  }, [uploadFiles]);
  
  // Fetch states for this entity
  const { data: states, isLoading, error } = useStates({ entity_type, entity_id });
  
  // Fetch learning objectives when entity is an action
  const { data: learningData } = useLearningObjectives(
    entity_type === 'action' ? entity_id : undefined,
    entity_type === 'action' ? user?.userId : undefined
  );
  
  // Observation verification mutation
  const verificationMutation = useObservationVerification();
  
  // Mutations
  const { createState, updateState, deleteState, isCreating, isUpdating, isDeleting } = 
    useStateMutations({ entity_type, entity_id });
  
  // UI state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingStateId, setEditingStateId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  
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
    
    // Scroll to the form after React has re-rendered
    setTimeout(() => {
      const formElement = document.querySelector('[data-edit-form]');
      if (formElement) {
        formElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        console.warn('[StatesInline] Form element not found in DOM');
      }
    }, 300);
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

  return (
    <div className="space-y-4">
      {/* Add/Edit Form */}
      {showAddForm ? (
        <Card data-edit-form className="border-2 border-primary">
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
      ) : (
        <Button
          variant="outline"
          onClick={() => setShowAddForm(true)}
          className="w-full"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Observation
        </Button>
      )}

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
          {states.map((state) => (
            <Card key={state.id}>
              <CardContent className="pt-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="text-sm text-muted-foreground">
                    {state.captured_by_name || 'Unknown'} • {format(new Date(state.captured_at), 'MMM d, yyyy h:mm a')}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(state)}
                      disabled={isDeleting}
                      title="Edit observation"
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteConfirmId(state.id)}
                      disabled={isDeleting}
                      title="Delete observation"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Content: Photo on left, text on right */}
                <div className="flex gap-3">
                  {/* Photos — compact (first only) or expanded (all) */}
                  {state.photos && state.photos.length > 0 && !expandedPhotoStates.has(state.id) && (
                    <div className="flex-shrink-0 w-1/3">
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
                    {state.observation_text && (
                      <p className="text-sm whitespace-pre-wrap">
                        {state.observation_text.replace(/<[^>]*>/g, '').trim()}
                      </p>
                    )}
                    
                    {/* Photo descriptions (compact view only — expanded view shows them inline) */}
                    {!expandedPhotoStates.has(state.id) && state.photos && state.photos.some(p => p.photo_description) && (
                      <div className="mt-2 space-y-1">
                        {state.photos.map((photo, idx) => 
                          photo.photo_description ? (
                            <p key={photo.id} className="text-xs text-muted-foreground">
                              📷 {state.photos.length > 1 ? `${idx + 1}. ` : ''}{photo.photo_description}
                            </p>
                          ) : null
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Expanded photo list — edit-view style, thumbnails clickable for high-res */}
                {expandedPhotoStates.has(state.id) && state.photos && state.photos.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {state.photos.map((photo, idx) => (
                      <div key={photo.id} className="flex gap-2 items-stretch border rounded p-2">
                        <div className="flex-shrink-0 w-24 relative">
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
                        </div>
                        <div className="flex-1 min-w-0 flex items-center">
                          {photo.photo_description ? (
                            <p className="text-sm text-muted-foreground">{photo.photo_description}</p>
                          ) : (
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
