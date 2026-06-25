import { useState, useEffect } from 'react';
import { useOrganization } from './useOrganization';

/**
 * Persists a filter value in localStorage, namespaced by org ID.
 * Follows the same pattern as useSharedOrgs.
 */
export function usePersistedFilter(key: string, defaultValue: string) {
  const { organization } = useOrganization();
  const orgId = organization?.id ?? null;

  const storageKey = orgId ? `cwf_filter_${orgId}_${key}` : null;

  const [value, setValue] = useState(() => {
    if (!storageKey) return defaultValue;
    return localStorage.getItem(storageKey) ?? defaultValue;
  });

  // Re-sync when org changes
  useEffect(() => {
    if (!storageKey) return;
    setValue(localStorage.getItem(storageKey) ?? defaultValue);
  }, [storageKey]);

  const set = (newValue: string) => {
    setValue(newValue);
    if (storageKey) localStorage.setItem(storageKey, newValue);
  };

  return [value, set] as const;
}
