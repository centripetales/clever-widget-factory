#!/usr/bin/env node

/**
 * Wires already-computed AZOLLA_DUCKWEED_OBSERVATION perspective coverage
 * estimates (state_perspectives.content, see migration 020) into the real
 * metrics/metric_snapshots system, one registered tool asset per named
 * container.
 *
 * Scoping note: each field worker's azolla setup lives under its own
 * dedicated organization (org.name = 'Wilfred', 'Jusua', etc — confirmed by
 * reading scripts/azolla-duckweed-observation.js, which already scopes by
 * organization for exactly this reason). So this script scopes by
 * organization_id, not captured_by.
 *
 * Idempotent: safe to rerun — get-or-create for tool/metric, ON CONFLICT
 * DO UPDATE for snapshots, existence check before linking state_links.
 *
 * Usage: node scripts/azolla-wire-coverage-metric.js [--dry-run]
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

// One entry per pilot participant. containerName becomes the tools.name.
// orgId is each participant's dedicated organization (see organizations
// table: Wilfred=772cb749..., Jusua=312968f9..., etc).
const ROSTER = [
  // Wilfred's photos bounce between clearly different containers day to day
  // (clear plastic bag, ceramic pot, coconut shell, white plastic container,
  // concrete container) — same mixing problem as Stefan/Mae. Included anyway
  // per "include everyone": the day-aggregated multi-photo tooltip now makes
  // that mixing visible (each photo shown with its own description) instead
  // of silently averaging it away, same tolerance already applied to them.
  { containerName: "Wilfred's Azolla Container", orgId: '772cb749-4fe7-4c06-b37c-55fa59fda661' },
  { containerName: "Jusua's Azolla Container", orgId: '312968f9-8da4-4bc9-9681-8ef6d09e8b53' },
  { containerName: "Marvin's Azolla Container", orgId: '8161b73c-7565-4a97-9efa-97f9717f94d7' },
  { containerName: "Buboy's Azolla Container", orgId: 'b4f0d9b0-2f37-4a03-9903-76d31a08543a' },
  { containerName: "LesterLuna's Azolla Container", orgId: 'e195f4bd-2f19-41e7-8df1-70312b33c4b8' },
  { containerName: "John Kenneth's Azolla Container", orgId: '7101170d-6c5c-4975-909f-813b15269204' },
  { containerName: "Chael's Azolla Container", orgId: 'a893eff0-6168-4c77-b781-1d68d6cf2589' },
  { containerName: "Allan's Azolla Container", orgId: '3e34261e-df7f-4266-b6c4-bd03468cbda3' },
  // Renzel has no observations yet — nothing to wire in, will appear
  // automatically once he records his first one and this script reruns.
  // Stefan and Mae's azolla activity lives under the shared "Stargazer Farm"
  // org alongside unrelated farm activity, so they're scoped by their
  // dedicated action instead of by org (same distinction the vision script
  // itself already makes — see fetchEligiblePhotos's ACTION_ID branch).
  { containerName: "Stefan's Azolla Container", orgId: '00000000-0000-0000-0000-000000000001', actionId: '7d5553bb-14ae-485d-9014-7f84ed49841f' },
  { containerName: "Mae's Azolla Container", orgId: '00000000-0000-0000-0000-000000000001', actionId: 'a98acb69-687e-4bad-aad4-34c1d35d3a58' },
];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function getOrCreateTool(client, name, orgId) {
  // Case-insensitive: an untracked DB trigger title-cases tools.name after
  // insert (confirmed not present anywhere in this repo — it's unowned RDS
  // infra), so an exact-match SELECT against the original string silently
  // fails to find rows it created on a prior run and duplicates them. Hit
  // this for real — cost several duplicate tool/metric/snapshot sets before
  // being caught. lower() comparison is immune to whatever the trigger does.
  const existing = await client.query(
    'SELECT id FROM tools WHERE lower(name) = lower($1) AND organization_id = $2 ORDER BY created_at LIMIT 1',
    [name, orgId]
  );
  if (existing.rows.length) return existing.rows[0].id;

  if (DRY_RUN) {
    console.log(`  [DRY RUN] would create tool "${name}" in org ${orgId}`);
    return null;
  }
  const inserted = await client.query(
    `INSERT INTO tools (name, description, organization_id, category)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, 'Azolla/duckweed cultivation container — coverage % pilot', orgId, null]
  );
  return inserted.rows[0].id;
}

async function getOrCreateMetric(client, toolId, orgId) {
  const existing = await client.query(
    "SELECT metric_id FROM metrics WHERE tool_id = $1 AND name = 'Coverage %'",
    [toolId]
  );
  if (existing.rows.length) return existing.rows[0].metric_id;

  if (DRY_RUN) {
    console.log(`  [DRY RUN] would create "Coverage %" metric on tool ${toolId}`);
    return null;
  }
  const inserted = await client.query(
    `INSERT INTO metrics (tool_id, name, unit, details, organization_id)
     VALUES ($1, 'Coverage %', '%', 'Vision-LLM-estimated azolla/duckweed coverage of the visible water surface.', $2)
     RETURNING metric_id`,
    [toolId, orgId]
  );
  return inserted.rows[0].metric_id;
}

// One row per state, averaging coverage across that state's photos (a state
// can have multiple photos, e.g. same session from different angles).
async function coverageByState(client, orgId) {
  const res = await client.query(`
    SELECT s.id as state_id, s.captured_at,
      AVG((sper.content->>'plant_coverage_percent_estimate')::numeric) as avg_coverage,
      array_agg(DISTINCT sper.content->>'vessel_type') as vessel_types
    FROM states s
    JOIN state_photos sp ON sp.state_id = s.id
    JOIN state_links sl ON sl.entity_type = 'state_photo' AND sl.entity_id = sp.id
    JOIN state_perspectives sper ON sper.state_id = sl.state_id AND sper.perspective_type = 'AZOLLA_DUCKWEED_OBSERVATION'
    WHERE s.organization_id = $1
      AND sper.content->>'plant_coverage_percent_estimate' IS NOT NULL
    GROUP BY s.id, s.captured_at
    ORDER BY s.captured_at
  `, [orgId]);
  return res.rows;
}

// Same as coverageByState, but scoped to an action via state_links instead
// of organization_id — for Stefan/Mae, see ROSTER comment above.
async function coverageByAction(client, actionId) {
  const res = await client.query(`
    SELECT s.id as state_id, s.captured_at,
      AVG((sper.content->>'plant_coverage_percent_estimate')::numeric) as avg_coverage,
      array_agg(DISTINCT sper.content->>'vessel_type') as vessel_types
    FROM state_links act_link
    JOIN states s ON s.id = act_link.state_id
    JOIN state_photos sp ON sp.state_id = s.id
    JOIN state_links sl ON sl.entity_type = 'state_photo' AND sl.entity_id = sp.id
    JOIN state_perspectives sper ON sper.state_id = sl.state_id AND sper.perspective_type = 'AZOLLA_DUCKWEED_OBSERVATION'
    WHERE act_link.entity_type = 'action' AND act_link.entity_id = $1
      AND sper.content->>'plant_coverage_percent_estimate' IS NOT NULL
    GROUP BY s.id, s.captured_at
    ORDER BY s.captured_at
  `, [actionId]);
  return res.rows;
}

async function main() {
  const client = await pool.connect();
  try {
    for (const entry of ROSTER) {
      const scopeLabel = entry.actionId ? `action ${entry.actionId}` : `org ${entry.orgId}`;
      console.log(`\n=== ${entry.containerName} (${scopeLabel}) ===`);

      const toolId = await getOrCreateTool(client, entry.containerName, entry.orgId);
      const metricId = toolId ? await getOrCreateMetric(client, toolId, entry.orgId) : null;
      if (toolId) console.log(`  tool_id: ${toolId}`);
      if (metricId) console.log(`  metric_id: ${metricId}`);

      const rows = entry.actionId
        ? await coverageByAction(client, entry.actionId)
        : await coverageByState(client, entry.orgId);
      console.log(`  ${rows.length} states with a coverage estimate`);

      for (const row of rows) {
        const value = Number(row.avg_coverage).toFixed(2);
        console.log(`  ${row.captured_at.toISOString().slice(0, 10)} | ${value}% | ${row.vessel_types.join(', ')}`);

        if (DRY_RUN) continue;

        // Link state -> tool if not already linked.
        const linked = await client.query(
          "SELECT 1 FROM state_links WHERE state_id = $1 AND entity_type = 'tool' AND entity_id = $2",
          [row.state_id, toolId]
        );
        if (!linked.rows.length) {
          await client.query(
            "INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'tool', $2)",
            [row.state_id, toolId]
          );
        }

        await client.query(
          `INSERT INTO metric_snapshots (state_id, metric_id, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (state_id, metric_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [row.state_id, metricId, value]
        );
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
