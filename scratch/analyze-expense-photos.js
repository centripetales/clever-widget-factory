const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
const fs = require('fs');

// Load environment variables from .env.local
const envPath = path.join(__dirname, '..', '.env.local');
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

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-west-2' });

async function main() {
  const recordId = '2fa23cfa-81cb-458d-a3a9-ceaab6e5f58d';
  console.log(`🚀 Analyzing photos for Financial Record: ${recordId}\n`);

  // 1. Get photo_analysis params
  const paramRes = await pool.query(
    "SELECT * FROM photo_analysis_params WHERE prompt_key = 'photo_analysis' LIMIT 1"
  );
  if (paramRes.rows.length === 0) {
    console.error('✗ photo_analysis prompt not found in database!');
    process.exit(1);
  }
  const params = paramRes.rows[0];
  console.log(`Using model: ${params.model_id}`);
  console.log(`Prompt: ${params.system_prompt.substring(0, 80)}...\n`);

  // 2. Get linked state
  const stateLink = await pool.query(
    `SELECT sl.state_id FROM state_links sl
     WHERE sl.entity_id = $1 AND sl.entity_type = 'financial_record'`,
    [recordId]
  );
  if (stateLink.rows.length === 0) {
    console.error('No state linked to this financial record');
    process.exit(1);
  }
  const stateId = stateLink.rows[0].state_id;

  // 3. Get photos without existing analysis
  const photos = await pool.query(
    `SELECT sp.id, sp.photo_url, sp.photo_description, sp.photo_order
     FROM state_photos sp
     WHERE sp.state_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM state_links sl2
         JOIN states s2 ON sl2.state_id = s2.id
         WHERE sl2.entity_type = 'state_photo'
           AND sl2.entity_id = sp.id
           AND s2.state_text LIKE '[photo_analysis]%'
       )
     ORDER BY sp.photo_order`,
    [stateId]
  );

  console.log(`Found ${photos.rows.length} photos without analysis\n`);

  for (const photo of photos.rows) {
    console.log(`📷 Analyzing photo ${photo.photo_order}: ${photo.photo_url.split('/').pop()}`);

    try {
      // Download the image
      const response = await fetch(photo.photo_url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Data = buffer.toString('base64');

      // Detect format from magic bytes
      let format = 'jpeg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        format = 'png';
      } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        format = 'webp';
      }
      const mediaType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      console.log(`  Format detected: ${mediaType} (${(buffer.length / 1024).toFixed(0)} KB)`);

      // Call Bedrock
      const command = new InvokeModelCommand({
        modelId: params.model_id,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: [
              { image: { format, source: { bytes: base64Data } } },
              { text: params.system_prompt }
            ]
          }],
          inferenceConfig: { maxTokens: 1024, temperature: 0.2 }
        })
      });

      const result = await bedrock.send(command);
      const body = JSON.parse(new TextDecoder().decode(result.body));
      const description = body.output?.message?.content?.[0]?.text;

      if (!description || !description.trim()) {
        throw new Error('Empty transcription returned from model');
      }

      console.log(`  ✓ Got description: ${description.substring(0, 100)}...`);

      // Get organization_id from the state
      const orgRes = await pool.query('SELECT organization_id FROM states WHERE id = $1', [stateId]);
      const orgId = orgRes.rows[0].organization_id;

      // Insert the analysis state
      const stateText = `[photo_analysis] ${description}`;
      const insertRes = await pool.query(
        `INSERT INTO states (organization_id, state_text, captured_by, captured_at, created_at, updated_at)
         VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', NOW(), NOW(), NOW())
         RETURNING id`,
        [orgId, stateText]
      );
      const analysisStateId = insertRes.rows[0].id;

      // Link to the photo
      await pool.query(
        `INSERT INTO state_links (state_id, entity_type, entity_id)
         VALUES ($1, 'state_photo', $2)`,
        [analysisStateId, photo.id]
      );

      // Link to the analysis params
      await pool.query(
        `INSERT INTO state_links (state_id, entity_type, entity_id)
         VALUES ($1, 'photo_analysis_param', $2)`,
        [analysisStateId, params.id]
      );

      console.log(`  ✓ Saved analysis state: ${analysisStateId}\n`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}\n`);
    }
  }

  console.log('Done!');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
