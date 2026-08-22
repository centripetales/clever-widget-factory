#!/usr/bin/env node

/**
 * Backfills embedding generation for actions created via direct SQL insert
 * (scripts/azolla-experience-form.js), which bypassed the normal
 * lambda/actions/index.js API path and therefore never queued an embedding
 * job. Reuses the exact same SQS contract the real API uses
 * (entity_type/entity_id/embedding_source/organization_id on
 * cwf-embeddings-queue) so these actions become searchable the same way
 * any other action is.
 *
 * Usage: node scripts/azolla-backfill-action-embeddings.js
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

// Matches lambda/shared/embedding-composition.js composeActionEmbeddingSource exactly.
function composeActionEmbeddingSource(action) {
  const parts = [action.title, action.description].filter(Boolean);
  return parts.join('. ');
}

async function main() {
  const client = await pool.connect();
  try {
    const actions = await client.query(`
      SELECT id, title, description, organization_id
      FROM actions
      WHERE description LIKE '%azolla-sasr%'
      AND NOT EXISTS (
        SELECT 1 FROM unified_embeddings ue WHERE ue.entity_type = 'action' AND ue.entity_id = actions.id
      )
    `);
    console.log(`${actions.rows.length} azolla-sasr actions missing embeddings`);

    for (const action of actions.rows) {
      const embeddingSource = composeActionEmbeddingSource(action);
      if (!embeddingSource.trim()) { console.log(`Skipping ${action.id.slice(0, 8)} — empty embedding source`); continue; }
      await sqs.send(new SendMessageCommand({
        QueueUrl: EMBEDDINGS_QUEUE_URL,
        MessageBody: JSON.stringify({
          entity_type: 'action',
          entity_id: action.id,
          embedding_source: embeddingSource,
          organization_id: action.organization_id,
        }),
      }));
      console.log(`Queued embedding for "${action.title}" (${action.id.slice(0, 8)})`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
