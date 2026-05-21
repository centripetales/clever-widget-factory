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
  const recordId = '2fa23cfa-81cb-458d-a3a9-ceaab6e5f58d';
  console.log(`Checking financial record: ${recordId}\n`);

  // 1. Get the linked state
  const stateLink = await pool.query(
    `SELECT sl.state_id, s.state_text
     FROM state_links sl
     JOIN states s ON s.id = sl.state_id
     WHERE sl.entity_id = $1 AND sl.entity_type = 'financial_record'`,
    [recordId]
  );
  console.log('State links:', stateLink.rows);

  if (stateLink.rows.length === 0) {
    console.log('No state linked to this financial record');
    await pool.end();
    return;
  }

  const stateId = stateLink.rows[0].state_id;

  // 2. Get state_photos
  const photos = await pool.query(
    `SELECT sp.id, sp.photo_url, sp.photo_description, sp.photo_order
     FROM state_photos sp
     WHERE sp.state_id = $1
     ORDER BY sp.photo_order`,
    [stateId]
  );
  console.log(`\nPhotos count: ${photos.rows.length}`);
  for (const p of photos.rows) {
    console.log(`  Photo ${p.photo_order}: ${p.id} - ${p.photo_url}`);
    console.log(`    Description: ${p.photo_description}`);

    // 3. Check for photo_analysis linked to each photo
    const analysis = await pool.query(
      `SELECT sl.state_id, s.state_text
       FROM state_links sl
       JOIN states s ON sl.state_id = s.id
       WHERE sl.entity_type = 'state_photo'
         AND sl.entity_id = $1
         AND s.state_text LIKE '[photo_analysis]%'`,
      [p.id]
    );
    if (analysis.rows.length > 0) {
      console.log(`    ✓ Has photo_analysis: ${analysis.rows[0].state_text.substring(0, 100)}...`);
    } else {
      console.log(`    ✗ NO photo_analysis found`);
    }
  }

  // 4. Run the exact same query the API uses for getRecord
  const apiQuery = await pool.query(
    'SELECT sp.*, ' +
    '  s_trans.state_text AS transcription, ' +
    '  pap.model_id, ' +
    '  pap.version, ' +
    '  pap.system_prompt ' +
    ' FROM state_photos sp' +
    ' JOIN state_links sl ON sl.state_id = sp.state_id' +
    ' LEFT JOIN state_links sl_trans ON sl_trans.entity_type = \'state_photo\' AND sl_trans.entity_id = sp.id' +
    ' LEFT JOIN states s_trans ON sl_trans.state_id = s_trans.id AND s_trans.state_text LIKE \'[photo_analysis]%\'' +
    ' LEFT JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = \'photo_analysis_param\'' +
    ' LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id' +
    ' WHERE sl.entity_id = $1 AND sl.entity_type = \'financial_record\'' +
    ' ORDER BY sp.photo_order',
    [recordId]
  );
  console.log('\n--- API query result (what getRecord returns as photos) ---');
  for (const row of apiQuery.rows) {
    console.log({
      id: row.id,
      photo_url: row.photo_url?.substring(0, 60),
      transcription: row.transcription ? row.transcription.substring(0, 80) + '...' : null,
      model_id: row.model_id || null,
    });
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
