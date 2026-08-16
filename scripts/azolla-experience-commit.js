#!/usr/bin/env node

/**
 * Commit step of the backfill review flow (docs/specs/azolla-impact-power-model.md §7).
 *
 * Reads a decisions JSON exported from azolla-experience-review-gen.js's
 * HTML page and, for each ACCEPTED or EDITED pair, creates the real
 * `actions` row plus `experiences`/`experience_components` rows. REJECTED
 * pairs and anything absent from the file create nothing — their
 * ACTION_HYPOTHESIS/AZOLLA_STATE perspectives simply remain as a record of
 * what was proposed and turned down (no separate validation-status column
 * needed; the presence/absence of downstream rows is the signal, per the
 * spec).
 *
 * A pair whose accepted hypothesis's no_action_found is effectively true
 * (rejected, or accepted with no selected hypothesis and no edit) creates
 * an experience with only initial_state/final_state components — no
 * action component — never a synthesized placeholder action, per the
 * "actions always correspond to a real human action" rule.
 *
 * Usage: node scripts/azolla-experience-commit.js <decisions.json>
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

const DECISIONS_PATH = process.argv[2];
if (!DECISIONS_PATH) {
  console.error('Usage: node scripts/azolla-experience-commit.js <decisions.json>');
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

async function alreadyCommitted(client, hypothesisPerspectiveId) {
  // A pair is already committed if an experience_components row exists
  // whose action was created from this hypothesis perspective. We track
  // that provenance via actions.description carrying a marker — simplest
  // approach without adding a new column. See insertExperience below.
  const res = await client.query(
    `SELECT 1 FROM experience_components WHERE state_id = (
       SELECT state_id FROM state_perspectives WHERE id = $1
     ) AND component_type = 'final_state'
     AND experience_id IN (
       SELECT experience_id FROM experience_components ec2
       JOIN actions a ON a.id = ec2.action_id
       WHERE ec2.component_type = 'action' AND a.description LIKE '%[backfill:' || $1 || ']%'
     )
     LIMIT 1`,
    [hypothesisPerspectiveId]
  );
  return res.rows.length > 0;
}

async function fetchPairInfo(client, hypothesisPerspectiveId) {
  const res = await client.query(
    `SELECT sp.state_id AS final_state_id, ahp.prior_state_id, s.organization_id, s.captured_by, s.captured_at,
            (SELECT entity_id FROM state_links WHERE state_id = sp.state_id AND entity_type = 'tool' LIMIT 1) AS tool_id
     FROM action_hypothesis_perspectives ahp
     JOIN state_perspectives sp ON sp.id = ahp.id
     JOIN states s ON s.id = sp.state_id
     WHERE ahp.id = $1`,
    [hypothesisPerspectiveId]
  );
  return res.rows[0] || null;
}

async function createExperience(client, { organizationId, toolId, priorStateId, finalStateId, actionRow, createdBy }) {
  const experienceId = crypto.randomUUID();
  await client.query(
    `INSERT INTO experiences (id, entity_type, entity_id, organization_id, created_by, created_at)
     VALUES ($1, 'tool', $2, $3, $4, NOW())`,
    [experienceId, toolId, organizationId, createdBy]
  );
  await client.query(
    `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
     VALUES ($1, $2, 'initial_state', $3, NULL, $4, NOW())`,
    [crypto.randomUUID(), experienceId, priorStateId, organizationId]
  );
  await client.query(
    `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
     VALUES ($1, $2, 'final_state', $3, NULL, $4, NOW())`,
    [crypto.randomUUID(), experienceId, finalStateId, organizationId]
  );
  if (actionRow) {
    await client.query(
      `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
       VALUES ($1, $2, 'action', NULL, $3, $4, NOW())`,
      [crypto.randomUUID(), experienceId, actionRow.id, organizationId]
    );
  }
  return experienceId;
}

async function createAction(client, { organizationId, title, description, createdBy, completedAt, toolId, hypothesisPerspectiveId }) {
  const actionId = crypto.randomUUID();
  const taggedDescription = `${description || ''}\n\n[backfill:${hypothesisPerspectiveId}]`;
  await client.query(
    `INSERT INTO actions (id, title, description, status, organization_id, created_by, completed_at, asset_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, NOW(), NOW())`,
    [actionId, title.slice(0, 250), taggedDescription, organizationId, createdBy, completedAt, toolId]
  );
  return { id: actionId };
}

async function main() {
  const decisions = JSON.parse(fs.readFileSync(DECISIONS_PATH, 'utf-8'));
  const client = await pool.connect();

  let committed = 0, skippedRejected = 0, skippedAlready = 0, errors = 0;

  try {
    for (const [pairId, decision] of Object.entries(decisions)) {
      if (decision.decision === 'rejected') { skippedRejected++; continue; }

      try {
        if (await alreadyCommitted(client, pairId)) { skippedAlready++; continue; }

        const pairInfo = await fetchPairInfo(client, pairId);
        if (!pairInfo) { console.warn(`No pair info for ${pairId}, skipping`); errors++; continue; }

        await client.query('BEGIN');

        let actionRow = null;
        if (decision.decision === 'edited' && decision.title && decision.title.trim()) {
          actionRow = await createAction(client, {
            organizationId: pairInfo.organization_id,
            title: decision.title,
            description: decision.description,
            createdBy: pairInfo.captured_by,
            completedAt: pairInfo.captured_at,
            toolId: pairInfo.tool_id,
            hypothesisPerspectiveId: pairId,
          });
        } else if (decision.decision === 'accepted' && decision.selectedHypIdx != null) {
          const hypRes = await client.query(
            `SELECT hypotheses FROM action_hypothesis_perspectives WHERE id = $1`, [pairId]
          );
          const hyp = (hypRes.rows[0]?.hypotheses || [])[decision.selectedHypIdx];
          if (hyp) {
            actionRow = await createAction(client, {
              organizationId: pairInfo.organization_id,
              title: hyp.title || 'Untitled action',
              description: hyp.description,
              createdBy: pairInfo.captured_by,
              completedAt: pairInfo.captured_at,
              toolId: pairInfo.tool_id,
              hypothesisPerspectiveId: pairId,
            });
          }
        }
        // decision.decision === 'accepted' with no selected hypothesis, or
        // an edit with an empty title, means no real human action was
        // confirmed — actionRow stays null and the experience below gets
        // no action component. This is correct, not an error case.

        await createExperience(client, {
          organizationId: pairInfo.organization_id,
          toolId: pairInfo.tool_id,
          priorStateId: pairInfo.prior_state_id,
          finalStateId: pairInfo.final_state_id,
          actionRow,
          createdBy: pairInfo.captured_by,
        });

        await client.query('COMMIT');
        committed++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`Error committing pair ${pairId}:`, e.message);
        errors++;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\nCommitted: ${committed}`);
  console.log(`Skipped (rejected): ${skippedRejected}`);
  console.log(`Skipped (already committed): ${skippedAlready}`);
  console.log(`Errors: ${errors}`);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
