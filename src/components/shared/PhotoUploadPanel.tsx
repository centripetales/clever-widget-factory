import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X, GripVertical, Loader2, AlertCircle, Camera, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getImageUrl, getThumbnailUrl, getOriginalUrl } from '@/lib/imageUtils';
import { apiService } from '@/lib/apiService';

export interface PhotoItem {
  id?: string;
  file?: File;
  photo_url?: string;
  photo_type?: string;
  photo_description?: string;
  photo_order: number;
  previewUrl?: string;
  isUploading?: boolean;
  isExisting?: boolean;
  uploadFailed?: boolean;
}

export interface PhotoUploadPanelProps {
  photos: PhotoItem[];
  onPhotosChange: (photos: PhotoItem[]) => void;
  photoTypes?: string[];
  requiredTypes?: string[];
  maxPhotos?: number;
  showDescriptions?: boolean;
  disabled?: boolean;
  className?: string;
  /** When provided, uploads files immediately on selection. Return the public URL. */
  onEagerUpload?: (file: File) => Promise<{ url: string }>;
  onPhotoAnalyzed?: (index: number, description: string, extractedGuids: string[]) => void;
}

/**
 * Returns the set of required photo types that are missing (no photo of that type exists).
 */
export function getMissingRequiredTypes(
  photos: PhotoItem[],
  requiredTypes?: string[]
): string[] {
  if (!requiredTypes || requiredTypes.length === 0) return [];
  const presentTypes = new Set(
    photos
      .filter((p) => !p.isUploading)
      .map((p) => p.photo_type)
      .filter(Boolean)
  );
  return requiredTypes.filter((t) => !presentTypes.has(t));
}

/**
 * Extract the EXIF thumbnail from a JPEG file's header (~10-20KB).
 * Only reads the first 64KB of the file — never decodes the full image.
 * Returns a blob URL to the thumbnail, or null if not found.
 */
async function extractExifThumbnail(file: File): Promise<string | null> {
  try {
    const header = file.slice(0, 64000);
    const buffer = await header.arrayBuffer();
    const array = new Uint8Array(buffer);
    let start = 0, end = 0;
    // Find the second 0xFF 0xD8 (first is the main JPEG SOI)
    for (let i = 2; i < array.length; i++) {
      if (array[i] === 0xFF) {
        if (!start) {
          if (array[i + 1] === 0xD8) start = i;
        } else {
          if (array[i + 1] === 0xD9) { end = i + 2; break; }
        }
      }
    }
    if (start && end) {
      const thumbBlob = new Blob([array.subarray(start, end)], { type: 'image/jpeg' });
      return URL.createObjectURL(thumbBlob);
    }
  } catch {
    // EXIF extraction failed
  }
  return null;
}

const isMobileDevice = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/**
 * Shared, reusable photo upload panel.
 *
 * Handles file selection (with mobile camera capture), lightweight previews
 * (EXIF thumbnails for JPEGs), photo type tagging, per-photo descriptions,
 * remove/reorder, upload progress indicators, and validation feedback.
 */
