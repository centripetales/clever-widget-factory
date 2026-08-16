#!/usr/bin/env node

/**
 * Propose step of the backfill review flow (docs/specs/azolla-impact-power-model.md §7).
 *
 * Walks each azolla container's states chronologically and, for every
 * state, generates an AZOLLA_STATE perspective (computed once per state,
 * reusable as either endpoint of however many experiences reference it);
 * for every consecutive pair, generates an ACTION_HYPOTHESIS perspective
 * on the later state (candidate human action(s) between the two, or an
 * explicit "no action found").
 *
 * The actual LLM calls (generateAzollaStateContext / generateActionHypothesis
 * below) are STUBS — see docs/specs/azolla-impact-power-model.md §8. This
 * script is safe to run now: it exercises the real pairing/idempotency/DB
 * logic against the real 289 observations, but writes clearly-marked
 * placeholder content, not real synthesis. Swap the stub bodies for real
 * Bedrock calls once the prompts are written — nothing else in this file
 * needs to change.
 *
 * Usage: node scripts/azolla-experience-propose.js
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

// Placeholder llm_generation_configs rows — see insert-stub-configs.js run
// during setup. Real configs (real model_id, real system_prompt) replace
// these once the prompts are written; nothing else needs to change since
// callers look these up by variable, not by re-querying model_id.
const AZOLLA_STATE_CONFIG_ID = '11111111-1111-4111-8111-111111111111';
const ACTION_HYPOTHESIS_CONFIG_ID = '22222222-2222-4222-8222-222222222222';

/**
 * STUB. Real version reads the state's own text/photos plus however much
 * prior context (per docs/specs/azolla-impact-power-model.md §7) is
 * needed, and asks the model for a structured AZOLLA_STATE synthesis:
 * coverage estimate, water color, vessel condition, phosphorus/pH
 * estimates (each with a basis — never presented as measured), a free-text
 * summary, and uncertainty flags.
 */
async function generateAzollaStateContext(state, priorStatesInContainer) {
  return {
    coverage_percent_estimate: null,
    water_color: null,
    vessel_condition: null,
    phosphorus_ppm_estimate: null,
    phosphorus_estimate_basis: null,
    ph_estimate: null,
    ph_estimate_basis: null,
    summary: '[STUB] AZOLLA_STATE synthesis not yet implemented.',
    uncertainty_flags: { stub: true },
    content: { stub: true, note: 'Placeholder — prompt not yet written.' },
  };
}

/**
 * STUB. Real version reads both states' text/photos and asks the model
 * for candidate human action(s) between them, each with a confidence —
 * or an explicit no_action_found=true when no real human action is
 * describable from the text (never a synthesized placeholder action).
 */
async function generateActionHypothesis(priorState, finalState) {
  return {
    no_action_found: true,
    hypotheses: [],
    content: { stub: true, note: 'Placeholder — prompt not yet written.' },
  };
}

async function fetchContainerStates(client) {
  const res = await client.query(`
    SELECT
      t.id AS tool_id, t.name AS container_name, t.organization_id,
      s.id AS state_id, s.state_text, s.captured_by, s.captured_at
    FROM tools t
    JOIN metrics m ON m.tool_id = t.id AND m.name = 'Coverage %'
    JOIN state_links sl ON sl.entity_type = 'tool' AND sl.entity_id = t.id
    JOIN states s ON s.id = sl.state_id
    ORDER BY t.name, s.captured_at, s.id
  `);

  const containers = new Map();
  for (const r of res.rows) {
    if (!containers.has(r.tool_id)) {
      containers.set(r.tool_id, { toolId: r.tool_id, name: r.container_name, organizationId: r.organization_id, states: [] });
    }
    containers.get(r.tool_id).states.push({
      id: r.state_id,
      text: r.state_text,
      capturedBy: r.captured_by,
      capturedAt: r.captured_at,
    });
  }
  return [...containers.values()];
}

async function azollaStateExists(client, stateId) {
  const res = await client.query(
    `SELECT 1 FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'AZOLLA_STATE' LIMIT 1`,
    [stateId]
  );
  return res.rows.length > 0;
}

