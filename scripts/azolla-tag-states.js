#!/usr/bin/env node

/**
 * Human-judged state tagging for the state-transition graph
 * (docs/specs/azolla-impact-power-model.md §9). v1 classification is NOT
 * AI-generated — "these are states and people can be the judge of them for
 * now" — this script just records a person's own tag choices as a new
 * STATE_OBSERVATION_TAGS perspective, reusing the existing state_perspectives
 * mechanism the same way the (deterministic, non-model) GROWTH_COLOR_METRICS
 * perspective did (migration 011) — provenance is distinguished purely by
 * perspective_type, no schema change needed.
 *
 * Scope: only states that are actually part of a closed experience
 * (experience_components.component_type IN ('initial_state','final_state'))
 * — matches the graph's own scope, no point tagging a state nothing will
 * ever plot.
 *
 * Usage:
 *   node scripts/azolla-tag-states.js <tool_id> --list          # show untagged states + their CLAIM text
 *   node scripts/azolla-tag-states.js <tool_id> --file=tags.json  # apply tags from a JSON file
 *
 * tags.json shape: { "<state_id>": { "azolla_color": "dark_green", "azolla_size": "small", ... }, ... }
 * Any dimension can be omitted if not applicable/visible in that observation.
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { STATE_DIMENSIONS } = require('../lambda/shared/azolla-state-dimensions');

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

const TOOL_ID = process.argv[2];
const LIST_MODE = process.argv.includes('--list');
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const TAGS_FILE = fileArg ? fileArg.split('=')[1] : null;

if (!TOOL_ID || (!LIST_MODE && !TAGS_FILE)) {
  console.error('Usage:');
  console.error('  node scripts/azolla-tag-states.js <tool_id> --list');
  console.error('  node scripts/azolla-tag-states.js <tool_id> --file=tags.json');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

const PERSPECTIVE_TYPE = 'STATE_OBSERVATION_TAGS';
// Sentinel config row for human-authored perspectives — state_perspectives'
// llm_generation_config_id is NOT NULL, but this row isn't model-generated
// (same "algorithm/human, not a model" provenance case GROWTH_COLOR_METRICS
// already established, migration 011). model_id='human' makes that explicit
// rather than pointing at a real model id that would misrepresent the source.
async function getOrCreateHumanConfigId(client) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = 'human' AND version = 'manual-tagging-v1' LIMIT 1`
  );
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ('human', 'manual-tagging-v1', 'N/A - human-entered, not model-generated', '{}'::jsonb)
     RETURNING id`
  );
  return inserted.rows[0].id;
}

function validateTags(stateId, tags) {
  const errors = [];
  for (const [dim, value] of Object.entries(tags)) {
    const spec = STATE_DIMENSIONS[dim];
    if (!spec) {
      errors.push(`state ${stateId}: unknown dimension "${dim}"`);
      continue;
    }
    if (!spec.values.includes(value)) {
      errors.push(`state ${stateId}: "${dim}" value "${value}" not in [${spec.values.join(', ')}]`);
    }
  }
  return errors;
}

async function listUntagged(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT s.id, s.captured_at,
       (SELECT sp.content->>'content' FROM state_perspectives sp
        WHERE sp.state_id = s.id AND sp.perspective_type = 'CLAIM'
        ORDER BY sp.created_at DESC LIMIT 1) AS claim,
       (SELECT json_agg(photo_description ORDER BY photo_order)
        FROM state_photos WHERE state_id = s.id AND photo_description IS NOT NULL AND photo_description != '') AS photo_descriptions
     FROM states s
     JOIN experience_components ec ON ec.state_id = s.id
       AND ec.component_type IN ('initial_state', 'final_state')
     JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id::text = $1
     LEFT JOIN state_perspectives existing
       ON existing.state_id = s.id AND existing.perspective_type = $2
     WHERE existing.id IS NULL
     ORDER BY s.captured_at ASC`,
    [TOOL_ID, PERSPECTIVE_TYPE]
  );
  console.log(`\n${rows.length} experience-linked state(s) not yet tagged for tool ${TOOL_ID}:\n`);
  console.log('Dimensions:', JSON.stringify(Object.fromEntries(
    Object.entries(STATE_DIMENSIONS).map(([k, v]) => [k, v.values])
  ), null, 2));
  console.log('');
  for (const row of rows) {
    console.log(`- ${row.id}  (${new Date(row.captured_at).toISOString()})`);
    // CLAIM is usually empty at this stage (no generation step has run on
    // these states yet) — the real evidence for tagging is almost always
    // the per-photo captions written at capture time, alongside the same
    // photos coverage % is already computed from. Prefer CLAIM when it
    // exists (denser, technical-density-tuned text), fall back to raw
    // photo descriptions rather than showing nothing.
    if (row.claim) {
      console.log(`  CLAIM: ${row.claim.slice(0, 300)}`);
    } else if (row.photo_descriptions) {
      console.log(`  Photo notes: ${row.photo_descriptions.join(' | ')}`);
    } else {
      console.log('  (no CLAIM text or photo descriptions — check the photos directly)');
    }
  }
  console.log(`\nFill these into a JSON file ({ "<state_id>": { "azolla_color": "...", ... } }) and re-run with --file=<path>.`);
}

async function applyTags(client) {
  const tagsByState = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf-8'));
  const allErrors = [];
  for (const [stateId, tags] of Object.entries(tagsByState)) {
    allErrors.push(...validateTags(stateId, tags));
  }
  if (allErrors.length) {
    console.error('Validation errors, nothing written:');
    allErrors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  const configId = await getOrCreateHumanConfigId(client);
  let written = 0;
  for (const [stateId, tags] of Object.entries(tagsByState)) {
    // Upsert-by-rerun convention, same as every other perspective type: a
    // fresh row under the same config replaces the prior one for this state
    // rather than accumulating duplicates on re-tagging.
    await client.query(`DELETE FROM state_perspectives WHERE state_id = $1 AND perspective_type = $2 AND llm_generation_config_id = $3`, [stateId, PERSPECTIVE_TYPE, configId]);
    await client.query(
      `INSERT INTO state_perspectives (id, state_id, perspective_type, llm_generation_config_id, status, content)
       VALUES ($1, $2, $3, $4, 'SUCCESS', $5)`,
      [crypto.randomUUID(), stateId, PERSPECTIVE_TYPE, configId, JSON.stringify(tags)]
    );
    written += 1;
  }
  console.log(`Tagged ${written} state(s).`);
}

async function main() {
  const client = await pool.connect();
  try {
    if (LIST_MODE) {
      await listUntagged(client);
    } else {
      await applyTags(client);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
