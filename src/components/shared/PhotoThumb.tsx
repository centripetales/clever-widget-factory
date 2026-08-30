import { ReactNode, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

interface PhotoThumbProps {
  src: string;
  alt?: string;
  href?: string;
  onClick?: () => void;
  /** Sizing/border/hover classes for the tile itself, e.g. "w-full h-32 rounded border" */
  className?: string;
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  children?: ReactNode;
}

/**
 * Fixed-size photo tile that never crops: the image is letterboxed
 * (object-contain) against a neutral backdrop instead of object-cover,
 * so detail near the edges or off-center (a meter reading, a label)
 * isn't silently cut off.
 */
export function PhotoThumb({ src, alt, href, onClick, className = "", onError, children }: PhotoThumbProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const tile = (
    <div className={`relative flex items-center justify-center bg-muted overflow-hidden ${className}`}>
      <img
        src={src}
        alt={alt || "Photo"}
        className="max-w-full max-h-full object-contain"
        onError={onError}
      />
      {children}
    </div>
  );

  if (href) {
    // An in-page dialog, not <a target="_blank"> — some embedded/webview
    // browser contexts treat target="_blank" as same-tab navigation, so
    // clicking a photo filled the whole screen with no way back except the
    // browser Back button, which lost the scroll position in the list
    // behind it. A dialog can just be dismissed, leaving that untouched.
    return (
      <>
        {/* No w-full here — the tile's own className (e.g. "w-28 h-28")
            dictates the actual size, same as the <a> this replaced. Adding
            w-full made this button (and the flex item it's in) claim the
            entire row's width, leaving any sibling — e.g. the caption text
            next to a photo in a flex row — with zero space of its own. */}
        <button type="button" onClick={() => setLightboxOpen(true)} className="block text-left cursor-pointer">
          {tile}
        </button>
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="max-w-[90vw] w-fit h-[90vh] p-2 border-none bg-transparent shadow-none flex items-center justify-center">
            <img src={href} alt={alt || "Full resolution"} className="max-w-full max-h-full object-contain rounded" />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full text-left cursor-pointer">
        {tile}
      </button>
    );
  }

  return tile;
}
