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
 *   node scripts/azolla-weekly-report.js --last-30-days --by-phone
 *
 * --by-phone adds a payout-oriented section grouped by phone number (two
 * WORKER_MAP entries can share a phone, e.g. the two John Lester Lunas) with
 * two numbers that matter more for payment than the raw table above:
 *   - real submissions: same as "observations" but with the vision-LLM
 *     derived-state rows excluded (see storeObservation() in
 *     azolla-duckweed-observation.js — it inserts one placeholder state per
 *     photo processed, which otherwise double-counts every photographed
 *     observation as two rows here).
 *   - photo-days: distinct days a photo was actually TAKEN (preferring
 *     photo_metadata_extractions EXIF/file time over the submission
 *     timestamp, same logic azolla-coverage-fetch-data.js uses) and made it
 *     into the system — catches e.g. a photo taken the night before but
 *     submitted the next day.
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

function resolveLast30Days() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  const start = new Date(now);
  start.setDate(now.getDate() - 29);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(now) };
}

const BY_PHONE = args.includes('--by-phone');

let START, END;
if (args.includes('--last-week')) {
  ({ start: START, end: END } = resolveLastSundayToSaturday());
} else if (args.includes('--last-30-days')) {
  ({ start: START, end: END } = resolveLast30Days());
} else {
  START = (args.find(a => a.startsWith('--start=')) || '').split('=')[1];
  END = (args.find(a => a.startsWith('--end=')) || '').split('=')[1];
}
if (!START || !END) {
  console.error('Usage: node scripts/azolla-weekly-report.js --start=YYYY-MM-DD --end=YYYY-MM-DD');
  console.error('   or: node scripts/azolla-weekly-report.js --last-week');
  console.error('   or: node scripts/azolla-weekly-report.js --last-30-days [--by-phone]');
  process.exit(1);
}

const DERIVED_STATE_TEXT = '[azolla_duckweed_observation] vision LLM structured extraction';

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
  // Below: participants with only ever a single observation as of the last
  // check. Previously left commented out on the theory they'd "reappear
  // automatically" once active — that was wrong, since a commented-out
  // entry can never appear in any query. Kept as real entries now so they
  // show up (even at 0) instead of silently vanishing from every report.
  '68e143f0-d041-701b-163d-5b0d16a6b8d9': { name: 'John Kenneth Narag', phone: '09455185997' }, // shared with John Marvin
  'd8d12380-d001-709e-4548-0351bff8e15f': { name: 'Chael Lascuna', phone: '09667334615' },
  'd841e330-0071-70c4-2f0e-5f33b4fec2bd': { name: 'Renzel Luna', phone: '09062303099' },
  '68f15370-f0f1-70da-0a13-c51768af24de': { name: 'Allan de Domingo', phone: '09100070209' },
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

