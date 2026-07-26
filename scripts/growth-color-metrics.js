#!/usr/bin/env node

/**
 * Offline, deterministic color/coverage metrics for azolla program photos.
 *
 * Unlike the Sonnet vision perspective (subjective, model-generated), this script
 * computes purely algorithmic pixel statistics (HSV green thresholding) so the
 * numbers are reproducible and comparable photo-to-photo without model drift.
 * Stored as its own perspective_type (GROWTH_COLOR_METRICS), linked back to the
 * source photo via state_links (entity_type = 'state_photo'), so a later
 * higher-level LLM pass has both the raw metrics and the photo to interpret.
 *
 * Scoping: --since filters by ORGANIZATION signup date (each participant has their
 * own org, created in the 2026-07-19/20 batch), not photo capture date. Stefan/Mae's
 * own test observations live under a separate, pre-existing org and are excluded by
 * that; --exclude is a secondary safety net against admin/staff posting into a real
 * participant org directly.
 *
 * Usage:
 *   node scripts/growth-color-metrics.js --dry-run
 *   node scripts/growth-color-metrics.js --since=2026-07-19 --exclude=Mae,Stefan
 *   node scripts/growth-color-metrics.js --participant=Wilfred --dry-run
 *   node scripts/growth-color-metrics.js --limit=10 --dry-run
 */

const { Pool } = require('pg');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ALGORITHM_VERSION = 'hsv-exg-hybrid-v1';
const HUE_MIN_DEG = 70;
const HUE_MAX_DEG = 170;
const SATURATION_MIN = 0.15;
const VALUE_MIN = 0.08;
const EXG_THRESHOLD = 0.05;
const RESIZE_MAX_DIM = 800;

// Load environment variables from .env.local (same convention as batch-analyze-expenses.js)
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

// CLI parameters
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINCE = (() => {
  const a = args.find(a => a.startsWith('--since='));
  return a ? a.split('=')[1] : '2026-07-19';
})();
const LIMIT = (() => {
  const a = args.find(a => a.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const EXCLUDE_NAMES = (() => {
  const a = args.find(a => a.startsWith('--exclude='));
  return (a ? a.split('=')[1] : 'Mae,Stefan').split(',').map(s => s.trim()).filter(Boolean);
})();
const PARTICIPANT = (() => {
  const a = args.find(a => a.startsWith('--participant='));
  return a ? a.split('=')[1] : null;
})();

for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[v]) throw new Error(`${v} environment variable is required (check .env.local)`);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function fetchImageBytes(photoUrl) {
  let url = photoUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function rgbToHsv(r, g, b) {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rN) h = 60 * (((gN - bN) / delta) % 6);
    else if (max === gN) h = 60 * ((bN - rN) / delta + 2);
    else h = 60 * ((rN - gN) / delta + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

// Excess Green Index: uses relative channel dominance (normalized chromaticity),
// not saturation, so it stays sensitive to pale/washed-out or backlit foliage
// where HSV saturation collapses toward zero even though green still dominates.
function excessGreen(r, g, b) {
  const sum = r + g + b;
  if (sum === 0) return 0;
  const rN = r / sum, gN = g / sum, bN = b / sum;
  return 2 * gN - rN - bN;
}

// Nearest-rank quantile over an unsorted array (mutates via sort).
function quantile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * sortedArr.length)));
  return sortedArr[idx];
}

/**
 * Whole-frame green pixel classification. No region-of-interest detection —
 * scores every pixel in the frame, so results include background (e.g.
 * non-plant green objects in the container's field of view) in the count.
 * A pixel counts as green if either the HSV hue/saturation rule matches, or
 * the ExG index matches (catches washed-out foliage HSV saturation misses).
 */
