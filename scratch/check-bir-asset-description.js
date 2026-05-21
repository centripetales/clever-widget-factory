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
  // Query state photos linked to asset/record containing 'bir'
  const res = await pool.query(`
    SELECT 
      sp.id AS photo_id,
      sp.photo_url,
      sp.photo_description,
      s.state_text AS machine_description,
      s.captured_at
    FROM state_photos sp
    LEFT JOIN states s ON sp.state_id = s.id
    WHERE sp.photo_url LIKE '%2303%' OR sp.photo_description LIKE '%Bir%' OR s.state_text LIKE '%2303%'
    ORDER BY s.captured_at DESC
    LIMIT 5;
  `);

  console.log(`Found ${res.rows.length} asset photos for Bir/2303:`);
  res.rows.forEach((r, idx) => {
    console.log(`\n=========================================`);
    console.log(`ASSET PHOTO #${idx + 1}`);
    console.log(`Photo ID: ${r.photo_id} | S3 Url: ${r.photo_url}`);
    console.log(`User Photo Description: "${r.photo_description || 'None'}"`);
    console.log(`Machine Description: "${r.machine_description || 'None'}"`);
  });
  
  await pool.end();
}

main().catch(console.error);