async function actionHypothesisExists(client, priorStateId, finalStateId) {
  const res = await client.query(
    `SELECT 1 FROM state_perspectives sp
     JOIN action_hypothesis_perspectives ahp ON ahp.id = sp.id
     WHERE sp.state_id = $1 AND ahp.prior_state_id = $2 AND sp.perspective_type = 'ACTION_HYPOTHESIS'
     LIMIT 1`,
    [finalStateId, priorStateId]
  );
  return res.rows.length > 0;
}

async function insertAzollaState(client, state, synthesis) {
  const perspectiveId = crypto.randomUUID();
  await client.query(
    `INSERT INTO state_perspectives (id, state_id, perspective_type, llm_generation_config_id, status, created_at)
     VALUES ($1, $2, 'AZOLLA_STATE', $3, 'SUCCESS', NOW())`,
    [perspectiveId, state.id, AZOLLA_STATE_CONFIG_ID]
  );
  await client.query(
    `INSERT INTO azolla_state_perspectives
       (id, coverage_percent_estimate, water_color, vessel_condition,
        phosphorus_ppm_estimate, phosphorus_estimate_basis, ph_estimate, ph_estimate_basis,
        summary, uncertainty_flags, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      perspectiveId,
      synthesis.coverage_percent_estimate,
      synthesis.water_color,
      synthesis.vessel_condition,
      synthesis.phosphorus_ppm_estimate,
      synthesis.phosphorus_estimate_basis,
      synthesis.ph_estimate,
      synthesis.ph_estimate_basis,
      synthesis.summary,
      JSON.stringify(synthesis.uncertainty_flags || {}),
      JSON.stringify(synthesis.content || {}),
    ]
  );
  return perspectiveId;
}

async function insertActionHypothesis(client, priorState, finalState, hypothesis) {
  const perspectiveId = crypto.randomUUID();
  await client.query(
    `INSERT INTO state_perspectives (id, state_id, perspective_type, llm_generation_config_id, status, created_at)
     VALUES ($1, $2, 'ACTION_HYPOTHESIS', $3, 'SUCCESS', NOW())`,
    [perspectiveId, finalState.id, ACTION_HYPOTHESIS_CONFIG_ID]
  );
  await client.query(
    `INSERT INTO action_hypothesis_perspectives (id, prior_state_id, no_action_found, hypotheses, content)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      perspectiveId,
      priorState.id,
      hypothesis.no_action_found,
      JSON.stringify(hypothesis.hypotheses || []),
      JSON.stringify(hypothesis.content || {}),
    ]
  );
  return perspectiveId;
}

async function main() {
  const client = await pool.connect();
  try {
    const containers = await fetchContainerStates(client);
    console.log(`Found ${containers.length} containers`);

    let azollaStateCreated = 0, azollaStateSkipped = 0;
    let hypothesisCreated = 0, hypothesisSkipped = 0;

    for (const container of containers) {
      const { states } = container;
      console.log(`\n${container.name} — ${states.length} states`);

      for (let i = 0; i < states.length; i++) {
        const state = states[i];
        if (await azollaStateExists(client, state.id)) {
          azollaStateSkipped++;
          continue;
        }
        const priorStates = states.slice(0, i);
        const synthesis = await generateAzollaStateContext(state, priorStates);
        await insertAzollaState(client, state, synthesis);
        azollaStateCreated++;
      }

      for (let i = 1; i < states.length; i++) {
        const priorState = states[i - 1];
        const finalState = states[i];
        if (await actionHypothesisExists(client, priorState.id, finalState.id)) {
          hypothesisSkipped++;
          continue;
        }
        const hypothesis = await generateActionHypothesis(priorState, finalState);
        await insertActionHypothesis(client, priorState, finalState, hypothesis);
        hypothesisCreated++;
      }
    }

    console.log(`\nAZOLLA_STATE: ${azollaStateCreated} created, ${azollaStateSkipped} already existed`);
    console.log(`ACTION_HYPOTHESIS: ${hypothesisCreated} created, ${hypothesisSkipped} already existed`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
