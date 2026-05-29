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

async function checkBir() {
  try {
    // 1. Find BIR tool
    const toolRes = await pool.query(`SELECT id, name FROM tools WHERE name ILIKE '%bir%'`);
    console.log('BIR Tools found:', toolRes.rows);
    if (toolRes.rows.length === 0) return;
    
    const toolId = toolRes.rows[0].id;
    
    // 2. Find states linked to BIR
    const statesRes = await pool.query(`
      SELECT s.id, s.state_text, s.captured_at, s.created_at
      FROM states s
      JOIN state_links sl ON sl.state_id = s.id
      WHERE sl.entity_type = 'tool' AND sl.entity_id = $1
      ORDER BY s.captured_at DESC
    `, [toolId]);
    
    console.log(`\nFound ${statesRes.rows.length} observations for BIR:`);
    for (const s of statesRes.rows) {
      console.log(`- State ID: ${s.id}`);
      console.log(`  Captured At: ${s.captured_at}`);
      console.log(`  Text: "${s.state_text}"`);
      
      // Get photos for this state
      const photosRes = await pool.query(`
        SELECT id, photo_url, photo_description
        FROM state_photos
        WHERE state_id = $1
      `, [s.id]);
      
      console.log(`  Photos (${photosRes.rows.length}):`);
      for (const p of photosRes.rows) {
        console.log(`    * Photo ID: ${p.id}`);
        console.log(`      URL: ${p.photo_url}`);
        console.log(`      Description: "${p.photo_description}"`);
        
        // Find if this photo has a photo_analysis linked
        const transRes = await pool.query(`
          SELECT s_trans.id, s_trans.state_text
          FROM state_links sl_trans
          JOIN states s_trans ON sl_trans.state_id = s_trans.id
          WHERE sl_trans.entity_type = 'state_photo' 
            AND sl_trans.entity_id = $1 
            AND s_trans.state_text LIKE '[photo_analysis]%'
        `, [p.id]);
        
        console.log(`      Photo Analysis Link Count: ${transRes.rows.length}`);
        for (const t of transRes.rows) {
          console.log(`        > Analysis ID: ${t.id}`);
          console.log(`          Content: "${t.state_text.substring(0, 100)}..."`);
        }
      }
    }
  } catch (err) {
    console.error('Error checking BIR:', err);
  } finally {
    await pool.end();
  }
}

checkBir();
