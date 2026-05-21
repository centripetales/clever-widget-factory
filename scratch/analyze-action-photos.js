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

async function main() {
  const actionId = 'c685afab-1697-4fad-a414-caea960b7571';
  console.log(`🚀 Starting Nova Pro analysis on photos for Action ID: ${actionId}...\n`);

  // 1. Fetch the photo_analysis parameters
  const paramRes = await pool.query(
    "SELECT * FROM photo_analysis_params WHERE prompt_key = 'photo_analysis' LIMIT 1"
  );
  if (paramRes.rows.length === 0) {
    console.error('✗ photo_analysis prompt not found in database!');
    process.exit(1);
  }
  const params = paramRes.rows[0];
  console.log(`🤖 Model ID: ${params.model_id}`);
  console.log(`📝 System Prompt: \n"${params.system_prompt}"\n`);

  // 2. Fetch all state photos for the action
  const spRes = await pool.query(`
    SELECT sp.id, sp.photo_url, sp.photo_description
    FROM state_photos sp
    JOIN state_links sl ON sp.state_id = sl.state_id
    WHERE sl.entity_type = 'action' AND sl.entity_id = $1
    ORDER BY sp.photo_order ASC
  `, [actionId]);

  console.log(`Found ${spRes.rows.length} photos to analyze.`);

  const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });
  const userUuid = '08617390-b001-708d-f61e-07a1698282ec'; // Stefan Hamilton ID
  const orgId = '00000000-0000-0000-0000-000000000001';

  for (let i = 0; i < spRes.rows.length; i++) {
    const photo = spRes.rows[i];
    console.log(`\n-----------------------------------------`);
    console.log(`Analyzing Photo #${i + 1} of ${spRes.rows.length}`);
    console.log(`ID: ${photo.id}`);
    console.log(`URL: ${photo.photo_url}`);
    console.log(`User Desc: "${photo.photo_description || 'None'}"`);

    try {
      console.log('Downloading image bytes...');
      const response = await fetch(photo.photo_url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Data = buffer.toString('base64');
      
      let format = 'jpeg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        format = 'png';
      } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        format = 'webp';
      }
      const mediaType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';

      const payload = {
        messages: [
          {
            role: 'user',
            content: [
              {
                image: {
                  format: format,
                  source: {
                    bytes: base64Data
                  }
                }
              },
              {
                text: params.system_prompt
              }
            ]
          }
        ],
        system: [
          {
            text: "You are a professional assistant analyzing farmer logs and observations."
          }
        ],
        inferenceConfig: {
          maxTokens: params.inference_config?.max_tokens || 1000,
          temperature: params.inference_config?.temperature || 0.1
        }
      };

      console.log('Invoking Bedrock Nova Pro...');
      const command = new InvokeModelCommand({
        modelId: params.model_id,
        body: JSON.stringify(payload),
        contentType: 'application/json',
        accept: 'application/json'
      });

      const start = Date.now();
      const bedrockResponse = await bedrockClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
      const description = responseBody?.output?.message?.content?.[0]?.text;
      const latencySec = ((Date.now() - start) / 1000).toFixed(2);

      if (!description || !description.trim()) {
        throw new Error('Empty description returned from model');
      }

      console.log(`✓ Model completed in ${latencySec}s.`);
      console.log(`Description:\n"${description}"`);

      // Persist description state to database
      console.log('Persisting to database...');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Remove any existing photo_analysis state for this specific photo to keep it clean
        await client.query(`
          DELETE FROM states
          WHERE id IN (
            SELECT state_id FROM state_links
            WHERE entity_type = 'state_photo' AND entity_id = $1
          ) AND state_text LIKE '[photo_analysis]%'
        `, [photo.id]);

        const stateText = `[photo_analysis] ${description}`;
        const stateRes = await client.query(
          `INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
           VALUES (gen_random_uuid(), $1, $2, $3, NOW())
           RETURNING id`,
          [orgId, stateText, userUuid]
        );
        const stateId = stateRes.rows[0].id;
        
        // Link to state_photo
        await client.query(
          `INSERT INTO state_links (id, state_id, entity_type, entity_id)
           VALUES (gen_random_uuid(), $1, 'state_photo', $2)`,
          [stateId, photo.id]
        );

        // Link to photo_analysis_param
        await client.query(
          `INSERT INTO state_links (id, state_id, entity_type, entity_id)
           VALUES (gen_random_uuid(), $1, 'photo_analysis_param', $2)`,
          [stateId, params.id]
        );
        
        await client.query('COMMIT');
        console.log(`✓ Saved description state ID: ${stateId}`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.error('✗ DB save failed:', dbErr.message);
      } finally {
        client.release();
      }

    } catch (err) {
      console.error(`✗ Failed to analyze Photo ${photo.id}:`, err.message);
    }
  }

  await pool.end();
  console.log('\n🏁 Analysis run completed!');
}

main().catch(console.error);
