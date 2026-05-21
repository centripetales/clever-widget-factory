const { Client } = require('pg');
require('dotenv').config({ path: './.env.local' });

async function run() {
  const client = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    ssl: { rejectUnauthorized: false }
  });
  try {
    await client.connect();
    
    // Find photos attached to states linked to financial records, or photos that mention receipts
    const sql = `
      SELECT 
        sp.id AS photo_id,
        sp.photo_url,
        sp.photo_description,
        s.id AS state_id,
        s.state_text
      FROM state_photos sp
      JOIN states s ON sp.state_id = s.id
      WHERE s.state_text ILIKE '%receipt%' 
         OR s.state_text ILIKE '%expense%'
         OR s.state_text ILIKE '%peso%'
         OR s.state_text ILIKE '%spent%'
         OR s.state_text ILIKE '%bought%'
         OR s.state_text ILIKE '%purc%'
         OR sp.photo_description ILIKE '%receipt%'
         OR sp.photo_description ILIKE '%invoice%'
         OR sp.photo_description ILIKE '%expense%'
      LIMIT 15;
    `;
    const res = await client.query(sql);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}
run();
