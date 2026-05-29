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
  // Query total count of [photo_analysis] states
  const totalRes = await pool.query(`
    SELECT COUNT(*) AS count
    FROM states
    WHERE state_text LIKE '[photo_analysis]%';
  `);
  
  // Query count created today (May 19, 2026)
  const todayRes = await pool.query(`
    SELECT COUNT(*) AS count
    FROM states
    WHERE state_text LIKE '[photo_analysis]%'
      AND captured_at >= '2026-05-19 00:00:00';
  `);

  console.log('--- Database Metrics ---');
  console.log(`Total photo analyses persisted: ${totalRes.rows[0].count}`);
  console.log(`Analyses created today (May 19, 2026): ${todayRes.rows[0].count}`);
  
  await pool.end();
}

main().catch(console.error);
