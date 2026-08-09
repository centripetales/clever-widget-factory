#!/usr/bin/env node

/**
 * Builds the phone-labeled heatmap stats table (inline-styled HTML, safe to
 * paste into Gmail compose) for the weekly azolla email. Reuses the same
 * dedup-safe query as azolla-weekly-report.js — see that file for why the
 * dedup matters.
 *
 * Rows are labeled by PHONE NUMBER, not name, matching the payment-email
 * convention — except Stefan and Mae, who keep their names since they don't
 * have a tracked phone. Where two people share a phone (paid to the same
 * GCash account), both rows keep the same number suffixed -1/-2.
 *
 * Usage:
 *   node scripts/azolla-weekly-heatmap.js --start=2026-07-26 --end=2026-08-01 > table.html
 *   node scripts/azolla-weekly-heatmap.js --last-week > table.html
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

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

function resolveLastSundayToSaturday() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  const day = now.getDay();
  const daysSinceLastSunday = day === 0 ? 7 : day;
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - daysSinceLastSunday);
  const lastSaturday = new Date(lastSunday);
  lastSaturday.setDate(lastSunday.getDate() + 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(lastSunday), end: fmt(lastSaturday) };
}

let START, END;
if (args.includes('--last-week')) {
  ({ start: START, end: END } = resolveLastSundayToSaturday());
} else {
  START = (args.find(a => a.startsWith('--start=')) || '').split('=')[1];
  END = (args.find(a => a.startsWith('--end=')) || '').split('=')[1];
}
if (!START || !END) {
  console.error('Usage: node scripts/azolla-weekly-heatmap.js --start=YYYY-MM-DD --end=YYYY-MM-DD');
  console.error('   or: node scripts/azolla-weekly-heatmap.js --last-week');
  process.exit(1);
}

// Update this as the roster changes. "label" is what shows in the table —
// phone number for workers, first name for core team (no tracked phone).
// Rows are printed in this order.
const ROSTER = [
  { id: 'b801b310-00d1-7076-86e7-10babf7ab591', label: '09388211690' },        // Wilfred Salazar
  { id: '1871b320-b041-7073-ccf1-713d36e0c23a', label: '09158545941' },        // Jusua Natabio
  { id: '68a1c3b0-9091-700c-7cad-e0b4bf299ff2', label: '09487149611-1' },      // John Lester Luna (LesterLuna)
  { id: 'john-kenneth-placeholder', label: '09455185997-1', noAccountYet: true }, // John Kenneth Narag — not yet linked to a states account
  { id: 'f8b123a0-90a1-7097-454a-ba015da4c8f0', label: '09455185997-2' },      // John Marvin Layos
  { id: 'STEFAN_ACTION', label: 'Stefan', actionId: '7d5553bb-14ae-485d-9014-7f84ed49841f' },
  { id: 'f8b13370-a0c1-70e6-7dc8-0cc2c3f3a175', label: '09487149611-2' },      // John Lester Luna (Buboy)
  { id: 'MAE_ACTION', label: 'Mae', actionId: 'a98acb69-687e-4bad-aad4-34c1d35d3a58' },
  { id: 'chael-placeholder', label: '09667334615', noAccountYet: true },       // Chael Lascuna
  { id: 'allan-placeholder', label: '09100070209', noAccountYet: true },       // Allan de Domingo
  { id: 'renzel-placeholder', label: '09062303099', noAccountYet: true },      // Renzel Luna
];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function statsForRow(client, row) {
  if (row.noAccountYet) return { obsPerDay: null, photosPerObs: null, medianText: null };

  const filter = row.actionId
    ? `FROM state_links sl JOIN states s ON s.id = sl.state_id WHERE sl.entity_type='action' AND sl.entity_id = $3`
    : `FROM states s WHERE s.captured_by::text = $3`;
  const key = row.actionId || row.id;

  const countRes = await client.query(`
    SELECT COUNT(DISTINCT s.id) as observations, COUNT(sp.id) as total_photos
    FROM states s
    LEFT JOIN state_photos sp ON sp.state_id = s.id
    ${row.actionId ? 'JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type=\'action\' AND sl.entity_id = $3' : ''}
    WHERE (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1 AND $2
      ${row.actionId ? '' : 'AND s.captured_by::text = $3'}
  `, [START, END, key]);

  const textRes = await client.query(`
    SELECT length(s.state_text) as len
    FROM states s
    ${row.actionId ? 'JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type=\'action\' AND sl.entity_id = $3' : ''}
    WHERE (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1 AND $2
      ${row.actionId ? '' : 'AND s.captured_by::text = $3'}
      AND s.state_text IS NOT NULL
    ORDER BY len
  `, [START, END, key]);

  const days = (new Date(END) - new Date(START)) / 86400000 + 1;
  const observations = Number(countRes.rows[0].observations);
  const totalPhotos = Number(countRes.rows[0].total_photos);
  const lens = textRes.rows.map(r => Number(r.len));
  let median = 0;
  if (lens.length) {
    const mid = Math.floor(lens.length / 2);
    median = lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
  }

  return {
    obsPerDay: observations === 0 ? null : Number((observations / days).toFixed(2)),
    photosPerObs: observations === 0 ? null : Number((totalPhotos / observations).toFixed(2)),
    medianText: observations === 0 ? null : median,
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function heatColor(t) {
  const light = [222, 234, 250], dark = [17, 61, 119];
  return light.map((c, i) => Math.round(lerp(c, dark[i], t)));
}
function hexc([r, g, b]) { return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; }
function textColor([r, g, b]) {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.55 ? '#ffffff' : '#1a2b3c';
}
function cellHtml(v, values, fmt) {
  if (v === null) {
    return '<td style="padding:10px 16px;background:#f4f6f9;color:#9aa5b1;font-family:Arial,Helvetica,sans-serif;font-size:13px;text-align:center;border-bottom:1px solid #e7ebf0;">no data</td>';
  }
  const lo = Math.min(...values), hi = Math.max(...values);
  const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
  const rgb = heatColor(t);
  return `<td style="padding:10px 16px;background:${hexc(rgb)};color:${textColor(rgb)};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;border-bottom:1px solid #e7ebf0;">${fmt(v)}</td>`;
}

async function main() {
  const client = await pool.connect();
  try {
    const rows = [];
    for (const row of ROSTER) {
      const stats = await statsForRow(client, row);
      rows.push({ label: row.label, ...stats });
    }

    const col1 = rows.map(r => r.obsPerDay).filter(v => v !== null);
    const col2 = rows.map(r => r.photosPerObs).filter(v => v !== null);
    const col3 = rows.map(r => r.medianText).filter(v => v !== null);

    let html = '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;border:1px solid #e7ebf0;">\n';
    html += '<tr style="background:#f8f9fb;">'
      + '<th style="padding:10px 16px;text-align:left;font-size:11px;letter-spacing:0.06em;color:#5b6673;text-transform:uppercase;border-bottom:2px solid #e0e4ea;">Person</th>'
      + '<th style="padding:10px 16px;text-align:center;font-size:11px;letter-spacing:0.06em;color:#5b6673;text-transform:uppercase;border-bottom:2px solid #e0e4ea;">Observations<br/>/ day</th>'
      + '<th style="padding:10px 16px;text-align:center;font-size:11px;letter-spacing:0.06em;color:#5b6673;text-transform:uppercase;border-bottom:2px solid #e0e4ea;">Photos /<br/>observation</th>'
      + '<th style="padding:10px 16px;text-align:center;font-size:11px;letter-spacing:0.06em;color:#5b6673;text-transform:uppercase;border-bottom:2px solid #e0e4ea;">Median text<br/>/ observation</th>'
      + '</tr>\n';

    for (const r of rows) {
      html += '<tr>';
      html += `<td style="padding:10px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a2b3c;border-bottom:1px solid #e7ebf0;background:#ffffff;">${r.label}</td>`;
      html += cellHtml(r.obsPerDay, col1, (v) => v.toFixed(2));
      html += cellHtml(r.photosPerObs, col2, (v) => v.toFixed(2));
      html += cellHtml(r.medianText, col3, (v) => String(v));
      html += '</tr>\n';
    }
    html += '</table>';

    console.log(html);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
