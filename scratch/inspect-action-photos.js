const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Load environment variables from .env.local
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
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const actionId = 'fe00e682-47bd-4c78-a8fc-d19cddf70562';
  console.log(`🔍 Inspecting database for Action ID: ${actionId}...`);

  // Query action itself
  const actionRes = await pool.query(
    "SELECT * FROM actions WHERE id = $1",
    [actionId]
  );
  if (actionRes.rows.length === 0) {
    console.log('✗ Action not found in actions table!');
  } else {
    console.log('✓ Action Row:', actionRes.rows[0]);
  }

  // Find all states linked to this action
  const linksRes = await pool.query(
    "SELECT * FROM state_links WHERE entity_type = 'action' AND entity_id = $1",
    [actionId]
  );
  console.log(`\n✓ Found ${linksRes.rows.length} state links to this action:`);
  linksRes.rows.forEach(l => console.log(l));

  if (linksRes.rows.length > 0) {
    const stateIds = linksRes.rows.map(l => l.state_id);
    // Find all state photos for these state IDs
    const spRes = await pool.query(
      "SELECT * FROM state_photos WHERE state_id = ANY($1)",
      [stateIds]
    );
    console.log(`\n✓ Found ${spRes.rows.length} state photos associated with these states:`);
    spRes.rows.forEach(p => console.log(p));
  }

  await pool.end();
  process.exit(0);
}

main().catch(console.error);
