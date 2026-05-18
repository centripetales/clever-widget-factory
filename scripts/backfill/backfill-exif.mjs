#!/usr/bin/env node
import pg from 'pg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import exifr from 'exifr';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const limitArg = args.find(a => a.startsWith('--limit='));
  return limitArg ? parseInt(limitArg.split('=')[1]) : null;
})();

// Get current directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env - parse .env.local manually
const envPath = path.join(__dirname, '..', '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

// Database client
const pool = new Pool({
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('Pool error (non-fatal):', err.message));

// S3 Client
const s3 = new S3Client({ region: 'us-west-2' });

async function main() {
  console.log('=== High-Speed EXIF & Diagnostics Metadata Backfill ===');
  if (DRY_RUN) console.log('(DRY RUN — no database updates will be written)\n');

  // Query all photos from state_photos starting with http
  const query = `
    SELECT photo_url 
    FROM state_photos
    WHERE photo_url LIKE 'http%'
    ORDER BY photo_url ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `;

  console.log('Fetching photo entries from database...');
  const result = await pool.query(query);
  const photos = result.rows;

  console.log(`Found ${photos.length} photos in database.\n`);

  if (photos.length === 0) {
    console.log('No photos to process.');
    await pool.end();
    return;
  }

  let processed = 0;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const photoUrl = photo.photo_url;
    processed++;

    console.log(`[${processed}/${photos.length}] Processing: ${photoUrl}`);

    try {
      if (!photoUrl || !photoUrl.startsWith('http')) {
        console.log(`  -> Skipping relative or invalid URL path`);
        success++;
        continue;
      }

      // Parse bucket and key from URL
      const parsedUrl = new URL(photoUrl);
      const bucket = parsedUrl.hostname.split('.')[0];
      const key = decodeURIComponent(parsedUrl.pathname.slice(1));

      // Translate public compressed key to original uncompressed uploads key
      let originalKey = key;
      if (key.includes('/images/') && !key.includes('/images/uploads/')) {
        originalKey = key.replace('/images/', '/images/uploads/');
      } else if (key.startsWith('mission-attachments/') && !key.startsWith('mission-attachments/uploads/')) {
        originalKey = key.replace('mission-attachments/', 'mission-attachments/uploads/');
      }

      console.log(`  -> S3 Range Request (64KB header): bucket=${bucket}, key=${originalKey}`);
      
      // Perform S3 Range Request to fetch only first 64KB
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: originalKey,
        Range: 'bytes=0-65535'
      }));

      // Consume stream to buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const headerBuffer = Buffer.concat(chunks);

      // Parse metadata using exifr
      const tags = await exifr.parse(headerBuffer, {
        gps: true,
        tiff: true,
        xmp: false,
        iptc: false
      });

      if (!tags) {
        throw new Error('Image header contains no valid EXIF segment');
      }

      const latitude = (tags.latitude !== undefined && !isNaN(tags.latitude)) ? tags.latitude : 'NULL';
      const longitude = (tags.longitude !== undefined && !isNaN(tags.longitude)) ? tags.longitude : 'NULL';
      const altitude = (tags.GPSAltitude !== undefined && !isNaN(tags.GPSAltitude)) ? tags.GPSAltitude : 'NULL';
      
      let capturedAt = 'NULL';
      if (tags.DateTimeOriginal) {
        const d = new Date(tags.DateTimeOriginal);
        if (!isNaN(d.getTime())) {
          capturedAt = `'${d.toISOString()}'`;
        }
      }
      
      const deviceMake = tags.Make ? `'${tags.Make.replace(/'/g, "''")}'` : 'NULL';
      const deviceModel = tags.Model ? `'${tags.Model.replace(/'/g, "''")}'` : 'NULL';
      
      // Clean raw_exif from complex sub-objects/buffers for clean JSONB serialization
      const cleanExif = {};
      for (const [k, v] of Object.entries(tags)) {
        if (v instanceof Buffer || typeof v === 'object' && v !== null && v.constructor !== Object && !Array.isArray(v)) {
          continue;
        }
        cleanExif[k] = v;
      }
      const rawExifJson = JSON.stringify(cleanExif).replace(/'/g, "''");

      console.log(`  -> Parsed metadata: Make=${tags.Make || 'N/A'}, Model=${tags.Model || 'N/A'}, Lat=${latitude}, Lng=${longitude}, Altitude=${altitude}`);

      if (DRY_RUN) {
        console.log('  -> DRY RUN (Skip database write)');
        success++;
        continue;
      }

      // Upsert into photo_metadata_extractions
      const upsertQuery = `
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

      await pool.query(upsertQuery);
      console.log('  -> Database updated successfully.');
      success++;

    } catch (err) {
      console.error(`  -> ERROR processing photo: ${err.message}`);
      failed++;
    }
  }

  console.log('\n=== Backfill Summary ===');
  console.log(`  Total Processed: ${processed}`);
  console.log(`  Successful:      ${success}`);
  console.log(`  Failed:          ${failed}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error in backfill script:', err);
  pool.end();
  process.exit(1);
});
