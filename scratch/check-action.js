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
  const actionId = 'c685afab-1697-4fad-a414-caea960b7571';
  console.log(`Checking Action: ${actionId}`);

  // Get action details
  const actionRes = await pool.query('SELECT * FROM actions WHERE id = $1', [actionId]);
  if (actionRes.rows.length === 0) {
    console.log('Action not found!');
    process.exit(1);
  }
  console.log('Action Title:', actionRes.rows[0].title);
  console.log('Action Policy:', actionRes.rows[0].policy);

  // Get states linked to the action
  const statesRes = await pool.query(`
    SELECT s.id, s.state_text, s.captured_by, s.captured_at
    FROM states s
    JOIN state_links sl ON s.id = sl.state_id
    WHERE sl.entity_type = 'action' AND sl.entity_id = $1
  `, [actionId]);

  console.log(`\nLinked States count: ${statesRes.rows.length}`);
  for (const state of statesRes.rows) {
    console.log(`- State ID: ${state.id}`);
    console.log(`  Captured By: ${state.captured_by}`);
    console.log(`  State Text: ${state.state_text}`);

    // Get photos linked to this state
    const photosRes = await pool.query(`
      SELECT sp.id, sp.photo_url, sp.photo_description
      FROM state_photos sp
      WHERE sp.state_id = $1
    `, [state.id]);
    console.log(`  Photos count: ${photosRes.rows.length}`);
    for (const photo of photosRes.rows) {
      console.log(`    * Photo ID: ${photo.id}`);
      console.log(`      URL: ${photo.photo_url}`);
      console.log(`      Description: ${photo.photo_description}`);

      // Check for photo analysis for this photo
      const analysisRes = await pool.query(`
        SELECT s.id, s.state_text
        FROM states s
        JOIN state_links sl ON s.id = sl.state_id
        WHERE sl.entity_type = 'state_photo' AND sl.entity_id = $1 AND s.state_text LIKE '[photo_analysis]%'
      `, [photo.id]);
      console.log(`      Photo Analysis count: ${analysisRes.rows.length}`);
      for (const a of analysisRes.rows) {
        console.log(`        - Analysis ID: ${a.id}`);
        console.log(`          Content: ${a.state_text.substring(0, 100)}...`);
      }
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
