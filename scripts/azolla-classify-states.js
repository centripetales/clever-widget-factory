#!/usr/bin/env node

/**
 * Classifies each real experience's final state as STATE_TREND: increasing
 * or decreasing — computed arithmetically from the existing Coverage %
 * metric (metric_snapshots / metrics.name = 'Coverage %'), not from text.
 *
 * Replaces the earlier embedding-based nearest-anchor classifier (dry-run
 * against Stefan's data misclassified a state whose claim literally said
 * "Duckweed coverage has increased" as decreasing — antonym confusion is a
 * known structural weakness of cosine similarity over short claims). The
 * trend a person cares about here is a real number the pipeline already
 * tracks, so compare it directly instead of inferring it from words.
 *
 * A state's trend describes the transition INTO it, so this classifies the
 * final_state of each experience by comparing its Coverage % against that
 * same experience's initial_state. The chain's very first initial_state (or
 * any state missing a Coverage % reading) is left unclassified rather than
 * forcing a value the data doesn't support.
 *
 * Scoped to real `experiences` rows only (curated, human-reviewed), same as
 * the classifier this replaces.
 *
 * Usage:
 *   node scripts/azolla-classify-states.js --tool=<tool_id> [--dry-run] [--force]
 *   node scripts/azolla-classify-states.js --all-azolla [--dry-run] [--force]
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const CLASSIFIER_VERSION = 'coverage-metric-classifier-v1';
const PERSPECTIVE_TYPE = 'STATE_TREND';

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
  console.error('Usage: node scripts/azolla-classify-states.js --tool=<tool_id> | --all-azolla [--dry-run] [--force]');
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

async function getAllAzollaToolIds(client) {
  const r = await client.query(`SELECT id FROM tools WHERE name ILIKE '%''s Azolla Container%'`);
  return r.rows.map((row) => row.id);
}

async function fetchExperiences(client, toolId) {
  const sql = `
    SELECT e.id AS experience_id,
      init_s.id AS initial_state_id, init_m.value AS initial_coverage,
      final_s.id AS final_state_id, final_m.value AS final_coverage
    FROM experiences e
    JOIN experience_components ec_init ON ec_init.experience_id = e.id AND ec_init.component_type = 'initial_state'
    JOIN states init_s ON init_s.id = ec_init.state_id
    LEFT JOIN metric_snapshots init_m ON init_m.state_id = init_s.id
      AND init_m.metric_id IN (SELECT metric_id FROM metrics WHERE name = 'Coverage %')
    JOIN experience_components ec_final ON ec_final.experience_id = e.id AND ec_final.component_type = 'final_state'
    JOIN states final_s ON final_s.id = ec_final.state_id
    LEFT JOIN metric_snapshots final_m ON final_m.state_id = final_s.id
      AND final_m.metric_id IN (SELECT metric_id FROM metrics WHERE name = 'Coverage %')
    WHERE e.entity_type = 'tool' AND e.entity_id = $1
      ${FORCE ? '' : `AND NOT EXISTS (
        SELECT 1 FROM state_perspectives existing
        WHERE existing.state_id = final_s.id AND existing.perspective_type = '${PERSPECTIVE_TYPE}'
      )`}
  `;
  const res = await client.query(sql, [toolId]);
  return res.rows;
}

function classify(initialCoverage, finalCoverage) {
  if (initialCoverage === null || finalCoverage === null) return null;
  const init = parseFloat(initialCoverage);
  const final = parseFloat(finalCoverage);
  if (final > init) return { value: 'increasing', initial_coverage: init, final_coverage: final };
  if (final < init) return { value: 'decreasing', initial_coverage: init, final_coverage: final };
  return null; // equal — no directional signal, leave unclassified
}

async function main() {
  console.log('STATE_TREND classification (Coverage % based)');
  console.log('================================================');
  console.log('Dry run:', DRY_RUN, ' Force:', FORCE);
  console.log('');

  const client = await pool.connect();
  try {
    let configId = null;
    if (!DRY_RUN) {
      const configCheck = await client.query(
        `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
        ['coverage-metric', CLASSIFIER_VERSION]
      );
      if (configCheck.rows.length > 0) {
        configId = configCheck.rows[0].id;
      } else {
        const inserted = await client.query(
          `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          ['coverage-metric', CLASSIFIER_VERSION, 'N/A - deterministic arithmetic comparison of Coverage % metric between an experience\'s initial_state and final_state, not a generative prompt', JSON.stringify({})]
        );
        configId = inserted.rows[0].id;
      }
    }

    const toolIds = ALL_AZOLLA ? await getAllAzollaToolIds(client) : [TOOL_ID];
    let totalProcessed = 0;
    let totalWritten = 0;

    for (const toolId of toolIds) {
      const experiences = await fetchExperiences(client, toolId);
      console.log(`Tool ${toolId}: ${experiences.length} eligible experience(s).`);
      for (const row of experiences) {
        const result = classify(row.initial_coverage, row.final_coverage);
        console.log(
          `  experience ${row.experience_id}: final_state ${row.final_state_id} — ` +
          `${row.initial_coverage ?? 'null'}% -> ${row.final_coverage ?? 'null'}% : ` +
          `${result ? result.value : 'unclear (missing or equal coverage)'}`
        );

        if (!DRY_RUN && result) {
          await client.query(`DELETE FROM state_perspectives WHERE state_id = $1 AND perspective_type = $2`, [row.final_state_id, PERSPECTIVE_TYPE]);
          await client.query(
            `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content)
             VALUES ($1, $2, $3, 'SUCCESS', $4)`,
            [row.final_state_id, PERSPECTIVE_TYPE, configId, JSON.stringify({
              value: result.value,
              initial_coverage: result.initial_coverage,
              final_coverage: result.final_coverage,
              experience_id: row.experience_id,
            })]
          );
          totalWritten++;
        }
        totalProcessed++;
      }
    }

    console.log(`\nDone. Processed ${totalProcessed} experience(s).${DRY_RUN ? ' (dry run — no DB writes)' : ` Wrote ${totalWritten} STATE_TREND row(s).`}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
