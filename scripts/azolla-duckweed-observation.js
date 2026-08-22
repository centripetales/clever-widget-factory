#!/usr/bin/env node

/**
 * Offline vision-LLM perspective for azolla program photos. Runs Sonnet on each
 * photo ALONE (no participant caption/description as input) and stores the result
 * as an AZOLLA_DUCKWEED_OBSERVATION perspective, linked back to the source photo
 * via state_links (entity_type = 'state_photo') — same tie-back pattern as
 * growth-color-metrics.js, so a later per-person summary pass can read both the
 * algorithmic pixel metrics and this structured LLM read for every photo.
 *
 * Scoping: --since filters by ORGANIZATION signup date, not photo capture date —
 * see growth-color-metrics.js for why. --exclude is a safety net against
 * admin/staff posting into a real participant org directly.
 *
 * Usage:
 *   node scripts/azolla-duckweed-observation.js --dry-run
 *   node scripts/azolla-duckweed-observation.js --since=2026-07-19 --exclude=Mae,Stefan
 *   node scripts/azolla-duckweed-observation.js --participant=Wilfred --dry-run
 *   node scripts/azolla-duckweed-observation.js --limit=5 --dry-run
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
const fs = require('fs');

const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const PROMPT_VERSION = 'azolla-duckweed-v1';

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

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINCE = (() => {
  const a = args.find(a => a.startsWith('--since='));
  return a ? a.split('=')[1] : '2026-07-19';
})();
const LIMIT = (() => {
  const a = args.find(a => a.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const EXCLUDE_NAMES = (() => {
  const a = args.find(a => a.startsWith('--exclude='));
  return (a ? a.split('=')[1] : 'Mae,Stefan').split(',').map(s => s.trim()).filter(Boolean);
})();
const PARTICIPANT = (() => {
  const a = args.find(a => a.startsWith('--participant='));
  return a ? a.split('=')[1] : null;
})();
const ACTION_ID = (() => {
  const a = args.find(a => a.startsWith('--action='));
  return a ? a.split('=')[1] : null;
})();

for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[v]) throw new Error(`${v} environment variable is required (check .env.local)`);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });

const TOOL_SCHEMA = {
  name: 'record_growth_observation',
  description: 'Record structured, purely observational data extracted from an azolla/duckweed cultivation photo.',
  input_schema: {
    type: 'object',
    properties: {
      vessel_present: { type: 'boolean' },
      vessel_type: { type: 'string' },
      vessel_frame_occupancy_percent: { type: ['number', 'null'], description: 'Rough estimate of what percent of the frame the vessel occupies. Null if vessel_present is false or not determinable.' },
      plant_material_visible: { type: 'boolean' },
      plant_sample_points: {
        type: 'array',
        description: '1-3 points (fractions of frame width/height, 0.0-1.0) that fall on visible plant material.',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
          },
          required: ['x', 'y', 'confidence']
        }
      },
      plant_coverage_percent_estimate: { type: ['number', 'null'], description: 'Estimate as a percentage of the visible water surface, not the whole photo frame.' },
      water_visible_percent_estimate: { type: ['number', 'null'] },
      dominant_plant_color: { type: 'string', enum: ['green', 'yellow-green', 'red-tinged', 'brown', 'mixed', 'not_visible'] },
      species_guess: { type: 'string', enum: ['azolla', 'duckweed', 'mixed', 'indistinguishable', 'not_visible'] },
      species_guess_basis: { type: 'string' },
      lighting_condition: { type: 'string', enum: ['direct_sun', 'shade', 'overcast', 'indoor', 'backlit', 'unknown'] },
      frame_contains_non_vessel_vegetation: { type: 'boolean', description: 'True if there is visible plant material in the frame that is clearly not inside/part of the vessel (e.g. background leaves, garden plants).' },
      most_interesting_observation: { type: 'string', description: 'The single most noteworthy, specific thing visible in this photo that a quick glance might miss. State ONLY what is directly visible (position, count, shape, color, arrangement) — do not infer a cause, mechanism, or explanation for why it looks that way. If you cannot confidently identify what an object or feature specifically is, describe its visible properties (shape, color, size, position) rather than naming what it is — e.g. write "an elongated white streak" rather than "a pipette" unless you are certain. A hedged, generic description is more useful than a specific but unconfirmed one.' },
      notable_organisms_visible: {
        type: 'array',
        description: 'Any animals, insects, or other organisms directly visible in the photo that are not the azolla/duckweed crop itself (e.g. a duck, a frog, tadpoles, insects). One short factual description per organism (what it is or looks like, roughly where in the frame). State only what is visible — do not infer whether it is beneficial, harmful, or why it is there. Empty array if none visible.',
        items: { type: 'string' }
      },
      uncertainty_flags: { type: 'array', items: { type: 'string' } }
    },
    required: ['vessel_present', 'vessel_type', 'plant_material_visible', 'plant_sample_points', 'dominant_plant_color', 'species_guess', 'species_guess_basis', 'lighting_condition', 'frame_contains_non_vessel_vegetation', 'most_interesting_observation', 'notable_organisms_visible', 'uncertainty_flags']
  }
};

const SYSTEM_PROMPT = `You are a data extraction system supporting azolla/duckweed cultivation. Your only job is to report what is directly visible in the photo, as structured data. Do not assess health, growth quality, or compare against an ideal state. If something can't be determined from the image, say so explicitly in uncertainty_flags rather than guessing.

This program cultivates azolla and duckweed as part of a research trial in the Philippines.

When choosing plant_sample_points, only pick points that fall on visible plant material — never on open water, container walls, or background. These points seed an automated image segmentation step, and a point on the wrong thing will make that step segment the wrong object entirely. If you are not confident a point lands on plant material, mark its confidence as "low" rather than omitting it.`;

async function fetchImageBytes(photoUrl) {
  let url = photoUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function runObservation(imageBuffer) {
  const base64Data = imageBuffer.toString('base64');
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Data } }]
    }],
    tools: [{ name: TOOL_SCHEMA.name, description: TOOL_SCHEMA.description, input_schema: TOOL_SCHEMA.input_schema }],
    tool_choice: { type: 'tool', name: TOOL_SCHEMA.name }
  };
  const command = new InvokeModelCommand({ modelId: MODEL_ID, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) });
  const response = await bedrockRuntime.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const toolUse = responseBody.content.find(c => c.type === 'tool_use');
  if (!toolUse) throw new Error('No tool_use block in response: ' + JSON.stringify(responseBody));
  return toolUse.input;
}

async function getOrCreateModelConfig(client) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
    [MODEL_ID, PROMPT_VERSION]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [MODEL_ID, PROMPT_VERSION, SYSTEM_PROMPT, JSON.stringify({ max_tokens: 1000, temperature: 0 })]
  );
  return inserted.rows[0].id;
}

async function fetchEligiblePhotos(client) {
  // Action-scoped path: Stefan/Mae's data doesn't live under their own org (it's
  // under the shared "Stargazer Farm" org, alongside unrelated farm activity), so
  // their real scope is a specific action, not an org — same distinction made for
  // the payment counts earlier in this project.
  if (ACTION_ID) {
    const sql = `
      SELECT sp.id AS photo_id, sp.photo_url, s.id AS state_id, s.organization_id, s.captured_by, s.captured_at,
             a.title AS participant_name
      FROM state_links sl
      JOIN states s ON s.id = sl.state_id
      JOIN state_photos sp ON sp.state_id = s.id
      JOIN actions a ON a.id = sl.entity_id
      WHERE sl.entity_type = 'action' AND sl.entity_id = $1
        AND sp.photo_url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM state_links sl2
          JOIN state_perspectives sper ON sper.state_id = sl2.state_id
          WHERE sl2.entity_type = 'state_photo' AND sl2.entity_id = sp.id
            AND sper.perspective_type = 'AZOLLA_DUCKWEED_OBSERVATION'
        )
      ORDER BY s.captured_at ASC
      ${LIMIT ? `LIMIT ${LIMIT}` : ''}
    `;
    const res = await client.query(sql, [ACTION_ID]);
    return res.rows;
  }

  const params = [SINCE];
  let participantClause = '';
  let excludeClause = '';

  if (PARTICIPANT) {
    params.push(`%${PARTICIPANT}%`);
    participantClause = `AND o.name ILIKE $${params.length}`;
  } else {
    const excludeClauses = EXCLUDE_NAMES.map((_, i) => {
      params.push(`%${EXCLUDE_NAMES[i]}%`);
      return `COALESCE(om.full_name, '') NOT ILIKE $${params.length}`;
    });
    excludeClause = excludeClauses.length ? `AND ${excludeClauses.join(' AND ')}` : '';
  }

  const sql = `
    SELECT sp.id AS photo_id, sp.photo_url, s.id AS state_id, s.organization_id, s.captured_by, s.captured_at,
           o.name AS participant_name
    FROM state_photos sp
    JOIN states s ON sp.state_id = s.id
    JOIN organizations o ON o.id = s.organization_id
    LEFT JOIN organization_members om ON om.user_id = s.captured_by AND om.organization_id = s.organization_id
    WHERE o.created_at >= $1
      AND sp.photo_url IS NOT NULL
      ${participantClause}
      ${excludeClause}
      AND NOT EXISTS (
        SELECT 1 FROM state_links sl
        JOIN state_perspectives sper ON sper.state_id = sl.state_id
        WHERE sl.entity_type = 'state_photo' AND sl.entity_id = sp.id
          AND sper.perspective_type = 'AZOLLA_DUCKWEED_OBSERVATION'
      )
    ORDER BY s.captured_at ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `;
  const res = await client.query(sql, params);
  return res.rows;
}

async function storeObservation(client, photo, result, configId) {
  await client.query('BEGIN');
  try {
    const stateRes = await client.query(
      `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [photo.organization_id, '[azolla_duckweed_observation] vision LLM structured extraction', photo.captured_by]
    );
    const derivedStateId = stateRes.rows[0].id;

    await client.query(
      `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'state_photo', $2)`,
      [derivedStateId, photo.photo_id]
    );

    // No dedicated child table — see migration 020. Structured output lives
    // directly in state_perspectives.content.
    const perspRes = await client.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content)
       VALUES ($1, 'AZOLLA_DUCKWEED_OBSERVATION', $2, 'SUCCESS', $3) RETURNING id`,
      [derivedStateId, configId, JSON.stringify(result)]
    );
    const perspectiveId = perspRes.rows[0].id;

    await client.query('COMMIT');
    return { derivedStateId, perspectiveId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  console.log('Azolla/Duckweed Observation (vision LLM, offline)');
  console.log('===================================================');
  console.log(`Since: ${SINCE}`);
  console.log(PARTICIPANT ? `Participant filter: ${PARTICIPANT}` : `Excluding participants matching: ${EXCLUDE_NAMES.join(', ')}`);
  console.log(`Limit: ${LIMIT || 'none'}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('');

  const client = await pool.connect();
  const results = { total: 0, success: 0, failed: 0 };
  try {
    const configId = DRY_RUN ? null : await getOrCreateModelConfig(client);
    const photos = await fetchEligiblePhotos(client);
    results.total = photos.length;
    console.log(`Found ${photos.length} eligible photos.\n`);

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      console.log(`[${i + 1}/${photos.length}] ${photo.participant_name} — photo ${photo.photo_id} (state ${photo.state_id}, captured ${photo.captured_at})`);
      console.log(`  photo_url: ${photo.photo_url}`);
      try {
        const imageBuffer = await fetchImageBytes(photo.photo_url);
        const result = await runObservation(imageBuffer);
        console.log(`  species_guess=${result.species_guess} coverage=${result.plant_coverage_percent_estimate}% observation="${result.most_interesting_observation}"`);

        if (DRY_RUN) {
          console.log('  [DRY RUN] not writing to DB');
        } else {
          const stored = await storeObservation(client, photo, result, configId);
          console.log(`  stored perspective ${stored.perspectiveId} on derived state ${stored.derivedStateId}`);
        }
        results.success++;
      } catch (err) {
        console.error(`  FAILED: ${err.message}`);
        results.failed++;
      }
      console.log('');
    }
  } finally {
    client.release();
  }

  console.log('Summary');
  console.log('=======');
  console.log(`Total: ${results.total}`);
  console.log(`Success: ${results.success}`);
  console.log(`Failed: ${results.failed}`);
  if (DRY_RUN) console.log('\nThis was a dry run. No DB rows were written.');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