// True capture date of a photo: prefer photo_metadata_extractions (EXIF, or
// failing that the browser's File.lastModified) over the submission
// timestamp, same "true time" logic azolla-coverage-fetch-data.js uses so a
// photo taken late at night but uploaded the next morning counts on the
// night it was actually taken. Guarded against broken device clocks by only
// trusting the EXIF year if it's close to the submitted year.
function manilaLocalFromUTC(utcDate) {
  return new Date(utcDate.getTime() + 8 * 3600 * 1000);
}
function dateKeyFromLocalDigits(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function realSubmissionCounts(client, ids) {
  const res = await client.query(`
    SELECT captured_by::text as cb, count(*) as cnt
    FROM states
    WHERE captured_by::text = ANY($1)
      AND (captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3
      AND state_text IS DISTINCT FROM $4
    GROUP BY captured_by
  `, [ids, START, END, DERIVED_STATE_TEXT]);
  const out = {};
  for (const r of res.rows) out[r.cb] = Number(r.cnt);
  return out;
}

async function photoDaysByPerson(client, ids) {
  const res = await client.query(`
    SELECT s.captured_by::text as cb, s.captured_at as submitted_at, pme.captured_at as exif_captured_at
    FROM states s
    JOIN state_photos sp ON sp.state_id = s.id
    LEFT JOIN photo_metadata_extractions pme ON pme.photo_url = sp.photo_url
    WHERE s.captured_by::text = ANY($1)
  `, [ids]);
  const out = {};
  for (const r of res.rows) {
    const submittedLocal = manilaLocalFromUTC(r.submitted_at);
    let trueTime = submittedLocal;
    if (r.exif_captured_at && Math.abs(r.exif_captured_at.getUTCFullYear() - submittedLocal.getUTCFullYear()) <= 1) {
      trueTime = r.exif_captured_at;
    }
    const day = dateKeyFromLocalDigits(trueTime);
    if (day < START || day > END) continue;
    if (!out[r.cb]) out[r.cb] = new Set();
    out[r.cb].add(day);
  }
  return out;
}

async function totalPhotoCounts(client, ids) {
  const res = await client.query(`
    SELECT s.captured_by::text as cb, count(sp.id) as cnt
    FROM states s
    JOIN state_photos sp ON sp.state_id = s.id
    WHERE s.captured_by::text = ANY($1)
      AND (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3
    GROUP BY s.captured_by
  `, [ids, START, END]);
  const out = {};
  for (const r of res.rows) out[r.cb] = Number(r.cnt);
  return out;
}

const STARGAZER_FARM_ORG_ID = '00000000-0000-0000-0000-000000000001';

// Same-shape stats for an action-scoped person (Stefan/Mae — see
// ACTION_SCOPED above for why they can't be queried by raw captured_by).
async function actionScopedPhoneStats(client, actionId) {
  const [realRes, photoRes] = await Promise.all([
    client.query(`
      SELECT count(*) as cnt
      FROM state_links sl JOIN states s ON s.id = sl.state_id
      WHERE sl.entity_type = 'action' AND sl.entity_id = $1
        AND (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3
        AND s.state_text IS DISTINCT FROM $4
    `, [actionId, START, END, DERIVED_STATE_TEXT]),
    client.query(`
      SELECT s.captured_at as submitted_at, pme.captured_at as exif_captured_at, count(*) OVER () as total_photos
      FROM state_links sl
      JOIN states s ON s.id = sl.state_id
      JOIN state_photos sp ON sp.state_id = s.id
      LEFT JOIN photo_metadata_extractions pme ON pme.photo_url = sp.photo_url
      WHERE sl.entity_type = 'action' AND sl.entity_id = $1
    `, [actionId]),
  ]);
  const days = new Set();
  for (const r of photoRes.rows) {
    const submittedLocal = manilaLocalFromUTC(r.submitted_at);
    let trueTime = submittedLocal;
    if (r.exif_captured_at && Math.abs(r.exif_captured_at.getUTCFullYear() - submittedLocal.getUTCFullYear()) <= 1) {
      trueTime = r.exif_captured_at;
    }
    const day = dateKeyFromLocalDigits(trueTime);
    if (day >= START && day <= END) days.add(day);
  }
  return {
    real_submissions: Number(realRes.rows[0].cnt),
    photo_days: days.size,
    total_photos: photoRes.rows.length,
  };
}

// Finds anyone with azolla/duckweed-tagged or photo-attached activity this
// window who isn't in WORKER_MAP or under the Stargazer Farm org (Stefan/
// Mae's shared org) — a safety net against the roster silently going stale,
// the way the "Mac" account (a one-off photo from weeks earlier that only
// surfaced when its vision-LLM backfill ran this window) did.
const SYSTEM_CAPTURED_BY = '00000000-0000-0000-0000-000000000000';

async function strayActivity(client) {
  const knownIds = Object.keys(WORKER_MAP);
  const res = await client.query(`
    SELECT s.organization_id, o.name as org_name, s.captured_by::text as captured_by,
      NULLIF(om.full_name, '') as full_name, om.email, count(*) as cnt
    FROM states s
    LEFT JOIN organizations o ON o.id = s.organization_id
    LEFT JOIN organization_members om ON om.user_id = s.captured_by AND om.organization_id = s.organization_id
    WHERE (s.captured_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1 AND $2
      AND NOT (s.captured_by::text = ANY($3))
      AND s.captured_by::text != $5
      AND s.organization_id != $4
      AND s.state_text IS DISTINCT FROM $6
      AND EXISTS (SELECT 1 FROM state_photos sp WHERE sp.state_id = s.id)
    GROUP BY s.organization_id, o.name, s.captured_by, om.full_name, om.email
  `, [START, END, knownIds, STARGAZER_FARM_ORG_ID, SYSTEM_CAPTURED_BY, DERIVED_STATE_TEXT]);
  return res.rows.map((r) => ({
    org: r.org_name,
    person: r.full_name || r.email || r.captured_by,
    observations: Number(r.cnt),
  }));
}

// Groups WORKER_MAP by phone (two entries can share a number, e.g. the two
// John Lester Lunas) and unions their photo-day sets so an overlapping day
// isn't double-counted for a shared-phone payout. Also includes the
// action-scoped roster (Stefan/Mae — no phone on file, internal team) so
// the report covers everyone with observations, not just phone-based
// field workers.
async function byPhoneReport(client) {
  const ids = Object.keys(WORKER_MAP);
  const [realCounts, photoDays, photoCounts, actionScopedStats] = await Promise.all([
    realSubmissionCounts(client, ids),
    photoDaysByPerson(client, ids),
    totalPhotoCounts(client, ids),
    Promise.all(Object.entries(ACTION_SCOPED).map(async ([name, actionId]) => [
      name, await actionScopedPhoneStats(client, actionId),
    ])),
  ]);

  const phones = {};
  for (const [id, info] of Object.entries(WORKER_MAP)) {
    if (!phones[info.phone]) phones[info.phone] = { names: [], ids: [] };
    phones[info.phone].names.push(info.name);
    phones[info.phone].ids.push(id);
  }

  const rows = Object.entries(phones).map(([phone, group]) => {
    const unionDays = new Set();
    let realSubmissions = 0;
    let totalPhotos = 0;
    for (const id of group.ids) {
      realSubmissions += realCounts[id] || 0;
      totalPhotos += photoCounts[id] || 0;
      for (const d of (photoDays[id] || [])) unionDays.add(d);
    }
    return {
      phone,
      people: group.names.join(' + '),
      real_submissions: realSubmissions,
      photo_days: unionDays.size,
      total_photos: totalPhotos,
    };
  });

  for (const [name, stats] of actionScopedStats) {
    rows.push({ phone: '(no phone on file — internal)', people: name, ...stats });
  }

  return rows.sort((a, b) => b.photo_days - a.photo_days);
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

    let byPhone = null;
    let stray = null;
    if (BY_PHONE) {
      [byPhone, stray] = await Promise.all([byPhoneReport(client), strayActivity(client)]);
      console.log('\nBy phone number (submissions exclude vision-LLM derived states; photo-days use EXIF/file capture time):');
      console.log('Phone | Submissions | Photo-days | Total photos');
      for (const r of byPhone) {
        // Names are dropped for phone-keyed rows (payment is by phone number);
        // kept for Stefan/Mae since they have no phone to key on instead.
        const label = r.phone.startsWith('(no phone') ? ` (${r.people})` : '';
        console.log(`${r.phone}${label} | ${r.real_submissions} | ${r.photo_days} | ${r.total_photos}`);
      }

      if (stray.length > 0) {
        console.log('\n⚠️  Activity found outside the known roster — check these aren\'t missing payees:');
        for (const r of stray) {
          console.log(`  ${r.person} (org "${r.org}"): ${r.observations} observation(s)`);
        }
      }
    }

    console.log('\nJSON:');
    console.log(JSON.stringify(byPhone ? { all, byPhone, stray } : all, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
