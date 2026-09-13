// Tracks the last couple of assets/stock items a person opened from Combined
// Assets, so they can jump straight back in without re-filtering every time.
// Per-browser only (localStorage) -- this is a convenience shortcut, not
// data that needs to follow the user across devices.

const STORAGE_KEY = 'cwf:recent-assets';
const MAX_RECENT = 2;

export function getRecentAssetIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function recordRecentAsset(id: string): void {
  try {
    const withoutId = getRecentAssetIds().filter((existingId) => existingId !== id);
    const updated = [id, ...withoutId].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Private browsing, quota exceeded, etc. -- silently skip, not critical.
  }
}
