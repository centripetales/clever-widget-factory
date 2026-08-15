// Version management for debugging and tracking
export const APP_VERSION = "1.2.1";
export const BUILD_DATE = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
export const BUILD_TIMESTAMP = new Date().toISOString(); // Full timestamp with time

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