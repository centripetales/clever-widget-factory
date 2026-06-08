import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Loader2, Search, X, Wrench, Package, Info, Trash2, Play, Bot } from 'lucide-react';
import { useFileUpload } from '@/hooks/useFileUpload';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { useStateMutations, useStateById } from '@/hooks/useStates';
import { useToast } from '@/components/ui/use-toast';
import type { CreateObservationData } from '@/types/observations';
import { MetricsInput } from '@/components/observations/MetricsInput';
import { useMetrics } from '@/hooks/metrics/useMetrics';
import { useSnapshots } from '@/hooks/useSnapshots';
import { snapshotService } from '@/services/snapshotService';
import { PhotoUploadPanel, type PhotoItem } from '@/components/shared/PhotoUploadPanel';
import { apiService } from '@/lib/apiService';

export default function AddObservation() {
  const { assetType, id, observationId } = useParams<{ 
    assetType?: string; 
    id?: string; 
    observationId?: string;
  }>();
  const navigate = useNavigate();
  const { uploadFiles, isUploading } = useFileUpload();
  const { createState, updateState, isCreating, isUpdating } = useStateMutations();
  const { toast } = useToast();

  const handleBack = useCallback(() => {
    const hasHistory = window.history.state && window.history.state.idx > 0;
    if (hasHistory) {
      navigate(-1);
    } else if (assetType && id) {
      navigate('/combined-assets');
    } else {
      navigate('/observations');
    }
  }, [navigate, assetType, id]);

  const handleEagerUpload = useCallback(async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  }, [uploadFiles]);

  const handlePhotoAnalyzed = useCallback(async (index: number, description: string, extractedGuids: string[]) => {
    if (extractedGuids && extractedGuids.length > 0) {
      const guid = extractedGuids[0];
      try {
        const [toolsRes, partsRes] = await Promise.all([
          apiService.get('/tools?limit=2000'),
          apiService.get('/parts?limit=2000')
        ]);
        const tools = toolsRes.data || toolsRes || [];
        const parts = partsRes.data || partsRes || [];

        const matchedTool = tools.find((t: any) => t.serial_number === guid || t.id === guid);
        if (matchedTool) {
          setLinkedAsset({
            id: matchedTool.id,
            name: matchedTool.name,
            serial_number: matchedTool.serial_number,
            type: 'tool'
          });
          toast({
            title: 'AI Asset Linked',
            description: `Successfully matched and linked Tool: ${matchedTool.name}`,
          });
          return;
        }

        const matchedPart = parts.find((p: any) => p.serial_number === guid || p.id === guid);
        if (matchedPart) {
          setLinkedAsset({
            id: matchedPart.id,
            name: matchedPart.name,
            serial_number: matchedPart.serial_number,
            type: 'part'
          });
          toast({
            title: 'AI Asset Linked',
            description: `Successfully matched and linked Part/Livestock: ${matchedPart.name}`,
          });
          return;
        }
      } catch (err) {
        console.error('Failed to resolve AI extracted asset:', err);
      }
    }
  }, [toast]);

  // Determine if we're in edit mode based on observationId presence
  const isEditMode = !!observationId;

  // Fetch existing state when in edit mode
  const { data: existingState, isLoading: isLoadingState } = useStateById(observationId || '');

  // Fetch existing snapshots when editing
  const { data: existingSnapshots } = useSnapshots(isEditMode ? observationId : undefined);

  const [linkedAssets, setLinkedAssets] = useState<Array<{
    id: string;
    name: string;
    serial_number?: string;
    type: 'tool' | 'part' | 'action';
  }>>([]);

  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [toolsList, setToolsList] = useState<any[]>([]);
  const [partsList, setPartsList] = useState<any[]>([]);
  const [actionsList, setActionsList] = useState<any[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [isSemanticSearch, setIsSemanticSearch] = useState(false);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [semanticResults, setSemanticResults] = useState<any[]>([]);

  const handleSemanticSearch = async () => {
    if (!searchTerm.trim()) return;
    setIsSemanticSearching(true);
    setIsSemanticSearch(true);
    try {
      const response = await apiService.post('/semantic-search/unified', {
        query: searchTerm.trim(),
        entity_types: ['tool', 'part', 'action', 'action_existing_state'],
        limit: 30
      });
      const results = response?.results || response?.data?.results || [];
      setSemanticResults(results);
    } catch (err) {
      console.error('Semantic search failed:', err);
      toast({
        title: 'Search Error',
        description: 'Failed to perform semantic search. Please try again.',
        variant: 'destructive',
      });
      setIsSemanticSearch(false);
      setSemanticResults([]);
    } finally {
      setIsSemanticSearching(false);
    }
  };

  // Fetch asset details if linked via route or existing state links
  useEffect(() => {
    const fetchAssetDetails = async () => {
      if (isEditMode && existingState?.links) {
        const assetLinks = existingState.links.filter((l: any) => l.entity_type === 'tool' || l.entity_type === 'part' || l.entity_type === 'action');
        try {
          const fetchedAssets = await Promise.all(
            assetLinks.map(async (link: any) => {
              try {
                const endpoint = link.entity_type === 'tool' ? 'tools' : link.entity_type === 'part' ? 'parts' : 'actions';
                const result = await apiService.get(`/${endpoint}/${link.entity_id}`);
                const assetData = result.data || result;
                if (!assetData || (!assetData.id && !assetData.name && !assetData.title)) {
                  console.warn(`Empty or invalid asset data retrieved for ${link.entity_type} ${link.entity_id}`);
                  return null;
                }
                return {
                  id: assetData.id || link.entity_id,
                  name: assetData.title || assetData.name || 'Action',
                  serial_number: assetData.serial_number,
                  type: link.entity_type as 'tool' | 'part' | 'action'
                };
              } catch (singleErr) {
                console.error(`Failed to fetch individual asset details for ${link.entity_type} ${link.entity_id}:`, singleErr);
                return null;
              }
            })
          );
          setLinkedAssets(fetchedAssets.filter((a): a is NonNullable<typeof a> => a !== null));
        } catch (err) {
          console.error("Failed to fetch asset details:", err);
        }
      } else if (!isEditMode && assetType && id) {
        try {
          const endpoint = assetType === 'tools' ? 'tools' : assetType === 'parts' ? 'parts' : 'actions';
          const result = await apiService.get(`/${endpoint}/${id}`);
          const assetData = result.data || result;
          if (assetData) {
            setLinkedAssets([{
              id: assetData.id,
              name: assetData.title || assetData.name || 'Action',
              serial_number: assetData.serial_number,
              type: assetType === 'tools' ? 'tool' : assetType === 'parts' ? 'part' : 'action'
            }]);
          }
        } catch (err) {
          console.error("Failed to fetch route asset details:", err);
        }
      }
    };
    fetchAssetDetails();
  }, [existingState, isEditMode, assetType, id]);

  // Fetch tools, parts, and actions list for search when panel is opened
  useEffect(() => {
    if (showSearch && toolsList.length === 0 && partsList.length === 0 && actionsList.length === 0) {
      const fetchAssets = async () => {
        setLoadingAssets(true);
        try {
          const [toolsRes, partsRes, actionsRes] = await Promise.all([
            apiService.get('/tools?limit=2000'),
            apiService.get('/parts?limit=2000'),
            apiService.get('/actions?status=unresolved&limit=2000')
          ]);
          setToolsList(toolsRes.data || toolsRes || []);
          setPartsList(partsRes.data || partsRes || []);
          setActionsList(actionsRes.data || actionsRes || []);
        } catch (err) {
          console.error('Failed to fetch assets and actions for search:', err);
          toast({
            title: 'Error',
            description: 'Failed to load assets and actions for search. Please check your connection.',
            variant: 'destructive',
          });
        } finally {
          setLoadingAssets(false);
        }
      };
      fetchAssets();
    }
  }, [showSearch, toolsList.length, partsList.length, actionsList.length, toast]);

  // Determine toolId for metrics
  const toolId = linkedAssets.find(a => a.type === 'tool')?.id || null;
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
      // Must use local time components — toISOString() returns UTC which causes timezone offset bugs
      if (existingState.captured_at) {
        const d = new Date(existingState.captured_at);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        setCapturedAt(`${year}-${month}-${day}T${hours}:${minutes}`);
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
        links: linkedAssets.map((asset) => ({
          entity_type: asset.type,
          entity_id: asset.id
        }))
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
      const isToolObservation = linkedAssets.some(a => a.type === 'tool');
      
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
      
      handleBack();
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

  // Client-side filtering of tools, parts, and actions (semantic or keyword)
  const filteredTools = isSemanticSearch
    ? semanticResults
        .filter(r => r.entity_type === 'tool')
        .map(r => toolsList.find(t => t.id === r.entity_id))
        .filter(Boolean)
    : (searchTerm.trim() === ''
        ? []
        : toolsList.filter(t => 
            t.name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
            t.serial_number?.toLowerCase().includes(searchTerm.toLowerCase())
          )
      );

  const filteredParts = isSemanticSearch
    ? semanticResults
        .filter(r => r.entity_type === 'part')
        .map(r => partsList.find(p => p.id === r.entity_id))
        .filter(Boolean)
    : (searchTerm.trim() === ''
        ? []
        : partsList.filter(p => 
            p.name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
            p.serial_number?.toLowerCase().includes(searchTerm.toLowerCase())
          )
      );

  const filteredActions = isSemanticSearch
    ? semanticResults
        .filter(r => r.entity_type === 'action' || r.entity_type === 'action_existing_state')
        .reduce((acc: any[], r) => {
          if (acc.some(a => a.id === r.entity_id)) return acc;
          const action = actionsList.find(a => a.id === r.entity_id);
          if (action) acc.push(action);
          return acc;
        }, [])
    : (searchTerm.trim() === ''
        ? []
        : actionsList.filter(a => 
            (a.title || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
            (a.description || a.state_text || '').toLowerCase().includes(searchTerm.toLowerCase())
          )
      );

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleBack}
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
        <>
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
                onPhotoAnalyzed={handlePhotoAnalyzed}
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

          {/* Linked Asset Info */}
          {/* Linked Assets Info */}
          {linkedAssets.length > 0 && (
            <div className="space-y-2 mb-4 mt-4">
              {linkedAssets.map((asset) => (
                <Card key={asset.id} className="border-primary/20 bg-primary/5">
                  <CardContent className="pt-4 pb-4 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      {asset.type === 'tool' ? (
                        <Wrench className="w-5 h-5 text-primary flex-shrink-0" />
                      ) : asset.type === 'part' ? (
                        <Package className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                      ) : (
                        <Play className="w-5 h-5 text-blue-600 fill-blue-600/10 flex-shrink-0" />
                      )}
                      <div>
                        <p className="text-xs text-muted-foreground uppercase font-bold tracking-wider">
                          {asset.type === 'action' ? 'Linked Action' : 'Linked Asset'}
                        </p>
                        <h3 className="font-semibold text-base line-clamp-2">{asset.name}</h3>
                        {asset.serial_number && (
                          <p className="text-xs text-muted-foreground">
                            {asset.type === 'tool' ? 'Serial/Tag: ' : 'Tag/ID: '}
                            {asset.serial_number}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button 
                      type="button"
                      variant="ghost" 
                      size="icon"
                      onClick={() => setLinkedAssets(prev => prev.filter(a => a.id !== asset.id))}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Add Link Section */}
          {!showSearch ? (
            <div className="flex items-center gap-2 mt-4 mb-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowSearch(true)}
                className="flex-1 h-10 flex items-center justify-center gap-2 text-sm font-medium border-input bg-background hover:bg-accent hover:text-accent-foreground"
              >
                <Search className="h-4 w-4" />
                Link Asset
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button 
                      type="button" 
                      className="text-muted-foreground hover:text-foreground focus:outline-none p-2 border rounded-md h-10 w-10 flex items-center justify-center bg-background border-input hover:bg-accent transition-colors"
                    >
                      <Info className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs p-3">
                    <p className="text-xs leading-normal">Upload a photo and click "Load Description" to auto-extract tag GUIDs, or link an asset manually.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : (
            <Card className="mb-4 border border-input bg-background mt-4">
              <CardContent className="py-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="asset-search" className="text-sm font-semibold">Search Asset or Action</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowSearch(false);
                      setSearchTerm('');
                    }}
                    className="h-8 px-2 text-xs"
                  >
                    Cancel
                  </Button>
                </div>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          id="asset-search"
                          placeholder="Type tool/part/action name or tag..."
                          value={searchTerm}
                          onChange={(e) => {
                            setSearchTerm(e.target.value);
                            if (isSemanticSearch) {
                              setIsSemanticSearch(false);
                              setSemanticResults([]);
                            }
                          }}
                          className="pl-10 pr-10"
                          autoFocus
                        />
                        {searchTerm && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0"
                            onClick={() => {
                              setSearchTerm('');
                              setIsSemanticSearch(false);
                              setSemanticResults([]);
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      <Button
                        type="button"
                        onClick={handleSemanticSearch}
                        disabled={!searchTerm.trim() || isSemanticSearching}
                        variant="secondary"
                        title="AI-powered semantic search"
                        className="px-3"
                      >
                        {isSemanticSearching ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Bot className="h-4 w-4 text-teal-600 fill-teal-600/10" />
                        )}
                      </Button>
                    </div>

                    {/* Results list */}
                    {loadingAssets || isSemanticSearching ? (
                      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        {isSemanticSearching ? 'Searching semantically...' : 'Loading assets & actions...'}
                      </div>
                    ) : (
                      <div className="max-h-60 overflow-y-auto space-y-4 mt-2">
                        {filteredTools.length === 0 && filteredParts.length === 0 && filteredActions.length === 0 ? (
                          <div className="text-center py-4 text-sm text-muted-foreground">
                            {searchTerm ? `No assets or actions found matching "${searchTerm}"` : 'Type to start searching...'}
                          </div>
                        ) : (
                          <>
                            {filteredTools.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider px-1">Tools</h4>
                                {filteredTools.map((tool) => (
                                  <div
                                    key={tool.id}
                                    className="flex items-center justify-between p-2.5 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => {
                                      setLinkedAssets((prev) => {
                                        if (prev.some(a => a.id === tool.id)) return prev;
                                        return [...prev, {
                                          id: tool.id,
                                          name: tool.name,
                                          serial_number: tool.serial_number,
                                          type: 'tool'
                                        }];
                                      });
                                      setShowSearch(false);
                                      setSearchTerm('');
                                    }}
                                  >
                                    <div className="flex items-center gap-3">
                                      <Wrench className="w-4 h-4 text-primary flex-shrink-0" />
                                      <div>
                                        <p className="text-sm font-medium">{tool.name}</p>
                                        {tool.serial_number && (
                                          <p className="text-xs text-muted-foreground">Serial: {tool.serial_number}</p>
                                        )}
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-xs"
                                    >
                                      Link
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}

                            {filteredParts.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider px-1">Parts & Livestock</h4>
                                {filteredParts.map((part) => (
                                  <div
                                    key={part.id}
                                    className="flex items-center justify-between p-2.5 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => {
                                      setLinkedAssets((prev) => {
                                        if (prev.some(a => a.id === part.id)) return prev;
                                        return [...prev, {
                                          id: part.id,
                                          name: part.name,
                                          serial_number: part.serial_number,
                                          type: 'part'
                                        }];
                                      });
                                      setShowSearch(false);
                                      setSearchTerm('');
                                    }}
                                  >
                                    <div className="flex items-center gap-3">
                                      <Package className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                      <div>
                                        <p className="text-sm font-medium">{part.name}</p>
                                        {part.serial_number && (
                                          <p className="text-xs text-muted-foreground">Tag: {part.serial_number}</p>
                                        )}
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-xs"
                                    >
                                      Link
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}

                            {filteredActions.length > 0 && (
                              <div className="space-y-2">
                                <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider px-1">Actions</h4>
                                {filteredActions.map((action) => (
                                  <div
                                    key={action.id}
                                    className="flex items-center justify-between p-2.5 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => {
                                      setLinkedAssets((prev) => {
                                        if (prev.some(a => a.id === action.id)) return prev;
                                        return [...prev, {
                                          id: action.id,
                                          name: action.title || 'Action',
                                          serial_number: undefined,
                                          type: 'action'
                                        }];
                                      });
                                      setShowSearch(false);
                                      setSearchTerm('');
                                    }}
                                  >
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                      <Play className="w-4 h-4 text-blue-600 fill-blue-600/10 flex-shrink-0" />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium line-clamp-2">{action.title}</p>
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-xs flex-shrink-0 ml-2"
                                    >
                                      Link
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
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
            onClick={handleBack}
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
