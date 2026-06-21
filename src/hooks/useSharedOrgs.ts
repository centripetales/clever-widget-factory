import { useState, useEffect } from 'react';

const STORAGE_KEY = 'cwf_view_shared_orgs';

export function useSharedOrgs() {
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setSelectedOrgs(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse shared orgs from local storage', e);
      }
    }
    setIsLoaded(true);
  }, []);

  const toggleOrg = (orgId: string) => {
    const newSelection = selectedOrgs.includes(orgId)
      ? selectedOrgs.filter((id) => id !== orgId)
      : [...selectedOrgs, orgId];
    
    setSelectedOrgs(newSelection);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newSelection));
  };

  const clearOrgs = () => {
    setSelectedOrgs([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  return { selectedOrgs, toggleOrg, clearOrgs, isLoaded };
}
