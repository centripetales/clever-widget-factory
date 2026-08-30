/**
 * LinkExistingPhotoDialog
 *
 * Picks photos that already exist elsewhere in a container's observation
 * history, so a state can reuse them instead of requiring a fresh upload.
 *
 * "Linking" here is a copy of the reference, not a shared row: the save path
 * always creates a new `state_photos` row from a `photo_url`, so reusing an
 * existing URL needs no schema or endpoint change, and the source photo is
 * left untouched.
 *
 * Distinct from PhotoGalleryDialog, which is a view-only lightbox with no
 * selection.
 */

import { useMemo, useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Check } from 'lucide-react';
import { format } from 'date-fns';
import { useStates } from '@/hooks/useStates';
import { getImageUrl } from '@/lib/imageUtils';

export interface LinkablePhoto {
  photo_url: string;
  photo_description?: string | null;
  /** The state this photo currently lives on — shown for context only. */
  source_state_id: string;
  captured_at: string;
}

interface LinkExistingPhotoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  entityType: 'tool' | 'part';
  entityId: string;
  /** photo_urls already attached to the target — shown as already-added. */
  existingPhotoUrls?: string[];
  onConfirm: (photos: LinkablePhoto[]) => void;
}

export function LinkExistingPhotoDialog({
  open,
  onOpenChange,
  organizationId,
  entityType,
  entityId,
  existingPhotoUrls = [],
  onConfirm,
}: LinkExistingPhotoDialogProps) {
  const { data: states, isLoading } = useStates(organizationId, {
    entity_type: entityType,
    entity_id: entityId,
  });

  const [selected, setSelected] = useState<Record<string, LinkablePhoto>>({});

  useEffect(() => {
    if (!open) setSelected({});
  }, [open]);

  // useStates returns whole states with their photos; flatten to a photo pool.
  const photos = useMemo<LinkablePhoto[]>(() => {
    const flat: LinkablePhoto[] = [];
    for (const s of states || []) {
      for (const p of s.photos || []) {
        if (!p.photo_url) continue;
        flat.push({
          photo_url: p.photo_url,
          photo_description: p.photo_description,
          source_state_id: s.id,
          captured_at: s.captured_at,
        });
      }
    }
    return flat.sort(
      (a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
    );
  }, [states]);

  const alreadyAdded = useMemo(() => new Set(existingPhotoUrls), [existingPhotoUrls]);
  const selectedCount = Object.keys(selected).length;

  const toggle = (photo: LinkablePhoto) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[photo.photo_url]) delete next[photo.photo_url];
      else next[photo.photo_url] = photo;
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm(Object.values(selected));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link an existing photo</DialogTitle>
          <DialogDescription>
            Reuse a photo already recorded for this container. The original observation keeps its copy.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading photos...
          </div>
        ) : photos.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No photos recorded for this container yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {photos.map((photo) => {
              const isSelected = !!selected[photo.photo_url];
              const isAdded = alreadyAdded.has(photo.photo_url);
              return (
                <button
                  key={`${photo.source_state_id}-${photo.photo_url}`}
                  type="button"
                  onClick={() => !isAdded && toggle(photo)}
                  disabled={isAdded}
                  aria-pressed={isSelected}
                  className={`text-left rounded-md border overflow-hidden transition ${
                    isAdded
                      ? 'opacity-50 cursor-not-allowed'
                      : isSelected
                        ? 'ring-2 ring-primary border-primary'
                        : 'hover:border-primary/50'
                  }`}
                >
                  <div className="relative aspect-square bg-muted">
                    <img
                      src={getImageUrl(photo.photo_url) || photo.photo_url}
                      alt={photo.photo_description || ''}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    {(isSelected || isAdded) && (
                      <div className="absolute top-1 right-1 rounded-full bg-primary text-primary-foreground p-1">
                        <Check className="h-3 w-3" />
                      </div>
                    )}
                  </div>
                  <div className="p-2 space-y-1">
                    <p className="text-[11px] text-muted-foreground">
                      {format(new Date(photo.captured_at), 'MMM d, yyyy')}
                      {isAdded && ' · already added'}
                    </p>
                    {photo.photo_description && (
                      <p className="text-xs line-clamp-2">{photo.photo_description}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={selectedCount === 0}>
            Add {selectedCount > 0 ? `${selectedCount} photo${selectedCount === 1 ? '' : 's'}` : 'selected'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
