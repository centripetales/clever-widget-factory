/**
 * Lambda function to migrate observation photos from mission-attachments to organizations
 * Uses S3 CopyObject (no download/upload) and generates thumbnails
 */

import { S3Client, CopyObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import sharp from 'sharp';

const s3Client = new S3Client({ region: 'us-west-2' });
const BUCKET = 'cwf-dev-assets';

// Database connection
const dbConfig = {
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
};

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function migratePhoto(photo, orgId) {
  const { id, photo_url } = photo;
  
  // Extract S3 key from URL
  let oldKey = photo_url;
  if (photo_url.startsWith('http')) {
    oldKey = photo_url.replace(/^https?:\/\/[^\/]+\//, '');
  }
  
  // Skip if already migrated
  if (oldKey.startsWith('organizations/')) {
    return { success: true, skipped: true, reason: 'already migrated' };
  }
  
  // Generate new key
  const filename = oldKey.split('/').pop();
  const newKey = `organizations/${orgId}/images/${filename}`;
  const thumbnailKey = newKey
    .replace(/\/images\//, '/images/thumb/')
    .replace(/\.(jpg|jpeg|png)$/i, '.webp');
  
  try {
    // Download original (need to process for thumbnail)
    const getCommand = new GetObjectCommand({ Bucket: BUCKET, Key: oldKey });
    const response = await s3Client.send(getCommand);
    const imageBuffer = await streamToBuffer(response.Body);
    const originalSize = imageBuffer.length;
    
    // Compress with metadata stripped. NOTE: .withMetadata(false) does NOT
    // strip metadata in this sharp version — it behaves like .withMetadata()
    // with no args, which preserves it (see cwf-image-compressor/index.mjs
    // for how this was found). Never calling .withMetadata() is what
    // actually strips it.
    const compressed = await sharp(imageBuffer)
      .rotate()
      .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    // Upload compressed to new location
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: newKey,
      Body: compressed,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000',
    }));

    // Generate and upload thumbnail
    const thumbnail = await sharp(imageBuffer)
      .rotate()
      .resize(150, 150, { fit: 'cover' })
      .webp({ quality: 60 })
      .toBuffer();
    
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: thumbnailKey,
      Body: thumbnail,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000',
    }));
    
    return {
      success: true,
      id,
      oldKey,
      newKey,
      thumbnailKey,
      originalSize,
      compressedSize: compressed.length,
      thumbnailSize: thumbnail.length
    };
    
  } catch (error) {
    console.error(`Failed to migrate photo ${id}:`, error);
    return {
      success: false,
      id,
      oldKey,
      error: error.message
    };
  }
}

async function updatePhotoUrl(client, photoId, newUrl) {
  const query = `
    UPDATE state_photos
    SET photo_url = $1
    WHERE id = $2
    RETURNING id, photo_url
  `;
  
  const result = await client.query(query, [newUrl, photoId]);
  return result.rows[0];
}

export const handler = async (event) => {
  console.log('Starting observation photo migration...');
  
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    // Query photos that need migration
    const query = `
      SELECT sp.id, sp.photo_url, sp.state_id, sl.entity_id, a.organization_id
      FROM state_photos sp
      JOIN states s ON sp.state_id = s.id
      JOIN state_links sl ON s.id = sl.state_id
      LEFT JOIN actions a ON sl.entity_id = a.id AND sl.entity_type = 'action'
      WHERE sp.photo_url LIKE '%mission-attachments%'
      ORDER BY sp.id
    `;
    
    const result = await client.query(query);
    const photos = result.rows;
    
    console.log(`Found ${photos.length} photos to migrate`);
    
    if (photos.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'No photos to migrate',
          stats: { total: 0, migrated: 0, failed: 0, skipped: 0 }
        })
      };
    }
    
    const results = [];
    const stats = {
      total: photos.length,
      migrated: 0,
      failed: 0,
      skipped: 0,
      totalOriginalSize: 0,
      totalCompressedSize: 0,
      totalThumbnailSize: 0
    };
    
    // Process each photo
    for (const photo of photos) {
      // Use organization_id from action, or default
      const orgId = photo.organization_id || '00000000-0000-0000-0000-000000000001';
      
      console.log(`Migrating photo ${photo.id}...`);
      const result = await migratePhoto(photo, orgId);
      results.push(result);
      
      if (result.success) {
        if (result.skipped) {
          stats.skipped++;
        } else {
          // Update database
          await updatePhotoUrl(client, photo.id, result.newKey);
          stats.migrated++;
          stats.totalOriginalSize += result.originalSize || 0;
          stats.totalCompressedSize += result.compressedSize || 0;
          stats.totalThumbnailSize += result.thumbnailSize || 0;
        }
      } else {
        stats.failed++;
      }
    }
    
    console.log('Migration complete:', stats);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        stats,
        results: results.map(r => ({
          id: r.id,
          success: r.success,
          skipped: r.skipped,
          oldKey: r.oldKey,
          newKey: r.newKey,
          error: r.error
        }))
      })
    };
    
  } catch (error) {
    console.error('Migration failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  } finally {
    await client.end();
  }
};
