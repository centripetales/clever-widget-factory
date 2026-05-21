import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useStateMutations, useStateById } from '@/hooks/useStates';
import { useToast } from '@/components/ui/use-toast';
import type { CreateObservationData } from '@/types/observations';
import { MetricsInput } from '@/components/observations/MetricsInput';
import { useMetrics } from '@/hooks/metrics/useMetrics';
import { useSnapshots } from '@/hooks/useSnapshots';
import { snapshotService } from '@/services/snapshotService';
import { PhotoUploadPanel, type PhotoItem } from '@/components/shared/PhotoUploadPanel';

export default function AddObservation() {
  const { assetType, id, observationId } = useParams<{ 
    assetType?: string; 
    id?: string; 
    observationId?: string;
  }>();
  const navigate = useNavigate();
  const { uploadFiles, isUploading } = useFileUpload();
  const { createState, updateState, isCreating, isUpdating } = useStateMutations();

  const handleEagerUpload = useCallback(async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  }, [uploadFiles]);
  const { toast } = useToast();

  // Determine if we're in edit mode based on observationId presence
  const isEditMode = !!observationId;

  // Fetch existing state when in edit mode
  const { data: existingState, isLoading: isLoadingState } = useStateById(observationId || '');

  // Fetch existing snapshots when editing
  const { data: existingSnapshots } = useSnapshots(isEditMode ? observationId : undefined);

  // Determine toolId for metrics
  const toolId = isEditMode && existingState?.links?.[0]?.entity_type === 'tool' 
    ? existingState.links[0].entity_id 
    : (assetType === 'tools' ? id : null);
  const { data: metrics } = useMetrics(toolId || '');
  const hasMetrics = metrics && metrics.length > 0;

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [observationText, setObservationText] = useState('');
  // Format current local time for datetime-local input (YYYY-MM-DDTHH:MM)
  // Must use local time components — toISOString() returns UTC which causes timezone offset bugs
  const [capturedAt, setCapturedAt] = useState<string>(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  });
  const [metricValues, setMetricValues] = useState<Record<string, string>>({});

  // Pre-populate form fields when editing an existing state
  useEffect(() => {
    if (existingState && isEditMode) {
      setObservationText(existingState.observation_text || '');
      
      // Set captured_at from existing state (convert ISO string to datetime-local format)
      if (existingState.captured_at) {
        setCapturedAt(new Date(existingState.captured_at).toISOString().slice(0, 16));
      }
      
      // Map existing photos to PhotoItem format
      if (existingState.photos && existingState.photos.length > 0) {
        const mappedPhotos: PhotoItem[] = existingState.photos.map((photo) => ({
          id: `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          photo_url: photo.photo_url,
          photo_description: photo.photo_description || '',
          photo_order: photo.photo_order,
          previewUrl: photo.photo_url,
          isUploading: false,
          isExisting: true,
        }));
        setPhotos(mappedPhotos);
      }
    }
  }, [existingState, isEditMode]);

  // Pre-populate metric values when editing
  useEffect(() => {
    if (existingSnapshots && isEditMode) {
      const values: Record<string, string> = {};
      existingSnapshots.forEach(snapshot => {
        values[snapshot.metric_id] = snapshot.value;
      });
      setMetricValues(values);
    }
  }, [existingSnapshots, isEditMode]);

  const handleSubmit = async () => {
    // Validate that at least one of observationText, photos, or metrics is provided
    const hasText = observationText.trim().length > 0;
    const hasPhotos = photos.some(p => (p.photo_url || p.file) && !p.isUploading);
    const hasMetrics = Object.values(metricValues).some(value => value.trim().length > 0);
    
    if (!hasText && !hasPhotos && !hasMetrics) {
      toast({
        title: 'Validation Error',
        description: 'Please add observation text, at least one photo, or at least one metric value',
        variant: 'destructive'
      });
      return;
    }

    // Convert datetime-local value to UTC ISO string
    let capturedAtUTC: string;
    if (capturedAt) {
      const localDate = new Date(capturedAt);
      capturedAtUTC = localDate.toISOString();
    } else {
      capturedAtUTC = new Date().toISOString();
    }

    try {
      // Upload any photos that haven't been eagerly uploaded yet
      const pendingPhotos = photos.filter(p => p.file && !p.photo_url);
      let uploadedUrls: Map<string, string> = new Map();

      if (pendingPhotos.length > 0) {
        setPhotos(prev => prev.map(p => 
          p.file && !p.photo_url ? { ...p, isUploading: true } : p
        ));

        // Upload pending photos one at a time to avoid mobile memory issues
        for (const photo of pendingPhotos) {
          try {
            const result = await uploadFiles(photo.file!, { bucket: 'mission-attachments' });
            const r = Array.isArray(result) ? result[0] : result;
            uploadedUrls.set(photo.id!, r.url);
          } catch (err) {
            console.error('Failed to upload pending photo:', photo.file?.name, err);
            // Continue with other photos
          }
        }

        setPhotos(prev => prev.map(p => {
          const url = p.id ? uploadedUrls.get(p.id) : undefined;
          if (url) {
            return { ...p, photo_url: url, isUploading: false };
          }
          return p;
        }));
      }

      // Build final photo list: include all photos with URLs (existing + eagerly uploaded + just uploaded)
      const finalPhotos = photos
        .map((photo) => ({
          photo_url: photo.photo_url || (photo.id ? uploadedUrls.get(photo.id) : undefined) || '',
          photo_description: photo.photo_description || '',
          photo_order: 0
        }))
        .filter(p => p.photo_url)
        .map((p, index) => ({ ...p, photo_order: index }));

      const data: CreateObservationData = {
        state_text: hasText ? observationText : undefined,
        captured_at: capturedAtUTC,
        photos: finalPhotos,
        links: isEditMode ? existingState?.links : [{
          entity_type: assetType === 'tools' ? 'tool' : 'part',
          entity_id: id!
        }]
      };

      let stateId: string;
      let warnings: string[] | undefined;
      
      if (isEditMode) {
        const result = await updateState({ id: observationId!, data });
        stateId = observationId!;
        warnings = (result as any)?.warnings;
      } else {
        const result = await createState(data);
        stateId = result.id;
        warnings = (result as any)?.warnings;
      }

      if (warnings && warnings.length > 0) {
        toast({
          title: "Photo Transcription Failed",
          description: warnings.join('. ') + " bubbled for operator review.",
          variant: "destructive"
        });
      }

      // Save metric snapshots if there are any values
      const isToolObservation = isEditMode 
        ? existingState?.links?.[0]?.entity_type === 'tool'
        : assetType === 'tools';
      
      if (isToolObservation && hasMetrics && Object.keys(metricValues).length > 0) {
        try {
          const existingSnapshotsMap = new Map(
            (existingSnapshots || []).map(s => [s.metric_id, s])
          );

          for (const [metricId, value] of Object.entries(metricValues)) {
            const existingSnapshot = existingSnapshotsMap.get(metricId);
            
            if (value.trim()) {
              if (existingSnapshot) {
                await snapshotService.updateSnapshot(existingSnapshot.snapshot_id, { value });
              } else {
                await snapshotService.createSnapshot(stateId, {
                  metric_id: metricId,
                  value
                });
              }
            }
          }

          for (const [metricId, snapshot] of existingSnapshotsMap.entries()) {
            if (!metricValues[metricId] || !metricValues[metricId].trim()) {
              await snapshotService.deleteSnapshot(snapshot.snapshot_id);
            }
          }
        } catch (snapshotError) {
          console.error('Failed to save metric snapshots:', snapshotError);
          toast({
            title: 'Warning',
            description: 'Observation saved but some metrics failed to save. Please try editing the observation to update metrics.',
            variant: 'destructive'
          });
        }
      }

      toast({
        title: isEditMode ? 'Observation updated' : 'Observation saved',
        description: isEditMode ? 'Your changes have been saved successfully.' : 'Your observation has been saved successfully.'
      });
      
      if (isEditMode) {
        navigate(-1);
      } else {
        navigate('/combined-assets');
      }
    } catch (error) {
      console.error(`Failed to ${isEditMode ? 'update' : 'create'} observation:`, error);
      // Reset uploading state on error
      setPhotos(prev => prev.map(p => ({ ...p, isUploading: false })));
      const errorDetail = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Error',
        description: `Failed to ${isEditMode ? 'update' : 'save'} observation: ${errorDetail}`,
        variant: 'destructive'
      });
    }
  };

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/combined-assets')}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">{isEditMode ? 'Edit Observation' : 'Add Observation'}</h1>
      </div>

      {/* Show loading state while fetching existing state in edit mode */}
      {isEditMode && isLoadingState ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-muted-foreground">Loading observation...</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Upload Photos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PhotoUploadPanel
              photos={photos}
              onPhotosChange={setPhotos}
              onEagerUpload={handleEagerUpload}
              showDescriptions={true}
              disabled={isCreating || isUpdating}
            />
            <Textarea
              id="observation-text"
              placeholder="Details not captured elsewhere..."
              value={observationText}
              onChange={(e) => setObservationText(e.target.value)}
              rows={4}
            />
          </CardContent>
        </Card>
      )}

      {/* Metrics Section - only show for tools that have metrics defined */}
      {(!isEditMode || !isLoadingState) && toolId && hasMetrics ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricsInput
              toolId={toolId}
              values={metricValues}
              onChange={setMetricValues}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* Captured At Section */}
      {!isEditMode || !isLoadingState ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Label htmlFor="captured-at" className="min-w-[100px]">Captured At</Label>
              <Input
                id="captured-at"
                type="datetime-local"
                value={capturedAt}
                onChange={(e) => setCapturedAt(e.target.value)}
                className="flex-1"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Action Buttons */}
      {!isEditMode || !isLoadingState ? (
        <div className="flex gap-2 justify-end mt-4">
          <Button
            variant="outline"
            onClick={() => navigate('/combined-assets')}
            disabled={isCreating || isUpdating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              isCreating || 
              isUpdating || 
              isUploading ||
              (
                observationText.trim().length === 0 && 
                photos.filter(p => (p.photo_url || p.file) && !p.isUploading).length === 0 &&
                Object.values(metricValues).every(value => !value || value.trim().length === 0)
              )
            }
          >
            {isCreating || isUpdating ? 'Saving...' : isEditMode ? 'Update Observation' : 'Save Observation'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
