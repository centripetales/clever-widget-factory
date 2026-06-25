import { useState, useEffect, useCallback } from 'react';
import { useOrganization } from './useOrganization';

// Namespace shared-org selections per current org so switching orgs
// doesn't carry over stale choices.
const storageKey = (orgId: string) => `cwf_view_shared_orgs_${orgId}`;
const SYNC_EVENT_NAME = 'cwf_shared_orgs_updated';

export function useSharedOrgs() {
  const { organization } = useOrganization();
  const orgId = organization?.id ?? null;

  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  const loadSaved = useCallback(() => {
    if (!orgId) {
      setSelectedOrgs([]);
      setIsLoaded(true);
      return;
    }
    const saved = localStorage.getItem(storageKey(orgId));
    if (saved) {
      try {
        setSelectedOrgs(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse shared orgs from localStorage', e);
        setSelectedOrgs([]);
      }
    } else {
      // First visit: default to own org checked
      const defaults = [orgId];
      setSelectedOrgs(defaults);
      localStorage.setItem(storageKey(orgId), JSON.stringify(defaults));
    }
    setIsLoaded(true);
  }, [orgId]);

  // Re-load persisted selections whenever the active org changes, and listen for updates
  useEffect(() => {
    loadSaved();

    const handleSync = () => {
      loadSaved();
    };

    window.addEventListener(SYNC_EVENT_NAME, handleSync);
    window.addEventListener('storage', handleSync); // Sync across tabs/windows

    return () => {
      window.removeEventListener(SYNC_EVENT_NAME, handleSync);
      window.removeEventListener('storage', handleSync);
    };
  }, [orgId, loadSaved]);

  const toggleOrg = (sharedOrgId: string) => {
    if (!orgId) return;
    const currentSaved = localStorage.getItem(storageKey(orgId));
    let currentSelection: string[] = [];
    if (currentSaved) {
      try {
        currentSelection = JSON.parse(currentSaved);
      } catch {
        currentSelection = selectedOrgs;
      }
    } else {
      currentSelection = selectedOrgs;
    }

    const newSelection = currentSelection.includes(sharedOrgId)
      ? currentSelection.filter((id) => id !== sharedOrgId)
      : [...currentSelection, sharedOrgId];

    localStorage.setItem(storageKey(orgId), JSON.stringify(newSelection));
    window.dispatchEvent(new Event(SYNC_EVENT_NAME));
  };

  const clearOrgs = () => {
    if (!orgId) return;
    localStorage.removeItem(storageKey(orgId));
    window.dispatchEvent(new Event(SYNC_EVENT_NAME));
  };

  return { selectedOrgs, toggleOrg, clearOrgs, isLoaded };
}
