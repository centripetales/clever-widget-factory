#!/usr/bin/env node

/**
 * Batch Visual Analysis of all unprocessed Receipt/Expense photographs.
 * Utilizes AWS Bedrock Nova Pro multimodal vision capabilities.
 * 
 * Usage:
 *   # Dry run for all May expenses:
 *   node scripts/batch-analyze-expenses.js --may --dry-run
 * 
 *   # Process all May expenses:
 *   node scripts/batch-analyze-expenses.js --may
 */

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

// CLI parameters
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FILTER_MAY = args.includes('--may');
const FILTER_YEAR = (() => {
  const yearArg = args.find(a => a.startsWith('--year='));
  return yearArg ? parseInt(yearArg.split('=')[1], 10) : null;
})();
const LIMIT = (() => {
  const limitArg = args.find(a => a.startsWith('--limit='));
  return limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
})();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

async function fetchImageBytes(photoUrl) {
  let url = photoUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function getImageFormat(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'webp';
  return 'jpeg'; // Default fallback
}

async function main() {
  console.log('🚀 Initializing Batch Expense Visual Analysis...');
  console.log(`   Environment: AWS Region us-west-2`);
  console.log(`   Config: ${DRY_RUN ? 'DRY RUN (no DB mutations)' : 'LIVE RUN'}`);
  console.log(`   Filter: ${FILTER_MAY ? 'Month of May Only' : FILTER_YEAR ? `Year ${FILTER_YEAR} Only` : 'All Months'}`);
  console.log(`   Limit: ${LIMIT || 'No Limit'}`);
  console.log('-----------------------------------------------------\n');

  try {
    // 1. Fetch prompt configuration or seed it
    const paramRes = await pool.query(
      "SELECT * FROM photo_analysis_params WHERE prompt_key = 'photo_analysis' LIMIT 1"
    );

    let paramRow;
    if (paramRes.rows.length === 0) {
      console.log("Seeding default 'photo_analysis' prompt configuration for Nova Pro...");
      const insertRes = await pool.query(`
        INSERT INTO photo_analysis_params (prompt_key, model_id, version, system_prompt)
        VALUES (
          'photo_analysis',
          'us.amazon.nova-pro-v1:0',
          'v1.0',
          'Provide a detailed description of the photo to serve as semantic context for downstream AI agents. Include:\n1. Prominent physical objects and their counts (e.g. 3 water jugs, 4 bills).\n2. Object colors and key visual details.\n3. Scene context (where the objects are situated, the background, or what is happening).\n4. A clean transcription of any handwritten or printed text.\nNote: The application operates in the Philippines. Transcribe the currency symbol as ''₱'' (Philippine Peso) and never substitute it with ''$''.\nBe objective, direct, and factual.'
        ) RETURNING *;
      `);
      paramRow = insertRes.rows[0];
    } else {
      paramRow = paramRes.rows[0];
      // Force Nova Pro to ensure visual context requirements
      if (paramRow.model_id !== 'us.amazon.nova-pro-v1:0') {
        console.log(`Updating model_id to us.amazon.nova-pro-v1:0 for enhanced details...`);
        const updateRes = await pool.query(`
          UPDATE photo_analysis_params
          SET model_id = 'us.amazon.nova-pro-v1:0',
              system_prompt = 'Provide a detailed description of the photo to serve as semantic context for downstream AI agents. Include:\n1. Prominent physical objects and their counts (e.g. 3 water jugs, 4 bills).\n2. Object colors and key visual details.\n3. Scene context (where the objects are situated, the background, or what is happening).\n4. A clean transcription of any handwritten or printed text.\nNote: The application operates in the Philippines. Transcribe the currency symbol as ''₱'' (Philippine Peso) and never substitute it with ''$''.\nBe objective, direct, and factual.'
          WHERE prompt_key = 'photo_analysis'
          RETURNING *;
        `);
        paramRow = updateRes.rows[0];
      }
    }

    console.log(`🤖 Using Bedrock Model: ${paramRow.model_id}`);
    console.log(`📝 Loaded System Prompt Guidelines: \n"${paramRow.system_prompt.substring(0, 160)}..."`);
    console.log('-----------------------------------------------------\n');

    // 2. Query unprocessed receipt photos (with optional May filter)
    let query = `
      SELECT 
        sp.id AS photo_id,
        sp.photo_url,
        sp.state_id,
        sl.entity_id AS record_id,
        fr.organization_id,
        fr.created_by,
        fr.transaction_date
      FROM state_photos sp
      JOIN state_links sl ON sl.state_id = sp.state_id AND sl.entity_type = 'financial_record'
      JOIN financial_records fr ON sl.entity_id = fr.id
      LEFT JOIN state_links sl_trans ON sl_trans.entity_type = 'state_photo' AND sl_trans.entity_id = sp.id
      LEFT JOIN states s_trans ON sl_trans.state_id = s_trans.id AND s_trans.state_text LIKE '[photo_analysis]%'
      WHERE s_trans.id IS NULL
    `;

    const values = [];
    if (FILTER_MAY) {
      query += ` AND EXTRACT(MONTH FROM fr.transaction_date) = 5`;
    }
    if (FILTER_YEAR) {
      query += ` AND EXTRACT(YEAR FROM fr.transaction_date) = ${FILTER_YEAR}`;
    }

    query += ` ORDER BY fr.transaction_date DESC, fr.created_at DESC;`;

    const photosRes = await pool.query(query, values);
    const photos = photosRes.rows;
    console.log(`📊 Found ${photos.length} unprocessed receipt photos matching the criteria.`);

    if (photos.length === 0) {
      console.log('✅ Nothing to process. All matching photos are already transcribed!');
      return;
    }

    const itemsToProcess = LIMIT ? photos.slice(0, LIMIT) : photos;
    console.log(`👉 Selected ${itemsToProcess.length} photos for this batch run.\n`);

    if (DRY_RUN) {
      console.log('--- DRY RUN: Listing Selected Items ---');
      itemsToProcess.forEach((p, idx) => {
        console.log(`[${idx + 1}/${itemsToProcess.length}] Record: ${p.record_id} | Date: ${p.transaction_date} | Url: ${p.photo_url}`);
      });
      console.log('\nDry run complete. No database mutations or Bedrock calls were made.');
      return;
    }

    // 3. Process each photo sequential with rate-limit pauses
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];
      console.log(`[${i + 1}/${itemsToProcess.length}] Processing Photo ID: ${item.photo_id}`);
      console.log(`   Record: ${item.record_id} | S3 Url: ${item.photo_url}`);

      try {
        // Fetch image bytes
        console.log('   Downloading image bytes...');
        const bytes = await fetchImageBytes(item.photo_url);
        const format = getImageFormat(bytes);
        console.log(`   Downloaded successfully (${Math.round(bytes.length / 1024)} KB, format: ${format})`);

        // Multimodal API payload
        console.log(`   Invoking ${paramRow.model_id} via AWS Bedrock...`);
        const base64Data = bytes.toString('base64');
        const payload = {
          messages: [
            {
              role: "user",
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
                  text: "Describe this image based on the system instructions."
                }
              ]
            }
          ],
          system: [
            {
              text: paramRow.system_prompt
            }
          ],
          inferenceConfig: {
            maxTokens: 1000,
            temperature: 0.1
          }
        };

        const t0 = Date.now();
        const bedrockRes = await bedrockClient.send(new InvokeModelCommand({
          modelId: paramRow.model_id,
          body: JSON.stringify(payload),
          contentType: 'application/json',
          accept: 'application/json'
        }));
        const responseBody = JSON.parse(new TextDecoder().decode(bedrockRes.body));
        const text = responseBody?.output?.message?.content?.[0]?.text;
        const duration = Date.now() - t0;

        if (!text) {
          throw new Error('Empty text response received from Amazon Bedrock');
        }

        console.log(`   ✓ Analysis complete in ${duration}ms!`);
        console.log(`   --- DESCRIPTION ---`);
        console.log(text.trim());
        console.log(`   -------------------\n`);

        // Write to database inside transaction block
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Insert State
          const stateText = `[photo_analysis] ${text.trim()}`;
          const stateRes = await client.query(
            `INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
             VALUES (gen_random_uuid(), $1, $2, $3, NOW())
             RETURNING id`,
            [item.organization_id, stateText, item.created_by]
          );
          const stateId = stateRes.rows[0].id;

          // Insert State Link (state_photo)
          await client.query(
            `INSERT INTO state_links (id, state_id, entity_type, entity_id)
             VALUES (gen_random_uuid(), $1, 'state_photo', $2)`,
            [stateId, item.photo_id]
          );

          // Insert State Link (photo_analysis_param)
          await client.query(
            `INSERT INTO state_links (id, state_id, entity_type, entity_id)
             VALUES (gen_random_uuid(), $1, 'photo_analysis_param', $2)`,
            [stateId, paramRow.id]
          );

          await client.query('COMMIT');
          console.log(`   ✓ Persisted state ${stateId} and links successfully.\n`);
          succeeded++;
        } catch (dbErr) {
          await client.query('ROLLBACK');
          throw dbErr;
        } finally {
          client.release();
        }

      } catch (itemErr) {
        console.error(`   ✗ Processing Failed: ${itemErr.message}\n`);
        failed++;
      }

      // Safe Rate limit throttle delay between items
      if (i < itemsToProcess.length - 1) {
        console.log('   ⏱ Waiting 1500ms for Bedrock rate limits...');
        await new Promise(r => setTimeout(r, 1500));
        console.log('');
      }
    }

    console.log('=====================================================');
    console.log(`🎉 Batch Visual Analysis Session Complete.`);
    console.log(`   Succeeded: ${succeeded}`);
    console.log(`   Failed: ${failed}`);
    console.log('=====================================================');

  } catch (err) {
    console.error('Fatal execution error:', err);
  } finally {
    await pool.end();
  }
}

main();
