/**
 * useImageUpload — image/file upload hook using presigned POST + FormData.
 *
 * The backend (/upload/presigned-url) returns a presigned POST URL and policy
 * fields. The browser sends a multipart/form-data POST directly to S3, which
 * is a "simple" CORS request (no preflight OPTIONS needed). After upload, the
 * cwf-image-compressor Lambda processes the file via an S3 event trigger.
 *
 * Legacy implementation (presigned PUT) has been replaced by this approach.
 * The old file is preserved at useImageUpload.old.tsx for reference.
 */

import { useState } from 'react';
import { apiService } from '@/lib/apiService';
import { useEnhancedToast } from './useEnhancedToast';
import { compressImageSimple } from '@/lib/simpleImageCompression';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImageUploadOptions {
  /** Ignored — kept for backward compatibility with existing call sites. */
  bucket?: string;
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
  generateFileName?: (file: File, index?: number) => string;
  onProgress?: (stage: string, progress: number, details: string) => void;
  validateFile?: (file: File) => void;
}

export interface ImageUploadResult {
  url: string;
  fileName: string;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  fileType?: 'image' | 'pdf' | 'other';
}

// ── S3 upload helper ──────────────────────────────────────────────────────────

/**
 * Upload a file to S3 using a presigned POST with FormData.
 * S3 returns 204 on success.
 */
function uploadToS3(
  postUrl: string,
  postFields: Record<string, string>,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ ok: boolean; status: number; statusText: string }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    // Policy fields must come before the file
    Object.entries(postFields).forEach(([key, value]) => {
      formData.append(key, value);
    });
    // File must be the last field
    formData.append('file', file);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText,
      });
    });

    xhr.addEventListener('error', () => {
      reject(new TypeError(`S3 upload network error (status=${xhr.status})`));
    });

    xhr.addEventListener('abort', () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new TypeError('S3 upload timed out'));
    });

    xhr.open('POST', postUrl);
    // Do NOT set Content-Type — browser sets it with the correct multipart boundary
    xhr.timeout = 300_000; // 5 minutes
    xhr.send(formData);
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const PDF_MIME_TYPE = 'application/pdf';

function getFileType(mimeType: string): 'image' | 'pdf' | 'other' {
  if (IMAGE_MIME_TYPES.includes(mimeType)) return 'image';
  if (mimeType === PDF_MIME_TYPE) return 'pdf';
  return 'other';
}

export const useImageUpload = () => {
  const [isUploading, setIsUploading] = useState(false);
  const enhancedToast = useEnhancedToast();

  const uploadSingleImage = async (
    file: File,
    options: ImageUploadOptions = {},
  ): Promise<ImageUploadResult> => {
    const { validateFile, onProgress } = options;

    if (validateFile) validateFile(file);

    if (file.size > 50 * 1024 * 1024) {
      throw new Error(
        `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum is 50MB.`,
      );
    }

    const fileType = getFileType(file.type);
    const isValidType =
      fileType !== 'other' ||
      /\.(jpg|jpeg|png|gif|webp|heic|heif|pdf)$/i.test(file.name);

    if (!isValidType) {
      throw new Error(
        `Invalid file type: ${file.type}. Only images and PDFs are allowed.`,
      );
    }

    try {
      let fileToUpload = file;
      let originalSize = file.size;
      let compressedSize = file.size;
      let compressionRatio = 0;

      if (fileType === 'image') {
        const compressionToast = enhancedToast.showCompressionStart(file.name, file.size);
        try {
          const compressionResult = await compressImageSimple(file, {
            maxSizeMB: 0.5,
            maxWidthOrHeight: 1024,
          });
          fileToUpload = compressionResult.file;
          compressedSize = compressionResult.compressedSize;
          compressionRatio = compressionResult.compressionRatio;

          if (compressionRatio > 0) {
            enhancedToast.showCompressionComplete({
              ...compressionResult,
              timings: { total: 0 },
              stages: [],
              originalFormat: file.type.split('/')[1] || 'unknown',
              finalFormat: 'jpeg',
              algorithm: 'Canvas compression',
            });
          }
        } catch (compressionError) {
          console.warn('Image compression failed, uploading original:', compressionError);
          enhancedToast.showCompressionError(
            'Compression failed, uploading original image.',
            file.name,
          );
        }
      }

      // Step 1: Get presigned POST credentials from backend
      const presignedResponse = await apiService.post('/upload/presigned-url', {
        filename: fileToUpload.name,
        contentType: fileToUpload.type,
      });

      const { publicUrl, postUrl, postFields } = presignedResponse;

      if (!postUrl || !postFields) {
        throw new Error('Backend did not return presigned POST credentials');
      }

      // Step 2: Upload directly to S3 via multipart/form-data POST
      const result = await uploadToS3(postUrl, postFields, fileToUpload, (pct) => {
        onProgress?.('uploading', pct, fileToUpload.name);
      });

      if (!result.ok) {
        throw new Error(`S3 upload failed: ${result.status} ${result.statusText}`);
      }

      enhancedToast.showUploadSuccess(fileToUpload.name, publicUrl);

      return {
        url: publicUrl,
        fileName: fileToUpload.name,
        originalSize: originalSize,
        compressedSize: compressedSize,
        compressionRatio: compressionRatio,
        fileType: getFileType(file.type),
      };
    } catch (error) {
      enhancedToast.showUploadError(
        error instanceof Error ? error.message : 'Upload failed',
        file.name,
      );
      throw error;
    }
  };

  const uploadMultipleImages = async (
    files: File[],
    options: ImageUploadOptions = {},
  ): Promise<ImageUploadResult[]> => {
    const results: ImageUploadResult[] = [];
    const errors: { name: string; error: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      try {
        const fileOptions: ImageUploadOptions = {
          ...options,
          generateFileName: options.generateFileName
            ? (f: File) => options.generateFileName!(f, i + 1)
            : undefined,
        };
        results.push(await uploadSingleImage(files[i], fileOptions));

        // Small delay between uploads to prevent mobile browser memory issues
        if (i < files.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Upload failed';
        errors.push({ name: files[i].name, error: errorMsg });
      }
    }

    if (errors.length > 0 && results.length === 0) {
      const errorDetails = errors.map((e) => `${e.name}: ${e.error}`).join('; ');
      throw new Error(`Upload failed: ${errorDetails}`);
    }

    if (errors.length > 0) {
      enhancedToast.showUploadError(
        `${errors.length} file(s) failed to upload`,
        errors.map((e) => e.name).join(', '),
      );
    }

    return results;
  };

  const uploadImages = async (
    files: File | File[],
    options: ImageUploadOptions = {},
  ): Promise<ImageUploadResult | ImageUploadResult[]> => {
    setIsUploading(true);
    try {
      return Array.isArray(files)
        ? await uploadMultipleImages(files, options)
        : await uploadSingleImage(files, options);
    } finally {
      setIsUploading(false);
    }
  };

  return {
    uploadImages,
    /** Alias for uploadImages — used by observation/state upload flows */
    uploadFiles: uploadImages,
    isUploading,
  };
};
