#!/usr/bin/env node

/**
 * Generates CLAIM (+ SIGNIFICANCE + ENTROPY, produced together by the same
 * call) for states that are an initial_state/final_state of a real
 * experience but never qualified for the normal automatic pipeline —
 * specifically, states linked only as state_links(entity_type='tool'),
 * never 'observation'/'action', which is the eligibility gate
 * lambda/rsp-worker/index.js checks before generating CLAIM at all.
 *
 * Reuses the real generation logic verbatim (same model config, same
 * system/user prompt, same tool schema, same getCombinedStateText input
 * construction — state_text + photo captions/AI descriptions) rather than
 * inventing a parallel mechanism, so this produces output indistinguishable
 * from what the normal pipeline would have written had these states
 * qualified in the first place.
 *
 * Scope: states that are experience components (initial_state/final_state)
 * for a given tool, and don't already have CLAIM.
 *
 * Usage: node scripts/azolla-backfill-claim.js --tool=<tool_id> [--dry-run]
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
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
const DRY_RUN = args.includes('--dry-run');
const TOOL_ID = (() => {
  const a = args.find((x) => x.startsWith('--tool='));
  return a ? a.split('=')[1] : null;
})();
if (!TOOL_ID) {
  console.error('Usage: node scripts/azolla-backfill-claim.js --tool=<tool_id> [--dry-run]');
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

// Verbatim from lambda/rsp-worker/index.js's getCombinedStateText.
function getCombinedStateText(stateText, photos) {
  const photoTexts = (photos || []).map((p) => {
    const humanDesc = p.photo_description || '';
    const aiDesc = p.ai_description ? p.ai_description.replace('[photo_analysis]', '').trim() : '';
    if (humanDesc && aiDesc) return `Human Caption: ${humanDesc}\nVisual Description: ${aiDesc}`;
    return humanDesc || aiDesc;
  }).filter(Boolean).join('\n\n');
  return [stateText, photoTexts].filter(Boolean).join('\n\n');
}

// Verbatim from lambda/rsp-worker/index.js's epistemic-extraction prompt.
function buildUserPrompt(combinedText, actionContext) {
  return `
You are an Expert Agricultural Systems Architect and Master Farm Manager embedded in a living operational record. Your role is to extract structured epistemic value from farm observations — not to give advice, not to speculate beyond what is stated.

Analyze the following observation:
Observation: ${combinedText || 'None'}
Action Context: ${actionContext}

Extract three distinct epistemic dimensions. CRITICAL RULES:
- Be concise and information-dense. Every sentence must carry unique information.
- Do NOT repeat information across dimensions.
- Do NOT speculate. If data was not collected, note the absence cleanly — do not infer what the data would have shown.
- Do NOT use filler openers (e.g. "This observation...", "It is important...", "This suggests...").
- Do NOT moralize or judge decisions. Record gaps as neutral facts.
- Write in direct declarative statements only.

1. CLAIM: The raw, objective, observable assertion strictly as stated or visible. No interpretation.

2. SIGNIFICANCE: Identify meaningful gaps between how the work was executed and either: (a) the stated method/policy for this action, or (b) widely accepted best practice for this type of task — whichever applies. When the policy does not specify a detail, apply reasonable best practice to assess the gap, but only within the operational scope visible in this observation (e.g. small-scale manual farm work; do not invoke equipment, lab tests, or techniques not plausible in this context). A gap is only worth noting if it is material to the outcome — not every deviation matters. If execution aligns with both policy and best practice, state that clearly rather than manufacturing concerns. Also flag outcomes that the observation itself explicitly describes as surprising. Do NOT flag absence of measurement as a gap unless the method specifically required it.

3. ENTROPY: The net change in system knowledge. Did this observation resolve an open question (reduce) or expose a new unknown (increase)? Name the specific question or unknown. Be precise.
`;
}

const TOOL_SCHEMA = {
  name: 'record_epistemic_extraction',
  description: 'Record the three epistemic dimensions of the observation',
  input_schema: {
    type: 'object',
    properties: {
      claim: { type: 'string', description: 'Raw, objective, directly observable facts as stated. No interpretation or inference.' },
      significance: { type: 'string', description: 'Meaningful gaps vs. stated policy or scope-appropriate best practice. If execution aligns with both, state that. Do not speculate on unmeasured variables. Do not invoke equipment or techniques implausible in this operational context.' },
      entropy: { type: 'string', description: 'Net change in system knowledge: which specific question was resolved (reduction) or which new unknown was exposed (increase). Be precise.' },
    },
    required: ['claim', 'significance', 'entropy'],
  },
};

async function fetchEligibleStates(client) {
  const sql = `
    SELECT s.id AS state_id, s.state_text,
      (SELECT json_agg(json_build_object('photo_description', ph.photo_description))
       FROM state_photos ph WHERE ph.state_id = s.id) AS photos
    FROM states s
    WHERE EXISTS (
      SELECT 1 FROM experience_components ec
      JOIN experiences e ON e.id = ec.experience_id
      WHERE ec.state_id = s.id AND ec.component_type IN ('initial_state', 'final_state')
        AND e.entity_type = 'tool' AND e.entity_id = $1
    )
    AND NOT EXISTS (SELECT 1 FROM state_perspectives sp WHERE sp.state_id = s.id AND sp.perspective_type = 'CLAIM')
  `;
  const res = await client.query(sql, [TOOL_ID]);
  return res.rows;
}

async function main() {
  console.log('CLAIM backfill for experience-linked states missing it');
  console.log('========================================================');
  console.log('Tool:', TOOL_ID, ' Dry run:', DRY_RUN, '\n');

  const client = await pool.connect();
  try {
    const configRes = await client.query(`SELECT * FROM llm_generation_configs WHERE model_id = 'us.anthropic.claude-sonnet-4-20250514-v1:0' LIMIT 1`);
    const llmConfig = configRes.rows[0];
    if (!llmConfig) throw new Error('No llm_generation_configs row found for the standard Sonnet model — expected one to already exist.');

    const states = await fetchEligibleStates(client);
    console.log(`Found ${states.length} eligible state(s).\n`);

    for (const row of states) {
      const combinedText = getCombinedStateText(row.state_text, row.photos);
      const userPrompt = buildUserPrompt(combinedText, 'None');
      const body = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1000,
        system: llmConfig.system_prompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        tools: [{ name: TOOL_SCHEMA.name, description: TOOL_SCHEMA.description, input_schema: TOOL_SCHEMA.input_schema }],
        tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
      };
      const command = new InvokeModelCommand({
        modelId: llmConfig.model_id,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });
      const response = await bedrock.send(command);
      const result = JSON.parse(Buffer.from(response.body).toString());
      const toolUse = result.content.find((c) => c.type === 'tool_use');

      console.log(`state ${row.state_id}`);
      console.log('  input:', combinedText.slice(0, 150).replace(/\n/g, ' '));
      console.log('  CLAIM:', toolUse.input.claim);
      console.log('');

      if (!DRY_RUN) {
        await client.query(
          `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content) VALUES ($1, 'CLAIM', $2, 'SUCCESS', $3)`,
          [row.state_id, llmConfig.id, JSON.stringify({ content: toolUse.input.claim })]
        );
        await client.query(
          `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content) VALUES ($1, 'SIGNIFICANCE', $2, 'SUCCESS', $3)`,
          [row.state_id, llmConfig.id, JSON.stringify({ content: toolUse.input.significance })]
        );
        await client.query(
          `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content) VALUES ($1, 'ENTROPY', $2, 'SUCCESS', $3)`,
          [row.state_id, llmConfig.id, JSON.stringify({ content: toolUse.input.entropy })]
        );
      }
    }

    console.log(DRY_RUN ? 'Dry run — no DB writes.' : `Wrote CLAIM/SIGNIFICANCE/ENTROPY for ${states.length} state(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
