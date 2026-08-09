#!/usr/bin/env node

/**
 * Fetches coverage_points_by_day.json for azolla-coverage-chart.py and
 * downloads a thumbnail for every unique photo referenced.
 *
 * Groups by (container, calendar day) — each point on the chart is one day
 * for one container, with every photo taken that day and that day's real
 * human-written note (from states.state_text on the ORIGINAL observation,
 * not the derived vision-analysis state — see storeObservation() in
 * azolla-duckweed-observation.js, which creates a separate derived state
 * with a fixed placeholder text; joining from state_photos.state_id gets
 * you the real original observation, not that placeholder).
 *
 * Usage: node scripts/azolla-coverage-fetch-data.js <scratch_dir>
 *   Writes <scratch_dir>/coverage_points_by_day.json and downloads
 *   thumbnails into <scratch_dir>/thumbs/.
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

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

const SCRATCH_DIR = process.argv[2];
if (!SCRATCH_DIR) {
  console.error('Usage: node scripts/azolla-coverage-fetch-data.js <scratch_dir>');
  process.exit(1);
}
const THUMB_DIR = path.join(SCRATCH_DIR, 'thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${url} -> ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// Must match url_hash() in azolla-coverage-chart.py exactly — both sides
// use MD5 specifically because it's stable across processes/languages,
// unlike e.g. Python's built-in hash() which is randomized per-process.
function urlHash(url) {
  return crypto.createHash('md5').update(url, 'utf8').digest('hex');
}

// Philippines has no DST, so a fixed +8h shift of the UTC instant gives
// Manila wall-clock digits when read back via the UTC getters below.
function manilaLocalFromUTC(utcDate) {
  return new Date(utcDate.getTime() + 8 * 3600 * 1000);
}

// `d` must already carry local wall-clock digits in its UTC getters —
// either a shifted-UTC app timestamp (see above), or an EXIF timestamp
// used as-is (see the note by exif_captured_at below).
function dateKeyFromLocalDigits(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function timeStrFromLocalDigits(d) {
  let h = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT
        t.id as tool_id, t.name as container_name,
        s.id as state_id, s.captured_at,
        s.state_text as observation_notes, sp.photo_description as photo_notes,
        sp.id as photo_id, sp.photo_url,
        p.plant_coverage_percent_estimate as photo_coverage,
        pme.captured_at as exif_captured_at
      FROM metric_snapshots ms
      JOIN metrics m ON m.metric_id = ms.metric_id AND m.name = 'Coverage %'
      JOIN tools t ON t.id = m.tool_id
      JOIN states s ON s.id = ms.state_id
      JOIN state_photos sp ON sp.state_id = s.id
      LEFT JOIN state_links sl ON sl.entity_type = 'state_photo' AND sl.entity_id = sp.id
      LEFT JOIN state_perspectives sper ON sper.state_id = sl.state_id AND sper.perspective_type = 'AZOLLA_DUCKWEED_OBSERVATION'
      LEFT JOIN azolla_duckweed_observation_perspectives p ON p.id = sper.id
      LEFT JOIN photo_metadata_extractions pme ON pme.photo_url = sp.photo_url
      ORDER BY t.name, s.captured_at, sp.id
    `);

    const days = new Map();
    for (const r of res.rows) {
      // Prefer the photo's own EXIF capture time over when it was
      // successfully submitted — a delayed/retried upload (bad signal,
      // connectivity issues) should count toward the day it was actually
      // taken, not the day it finally went through. photo_metadata_
      // extractions.captured_at is stored as the raw local Manila clock
      // reading (confirmed by cross-checking against app timestamps across
      // several people) despite being a timestamptz column, so it's used
      // AS-IS here, not converted again — converting it a second time would
      // double-shift it by another 8 hours. Guarded against broken device
      // clocks (e.g. a dead battery resetting an old Android phone to
      // 2017): only trust EXIF if its year is close to the app's own year.
      const appLocal = manilaLocalFromUTC(r.captured_at);
      let trueTime = appLocal;
      if (r.exif_captured_at && Math.abs(r.exif_captured_at.getUTCFullYear() - appLocal.getUTCFullYear()) <= 1) {
        trueTime = r.exif_captured_at;
      }
      const dt = dateKeyFromLocalDigits(trueTime);
      const key = `${r.tool_id}|${dt}`;
      if (!days.has(key)) days.set(key, { tool_id: r.tool_id, container_name: r.container_name, date: dt, photos: new Map() });
      const d = days.get(key);
      if (!d.photos.has(r.photo_id)) {
        // Prefer the note attached to this specific image (state_photos.
        // photo_description) — that's what a person actually writes when
        // adding a description to a photo. Fall back to the observation-
        // level note (states.state_text) only when no per-photo one exists,
        // since some older observations only ever had that field.
        const photoNotes = r.photo_notes && r.photo_notes.trim() ? r.photo_notes : null;
        const observationNotes = r.observation_notes && r.observation_notes.trim() ? r.observation_notes : null;
        d.photos.set(r.photo_id, {
          url: r.photo_url,
          notes: photoNotes || observationNotes,
          state_id: r.state_id,
          photo_coverage: r.photo_coverage !== null ? Number(r.photo_coverage) : null,
          time: timeStrFromLocalDigits(trueTime),
          time_source: trueTime === r.exif_captured_at ? 'photo' : 'submitted',
        });
      }
    }

    // Keyword heuristic for marker shape — NOT deep understanding of the
    // note, just word matching. Good enough to surface "something happened
    // here" at a glance; treat it as a starting point, not ground truth.
    // Destructive checked first and wins on overlap (e.g. "fertilizer
    // burned the leaves" is worth flagging as destructive, not just action).
    const DESTRUCTIVE_WORDS = /\b(died|dying|dead|damage[ds]?|destroyed|killed|infest(ed|ation)?|pest[s]?|disease[ds]?|rot(ted|ting)?|mold(y)?|wilt(ed|ing)?|algae bloom|spill(ed)?|contaminat(ed|ion)|burned|burnt|die-?off|toxic|poison(ed)?)\b/i;
    const ACTION_WORDS = /\b(fertiliz(e|ed|er|ing)|fertilis(e|ed|er|ing)|manure|compost(ed)?|nutrient[s]?|treat(ed|ment)|applied|apply(ing)?|added|adding|dose[ds]?|dosed|spray(ed|ing)?|fed|feeding|transplant(ed)?|relocat(ed|e)|harvest(ed)?|thin(ned)?|prune[d]?|crimp(ed|ing)?|remove[ds]?|removing|mixed in|topped up|top-?dress(ed|ing)?)\b/i;

    function classifyMarker(images) {
      const text = images.map((i) => i.notes || '').join(' ');
      if (!text.trim()) return 'normal';
      if (DESTRUCTIVE_WORDS.test(text)) return 'destructive';
      if (ACTION_WORDS.test(text)) return 'action';
      return 'normal';
    }

    const points = [];
    for (const d of days.values()) {
      const images = [...d.photos.values()];
      const covs = images.map((i) => i.photo_coverage).filter((v) => v !== null);
      if (covs.length === 0) continue;
      const avg = covs.reduce((a, b) => a + b, 0) / covs.length;
      const numStates = new Set(images.map((i) => i.state_id)).size;
      const marker = classifyMarker(images);
      points.push({ tool_id: d.tool_id, container_name: d.container_name, date: d.date, avg_value: avg, num_states: numStates, images, marker });
    }

    fs.writeFileSync(path.join(SCRATCH_DIR, 'coverage_points_by_day.json'), JSON.stringify(points, null, 2));
    console.log(`points: ${points.length}`);

    const urls = new Set();
    for (const p of points) for (const img of p.images) urls.add(img.url);
    console.log(`unique images to download: ${urls.size}`);

    let i = 0, failed = 0;
    for (const url of urls) {
      const dest = path.join(THUMB_DIR, `${urlHash(url)}.jpg`);
      if (!fs.existsSync(dest)) {
        try {
          await download(url, dest);
        } catch (e) {
          console.error('FAILED', url, e.message);
          failed++;
        }
      }
      i++;
      if (i % 30 === 0) console.log(`progress ${i}/${urls.size}`);
    }
    console.log(`done downloading, failed=${failed}`);
    console.log('Downloads are full-size originals — azolla-coverage-chart.py downscales at embed time.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
