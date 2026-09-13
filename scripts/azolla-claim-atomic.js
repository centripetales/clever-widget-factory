#!/usr/bin/env node

/**
 * CLAIM_ATOMIC: decomposes a state or action's existing CLAIM text into its
 * individual atomic claims — the smallest independently-true statements it
 * contains. Purely derivative of CLAIM (no independent judgment): the only
 * two ways an atomic claim can be "wrong" are (1) the decomposition itself
 * is bad, fixed by re-running under a new PROMPT_VERSION, or (2) the source
 * CLAIM is wrong, fixed by editing the underlying state text and letting
 * CLAIM regenerate (already automatic on any state edit, lambda/states/
 * index.js) — CLAIM_ATOMIC has no correction surface of its own.
 *
 * Only extracts claims describing something that could plausibly have been
 * otherwise (a condition, measurement, ongoing presence/absence, change, or
 * event) — not claims that merely identify a fixed subject/location (see
 * SYSTEM_PROMPT). Validated empirically (2026-09-05): whole-CLAIM embeddings
 * do NOT cleanly cluster a shared recurring condition apart from unrelated
 * observations (topic/domain similarity dominates); atomic-claim embeddings
 * do (clean ~0.4+ similarity gap between same-theme and unrelated pairs).
 * This decomposition step is load-bearing for the emergent/clustering
 * approach (docs/specs/azolla-impact-power-model.md §9), not optional.
 *
 * Scope: real, human-authored observation states linked via
 * state_links(entity_type='action') to actions on a given tool — the same
 * states the azolla-duckweed-observation.js vision pipeline processes, but
 * reading their CLAIM text instead of their photos. Only states that
 * already have a CLAIM and don't yet have a current CLAIM_ATOMIC are
 * processed.
 *
 * Usage:
 *   node scripts/azolla-claim-atomic.js --tool=<tool_id> --dry-run
 *   node scripts/azolla-claim-atomic.js --tool=<tool_id>
 *   node scripts/azolla-claim-atomic.js --tool=<tool_id> --force   (re-run even if CLAIM_ATOMIC already exists)
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
const fs = require('fs');

const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
// v2, 2026-09-05: v1 passed the "could this have been otherwise" test but
// still let through a real noise category discovered at pilot scale (298
// claims across 10 containers) — meta-statements about the DOCUMENTATION
// PROCESS itself ("no measurement data was present," "Day 15 marker was
// recorded," "update provided late at night"), not about the container.
// These clustered strongly on their own (one cluster of 32 claims spanned
// 7 different containers, just from people writing "nothing to report" in
// similar ways) — real noise, not a shared biological/growing condition.
// v3, 2026-09-05: validated on a subset (Wilfred's 4 compost/manure
// observations) before this full rollout. v2's claims described the same
// recurring condition with inconsistent tense/structure across different
// observations ("nutrient mixture contains compost" / "compost was added
// to the system" / "compost was added as fertilizer" — same fact, three
// incompatible phrasings), and merged multiple distinct inputs into one
// claim ("cow manure mixed with compost" as a single atom instead of two).
// v3 adds explicit RL-state framing so the model phrases ongoing
// conditions consistently (present tense, "X is present") and splits
// compound inputs into separate atoms — confirmed on the test subset to
// produce four consistently-worded "compost is present" claims instead of
// four incompatible phrasings of the same fact.
const PROMPT_VERSION = 'claim-atomic-v3-rl-framing';
const PERSPECTIVE_TYPE = 'CLAIM_ATOMIC';

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
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const TOOL_ID = (() => {
  const a = args.find((x) => x.startsWith('--tool='));
  return a ? a.split('=')[1] : null;
})();
if (!TOOL_ID) {
  console.error('Usage: node scripts/azolla-claim-atomic.js --tool=<tool_id> [--dry-run] [--force]');
  process.exit(1);
}

for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[v]) throw new Error(`${v} environment variable is required (check .env.local)`);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });

const SYSTEM_PROMPT = `You decompose a factual claim about an azolla/duckweed cultivation observation into its individual atomic claims — the smallest independently-true statements it contains.

IMPORTANT CONTEXT: these atomic claims will be embedded and clustered to form STATES in a reinforcement-learning system, where the same underlying condition reported by many different people, in different words, needs to land in the same state/cluster. Because of this:
- Phrase each atomic claim as a STANDING CONDITION (present tense, "X is present" / "X is applied"), not a one-time past-tense event narration, whenever the claim describes something ongoing rather than a discrete instantaneous event. This makes phrasing consistent across many different observations of the same underlying condition.
- If multiple distinct inputs/ingredients/subjects are combined in one clause (e.g. "cow manure mixed with compost"), split each one into its own separate atomic claim — each ingredient is its own independently-trackable condition, not one bundled fact.

Only extract claims that describe something that could plausibly have been otherwise — a condition, measurement, ongoing presence/absence of something, change, or event. This includes ongoing conditions that trace back to a recent action (e.g. "vermicompost is present" is valid — its presence could vary over time and across containers, even though it resulted from an action). Do NOT extract claims that merely identify a fixed subject or location that could not meaningfully be otherwise for this container (e.g. "azolla is in the blue bin" just names where something permanently is, not a variable condition — omit this kind of claim entirely).

Do NOT extract claims that are about the DOCUMENTATION OR REPORTING PROCESS itself rather than about the container, plants, water, or actions taken. This includes: statements that data/measurements/observations were missing, absent, or not recorded ("no measurement data was present," "no action context was specified"); bare day/date markers with no accompanying substantive content ("Day 15 marker was recorded"); statements about when or how an update was submitted, or about the person's workload/schedule causing a delay; and statements that a photo or documentation was merely taken/performed with no other content. Omit these entirely rather than forcing them into the output — a source claim consisting only of this kind of content should produce an empty atomic_claims array.

Each atomic claim must be a single, self-contained fact extracted with minimal rewriting from the source text (do not interpret, combine, or infer beyond what is stated). Split on distinct subjects/facts. Do not invent facts not present in the source. Return each atomic claim as a short standalone sentence.`;

const TOOL_SCHEMA = {
  name: 'record_atomic_claims',
  description: 'Record the individual atomic claims extracted from a source claim.',
  input_schema: {
    type: 'object',
    properties: {
      atomic_claims: {
        type: 'array',
        items: { type: 'string' },
        description: 'Each a short, standalone, independently-true statement describing a condition, measurement, change, or event.',
      },
    },
    required: ['atomic_claims'],
  },
};

async function getOrCreateConfigId(client) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
    [MODEL_ID, PROMPT_VERSION]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [MODEL_ID, PROMPT_VERSION, SYSTEM_PROMPT, JSON.stringify({ max_tokens: 500, temperature: 0 })]
  );
  return inserted.rows[0].id;
}

async function fetchEligibleStates(client) {
  // Scoped directly via state_links(entity_type='tool'), not through
  // actions — real observations link to their container this way whether
  // or not an action exists for them (confirmed 2026-09-05: Wilfred's
  // container has 34 tool-linked states, 33 already have CLAIM, with no
  // action involved at all). This intentionally processes observations
  // that never got an action — per docs/specs/azolla-impact-power-model.md
  // §5a, an experience only forms when a real action closes a transition,
  // but a state/CLAIM_ATOMIC doesn't need an experience to exist; an
  // observation-only state is real data on its own.
  const sql = `
    SELECT DISTINCT s.id AS state_id,
      (SELECT sp.content->>'content' FROM state_perspectives sp
       WHERE sp.state_id = s.id AND sp.perspective_type = 'CLAIM'
       ORDER BY sp.created_at DESC LIMIT 1) AS claim
    FROM state_links sl
    JOIN states s ON s.id = sl.state_id
    WHERE sl.entity_type = 'tool' AND sl.entity_id = $1
      AND EXISTS (
        SELECT 1 FROM state_perspectives sp
        WHERE sp.state_id = s.id AND sp.perspective_type = 'CLAIM'
      )
      ${FORCE ? '' : `AND NOT EXISTS (
        SELECT 1 FROM state_perspectives sp2
        WHERE sp2.state_id = s.id AND sp2.perspective_type = '${PERSPECTIVE_TYPE}'
      )`}
  `;
  const res = await client.query(sql, [TOOL_ID]);
  return res.rows.filter((r) => r.claim);
}

async function extractAtomicClaims(claimText) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 500,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: claimText }] }],
    tools: [{ name: TOOL_SCHEMA.name, description: TOOL_SCHEMA.description, input_schema: TOOL_SCHEMA.input_schema }],
    tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
  };
  const command = new InvokeModelCommand({ modelId: MODEL_ID, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) });
  const response = await bedrock.send(command);
  const result = JSON.parse(Buffer.from(response.body).toString());
  const toolUse = result.content.find((c) => c.type === 'tool_use');
  return toolUse.input.atomic_claims;
}

async function main() {
  console.log('CLAIM_ATOMIC extraction');
  console.log('========================');
  console.log('Tool:', TOOL_ID);
  console.log('Force:', FORCE);
  console.log('Dry run:', DRY_RUN);
  console.log('');

  const client = await pool.connect();
  try {
    const states = await fetchEligibleStates(client);
    console.log(`Found ${states.length} eligible state(s) with CLAIM but no current CLAIM_ATOMIC.\n`);
    if (states.length === 0) return;

    const configId = DRY_RUN ? null : await getOrCreateConfigId(client);

    // Cache by CLAIM text — many states share byte-identical CLAIM text
    // (batch-written retrospective observations covering several actions
    // at once), no need to re-call the model for duplicates.
    const cache = new Map();
    let processed = 0;
    for (const row of states) {
      let atomicClaims;
      if (cache.has(row.claim)) {
        atomicClaims = cache.get(row.claim);
      } else {
        atomicClaims = await extractAtomicClaims(row.claim);
        cache.set(row.claim, atomicClaims);
      }

      console.log(`[${++processed}/${states.length}] state ${row.state_id}`);
      for (const c of atomicClaims) console.log('  -', c);

      if (!DRY_RUN) {
        await client.query(
          `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content)
           VALUES ($1, $2, $3, 'SUCCESS', $4)`,
          [row.state_id, PERSPECTIVE_TYPE, configId, JSON.stringify({ atomic_claims: atomicClaims, source_claim: row.claim })]
        );
      }
      console.log('');
    }

    console.log('Done.', DRY_RUN ? '(dry run — no DB writes)' : `Wrote ${processed} CLAIM_ATOMIC row(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
