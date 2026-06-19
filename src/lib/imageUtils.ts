/**
 * Utility functions for handling image URLs
 */

const S3_BUCKET_URL = 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com';

/**
 * Converts an S3 key or full URL to a complete S3 URL
 * @param urlOrKey - Either a full URL (starts with http) or an S3 key
 * @returns Full S3 URL
 */
export function getImageUrl(urlOrKey: string | null | undefined): string | null {
  if (!urlOrKey) return null;
  
  // If it's already a full URL, return as-is
  if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://')) {
    return urlOrKey;
  }
  
  // Otherwise, construct the full S3 URL
  // Remove leading slash if present
  const key = urlOrKey.startsWith('/') ? urlOrKey.slice(1) : urlOrKey;
  return `${S3_BUCKET_URL}/${key}`;
}

/**
 * Extracts the S3 key from a full URL or returns the key as-is
 * @param urlOrKey - Either a full URL or an S3 key
 * @returns S3 key without the bucket URL
 */
export function getImageKey(urlOrKey: string | null | undefined): string | null {
  if (!urlOrKey) return null;
  
  // If it's a full S3 URL, extract the key
  if (urlOrKey.startsWith(S3_BUCKET_URL)) {
    return urlOrKey.replace(`${S3_BUCKET_URL}/`, '');
  }
  
  // If it's another full URL, return as-is (external image)
  if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://')) {
    return urlOrKey;
  }
  
  // Otherwise, it's already a key
  return urlOrKey;
}

/**
 * Derives the original (high-res, EXIF-preserved) image URL from a compressed image URL.
 * 
 * The image compressor Lambda leaves the original in the /uploads/ subfolder and writes
 * the compressed version to the final path. This function reverses that transformation:
 *   - mission-attachments/abc123-file.jpg → mission-attachments/uploads/abc123-file.jpg
 *   - organizations/{org}/images/file.jpg → organizations/{org}/images/uploads/file.jpg
 * 
 * @param urlOrKey - Either a full URL or an S3 key pointing to the compressed image
 * @returns Full S3 URL to the original high-res image, or null if not applicable
 */
export function getOriginalUrl(urlOrKey: string | null | undefined): string | null {
  if (!urlOrKey) return null;

  const key = getImageKey(urlOrKey);
  if (!key) return null;

  // Skip if already an uploads path (already pointing to original)
  if (key.includes('/uploads/')) {
    return getImageUrl(urlOrKey);
  }

  // Skip thumbnails — they don't have originals at a predictable path
  if (key.includes('/thumb/')) {
    return null;
  }

  // Organization-scoped: organizations/{org}/images/file.jpg → organizations/{org}/images/uploads/file.jpg
  if (key.startsWith('organizations/') && key.includes('/images/')) {
    const originalKey = key.replace(/\/images\//, '/images/uploads/');
    return `${S3_BUCKET_URL}/${originalKey}`;
  }

  // Legacy: mission-attachments/abc123-file.jpg → mission-attachments/uploads/abc123-file.jpg
  if (key.startsWith('mission-attachments/')) {
    const originalKey = key.replace(/^mission-attachments\//, 'mission-attachments/uploads/');
    return `${S3_BUCKET_URL}/${originalKey}`;
  }

  // Unknown pattern — can't derive original
  return null;
}

/**
 * Converts an image URL/key to its thumbnail version
 * Thumbnails are stored in thumb/ subfolder as WebP
 * @param urlOrKey - Either a full URL or an S3 key
 * @returns Full S3 URL to thumbnail, or null if not applicable
 */
export function getThumbnailUrl(urlOrKey: string | null | undefined): string | null {
  if (!urlOrKey) return null;
  
  // Get the key (strip bucket URL if present)
  const key = getImageKey(urlOrKey);
  if (!key) return null;
  
  // Skip if already a thumbnail
  if (key.includes('/thumb/')) {
    return getImageUrl(urlOrKey);
  }
  
  // Handle organization-scoped images
  if (key.startsWith('organizations/')) {
    // Strip the /uploads/ segment if present — thumbnails are derived from the
    // compressed image path (images/file.jpg), not the original (images/uploads/file.jpg).
    const normalizedKey = key.replace(/\/images\/uploads\//, '/images/');
    // Convert to thumbnail path: organizations/{org}/images/file.jpg -> organizations/{org}/images/thumb/file.webp
    const thumbnailKey = normalizedKey
      .replace(/\/images\//, '/images/thumb/')
      .replace(/\.(jpg|jpeg|png)$/i, '.webp');
    
    return `${S3_BUCKET_URL}/${thumbnailKey}`;
  }
  
  // For other paths, return original URL
  return getImageUrl(urlOrKey);
}
