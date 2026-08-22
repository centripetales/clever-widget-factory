#!/usr/bin/env node

/**
 * One-time backfill migrating the current azolla pilot roster off the hardcoded
 * org-id list in scripts/azolla-wire-coverage-metric.js onto the live mechanism:
 *
 *   1. Set ai_config.processors = ["azolla_coverage"] on the designated hub org
 *      (organizations.ai_config is a jsonb column already used this way for
 *      lens_config elsewhere — lambda/core/index.js).
 *   2. Create a container-level share-grant (tool -> hub org) for each
 *      participant's container via the same mechanism POST /shares uses
 *      (lambda/core/index.js): a `states` row + two `state_links` rows.
 *
 * After this runs, lambda/rsp-worker's azolla_coverage processor picks up new
 * observations on these containers automatically — no more hardcoded roster,
 * no more manual script runs.
 *
 * Idempotent: safe to rerun. Get-or-create for the tool; ai_config merge only
 * adds "azolla_coverage" if not already present; share-grant creation checks
 * for an existing share to the same hub org before inserting.
 *
 * Usage:
 *   node scripts/azolla-backfill-org-processors.js --hub-org=<uuid> --dry-run
 *   node scripts/azolla-backfill-org-processors.js --hub-org=<uuid>
 */

const { Pool } = require('pg');
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

const DRY_RUN = process.argv.includes('--dry-run');
const HUB_ORG_ID = (() => {
  const a = process.argv.find(a => a.startsWith('--hub-org='));
  return a ? a.split('=')[1] : null;
})();
if (!HUB_ORG_ID) {
  console.error('Missing required --hub-org=<uuid> argument.');
  process.exit(1);
}

// Same roster as scripts/azolla-wire-coverage-metric.js — this backfill exists
// specifically to make that hardcoded list unnecessary going forward.
const ROSTER = [
  { containerName: "Wilfred's Azolla Container", orgId: '772cb749-4fe7-4c06-b37c-55fa59fda661' },
  { containerName: "Jusua's Azolla Container", orgId: '312968f9-8da4-4bc9-9681-8ef6d09e8b53' },
  { containerName: "Marvin's Azolla Container", orgId: '8161b73c-7565-4a97-9efa-97f9717f94d7' },
  { containerName: "Buboy's Azolla Container", orgId: 'b4f0d9b0-2f37-4a03-9903-76d31a08543a' },
  { containerName: "LesterLuna's Azolla Container", orgId: 'e195f4bd-2f19-41e7-8df1-70312b33c4b8' },
  { containerName: "John Kenneth's Azolla Container", orgId: '7101170d-6c5c-4975-909f-813b15269204' },
  { containerName: "Chael's Azolla Container", orgId: 'a893eff0-6168-4c77-b781-1d68d6cf2589' },
  { containerName: "Allan's Azolla Container", orgId: '3e34261e-df7f-4266-b6c4-bd03468cbda3' },
  // Stefan/Mae's containers already exist under the shared "Stargazer Farm" org
  // (id 00000000-0000-0000-0000-000000000001) — a container-level share-grant
  // makes the old actionId-scoping workaround unnecessary.
  { containerName: "Stefan's Azolla Container", orgId: '00000000-0000-0000-0000-000000000001' },
  { containerName: "Mae's Azolla Container", orgId: '00000000-0000-0000-0000-000000000001' },
];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function getExistingTool(client, name, orgId) {
  // Case-insensitive: see scripts/azolla-wire-coverage-metric.js's getOrCreateTool
  // for why (an unowned RDS trigger title-cases tools.name after insert).
  const existing = await client.query(
    'SELECT id FROM tools WHERE lower(name) = lower($1) AND organization_id = $2 ORDER BY created_at LIMIT 1',
    [name, orgId]
  );
  return existing.rows.length ? existing.rows[0].id : null;
}

async function ensureHubOrgProcessor(client, hubOrgId) {
  const res = await client.query('SELECT ai_config FROM organizations WHERE id = $1', [hubOrgId]);
  if (res.rows.length === 0) throw new Error(`Hub org ${hubOrgId} not found`);
  const current = res.rows[0].ai_config || {};
  const processors = Array.isArray(current.processors) ? current.processors : [];
  if (processors.includes('azolla_coverage')) {
    console.log(`  hub org already has azolla_coverage enabled`);
    return;
  }
  console.log(`  ${DRY_RUN ? '[DRY RUN] would add' : 'adding'} "azolla_coverage" to hub org ai_config.processors`);
  if (DRY_RUN) return;
  await client.query(
    `UPDATE organizations SET ai_config = COALESCE(ai_config, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ processors: [...processors, 'azolla_coverage'] }), hubOrgId]
  );
}

async function ensureContainerShare(client, toolId, sourceOrgId, hubOrgId) {
  const existing = await client.query(
    `SELECT 1 FROM state_links sl_entity
     JOIN state_links sl_org ON sl_org.state_id = sl_entity.state_id AND sl_org.entity_type = 'organization'
     WHERE sl_entity.entity_type = 'tool' AND sl_entity.entity_id = $1 AND sl_org.entity_id = $2
     LIMIT 1`,
    [toolId, hubOrgId]
  );
  if (existing.rows.length > 0) {
    console.log(`  tool already share-granted to hub org`);
    return;
  }
  console.log(`  ${DRY_RUN ? '[DRY RUN] would create' : 'creating'} share-grant to hub org`);
  if (DRY_RUN) return;

  await client.query('BEGIN');
  try {
    const stateRes = await client.query(
      `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', NOW()) RETURNING id`,
      [sourceOrgId, 'Shared tool with Azolla Kapwa (backfill)']
    );
    const shareStateId = stateRes.rows[0].id;
    await client.query(
      `INSERT INTO state_links (id, state_id, entity_type, entity_id) VALUES (gen_random_uuid(), $1, 'tool', $2)`,
      [shareStateId, toolId]
    );
    await client.query(
      `INSERT INTO state_links (id, state_id, entity_type, entity_id) VALUES (gen_random_uuid(), $1, 'organization', $2)`,
      [shareStateId, hubOrgId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  console.log('Azolla org-processor backfill');
  console.log('==============================');
  console.log(`Hub org: ${HUB_ORG_ID}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const client = await pool.connect();
  try {
    console.log('=== Hub org processor config ===');
    await ensureHubOrgProcessor(client, HUB_ORG_ID);
    console.log('');

    for (const entry of ROSTER) {
      console.log(`=== ${entry.containerName} (org ${entry.orgId}) ===`);
      const toolId = await getExistingTool(client, entry.containerName, entry.orgId);
      if (!toolId) {
        console.log(`  no existing tool found — skipping (nothing to share yet)`);
        continue;
      }
      console.log(`  tool_id: ${toolId}`);
      await ensureContainerShare(client, toolId, entry.orgId, HUB_ORG_ID);
      console.log('');
    }

    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
