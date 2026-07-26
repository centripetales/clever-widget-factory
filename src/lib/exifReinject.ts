import piexif from 'piexifjs';

/**
 * Canvas-based compression (simpleImageCompression.ts) inherently strips EXIF —
 * drawing to canvas and re-exporting carries no metadata through. This copies the
 * EXIF segment from the original file into the already-compressed JPEG blob
 * afterward, so uploads still land with EXIF intact for the existing
 * cwf-image-compressor Lambda pipeline to extract (it already parses EXIF/GPS
 * from files in the /uploads/ S3 prefix into photo_metadata_extractions — it was
 * just never receiving EXIF-bearing input).
 *
 * Only works when the ORIGINAL file is JPEG-encoded (piexifjs reads/writes the
 * JPEG APP1 EXIF segment specifically). iPhones set to capture HEIC will not have
 * their EXIF preserved by this path — falls back to returning the compressed file
 * unchanged rather than failing the upload.
 */
export async function reinjectExif(originalFile: File, compressedFile: File): Promise<File> {
  try {
    const originalBinary = await fileToBinaryString(originalFile);

    let exifBytes: string;
    try {
      const exifObj = piexif.load(originalBinary);
      const hasData = Object.values(exifObj).some(
        (ifd) => ifd && typeof ifd === 'object' && Object.keys(ifd).length > 0
      );
      if (!hasData) return compressedFile;
      exifBytes = piexif.dump(exifObj);
    } catch {
      // Original has no parseable JPEG EXIF segment (e.g. HEIC, PNG, or already stripped).
      return compressedFile;
    }

    const compressedBinary = await fileToBinaryString(compressedFile);
    const withExifBinary = piexif.insert(exifBytes, compressedBinary);
    const withExifBlob = binaryStringToBlob(withExifBinary, 'image/jpeg');

    return new File([withExifBlob], compressedFile.name, {
      type: 'image/jpeg',
      lastModified: compressedFile.lastModified,
    });
  } catch (err) {
    console.warn('[EXIF] Failed to re-inject EXIF into compressed image, uploading without it:', err);
    return compressedFile;
  }
}

async function fileToBinaryString(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    result += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return result;
}

function binaryStringToBlob(binaryString: string, type: string): Blob {
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}
