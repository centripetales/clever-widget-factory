// Version management for debugging and tracking.
// The last part of the version is the deploy's run number, so each deploy to main gets a higher one;
// a build made anywhere else ends in "dev". The commit and time are those of the build, not of the page load.
const MAJOR_MINOR = "1.2";
export const APP_VERSION = `${MAJOR_MINOR}.${__BUILD_NUMBER__}`;
export const BUILD_COMMIT = __BUILD_COMMIT__; // short SHA; empty outside a deploy
export const BUILD_DATE = __BUILD_TIME__.split('T')[0]; // YYYY-MM-DD format
export const BUILD_TIMESTAMP = __BUILD_TIME__; // Full timestamp with time

// Get browser and device information for debugging
export const getBrowserInfo = () => {
  const ua = navigator.userAgent;
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const browser = (() => {
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Safari')) return 'Safari';
    if (ua.includes('Edge')) return 'Edge';
    return 'Unknown';
  })();
  
  return {
    userAgent: ua,
    isMobile,
    browser,
    platform: navigator.platform,
    language: navigator.language,
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine
  };
};