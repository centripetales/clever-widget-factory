import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { getImageUrl, getOriginalUrl, openImage } from '@/lib/imageUtils';

interface PhotoGalleryPhoto {
  photo_url: string;
  photo_description?: string | null;
}

interface PhotoGalleryDialogProps {
  photos: PhotoGalleryPhoto[];
  initialIndex?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Full-screen photo gallery dialog with navigation and high-res link.
 * Shows compressed image for fast viewing, with a link to the original.
 */
export function PhotoGalleryDialog({
  photos,
  initialIndex = 0,
  open,
  onOpenChange,
}: PhotoGalleryDialogProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  // Sync currentIndex whenever initialIndex changes (e.g. user clicks a different photo)
  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  if (photos.length === 0) return null;

  const photo = photos[currentIndex] ?? photos[0];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < photos.length - 1;

  const originalUrl = getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || photo.photo_url;
  const displayUrl = getImageUrl(photo.photo_url) || photo.photo_url;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[95vw] p-0 gap-0 overflow-hidden [&>button]:hidden">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-background border-b">
          <span className="text-sm text-muted-foreground">
            {photos.length > 1 ? `${currentIndex + 1} / ${photos.length}` : '1 photo'}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs gap-1"
              onClick={() => openImage(photo.photo_url)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Full resolution
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Image area */}
        <div className="relative flex items-center justify-center bg-black min-h-[50vh] max-h-[75vh]">
          <img
            src={displayUrl}
            alt={photo.photo_description || `Photo ${currentIndex + 1}`}
            className="max-w-full max-h-[75vh] object-contain"
            onError={(e) => {
              // If compressed fails, try original
              if (e.currentTarget.src !== originalUrl) {
                e.currentTarget.src = originalUrl;
              }
            }}
          />

          {/* Navigation arrows */}
          {hasPrev && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white h-10 w-10 rounded-full"
              onClick={() => setCurrentIndex((i) => i - 1)}
            >
              <ChevronLeft className="h-6 w-6" />
            </Button>
          )}
          {hasNext && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white h-10 w-10 rounded-full"
              onClick={() => setCurrentIndex((i) => i + 1)}
            >
              <ChevronRight className="h-6 w-6" />
            </Button>
          )}
        </div>

        {/* Description footer */}
        {photo.photo_description && (
          <div className="px-4 py-3 border-t bg-background">
            <p className="text-sm text-muted-foreground">{photo.photo_description}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
