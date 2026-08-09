#!/usr/bin/env node

/**
 * Weekly azolla/duckweed experiment observation report: per-person days-with-
 * observation, observation count, and photo stats for a Sunday-Saturday window.
 *
 * Background on the two bugs this script exists to avoid re-introducing:
 * - organization_members has ONE ROW PER ORG a person belongs to. Joining
 *   states -> organization_members on cognito_user_id without deduping first
 *   fans out every real observation by however many orgs that person is in
 *   (Stefan is in 14 orgs; this turned 117 real observations into 1638).
 *   Fixed here by deduping organization_members to one row per person first.
 * - Some organization_members rows have full_name = '' (empty string, not
 *   NULL) instead of a real name. COALESCE only falls back on NULL, so those
 *   people silently merge into a single blank bucket unless NULLIF is used.
 *
 * Stefan and Mae are core team members whose accounts log lots of unrelated
 * activity (chatbot logs, financial docs, etc.), so their rows are scoped to
 * their specific azolla action via state_links instead of raw captured_by —
 * see WORKER_MAP below for the action IDs.
 *
 * Usage:
 *   node scripts/azolla-weekly-report.js --start=2026-07-26 --end=2026-08-01
 *   node scripts/azolla-weekly-report.js --last-week   (resolves last Sun-Sat automatically)
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
  const day = now.getDay(); // 0 = Sunday
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
  console.error('Usage: node scripts/azolla-weekly-report.js --start=YYYY-MM-DD --end=YYYY-MM-DD');
  console.error('   or: node scripts/azolla-weekly-report.js --last-week');
  process.exit(1);
}

// Known worker roster: raw text-question observations from guest/phone-based
// workers link a cognito_user_id whose organization_members.full_name is
// blank, so names/phones/emails are tracked here by hand rather than derived.
// Update this list as workers join/leave the experiment.
const WORKER_MAP = {
  'b801b310-00d1-7076-86e7-10babf7ab591': { name: 'Wilfred Salazar', phone: '09388211690' },
  '1871b320-b041-7073-ccf1-713d36e0c23a': { name: 'Jusua Natabio', phone: '09158545941' },
  'f8b123a0-90a1-7097-454a-ba015da4c8f0': { name: 'John Marvin Layos', phone: '09455185997' },
  'f8b13370-a0c1-70e6-7dc8-0cc2c3f3a175': { name: 'John Lester Luna (Buboy)', phone: '09487149611' },
  '68a1c3b0-9091-700c-7cad-e0b4bf299ff2': { name: 'John Lester Luna (LesterLuna)', phone: '09487149611' },
  // Not currently in the report because they had zero observations as of
  // 2026-08-01 — kept here so they reappear automatically once they do:
  // John Kenneth Narag  naragjohnkenneth224@gmail.com  09455185997 (shared with John Marvin)
  // Chael Lascuna       lascunachael134@gmail.com      09667334615
  // Renzel Luna         xenzeluna3@gmail.com           09062303099
  // Allan de Domingo    lanshomemadeproduct@gmail.com  09100070209
};

// Core team members: scoped to their specific azolla action via state_links
// instead of raw captured_by, since their accounts also log unrelated
// activity (chatbot messages, financial docs, etc.). Lester Paniel is
// deliberately excluded — he isn't part of this experiment.
const ACTION_SCOPED = {
  'Stefan Hamilton': '7d5553bb-14ae-485d-9014-7f84ed49841f',
  'Mae Dela Torre': 'a98acb69-687e-4bad-aad4-34c1d35d3a58',
};

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function workerRows(client) {
  const sql = `
    SELECT
      s.captured_by::text as captured_by,
      COUNT(DISTINCT (s.captured_at AT TIME ZONE 'Asia/Manila')::date) as days_with_observation,
      COUNT(DISTINCT s.id) as observations,
      COUNT(sp.id) as total_photos,
      ROUND(COUNT(sp.id)::numeric / NULLIF(COUNT(DISTINCT s.id), 0), 2) as avg_photos_per_observation
    FROM states s
    LEFT JOIN state_photos sp ON sp.state_id = s.id
    WHERE (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1 AND $2
      AND s.captured_by::text = ANY($3)
    GROUP BY s.captured_by
  `;
  const ids = Object.keys(WORKER_MAP);
  const res = await client.query(sql, [START, END, ids]);
  return res.rows.map((r) => ({
    person: WORKER_MAP[r.captured_by].name,
    phone: WORKER_MAP[r.captured_by].phone,
    days_with_observation: Number(r.days_with_observation),
    observations: Number(r.observations),
    total_photos: Number(r.total_photos),
    avg_photos_per_observation: Number(r.avg_photos_per_observation),
  }));
}

async function actionScopedRows(client) {
  const out = [];
  for (const [name, actionId] of Object.entries(ACTION_SCOPED)) {
    const res = await client.query(`
      SELECT
        COUNT(DISTINCT (s.captured_at AT TIME ZONE 'Asia/Manila')::date) as days_with_observation,
        COUNT(DISTINCT s.id) as observations,
        COUNT(sp.id) as total_photos,
        ROUND(COUNT(sp.id)::numeric / NULLIF(COUNT(DISTINCT s.id), 0), 2) as avg_photos_per_observation
      FROM state_links sl
      JOIN states s ON s.id = sl.state_id
      LEFT JOIN state_photos sp ON sp.state_id = s.id
      WHERE sl.entity_type = 'action' AND sl.entity_id = $1
        AND (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3
    `, [actionId, START, END]);
    const r = res.rows[0];
    out.push({
      person: name,
      scope: `azolla action ${actionId}`,
      phone: null,
      days_with_observation: Number(r.days_with_observation),
      observations: Number(r.observations),
      total_photos: Number(r.total_photos),
      avg_photos_per_observation: r.avg_photos_per_observation ? Number(r.avg_photos_per_observation) : 0,
    });
  }
  return out;
}

// Flags people whose observation count looks inflated by resubmission
// retries: same captured_by, same day, with state_text values that are
// near-duplicates (e.g. differ only in day-label casing) submitted within
// minutes of each other. Doesn't auto-correct anything — just surfaces it
// for a human look, the way the Buboy case needed one.
async function retryFlags(client) {
  const ids = [...Object.keys(WORKER_MAP), ...Object.values(ACTION_SCOPED)];
  const res = await client.query(`
    SELECT s.captured_by::text as captured_by, s.state_text, count(*) as cnt,
      min(s.created_at) as first_created, max(s.created_at) as last_created
    FROM states s
    WHERE (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1 AND $2
      AND s.captured_by::text = ANY($3)
      AND s.state_text IS NOT NULL
    GROUP BY s.captured_by, s.state_text
    HAVING count(*) > 1
  `, [START, END, Object.keys(WORKER_MAP)]);
  return res.rows.map((r) => ({
    person: (WORKER_MAP[r.captured_by] || {}).name || r.captured_by,
    duplicate_count: Number(r.cnt),
    text_sample: r.state_text.slice(0, 60),
    submitted_within_minutes: ((new Date(r.last_created) - new Date(r.first_created)) / 60000).toFixed(1),
  }));
}

async function main() {
  const client = await pool.connect();
  try {
    const [workers, actionScoped, retries] = await Promise.all([
      workerRows(client),
      actionScopedRows(client),
      retryFlags(client),
    ]);
    const all = [...workers, ...actionScoped].sort((a, b) => b.days_with_observation - a.days_with_observation);

    console.log(`\nAzolla weekly report: ${START} to ${END} (Asia/Manila)\n`);
    console.log('Person | Phone | Days with observation | Observations | Total photos | Avg photos/observation');
    for (const r of all) {
      console.log(`${r.person} | ${r.phone || '—'} | ${r.days_with_observation} | ${r.observations} | ${r.total_photos} | ${r.avg_photos_per_observation}`);
    }

    if (retries.length > 0) {
      console.log('\n⚠️  Possible retry-duplicate submissions (same person, same text, submitted close together):');
      for (const r of retries) {
        console.log(`  ${r.person}: "${r.text_sample}" submitted ${r.duplicate_count}x within ${r.submitted_within_minutes} min`);
      }
    }

    console.log('\nJSON:');
    console.log(JSON.stringify(all, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
