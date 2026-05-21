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
  console.log('🔄 Renaming database prompt_key from "triage" to "photo_analysis"...');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if photo_analysis already exists
    const checkRes = await client.query(
      "SELECT id FROM photo_analysis_params WHERE prompt_key = 'photo_analysis' LIMIT 1"
    );
    
    if (checkRes.rows.length > 0) {
      console.log('⚠️ A parameter row with key "photo_analysis" already exists. Merging triage row into it.');
      
      // Delete any duplicates in triage to avoid conflict, keeping photo_analysis
      await client.query(
        "DELETE FROM photo_analysis_params WHERE prompt_key = 'triage'"
      );
    } else {
      // Update key
      const updateRes = await client.query(
        "UPDATE photo_analysis_params SET prompt_key = 'photo_analysis' WHERE prompt_key = 'triage' RETURNING id"
      );
      if (updateRes.rows.length > 0) {
        console.log(`✓ Successfully updated prompt parameter row ID: ${updateRes.rows[0].id}`);
      } else {
        console.log('⚠️ No row found with prompt_key "triage".');
      }
    }
    
    await client.query('COMMIT');
    console.log('✓ Database rename transaction committed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Failed database key rename transaction:', err.message);
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(console.error);
