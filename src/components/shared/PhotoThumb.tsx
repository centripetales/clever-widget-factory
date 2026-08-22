import { ReactNode } from "react";

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
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        {tile}
      </a>
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