async function computeGreenMetrics(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .resize(RESIZE_MAX_DIM, RESIZE_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const totalPixels = width * height;

  const greenHues = [], greenSats = [], greenVals = [], greenExgs = [];
  const frameVals = [];
  let greenCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    const off = i * channels;
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const { h, s, v } = rgbToHsv(r, g, b);
    const exg = excessGreen(r, g, b);
    frameVals.push(v);

    const hsvGreen = h >= HUE_MIN_DEG && h <= HUE_MAX_DEG && s >= SATURATION_MIN && v >= VALUE_MIN;
    const exgGreen = exg >= EXG_THRESHOLD;
    if (hsvGreen || exgGreen) {
      greenCount++;
      greenHues.push(h);
      greenSats.push(s);
      greenVals.push(v);
      greenExgs.push(exg);
    }
  }

  greenHues.sort((a, b) => a - b);
  greenSats.sort((a, b) => a - b);
  greenVals.sort((a, b) => a - b);
  greenExgs.sort((a, b) => a - b);
  frameVals.sort((a, b) => a - b);

  const mean = arr => arr.length > 0 ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
  const greenMedianValue = quantile(greenVals, 0.5);
  const frameMedianValue = quantile(frameVals, 0.5);

  return {
    image_width: width,
    image_height: height,
    sampled_pixel_count: totalPixels,
    green_pixel_count: greenCount,
    green_pixel_percent: totalPixels > 0 ? (greenCount / totalPixels) * 100 : 0,
    green_mean_hue_degrees: mean(greenHues),
    green_mean_saturation: mean(greenSats),
    green_mean_value: mean(greenVals),
    green_median_hue_degrees: quantile(greenHues, 0.5),
    green_median_value: greenMedianValue,
    frame_mean_value: mean(frameVals),
    frame_median_value: frameMedianValue,
    value_ratio_to_frame: (greenMedianValue != null && frameMedianValue) ? greenMedianValue / frameMedianValue : null,
    exg_mean: mean(greenExgs),
    exg_median: quantile(greenExgs, 0.5),
    quantiles: {
      hue_degrees: { p10: quantile(greenHues, 0.1), p25: quantile(greenHues, 0.25), p50: quantile(greenHues, 0.5), p75: quantile(greenHues, 0.75), p90: quantile(greenHues, 0.9) },
      saturation: { p10: quantile(greenSats, 0.1), p25: quantile(greenSats, 0.25), p50: quantile(greenSats, 0.5), p75: quantile(greenSats, 0.75), p90: quantile(greenSats, 0.9) },
      value: { p10: quantile(greenVals, 0.1), p25: quantile(greenVals, 0.25), p50: quantile(greenVals, 0.5), p75: quantile(greenVals, 0.75), p90: quantile(greenVals, 0.9) },
      exg: { p10: quantile(greenExgs, 0.1), p25: quantile(greenExgs, 0.25), p50: quantile(greenExgs, 0.5), p75: quantile(greenExgs, 0.75), p90: quantile(greenExgs, 0.9) }
    }
  };
}

async function getOrCreateAlgorithmConfig(client) {
  const modelId = `algorithmic:${ALGORITHM_VERSION}`;
  const existing = await client.query(`SELECT id FROM llm_generation_configs WHERE model_id = $1 LIMIT 1`, [modelId]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [modelId, ALGORITHM_VERSION, 'N/A — deterministic algorithmic metric, no LLM prompt', JSON.stringify({
      description: 'Deterministic HSV green-threshold pixel metrics, not model-generated',
      hue_range_degrees: [HUE_MIN_DEG, HUE_MAX_DEG],
      saturation_min: SATURATION_MIN,
      value_min: VALUE_MIN,
      resize_max_dim: RESIZE_MAX_DIM
    })]
  );
  return inserted.rows[0].id;
}

async function fetchEligiblePhotos(client) {
  const params = [SINCE];
  let participantClause = '';
  let excludeClause = '';

  // Program participants are identified by organization signup date, not by photo
  // capture date or member name — each participant has their own org (named after
  // them), created in the 2026-07-19/20 signup batch. Stefan/Mae's own test
  // observations live under a separate, long-pre-existing org ("Stargazer Farm"),
  // so org-signup-date scoping already excludes them. The name check below is kept
  // as a safety net only, since Stefan Hamilton is an admin member of every org
  // (platform access) and could in principle post directly into a participant org.
  if (PARTICIPANT) {
    params.push(`%${PARTICIPANT}%`);
    participantClause = `AND o.name ILIKE $${params.length}`;
  } else {
    const excludeClauses = EXCLUDE_NAMES.map((_, i) => {
      params.push(`%${EXCLUDE_NAMES[i]}%`);
      return `COALESCE(om.full_name, '') NOT ILIKE $${params.length}`;
    });
    excludeClause = excludeClauses.length ? `AND ${excludeClauses.join(' AND ')}` : '';
  }

  const sql = `
    SELECT sp.id AS photo_id, sp.photo_url, s.id AS state_id, s.organization_id, s.captured_by, s.captured_at,
           o.name AS participant_name
    FROM state_photos sp
    JOIN states s ON sp.state_id = s.id
    JOIN organizations o ON o.id = s.organization_id
    LEFT JOIN organization_members om ON om.user_id = s.captured_by AND om.organization_id = s.organization_id
    WHERE o.created_at >= $1
      AND sp.photo_url IS NOT NULL
      ${participantClause}
      ${excludeClause}
      AND NOT EXISTS (
        SELECT 1 FROM state_links sl
        JOIN state_perspectives sper ON sper.state_id = sl.state_id
        WHERE sl.entity_type = 'state_photo' AND sl.entity_id = sp.id
          AND sper.perspective_type = 'GROWTH_COLOR_METRICS'
      )
    ORDER BY s.captured_at ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `;
  const res = await client.query(sql, params);
  return res.rows;
}

