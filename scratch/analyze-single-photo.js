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
  const photoId = '419472c9-b05a-475b-a898-94b3a036f035';
  console.log(`🚀 Starting manual analysis for photo ID: ${photoId}\n`);

  try {
    // 1. Fetch photo details
    const photoRes = await pool.query('SELECT * FROM state_photos WHERE id = $1', [photoId]);
    if (photoRes.rows.length === 0) {
      console.error(`✗ Photo not found: ${photoId}`);
      process.exit(1);
    }
    const photo = photoRes.rows[0];
    console.log(`Photo URL: ${photo.photo_url}`);
    console.log(`Photo Description: "${photo.photo_description}"`);

    // 2. Fetch analysis params
    const paramRes = await pool.query("SELECT * FROM photo_analysis_params WHERE prompt_key = 'photo_analysis' LIMIT 1");
    if (paramRes.rows.length === 0) {
      console.error('✗ photo_analysis prompt not found in database!');
      process.exit(1);
    }
    const params = paramRes.rows[0];
    console.log(`Model ID: ${params.model_id}`);

    // 3. Download the image bytes
    console.log('Downloading image bytes...');
    const response = await fetch(photo.photo_url);
    if (!response.ok) {
      throw new Error(`HTTP fetch failed with status: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = buffer.toString('base64');

    let mediaType = 'image/jpeg';
    if (photo.photo_url.toLowerCase().endsWith('.png')) mediaType = 'image/png';
    if (photo.photo_url.toLowerCase().endsWith('.webp')) mediaType = 'image/webp';

    // 4. Invoke Bedrock Nova Pro
    console.log('Invoking Bedrock Nova Pro...');
    const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });
    
    function buildPayload(fmt) {
      return {
        messages: [
          {
            role: "user",
            content: [
              {
                image: {
                  format: fmt,
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
    }

    let description;
    let responseBody;
    
    try {
      const formatStr = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpeg';
      const command = new InvokeModelCommand({
        modelId: params.model_id,
        body: JSON.stringify(buildPayload(formatStr)),
        contentType: 'application/json',
        accept: 'application/json'
      });
      const bedrockResponse = await bedrockClient.send(command);
      responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
      description = responseBody?.output?.message?.content?.[0]?.text;
    } catch (err) {
      if (err.message && err.message.includes('image/jpeg')) {
        console.warn('⚠️ Detected MIME mismatch. Retrying with JPEG format...');
        const command = new InvokeModelCommand({
          modelId: params.model_id,
          body: JSON.stringify(buildPayload('jpeg')),
          contentType: 'application/json',
          accept: 'application/json'
        });
        const bedrockResponse = await bedrockClient.send(command);
        responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
        description = responseBody?.output?.message?.content?.[0]?.text;
      } else {
        throw err;
      }
    }

    if (!description || !description.trim()) {
      throw new Error('Empty description returned from Bedrock');
    }

    console.log(`\n✓ Model description generated:\n"${description}"\n`);

    // 5. Persist to database
    console.log('Persisting to database...');
    await pool.query('BEGIN');

    const userUuid = '08617390-b001-708d-f61e-07a1698282ec'; // Stefan Hamilton ID

    const insertStateSql = `
      INSERT INTO states (organization_id, state_text, captured_by, captured_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id
    `;
    const stateRes = await pool.query(insertStateSql, [
      '00000000-0000-0000-0000-000000000001',
      `[photo_analysis] ${description}`,
      userUuid
    ]);
    const transStateId = stateRes.rows[0].id;

    // Link state_photo
    await pool.query(`
      INSERT INTO state_links (state_id, entity_type, entity_id)
      VALUES ($1, 'state_photo', $2)
    `, [transStateId, photoId]);

    // Link photo_analysis_param
    await pool.query(`
      INSERT INTO state_links (state_id, entity_type, entity_id)
      VALUES ($1, 'photo_analysis_param', $2)
    `, [transStateId, params.id]);

    await pool.query('COMMIT');
    console.log(`✓ Successfully created analysis state with ID: ${transStateId}`);

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('✗ Failed manual analysis:', err);
  } finally {
    await pool.end();
  }
}

main();
