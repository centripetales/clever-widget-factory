import { useState, useEffect } from 'react';
import { useOrganization } from './useOrganization';

// Namespace shared-org selections per current org so switching orgs
// doesn't carry over stale choices.
const storageKey = (orgId: string) => `cwf_view_shared_orgs_${orgId}`;

export function useSharedOrgs() {
  const { organization } = useOrganization();
  const orgId = organization?.id ?? null;

  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Re-load persisted selections whenever the active org changes
  useEffect(() => {
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
      setSelectedOrgs([]);
    }
    setIsLoaded(true);
  }, [orgId]);

  const toggleOrg = (sharedOrgId: string) => {
    if (!orgId) return;
    const newSelection = selectedOrgs.includes(sharedOrgId)
      ? selectedOrgs.filter((id) => id !== sharedOrgId)
      : [...selectedOrgs, sharedOrgId];

    setSelectedOrgs(newSelection);
    localStorage.setItem(storageKey(orgId), JSON.stringify(newSelection));
  };

  const clearOrgs = () => {
    if (!orgId) return;
    setSelectedOrgs([]);
    localStorage.removeItem(storageKey(orgId));
  };

  return { selectedOrgs, toggleOrg, clearOrgs, isLoaded };
}
