# Photo upload pipeline

**Status:** current-state reference — keep this accurate.
**Last verified:** 2026-08-01.

This replaces an older client-side, direct-to-S3 multipart upload approach
(`@aws-sdk/lib-storage`'s `Upload` class with AWS credentials embedded in the
frontend). That approach is gone — the AWS SDK creds it needed have been
removed from the frontend, and the code lives only in
`src/hooks/useImageUpload.old.tsx`, kept for reference, not used.

## Current flow: presigned POST

1. **Client-side compression** ([`simpleImageCompression.ts`](../../src/lib/simpleImageCompression.ts))
   downsizes the image in the browser via canvas before upload.
2. **EXIF reinjection** ([`exifReinject.ts`](../../src/lib/exifReinject.ts)) —
   canvas-based compression strips all EXIF (GPS, timestamp, device) by
   construction, so this step copies the EXIF segment from the *original*
   file into the compressed blob afterward, using `piexifjs`. Only works for
   JPEG-encoded originals (HEIC/PNG sources no-op safely, uploading without
   EXIF). This is what makes GPS survive the round trip to the server-side
   extraction step below.
3. **Get a presigned POST** — the client calls `/upload/presigned-url` on
   the backend, which returns a presigned POST URL and policy fields. No AWS
   credentials live in the frontend.
4. **Upload directly to S3** via a `multipart/form-data` POST (a "simple"
   CORS request — no preflight `OPTIONS` needed), landing in the bucket's
   `/uploads/` prefix.
5. **`cwf-image-compressor` Lambda** triggers on the S3 upload event. It:
   - Downloads the uploaded object and parses EXIF (via `exifr`) — this is
     where the GPS coordinates get extracted, from the file the browser
     actually sent, before anything below strips it.
   - Writes the extracted GPS/device/timestamp data to the
     `photo_metadata_extractions` table (keyed by the final serving URL, not
     the `/uploads/` URL).
   - Compresses the image again server-side (via `sharp`, downsampled to a
     max long side, `.withMetadata(false)`) and writes it to the final
     serving location — **this copy has no EXIF at all**, by design, since
     it's meant for display, not data extraction. Also generates a small
     WebP thumbnail, same no-metadata treatment.

So: the *served* image URL never has EXIF in it. If you need GPS/device data
for a photo, query `photo_metadata_extractions` by its final URL — don't
expect to find it in the image file itself.

## Why this matters for GPS specifically

Android's system Photo Picker (and browsers generally) will strip GPS EXIF
from a file handed to a web app unless the app holds
`ACCESS_MEDIA_LOCATION`, which browsers don't request. A plain
`capture="environment"` file input bypasses the picker and hands the browser
the camera's direct output instead, which isn't subject to that redaction —
this is why [`PhotoUploadPanel.tsx`](../../src/components/shared/PhotoUploadPanel.tsx)
has both a gallery-picker "Add Photos" input and a direct-capture "Take
Photo" input rather than just one.

## Where uploads are used

`useImageUpload.tsx` exposes `uploadImages`/`uploadSingleImage`/`uploadFiles`.
Callers include the observation photo panel, Maxwell chat image attachments,
and asset registration flows — check current call sites with:
```bash
grep -rln "useImageUpload" src/ --include=*.tsx --include=*.ts
```
