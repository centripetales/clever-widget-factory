import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import sharp from 'sharp';
import exifr from 'exifr';

const s3Client = new S3Client({ region: 'us-west-2' });
const lambdaClient = new LambdaClient({ region: 'us-west-2' });

export const handler = async (event) => {
  console.log('S3 event:', JSON.stringify(event, null, 2));
  
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    // Only process files in uploads/ folder
    if (!key.includes('/uploads/')) {
      console.log('Skipping non-upload file:', key);
      continue;
    }
    
    // Skip PDFs
    if (key.toLowerCase().endsWith('.pdf')) {
      console.log('Skipping PDF:', key);
      continue;
    }
    
    try {
      console.log('Processing:', { bucket, key });
      
      // Download original
      const getCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3Client.send(getCommand);
      const imageBuffer = await streamToBuffer(response.Body);
      
      console.log('Downloaded:', { size: imageBuffer.length });

      // Extract EXIF metadata
      let exifrOutput = null;
      try {
        exifrOutput = await exifr.parse(imageBuffer, {
          gps: true,
          tiff: true,
          xmp: false,
          iptc: false
        });
        console.log('Parsed EXIF successfully:', exifrOutput ? Object.keys(exifrOutput) : 'null');
      } catch (exifErr) {
        console.warn('EXIF parsing failed/skipped:', exifErr.message);
      }
      
      // Compress with sharp - downsample long side to max 2400px, preserve aspect ratio
      // Strip metadata (original in originals/ folder preserves EXIF)
      const compressed = await sharp(imageBuffer)
        .rotate() // Auto-rotate based on EXIF, then strip EXIF
        .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .withMetadata(false) // Explicitly strip all metadata
        .toBuffer();
      
      // Generate thumbnail - 150x150 cover crop, no metadata needed, target 15-30KB
      const thumbnail = await sharp(imageBuffer)
        .rotate() // Auto-rotate based on EXIF, then strip EXIF
        .resize(150, 150, { fit: 'cover' })
        .webp({ quality: 60 })
        .withMetadata(false) // Explicitly strip all metadata
        .toBuffer();
      
      console.log('Processed:', { 
        originalSize: imageBuffer.length, 
        compressedSize: compressed.length,
        thumbnailSize: thumbnail.length,
        compressionRatio: ((1 - compressed.length / imageBuffer.length) * 100).toFixed(1) + '%'
      });
      
      // Detect path pattern and generate appropriate keys
      const isMissionAttachments = key.startsWith('mission-attachments/');
      const isOrganizations = key.startsWith('organizations/');
      
      let finalKey, thumbnailKey;
      
      if (isMissionAttachments) {
        // Legacy mission-attachments behavior
        // Original stays at: mission-attachments/uploads/abc123-file.jpg
        // Compressed: mission-attachments/uploads/abc123-file.jpg → mission-attachments/abc123-file.jpg
        finalKey = key.replace('/uploads/', '/');
        // Thumbnail: mission-attachments/abc123-file.jpg → mission-attachments/thumb/abc123-file.webp
        thumbnailKey = finalKey.replace(/^(mission-attachments\/)/, '$1thumb/').replace(/\.(jpg|jpeg|png)$/i, '.webp');
      } else if (isOrganizations) {
        // Organization-scoped behavior
        // Original stays at: organizations/{org_id}/images/uploads/filename.jpg
        // Compressed: organizations/{org_id}/images/uploads/filename.jpg → organizations/{org_id}/images/filename.jpg
        finalKey = key.replace('/uploads/', '/');
        // Thumbnail: organizations/{org_id}/images/filename.jpg → organizations/{org_id}/images/thumb/filename.webp
        thumbnailKey = finalKey.replace(/\/images\//, '/images/thumb/').replace(/\.(jpg|jpeg|png)$/i, '.webp');
      } else {
        console.error('Unknown path pattern:', key);
        continue;
      }
      
      console.log('Processing paths:', { original: key, compressed: finalKey, thumbnail: thumbnailKey });
      
      // Original stays in /uploads/ folder with EXIF metadata preserved
      // Upload compressed to final location (no metadata)
      const putCommand = new PutObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        Body: compressed,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000', // 1 year cache
        Metadata: {
          'original-size': imageBuffer.length.toString(),
          'compressed-size': compressed.length.toString()
        }
      });
      
      await s3Client.send(putCommand);
      console.log('Uploaded compressed (no EXIF):', finalKey);
      
      // Write EXIF to companion DB table if extracted
      if (exifrOutput) {
        const photoUrl = `https://${bucket}.s3.us-west-2.amazonaws.com/${finalKey}`;
        const latitude = (exifrOutput.latitude !== undefined && !isNaN(exifrOutput.latitude)) ? exifrOutput.latitude : 'NULL';
        const longitude = (exifrOutput.longitude !== undefined && !isNaN(exifrOutput.longitude)) ? exifrOutput.longitude : 'NULL';
        const altitude = (exifrOutput.GPSAltitude !== undefined && !isNaN(exifrOutput.GPSAltitude)) ? exifrOutput.GPSAltitude : 'NULL';
        
        let capturedAt = 'NULL';
        if (exifrOutput.DateTimeOriginal) {
          const d = new Date(exifrOutput.DateTimeOriginal);
          if (!isNaN(d.getTime())) {
            capturedAt = `'${d.toISOString()}'`;
          }
        }
        
        const deviceMake = exifrOutput.Make ? `'${exifrOutput.Make.replace(/'/g, "''")}'` : 'NULL';
        const deviceModel = exifrOutput.Model ? `'${exifrOutput.Model.replace(/'/g, "''")}'` : 'NULL';
        
        const cleanExif = {};
        for (const [k, v] of Object.entries(exifrOutput)) {
          if (v instanceof Buffer || typeof v === 'object' && v !== null && v.constructor !== Object && !Array.isArray(v)) {
            continue;
          }
          cleanExif[k] = v;
        }
        const rawExifJson = JSON.stringify(cleanExif).replace(/'/g, "''");
        
        const sql = `
          INSERT INTO photo_metadata_extractions (
            photo_url, gps_latitude, gps_longitude, gps_altitude, captured_at, device_make, device_model, raw_exif
          )
          VALUES (
            '${photoUrl.replace(/'/g, "''")}', ${latitude}, ${longitude}, ${altitude}, ${capturedAt}, ${deviceMake}, ${deviceModel}, '${rawExifJson}'::jsonb
          )
          ON CONFLICT (photo_url)
          DO UPDATE SET
            gps_latitude = EXCLUDED.gps_latitude,
            gps_longitude = EXCLUDED.gps_longitude,
            gps_altitude = EXCLUDED.gps_altitude,
            captured_at = EXCLUDED.captured_at,
            device_make = EXCLUDED.device_make,
            device_model = EXCLUDED.device_model,
            raw_exif = EXCLUDED.raw_exif,
            updated_at = NOW();
        `;
        
        try {
          console.log('Writing EXIF metadata to DB for:', photoUrl);
          const dbResponse = await lambdaClient.send(new InvokeCommand({
            FunctionName: 'cwf-db-migration',
            Payload: JSON.stringify({ sql })
          }));
          const dbResult = JSON.parse(new TextDecoder().decode(dbResponse.Payload));
          console.log('EXIF database write result:', dbResult);
        } catch (dbErr) {
          console.error('Failed to write EXIF metadata to DB:', dbErr.message);
        }
      }
      
      // Upload thumbnail to thumb/ subfolder (no metadata)
      const putThumbnailCommand = new PutObjectCommand({
        Bucket: bucket,
        Key: thumbnailKey,
        Body: thumbnail,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000', // 1 year cache
      });
      
      await s3Client.send(putThumbnailCommand);
      console.log('Uploaded thumbnail:', thumbnailKey);
      
    } catch (error) {
      console.error('Error processing image:', error);
      // Don't throw - let other images process
    }
  }
  
  return { statusCode: 200 };
};

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
