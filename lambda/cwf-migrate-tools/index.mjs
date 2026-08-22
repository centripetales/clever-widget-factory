import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import sharp from 'sharp';

const s3Client = new S3Client({ region: 'us-west-2' });
const BUCKET = 'cwf-dev-assets';

// Database connection
const dbConfig = {
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
};

async function executeQuery(sql, parameters = []) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    const result = await client.query(sql, parameters);
    return result;
  } finally {
    await client.end();
  }
}

async function getToolsToMigrate() {
  const result = await executeQuery(`
    SELECT t.id, t.name, t.image_url, t.organization_id
    FROM tools t
    WHERE t.image_url LIKE '%mission-attachments%'
    ORDER BY t.name
  `);
  
  return result.rows;
}

async function fileExists(key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound') return false;
    throw error;
  }
}

async function getImageFromS3(key) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const response = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uploadToS3(key, buffer, contentType) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  }));
}

async function generateThumbnail(sourceKey, targetKey) {
  console.log(`Generating thumbnail: ${sourceKey} -> ${targetKey}`);
  
  // Check if thumbnail already exists
  if (await fileExists(targetKey)) {
    console.log(`Thumbnail already exists: ${targetKey}`);
    return { skipped: true };
  }
  
  // Download original image
  const imageBuffer = await getImageFromS3(sourceKey);
  
  // Generate thumbnail. NOTE: .withMetadata(false) does NOT strip metadata
  // in this sharp version — it behaves like .withMetadata() with no args,
  // which preserves it (see cwf-image-compressor/index.mjs for how this was
  // found). Never calling .withMetadata() is what actually strips it.
  const thumbnail = await sharp(imageBuffer)
    .rotate() // Auto-rotate based on EXIF
    .resize(150, 150, { fit: 'cover', position: 'center' })
    .webp({ quality: 60 })
    .toBuffer();
  
  // Upload thumbnail
  await uploadToS3(targetKey, thumbnail, 'image/webp');
  
  return { 
    size: thumbnail.length,
    skipped: false
  };
}

async function migrateTool(tool) {
  console.log(`\n=== Migrating tool: ${tool.name} (${tool.id}) ===`);
  
  try {
    // Parse the old URL
    const url = new URL(tool.image_url);
    const oldKey = url.pathname.substring(1); // Remove leading /
    console.log(`Old key: ${oldKey}`);
    
    // Extract filename from old path
    const filename = oldKey.split('/').pop();
    
    // Build new paths
    const newKey = `organizations/${tool.organization_id}/images/${filename}`;
    const newUrl = `https://${BUCKET}.s3.us-west-2.amazonaws.com/${newKey}`;
    
    // Build thumbnail paths
    const filenameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
    const thumbKey = `organizations/${tool.organization_id}/images/thumb/${filenameWithoutExt}.webp`;
    
    console.log(`New key: ${newKey}`);
    console.log(`Thumbnail key: ${thumbKey}`);
    
    // Check if source file exists
    if (!await fileExists(oldKey)) {
      console.log(`Source file not found: ${oldKey}`);
      return {
        success: false,
        error: 'Source file not found',
        tool_id: tool.id,
        tool_name: tool.name,
      };
    }
    
    // Copy file to new location (if not already there)
    if (!await fileExists(newKey)) {
      console.log(`Copying file: ${oldKey} -> ${newKey}`);
      await s3Client.send(new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${oldKey}`,
        Key: newKey,
        MetadataDirective: 'REPLACE',
        CacheControl: 'public, max-age=31536000',
      }));
    } else {
      console.log(`File already exists at new location: ${newKey}`);
    }
    
    // Generate thumbnail
    const thumbResult = await generateThumbnail(newKey, thumbKey);
    
    // Update database
    console.log(`Updating database: ${tool.id}`);
    await executeQuery(
      `UPDATE tools SET image_url = $1 WHERE id = $2`,
      [newUrl, tool.id]
    );
    
    return {
      success: true,
      tool_id: tool.id,
      tool_name: tool.name,
      old_url: tool.image_url,
      new_url: newUrl,
      thumbnail_generated: !thumbResult.skipped,
      thumbnail_size: thumbResult.size || 0,
    };
    
  } catch (error) {
    console.error(`Error migrating tool ${tool.name}:`, error);
    return {
      success: false,
      error: error.message,
      tool_id: tool.id,
      tool_name: tool.name,
    };
  }
}

export const handler = async (event) => {
  console.log('Starting tool image migration...');
  
  try {
    // Get all tools to migrate
    const tools = await getToolsToMigrate();
    console.log(`Found ${tools.length} tools to migrate`);
    
    if (tools.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No tools to migrate',
          total: 0,
          successful: 0,
          failed: 0,
        }),
      };
    }
    
    // Migrate each tool
    const results = [];
    for (const tool of tools) {
      const result = await migrateTool(tool);
      results.push(result);
    }
    
    // Calculate statistics
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const totalThumbnailSize = successful.reduce((sum, r) => sum + (r.thumbnail_size || 0), 0);
    
    console.log('\n=== Migration Summary ===');
    console.log(`Total tools: ${tools.length}`);
    console.log(`Successful: ${successful.length}`);
    console.log(`Failed: ${failed.length}`);
    console.log(`Total thumbnail size: ${(totalThumbnailSize / 1024).toFixed(2)} KB`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Migration complete',
        total: tools.length,
        successful: successful.length,
        failed: failed.length,
        totalThumbnailSize: totalThumbnailSize,
        results: results,
      }, null, 2),
    };
    
  } catch (error) {
    console.error('Migration failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: error.stack,
      }),
    };
  }
};
