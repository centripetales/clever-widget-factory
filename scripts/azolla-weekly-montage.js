#!/usr/bin/env node

/**
 * Downloads each azolla worker's latest photo, composes them into a labeled
 * grid, and uploads the result to the same public S3 bucket the app already
 * uses for photos — printing back a public URL ready to paste into Gmail
 * via Insert > Image > Web Address (don't attach it directly; an attached
 * image is stored in full for every recipient's mailbox, an S3-linked one
 * is stored once).
 *
 * Stefan and Mae are scoped to their azolla action (see azolla-weekly-
 * report.js for why), not raw captured_by. Their accounts sometimes log a
 * photo that isn't actually representative (a GCash receipt got mis-linked
 * to Stefan's action once) — if a tile looks wrong, use --stefan-skip=N /
 * --mae-skip=N to take the Nth most recent instead of the very latest.
 *
 * Requires Python 3 with Pillow (same environment used to build past
 * montages by hand) for the actual compositing step.
 *
 * Usage:
 *   node scripts/azolla-weekly-montage.js
 *   node scripts/azolla-weekly-montage.js --stefan-skip=1   (2nd most recent)
 *   node scripts/azolla-weekly-montage.js --no-upload        (compose only, skip S3)
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const https = require('https');

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

const args = process.argv.slice(2);
const stefanSkip = Number((args.find(a => a.startsWith('--stefan-skip=')) || '').split('=')[1] || 0);
const maeSkip = Number((args.find(a => a.startsWith('--mae-skip=')) || '').split('=')[1] || 0);
const noUpload = args.includes('--no-upload');

// Update as the roster changes.
const PEOPLE = [
  { label: 'Wilfred', id: 'b801b310-00d1-7076-86e7-10babf7ab591' },
  { label: 'Jusua', id: '1871b320-b041-7073-ccf1-713d36e0c23a' },
  { label: 'LesterLuna', id: '68a1c3b0-9091-700c-7cad-e0b4bf299ff2' },
  { label: 'Marvin', id: 'f8b123a0-90a1-7097-454a-ba015da4c8f0' },
  { label: 'Stefan', actionId: '7d5553bb-14ae-485d-9014-7f84ed49841f', skip: stefanSkip },
  { label: 'Buboy', id: 'f8b13370-a0c1-70e6-7dc8-0cc2c3f3a175' },
  { label: 'Mae', actionId: 'a98acb69-687e-4bad-aad4-34c1d35d3a58', skip: maeSkip },
];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function latestPhoto(client, person) {
  const filter = person.actionId
    ? `FROM state_links sl JOIN states s ON s.id = sl.state_id JOIN state_photos sp ON sp.state_id = s.id WHERE sl.entity_type = 'action' AND sl.entity_id = $1`
    : `FROM states s JOIN state_photos sp ON sp.state_id = s.id WHERE s.captured_by::text = $1`;
  const res = await client.query(`
    SELECT s.captured_at, sp.photo_url
    ${filter}
    ORDER BY s.captured_at DESC, sp.id
    LIMIT 20
  `, [person.actionId || person.id]);
  const skip = person.skip || 0;
  const row = res.rows[skip];
  if (!row) return null;
  return { date: row.captured_at.toISOString().slice(0, 10), url: row.photo_url };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${url} -> ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function main() {
  const client = await pool.connect();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azolla-montage-'));
  try {
    const manifest = [];
    for (const person of PEOPLE) {
      const photo = await latestPhoto(client, person);
      if (!photo) {
        console.error(`No photo found for ${person.label}, skipping.`);
        continue;
      }
      const ext = path.extname(new URL(photo.url).pathname) || '.jpg';
      const dest = path.join(tmpDir, `${person.label}${ext}`);
      await download(photo.url, dest);
      manifest.push({ label: person.label, date: photo.date, file: dest });
      console.error(`${person.label}: ${photo.date} -> ${dest}`);
    }

    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const outPath = path.join(tmpDir, 'montage.jpg');

    execFileSync('python3', [path.join(__dirname, 'azolla-montage-compose.py'), manifestPath, outPath], { stdio: 'inherit' });

    if (noUpload) {
      console.log(`Composed montage (not uploaded): ${outPath}`);
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const s3Key = `organizations/00000000-0000-0000-0000-000000000001/images/azolla-weekly-montage-${dateStr}.jpg`;
    execFileSync('aws', ['s3', 'cp', outPath, `s3://cwf-dev-assets/${s3Key}`, '--content-type', 'image/jpeg'], { stdio: 'inherit' });

    console.log(`\nPublic URL:\nhttps://cwf-dev-assets.s3.us-west-2.amazonaws.com/${s3Key}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
