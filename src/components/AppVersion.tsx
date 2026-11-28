import { useState } from "react";
import { APP_VERSION, BUILD_COMMIT, BUILD_TIMESTAMP } from "@/lib/version";

export function AppVersion() {
  const [showTimestamp, setShowTimestamp] = useState(false);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div 
      className="fixed bottom-2 left-2 md:bottom-2 md:right-2 md:left-auto text-xs text-muted-foreground bg-background/90 backdrop-blur-sm px-2 py-1 rounded border shadow-sm z-50 cursor-pointer hover:bg-background/95 transition-colors"
      onClick={() => setShowTimestamp(!showTimestamp)}
    >
      v{APP_VERSION}{showTimestamp && ` (${[BUILD_COMMIT, formatTimestamp(BUILD_TIMESTAMP)].filter(Boolean).join(' · ')})`}
    </div>
  );
}