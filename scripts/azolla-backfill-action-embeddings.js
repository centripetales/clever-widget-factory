#!/usr/bin/env node

/**
 * Backfills action_policy embeddings for every action missing one (or, with
 * --force, replaces all of them). Originally scoped to azolla-sasr-tagged
 * actions created via direct SQL insert (which bypass lambda/actions/index.js's
 * own embedding queueing); broadened to a general re-embed tool for the
 * action -> action_policy cutover (see docs/specs/azolla-impact-power-model.md
 * — "states as action context"), since every existing action's embedding
 * needs replacing under the new title+policy composition regardless of how
 * it was created.
 *
 * Usage:
 *   node scripts/azolla-backfill-action-embeddings.js           # only actions with no action_policy row yet
 *   node scripts/azolla-backfill-action-embeddings.js --force   # re-embed every action, replacing existing rows
 */

const { Pool } = require('pg');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const path = require('path');
const fs = require('fs');

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

const FORCE = process.argv.includes('--force');

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

// Matches lambda/shared/embedding-composition.js composeActionPolicySource exactly —
// title + policy only, HTML-stripped. See that file for why.
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function composeActionPolicySource(action) {
  return [action.title, stripHtml(action.policy)].filter(Boolean).join('. ');
}

async function main() {
  const client = await pool.connect();
  try {
    const actions = await client.query(`
      SELECT id, title, policy, organization_id
      FROM actions
      ${FORCE ? '' : `WHERE NOT EXISTS (
        SELECT 1 FROM unified_embeddings ue WHERE ue.entity_type = 'action_policy' AND ue.entity_id = actions.id
      )`}
    `);
    console.log(`${actions.rows.length} actions ${FORCE ? '(--force: all actions)' : 'missing an action_policy embedding'}`);

    let queued = 0, skipped = 0;
    for (const action of actions.rows) {
      const embeddingSource = composeActionPolicySource(action);
      if (!embeddingSource.trim()) { console.log(`Skipping ${action.id.slice(0, 8)} — empty embedding source`); skipped++; continue; }
      await sqs.send(new SendMessageCommand({
        QueueUrl: EMBEDDINGS_QUEUE_URL,
        MessageBody: JSON.stringify({
          entity_type: 'action_policy',
          entity_id: action.id,
          embedding_source: embeddingSource,
          organization_id: action.organization_id,
        }),
      }));
      queued++;
    }
    console.log(`Queued ${queued} embedding(s), skipped ${skipped} (empty source).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
