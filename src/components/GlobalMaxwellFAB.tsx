import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useEntityContext, EntityContext } from '@/hooks/useEntityContext';
import { GlobalMaxwellPanel } from '@/components/GlobalMaxwellPanel';
import { PrismIcon } from '@/components/icons/PrismIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function GlobalMaxwellFAB() {
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [currentContext, setCurrentContext] = useState<EntityContext | null>(null);
  
  const entityContext = useEntityContext();
  const location = useLocation();
  const isDashboard = location.pathname === '/' || location.pathname === '/dashboard';
  const isFinances = location.pathname === '/finances';
  const isObservations = location.pathname === '/observations' || location.pathname.startsWith('/observations/');

  // Listen for open-maxwell events from other components (e.g. Dashboard header button)
  useEffect(() => {
    const handleOpen = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.context) {
        setCurrentContext(customEvent.detail.context);
      }
      setIsPanelOpen(true);
    };
    window.addEventListener('open-maxwell', handleOpen);
    return () => window.removeEventListener('open-maxwell', handleOpen);
  }, []);
  
  // Keep component mounted on entity detail pages, dashboard, and finances, or if panel is already open.
  if (!entityContext && !isDashboard && !isFinances && !isObservations && !isPanelOpen) {
    return null;
  }
  
  return (
    <>
      <GlobalMaxwellPanel
        open={isPanelOpen}
        onOpenChange={setIsPanelOpen}
        context={currentContext}
      />
    </>
  );
}
