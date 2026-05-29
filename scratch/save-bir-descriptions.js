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
  const paramRes = await pool.query(
    "SELECT id FROM photo_analysis_params WHERE prompt_key = 'photo_analysis' LIMIT 1"
  );
  const paramId = paramRes.rows[0].id;
  const orgId = '00000000-0000-0000-0000-000000000001';
  const userUuid = '08617390-b001-708d-f61e-07a1698282ec'; // Valid User UUID
  
  const records = [
    {
      photo_id: '5d143c0a-3c7b-486a-9715-f086153a158f', // Real Page 1 ID
      description: 'The image depicts a framed certificate of registration issued by the Bureau of Internal Revenue (BIR) in the Philippines. The certificate is encased in a wooden frame with a maroon border. The document is titled "CERTIFICATE OF REGISTRATION" and contains various details about the taxpayer. The taxpayer\'s name is "STARGAZER TECHNOLOGIES INC." with a Taxpayer Identification Number (TIN) of 615-270-623-0000. The document includes the taxpayer\'s type, registration address, and business information details. The certificate also specifies the filing due dates for different tax types, such as Corporate Income Tax and Percentage Tax. The registration date is September 28, 2022. The document is printed on white paper with black text and is organized in a structured format with headings and subheadings.'
    },
    {
      photo_id: '803a751a-735c-47a0-86fe-7b2d07aeb14f', // Real Page 2 ID
      description: 'The image depicts a Certificate of Registration issued by the Bureau of Internal Revenue (BIR) in the Philippines. The document is framed in a red border and contains several key elements. At the top, there is a header with the BIR logo and the form number "2303," revised in August 2024. Below this, the document specifies the type of taxpayer as "Domestic Corporation" and provides the TIN and branch code "615-270-623-0000." The name of the taxpayer is "Stargazer Technologies Inc." The certificate number is "072RC20250000003477," and the date of issuance is September 28, 2022. The document also includes a stamp with the words "BIR Form 2025" and a signature from the Revenue District Officer (RDO), Nelia B. Demalata. The certificate is to be exhibited conspicuously in the place of business.'
    }
  ];

  for (const rec of records) {
    console.log(`Persisting state for Photo ID: ${rec.photo_id}...`);
    
    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const stateText = `[photo_analysis] ${rec.description}`;
      const stateRes = await client.query(
        `INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
         VALUES (gen_random_uuid(), $1, $2, $3, NOW())
         RETURNING id`,
        [orgId, stateText, userUuid]
      );
      const stateId = stateRes.rows[0].id;
      
      // Link to state_photo
      await client.query(
        `INSERT INTO state_links (id, state_id, entity_type, entity_id)
         VALUES (gen_random_uuid(), $1, 'state_photo', $2)`,
        [stateId, rec.photo_id]
      );

      // Link to photo_analysis_param
      await client.query(
        `INSERT INTO state_links (id, state_id, entity_type, entity_id)
         VALUES (gen_random_uuid(), $1, 'photo_analysis_param', $2)`,
        [stateId, paramId]
      );
      
      await client.query('COMMIT');
      console.log(`✓ Successfully saved state ${stateId}!`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ Failed to save photo ${rec.photo_id}:`, err.message);
    } finally {
      client.release();
    }
  }

  await pool.end();
}

main().catch(console.error);
