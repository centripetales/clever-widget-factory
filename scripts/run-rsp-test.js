const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { handler: workerHandler } = require('./lambda/rsp-worker/index.js');
require('dotenv').config({ path: './.env.local' });

async function run() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to DB');

    // 1. Run the migration
    const migrationSql = fs.readFileSync('./migrations/006-create-rsp-schemas.sql', 'utf8');
    await client.query(migrationSql);
    console.log('Migration 006 executed successfully.');

    // 2. Find the compost action and its associated state
    // We look for an action containing "compost"
    const actionSql = `
      SELECT a.id as action_id, a.title, a.description, s.id as state_id
      FROM actions a
      JOIN state_links sl ON sl.entity_id = a.id AND sl.entity_type = 'action'
      JOIN states s ON s.id = sl.state_id
      WHERE a.id = 'f1d79177-28b7-4ea0-beee-47f9ade66555'
      LIMIT 1
    `;
    const res = await client.query(actionSql);
    if (res.rows.length === 0) {
      console.log('No action found with that ID');
      return;
    }
    const targetState = res.rows[0];
    console.log('Found action state:', targetState);

    // 3. Insert into rsp_outbox
    const insertOutboxSql = `
      INSERT INTO rsp_outbox (state_id, idempotency_key, status, triggered_at)
      VALUES ($1, $2, 'PENDING', NOW())
      ON CONFLICT (idempotency_key) DO UPDATE SET status = 'PENDING', attempt_count = 0
    `;
    await client.query(insertOutboxSql, [
      targetState.state_id, 
      'manual-test-' + Date.now()
    ]);
    console.log('Inserted compost state into rsp_outbox');

    // 4. Run the worker
    console.log('Executing RSP worker...');
    const workerResult = await workerHandler({});
    console.log('Worker result:', workerResult);

    // 5. Fetch and display the generated strata
    const strataSql = `
      SELECT stratum_type, payload
      FROM state_strata
      WHERE state_id = $1
      ORDER BY created_at ASC
    `;
    const strataRes = await client.query(strataSql, [targetState.state_id]);
    console.log('\n--- GENERATED STRATA ---');
    strataRes.rows.forEach(r => {
      console.log(`\n[${r.stratum_type}]`);
      console.log(JSON.stringify(r.payload, null, 2));
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

run();