async function storeMetrics(client, photo, metrics, configId) {
  await client.query('BEGIN');
  try {
    const stateRes = await client.query(
      `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [photo.organization_id, '[growth_color_metrics] algorithmic pixel metrics', photo.captured_by]
    );
    const derivedStateId = stateRes.rows[0].id;

    await client.query(
      `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'state_photo', $2)`,
      [derivedStateId, photo.photo_id]
    );

    const perspRes = await client.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status)
       VALUES ($1, 'GROWTH_COLOR_METRICS', $2, 'SUCCESS') RETURNING id`,
      [derivedStateId, configId]
    );
    const perspectiveId = perspRes.rows[0].id;

    await client.query(
      `INSERT INTO growth_color_metrics_perspectives
        (id, sample_method, image_width, image_height, sampled_pixel_count, green_pixel_count,
         green_pixel_percent, green_mean_hue_degrees, green_mean_saturation, green_mean_value,
         frame_mean_value, green_median_value, green_median_hue_degrees, frame_median_value,
         value_ratio_to_frame, exg_mean, exg_median, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        perspectiveId, ALGORITHM_VERSION, metrics.image_width, metrics.image_height,
        metrics.sampled_pixel_count, metrics.green_pixel_count, metrics.green_pixel_percent,
        metrics.green_mean_hue_degrees, metrics.green_mean_saturation, metrics.green_mean_value,
        metrics.frame_mean_value, metrics.green_median_value, metrics.green_median_hue_degrees,
        metrics.frame_median_value, metrics.value_ratio_to_frame, metrics.exg_mean, metrics.exg_median,
        JSON.stringify(metrics)
      ]
    );

    await client.query('COMMIT');
    return { derivedStateId, perspectiveId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  console.log('Growth Color Metrics (algorithmic, offline)');
  console.log('============================================');
  console.log(`Since: ${SINCE}`);
  console.log(PARTICIPANT ? `Participant filter: ${PARTICIPANT}` : `Excluding participants matching: ${EXCLUDE_NAMES.join(', ')}`);
  console.log(`Limit: ${LIMIT || 'none'}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('');

  const client = await pool.connect();
  const results = { total: 0, success: 0, failed: 0 };
  try {
    const configId = DRY_RUN ? null : await getOrCreateAlgorithmConfig(client);
    const photos = await fetchEligiblePhotos(client);
    results.total = photos.length;
    console.log(`Found ${photos.length} eligible photos.\n`);

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      console.log(`[${i + 1}/${photos.length}] ${photo.participant_name} — photo ${photo.photo_id} (state ${photo.state_id}, captured ${photo.captured_at})`);
      console.log(`  photo_url: ${photo.photo_url}`);
      console.log(`  observation: http://localhost:8080/observations/edit/${photo.state_id}`);
      try {
        const imageBuffer = await fetchImageBytes(photo.photo_url);
        const metrics = await computeGreenMetrics(imageBuffer);
        console.log(`  green_pixel_percent=${metrics.green_pixel_percent.toFixed(2)}% green_median_value=${(metrics.green_median_value ?? 0).toFixed(3)} value_ratio_to_frame=${(metrics.value_ratio_to_frame ?? 0).toFixed(3)} exg_median=${(metrics.exg_median ?? 0).toFixed(3)}`);

        if (DRY_RUN) {
          console.log('  [DRY RUN] not writing to DB');
        } else {
          const stored = await storeMetrics(client, photo, metrics, configId);
          console.log(`  stored perspective ${stored.perspectiveId} on derived state ${stored.derivedStateId}`);
        }
        results.success++;
      } catch (err) {
        console.error(`  FAILED: ${err.message}`);
        results.failed++;
      }
      console.log('');
    }
  } finally {
    client.release();
  }

  console.log('Summary');
  console.log('=======');
  console.log(`Total: ${results.total}`);
  console.log(`Success: ${results.success}`);
  console.log(`Failed: ${results.failed}`);
  if (DRY_RUN) console.log('\nThis was a dry run. No DB rows were written.');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
