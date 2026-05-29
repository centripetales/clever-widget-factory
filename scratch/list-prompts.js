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
  const res = await pool.query(`
    SELECT id, prompt_key, model_id, version, system_prompt, created_at
    FROM photo_analysis_params
    ORDER BY created_at DESC;
  `);

  console.log(`--- REGISTERED PROMPTS ---`);
  console.log(`Found ${res.rows.length} prompts:`);
  res.rows.forEach(r => {
    console.log(`\n🔑 Key: "${r.prompt_key}" | Model: ${r.model_id} | Version: ${r.version}`);
    console.log(`-----------------------------------------`);
    console.log(r.system_prompt);
    console.log(`-----------------------------------------`);
  });
  
  await pool.end();
}

main().catch(console.error);
