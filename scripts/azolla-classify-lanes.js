#!/usr/bin/env node

/**
 * Classifies each state's CLAIM_ATOMIC claims against the manually-curated
 * lane list (lambda/shared/azolla-state-lanes.js) via nearest-anchor cosine
 * similarity over Titan embeddings — not open-ended clustering. Each
 * canonical lane value is embedded once; each atomic claim is compared
 * against every lane value; if the best match for a lane clears the
 * similarity threshold, that lane is set to that value for this
 * observation. A lane with no claim clearing the threshold stays
 * "not_mentioned" — every observation gets a well-defined value on every
 * lane, never silently missing.
 *
 * Stores the result as a new STATE_LANES perspective (state_perspectives),
 * keyed by state_id, alongside CLAIM/CLAIM_ATOMIC — same table, same
 * append-only/versioned convention, no schema change needed.
 *
 * Usage:
 *   node scripts/azolla-classify-lanes.js --tool=<tool_id> [--dry-run] [--force]
 *   node scripts/azolla-classify-lanes.js --all-azolla [--dry-run] [--force]
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
const fs = require('fs');
const { STATE_LANES } = require('../lambda/shared/azolla-state-lanes');

const EMBED_MODEL_ID = 'amazon.titan-embed-text-v1';
const CLASSIFIER_VERSION = 'lane-classifier-v1';
const PERSPECTIVE_TYPE = 'STATE_LANES';
const SIMILARITY_THRESHOLD = 0.55;

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
const FORCE = args.includes('--force');
const ALL_AZOLLA = args.includes('--all-azolla');
const TOOL_ID = (() => {
  const a = args.find((x) => x.startsWith('--tool='));
  return a ? a.split('=')[1] : null;
})();
if (!TOOL_ID && !ALL_AZOLLA) {
  console.error('Usage: node scripts/azolla-classify-lanes.js --tool=<tool_id> | --all-azolla [--dry-run] [--force]');
  process.exit(1);
}

for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[v]) throw new Error(`${v} environment variable is required (check .env.local)`);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });

async function embed(text) {
  const command = new InvokeModelCommand({
    modelId: EMBED_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: text }),
  });
  const response = await bedrock.send(command);
  return JSON.parse(Buffer.from(response.body).toString()).embedding;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function buildAnchorEmbeddings() {
  // Flat list of { lane, value, description, embedding } for every
  // non-"not_mentioned" canonical value — "not_mentioned" is never matched
  // against, it's the default when nothing else clears the threshold.
  const anchors = [];
  for (const [lane, spec] of Object.entries(STATE_LANES)) {
    for (const [value, description] of Object.entries(spec.values)) {
      if (value === 'not_mentioned') continue;
      anchors.push({ lane, value, description, embedding: await embed(description) });
    }
  }
  return anchors;
}

async function getAllAzollaToolIds(client) {
  const r = await client.query(`SELECT id FROM tools WHERE name ILIKE '%''s Azolla Container%'`);
  return r.rows.map((row) => row.id);
}

async function fetchEligibleStates(client, toolId) {
  // DISTINCT ON, most-recent CLAIM_ATOMIC per state — earlier prompt
  // versions (v1/v2/v3) are preserved append-only, not deleted, so a plain
  // join would return one row per historical version of the same state.
  const sql = `
    SELECT DISTINCT ON (s.id) s.id AS state_id, sp.content AS atomic_content
    FROM state_links sl
    JOIN states s ON s.id = sl.state_id
    JOIN state_perspectives sp ON sp.state_id = s.id AND sp.perspective_type = 'CLAIM_ATOMIC'
    WHERE sl.entity_type = 'tool' AND sl.entity_id = $1
      ${FORCE ? '' : `AND NOT EXISTS (
        SELECT 1 FROM state_perspectives existing
        WHERE existing.state_id = s.id AND existing.perspective_type = '${PERSPECTIVE_TYPE}'
      )`}
    ORDER BY s.id, sp.created_at DESC
  `;
  const res = await client.query(sql, [toolId]);
  return res.rows;
}

async function classifyState(atomicContent, anchors, embedCache) {
  const claims = atomicContent.atomic_claims || [];
  // Best (lane, similarity) seen so far, per lane.
  const best = {};
  for (const claim of claims) {
    let claimEmbedding = embedCache.get(claim);
    if (!claimEmbedding) {
      claimEmbedding = await embed(claim);
      embedCache.set(claim, claimEmbedding);
    }
    for (const anchor of anchors) {
      const sim = cosineSim(claimEmbedding, anchor.embedding);
      if (sim >= SIMILARITY_THRESHOLD && (!best[anchor.lane] || sim > best[anchor.lane].similarity)) {
        best[anchor.lane] = { value: anchor.value, similarity: sim, matched_claim: claim };
      }
    }
  }
  // Fill in not_mentioned for every lane with no match above threshold.
  const result = {};
  for (const lane of Object.keys(STATE_LANES)) {
    result[lane] = best[lane] ? best[lane].value : 'not_mentioned';
  }
  return { lanes: result, evidence: best };
}

async function main() {
  console.log('STATE_LANES classification');
  console.log('===========================');
  console.log('Similarity threshold:', SIMILARITY_THRESHOLD);
  console.log('Dry run:', DRY_RUN, ' Force:', FORCE);
  console.log('');

  const client = await pool.connect();
  try {
    console.log('Building anchor embeddings for', Object.keys(STATE_LANES).length, 'lanes...');
    const anchors = await buildAnchorEmbeddings();
    console.log('Anchors ready:', anchors.length, 'canonical values.\n');

    const toolIds = ALL_AZOLLA ? await getAllAzollaToolIds(client) : [TOOL_ID];
    const embedCache = new Map();
    let totalProcessed = 0;

    for (const toolId of toolIds) {
      const states = await fetchEligibleStates(client, toolId);
      console.log(`Tool ${toolId}: ${states.length} eligible state(s).`);
      for (const row of states) {
        const { lanes, evidence } = await classifyState(row.atomic_content, anchors, embedCache);
        const activeLanes = Object.entries(lanes).filter(([, v]) => v !== 'not_mentioned');
        console.log(`  state ${row.state_id}: ${activeLanes.map(([l, v]) => `${l}=${v}`).join(', ') || '(nothing matched)'}`);

        if (!DRY_RUN) {
          const configCheck = await client.query(
            `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
            [EMBED_MODEL_ID, CLASSIFIER_VERSION]
          );
          let configId;
          if (configCheck.rows.length > 0) {
            configId = configCheck.rows[0].id;
          } else {
            const inserted = await client.query(
              `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [EMBED_MODEL_ID, CLASSIFIER_VERSION, 'N/A - deterministic nearest-anchor cosine similarity classifier, not a generative prompt', JSON.stringify({ similarity_threshold: SIMILARITY_THRESHOLD })]
            );
            configId = inserted.rows[0].id;
          }
          await client.query(
            `DELETE FROM state_perspectives WHERE state_id = $1 AND perspective_type = $2`,
            [row.state_id, PERSPECTIVE_TYPE]
          );
          await client.query(
            `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content)
             VALUES ($1, $2, $3, 'SUCCESS', $4)`,
            [row.state_id, PERSPECTIVE_TYPE, configId, JSON.stringify({ lanes, evidence })]
          );
        }
        totalProcessed++;
      }
    }

    console.log(`\nDone.${DRY_RUN ? ' (dry run — no DB writes)' : ` Classified ${totalProcessed} state(s).`}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
