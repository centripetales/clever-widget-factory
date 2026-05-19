import { useState } from 'react';
import { X } from 'lucide-react';
import { getThumbnailUrl, getOriginalUrl } from '@/lib/imageUtils';

export function ExpandableMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [expanded, setExpanded] = useState(false);
  
  if (!src) return null;
  
  const thumbnailUrl = getThumbnailUrl(src) || src;
  const originalUrl = getOriginalUrl(src) || src;
  
  return (
    <>
      <button 
        type="button" 
        onClick={() => setExpanded(true)}
        className="block my-2 overflow-hidden rounded-md border border-border transition-opacity hover:opacity-90"
      >
        <img 
          src={thumbnailUrl} 
          alt={alt || ''} 
          className="max-h-32 w-auto object-cover m-0" 
          loading="lazy"
        />
      </button>
      
      {expanded && (
        <div 
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
          onClick={() => setExpanded(false)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center">
            <img 
              src={originalUrl} 
              alt={alt || ''} 
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl" 
            />
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
              className="absolute top-2 right-2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/80 transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
