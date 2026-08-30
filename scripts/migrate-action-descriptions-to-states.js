#!/usr/bin/env node

/**
 * Migrates actions.description into real states (see docs/specs/
 * azolla-impact-power-model.md — "states as action context"). Text only —
 * actions.attachments is never read here; images stay legacy until a person
 * attaches them through the ordinary add-photo flow (StatesInline, already
 * built and mounted in UnifiedActionDialog's Observations tab).
 *
 * Two populations, handled differently:
 *
 * 1. CLAIM copies — an action whose description is an exact copy of some
 *    state's CLAIM perspective content (this happens for azolla-extracted
 *    actions: scripts/azolla-experience-form.js used to write
 *    description = initialState.claim). These get LINKED to that real
 *    source state via state_links(entity_type='action') — never a new
 *    state, since the text already lives there in full. description is
 *    nulled afterward since it's a pure duplicate.
 *
 * 2. Everything else with a non-empty description — gets ONE new text-only
 *    state (state_text = description, captured_at = coalesce(completed_at,
 *    created_at), no photos), linked the same way plus to the action's
 *    asset (tool or part) when it has one. description is left in place —
 *    it's not a duplicate of anything else, and keeping it is what makes
 *    this reversible.
 *
 * Direct SQL insert, not POST /states — going through the API fans out to
 * both the embeddings and perspectives queues; this only queues embeddings
 * (cheap, immediate searchability win) and leaves perspective generation
 * for later on demand, matching the precedent already set in
 * scripts/azolla-experience-form.js.
 *
 * Usage: node scripts/migrate-action-descriptions-to-states.js [--dry-run]
 */

const { Pool } = require('pg');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
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

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('--dry-run: no DB writes, no SQS messages will be sent.\n');

const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});
const sqs = new SQSClient({ region: 'us-west-2' });

async function fetchCandidates(client) {
  const res = await client.query(`
    SELECT
      a.id, a.title, a.description, a.completed_at, a.created_at,
      a.asset_id, a.organization_id, a.created_by,
      a.scoring_data->>'experience_perspective_id' AS experience_perspective_id
    FROM actions a
    WHERE a.description IS NOT NULL AND btrim(a.description) <> ''
    ORDER BY a.created_at
  `);
  return res.rows;
}

// A CLAIM copy: this action's description matches some state's CLAIM content
// exactly. Only azolla-extracted actions (scoring_data.experience_perspective_id
// set) can be one, and the source state is that perspective's own
// prior_state_id — not a generic text search, to avoid matching an unrelated
// state that happens to share the same wording.
async function resolveClaimCopySourceStateId(client, action) {
  if (!action.experience_perspective_id) return null;
  const perspRes = await client.query(
    `SELECT content->>'prior_state_id' AS prior_state_id FROM state_perspectives WHERE id = $1`,
    [action.experience_perspective_id]
  );
  const priorStateId = perspRes.rows[0]?.prior_state_id;
  if (!priorStateId) return null;

  const claimRes = await client.query(
    `SELECT 1 FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'CLAIM' AND content->>'content' = $2`,
    [priorStateId, action.description]
  );
  return claimRes.rows.length > 0 ? priorStateId : null;
}

// NOT "does this action have any entity_type='action' link" — most
// azolla-extracted actions already have one from evidence-photo citations
// (scripts/azolla-experience-form.js's citedStateIds, unrelated to this
// migration), which would make every one of them look "already migrated"
// and get skipped. The real signal is a linked state whose OWN text matches
// this action's description — i.e. a state this exact migration produced,
// on this run or a prior one.
async function alreadyMigrated(client, actionId, description) {
  const res = await client.query(
    `SELECT 1 FROM state_links sl
     JOIN states s ON s.id = sl.state_id
     WHERE sl.entity_type = 'action' AND sl.entity_id = $1 AND s.state_text = $2
     LIMIT 1`,
    [actionId, description]
  );
  return res.rows.length > 0;
}

