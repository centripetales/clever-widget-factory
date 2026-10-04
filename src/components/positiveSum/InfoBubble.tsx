import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// A small (i) that opens a description, so the page itself stays short.
export function InfoBubble({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-auto p-1" aria-label="More information">
          <Info className="w-4 h-4 text-muted-foreground hover:text-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm text-muted-foreground">{children}</PopoverContent>
    </Popover>
  );
}