export function PhotoUploadPanel({
  photos,
  onPhotosChange,
  photoTypes,
  requiredTypes,
  maxPhotos,
  showDescriptions = true,
  disabled = false,
  className,
  onEagerUpload,
  onPhotoAnalyzed,
}: PhotoUploadPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [dragIndex, setDragIndex] = useState<number | null>(null);


  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const photosRef = useRef(photos);
  photosRef.current = photos;

  const createdBlobUrls = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      createdBlobUrls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const missingTypes = getMissingRequiredTypes(photos, requiredTypes);
  const hasValidationError = missingTypes.length > 0;
  const atMaxPhotos = maxPhotos != null && photos.length >= maxPhotos;

  // ── File selection ──────────────────────────────────────────────────

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const fileArray = Array.from(files);
      const slotsAvailable =
        maxPhotos != null ? maxPhotos - photos.length : Infinity;
      const filesToAdd = fileArray.slice(0, slotsAvailable);

      const newItems: PhotoItem[] = filesToAdd.map((file, index) => ({
        id: `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        photo_type: photoTypes?.[0],
        photo_description: '',
        photo_order: photos.length + index,
        previewUrl: '', // thumbnail generated async below
        isUploading: !!onEagerUpload,
        isExisting: false,
      }));

      onPhotosChange([...photos, ...newItems]);

      // Generate lightweight EXIF thumbnails (sequential, one at a time).
      // For JPEGs: extracts the ~10-20KB embedded thumbnail from the first 64KB.
      // For PNGs: uses a full blob URL (desktop only, memory not constrained).
      // After thumbnail is generated, the File is cleared from state to free memory.
      // The upload loop holds its own reference via newItems.
      (async () => {
        // Yield so React can process the state update above and refresh
        // photosRef.current. Without this, synchronous paths (e.g. PNG
        // blob URL creation) would read stale state and overwrite the
        // newly added photo items.
        await new Promise(r => setTimeout(r, 0));

        for (const item of newItems) {
          if (!item.file || !item.id) continue;
          const isJpeg = item.file.type === 'image/jpeg' || item.file.type === 'image/jpg'
            || /\.jpe?g$/i.test(item.file.name);

          let thumbUrl: string;
          if (isJpeg) {
            const exifThumb = await extractExifThumbnail(item.file);
            if (exifThumb) {
              createdBlobUrls.current.add(exifThumb);
              thumbUrl = exifThumb;
            } else {
              // JPEG without EXIF thumbnail — use blob URL as fallback
              thumbUrl = URL.createObjectURL(item.file);
              createdBlobUrls.current.add(thumbUrl);
            }
          } else {
            // Non-JPEG (PNG, etc.) — full blob URL
            thumbUrl = URL.createObjectURL(item.file);
            createdBlobUrls.current.add(thumbUrl);
          }

          const latest = photosRef.current.map((p) =>
            p.id === item.id ? { ...p, previewUrl: thumbUrl, file: undefined } : p
          );
          onPhotosChange(latest);
        }
      })();

      // Eager upload: upload each file sequentially
      if (onEagerUpload) {
        const uploadSequentially = async () => {
          for (let idx = 0; idx < newItems.length; idx++) {
            const item = newItems[idx];
            if (!item.file || !item.id) continue;
            const itemId = item.id;

            try {
              // On mobile, pause between uploads to let the router CPU recover.
              // Budget routers (e.g. TP-Link Archer A6) hit 100% CPU during
              // large uploads and drop subsequent connections without this delay.
              if (idx > 0 && isMobileDevice()) {
                await new Promise(r => setTimeout(r, 3000));
              }

              const { url } = await onEagerUpload(item.file);

              const latest = photosRef.current.map((p) =>
                p.id === itemId
                  ? { ...p, photo_url: url, isUploading: false, file: undefined }
                  : p
              );
              onPhotosChange(latest);
            } catch (err) {
              console.error('Upload failed:', item.file?.name, err);
              const latest = photosRef.current.map((p) =>
                p.id === itemId
                  ? { ...p, isUploading: false, uploadFailed: true, file: undefined }
                  : p
              );
              onPhotosChange(latest);
            }
          }
        };
        uploadSequentially();
      }

      e.target.value = '';
    },
    [photos, onPhotosChange, photoTypes, maxPhotos, onEagerUpload]
  );

  // ── Photo mutations ─────────────────────────────────────────────────

  const handleRemove = useCallback(
    (index: number) => {
      const photo = photos[index];
      if (photo.previewUrl && photo.previewUrl.startsWith('blob:') && !photo.isExisting) {
        URL.revokeObjectURL(photo.previewUrl);
        createdBlobUrls.current.delete(photo.previewUrl);
      }
      const updated = photos
        .filter((_, i) => i !== index)
        .map((p, i) => ({ ...p, photo_order: i }));
      onPhotosChange(updated);
    },
    [photos, onPhotosChange]
  );

  const handleTypeChange = useCallback(
    (index: number, type: string) => {
      onPhotosChange(photos.map((p, i) => i === index ? { ...p, photo_type: type } : p));
    },
    [photos, onPhotosChange]
  );

  const handleDescriptionChange = useCallback(
    (index: number, description: string) => {
      onPhotosChange(photos.map((p, i) => i === index ? { ...p, photo_description: description } : p));
    },
    [photos, onPhotosChange]
  );

  // ── Drag-and-drop reorder ───────────────────────────────────────────

  const handleDragStart = (index: number) => setDragIndex(index);

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const reordered = [...photos];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(dropIndex, 0, moved);
    onPhotosChange(reordered.map((p, i) => ({ ...p, photo_order: i })));
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  // ── Preview URL resolution ──────────────────────────────────────────

  const getPreviewSrc = (photo: PhotoItem): string => {
    if (photo.previewUrl) {
      if (photo.isExisting && !photo.previewUrl.startsWith('blob:')) {
        return getThumbnailUrl(photo.previewUrl) || getImageUrl(photo.previewUrl) || photo.previewUrl;
      }
      return photo.previewUrl;
    }
    if (photo.photo_url) {
      return getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || photo.photo_url;
    }
    return '';
  };

  /** Best available URL for viewing a photo at full size. */
  const getViewUrl = (photo: PhotoItem): string | null => {
    // Uploaded photo — use original high-res if available, else compressed
    if (photo.photo_url) {
      return getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || photo.photo_url;
    }
    // Local-only photo — blob preview is the best we have
    if (photo.previewUrl) {
      return photo.previewUrl;
    }
    return null;
  };

  const handlePhotoClick = (photo: PhotoItem) => {
    if (photo.isUploading) return;
    const url = getViewUrl(photo);
    if (url) {
      window.open(url, '_blank');
    }
  };

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className={cn('space-y-3', className)}>
      <div>
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          disabled={disabled || atMaxPhotos}
        />
        <label
          htmlFor={disabled || atMaxPhotos ? undefined : inputId}
          className={cn(
            'flex items-center justify-center w-full h-10 px-4 py-2 rounded-md border border-input bg-background text-sm font-medium ring-offset-background transition-colors',
            disabled || atMaxPhotos
              ? 'cursor-not-allowed opacity-50'
              : 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <Camera className="h-4 w-4 mr-2" />
          {atMaxPhotos ? `Maximum ${maxPhotos} photos reached` : 'Add Photos'}
        </label>
      </div>

      {hasValidationError && photos.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>
            Required:{' '}
            {missingTypes.map((t) => (
              <Badge key={t} variant="destructive" className="mr-1 capitalize">{t}</Badge>
            ))}
            photo{missingTypes.length > 1 ? 's' : ''} missing
          </span>
        </div>
      )}

      {photos.length > 0 && (
        <div className="space-y-2">
          {photos.map((photo, index) => (
            <div
              key={photo.id || index}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                'flex gap-2 items-stretch border rounded p-2 transition-colors',
                dragOverIndex === index && 'border-primary bg-primary/5',
                dragIndex === index && 'opacity-50'
              )}
            >
              {/* Drag handle is the only draggable element — keeps the row itself non-draggable
                  so long-press on text/images doesn't trigger reorder drag */}
              <div
                draggable={!disabled}
                onDragStart={() => handleDragStart(index)}
                className="flex items-center cursor-grab active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4 text-muted-foreground" />
              </div>

              <div className="flex-shrink-0 w-24 relative">
                {getPreviewSrc(photo) ? (
                  <img
                    src={getPreviewSrc(photo)}
                    alt={`Photo ${index + 1}`}
                    className={cn(
                      'w-full aspect-square object-cover rounded',
                      !photo.isUploading && 'cursor-pointer hover:opacity-80 transition-opacity'
                    )}
                    onClick={() => handlePhotoClick(photo)}
                    onError={(e) => {
                      if (photo.photo_url) {
                        const original = getImageUrl(photo.photo_url);
                        if (original && e.currentTarget.src !== original) {
                          e.currentTarget.src = original;
                          return;
                        }
                      }
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-full aspect-square rounded bg-muted flex items-center justify-center">
                    <Camera className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                {photo.isUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/70 rounded">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                )}
                {photo.uploadFailed && !photo.isUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-destructive/20 rounded">
                    <AlertCircle className="h-5 w-5 text-destructive" />
                  </div>
                )}
              </div>

              <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                {photoTypes && photoTypes.length > 0 && (
                  <Select
                    value={photo.photo_type || ''}
                    onValueChange={(val) => handleTypeChange(index, val)}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {photoTypes.map((type) => (
                        <SelectItem key={type} value={type} className="capitalize">{type}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {showDescriptions && (
                  <Textarea
                    placeholder={`Description for photo ${index + 1}`}
                    value={photo.photo_description || ''}
                    onChange={(e) => handleDescriptionChange(index, e.target.value)}
                    className="flex-1 resize-none text-sm min-h-[60px]"
                    disabled={disabled}
                  />
                )}

              </div>

              <Button
                variant="ghost"
                size="icon"
                className="self-start flex-shrink-0"
                onClick={() => handleRemove(index)}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {photos.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {photos.length} photo{photos.length !== 1 ? 's' : ''}
          {maxPhotos != null && ` of ${maxPhotos} max`}
          {photos.some((p) => p.isUploading) &&
            ` · ${photos.filter((p) => p.isUploading).length} uploading`}
        </p>
      )}
    </div>
  );
}