async function resolveAssetEntityType(client, assetId) {
  if (!assetId) return null;
  const toolRes = await client.query(`SELECT 1 FROM tools WHERE id = $1`, [assetId]);
  if (toolRes.rows.length > 0) return 'tool';
  const partRes = await client.query(`SELECT 1 FROM parts WHERE id = $1`, [assetId]);
  if (partRes.rows.length > 0) return 'part';
  return null; // dangling asset_id — link to the action only
}

async function main() {
  const client = await pool.connect();
  const pendingEmbeddingMessages = [];
  let linkedToExisting = 0, migratedNew = 0, skippedAlready = 0, skippedNoAsset = 0;

  try {
    const candidates = await fetchCandidates(client);
    console.log(`${candidates.length} action(s) with a non-empty description\n`);

    if (!DRY_RUN) await client.query('BEGIN');
    try {
      for (const action of candidates) {
        if (await alreadyMigrated(client, action.id, action.description)) {
          skippedAlready++;
          continue;
        }

        const claimSourceStateId = await resolveClaimCopySourceStateId(client, action);

        if (claimSourceStateId) {
          console.log(`[claim-copy] "${action.title}" (${action.id.slice(0, 8)}) -> links to existing state ${claimSourceStateId.slice(0, 8)}, description cleared`);
          if (!DRY_RUN) {
            await client.query(
              `INSERT INTO state_links (id, state_id, entity_type, entity_id, created_at) VALUES ($1, $2, 'action', $3, NOW())`,
              [crypto.randomUUID(), claimSourceStateId, action.id]
            );
            await client.query(`UPDATE actions SET description = NULL WHERE id = $1`, [action.id]);
          }
          linkedToExisting++;
          continue;
        }

        const capturedAt = action.completed_at || action.created_at;
        const assetEntityType = await resolveAssetEntityType(client, action.asset_id);
        if (action.asset_id && !assetEntityType) skippedNoAsset++; // dangling asset_id, logged but not blocking

        console.log(`[new-state] "${action.title}" (${action.id.slice(0, 8)}) -> new text-only state, captured_at=${capturedAt?.toISOString?.().slice(0, 10)}${assetEntityType ? `, linked to ${assetEntityType} ${action.asset_id.slice(0, 8)}` : ''}`);

        if (!DRY_RUN) {
          const stateId = crypto.randomUUID();
          await client.query(
            `INSERT INTO states (id, organization_id, captured_by, captured_at, state_text, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [stateId, action.organization_id, action.created_by, capturedAt, action.description]
          );
          await client.query(
            `INSERT INTO state_links (id, state_id, entity_type, entity_id, created_at) VALUES ($1, $2, 'action', $3, NOW())`,
            [crypto.randomUUID(), stateId, action.id]
          );
          if (assetEntityType) {
            await client.query(
              `INSERT INTO state_links (id, state_id, entity_type, entity_id, created_at) VALUES ($1, $2, $3, $4, NOW())`,
              [crypto.randomUUID(), stateId, assetEntityType, action.asset_id]
            );
          }
          pendingEmbeddingMessages.push({
            entity_type: 'state',
            entity_id: stateId,
            embedding_source: action.description,
            organization_id: action.organization_id,
          });
        }
        migratedNew++;
      }

      if (!DRY_RUN) await client.query('COMMIT');
    } catch (e) {
      if (!DRY_RUN) await client.query('ROLLBACK');
      throw e;
    }

    if (DRY_RUN) {
      console.log(`\nWould queue ${migratedNew} state embedding(s).`);
    } else {
      for (const msg of pendingEmbeddingMessages) {
        await sqs.send(new SendMessageCommand({ QueueUrl: EMBEDDINGS_QUEUE_URL, MessageBody: JSON.stringify(msg) }));
      }
      console.log(`\nQueued ${pendingEmbeddingMessages.length} state embedding(s).`);
    }

    console.log(`\nLinked to existing state (CLAIM copy): ${linkedToExisting}`);
    console.log(`Migrated to new text-only state: ${migratedNew}`);
    console.log(`Skipped (already migrated): ${skippedAlready}`);
    if (skippedNoAsset > 0) console.log(`Note: ${skippedNoAsset} action(s) had a dangling asset_id (no matching tool or part) — state created and linked to the action only.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
