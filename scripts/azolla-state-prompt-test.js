#!/usr/bin/env node

/**
 * Standalone prompt-dialing harness for the AZOLLA_STATE perspective —
 * NOT part of the production propose script yet. Tests one design
 * question directly: does feeding the model the already-computed CLAIM
 * perspective (denser, distilled) produce a better synthesis than feeding
 * raw photo_description/state_text, for the same real observations?
 *
 * Runs both variants against Stefan's last week of data and prints them
 * side by side. Context = all observations in the window, oldest first,
 * most recent last, with an explicit recency-weighting instruction in the
 * prompt rather than in how the data is assembled (episode-boundary
 * scoping — "since the last action" — is not implemented here yet since
 * ACTION_HYPOTHESIS hasn't been run for real; this test uses the whole
 * last-week window as a stand-in for "one episode").
 *
 * Usage: node scripts/azolla-state-prompt-test.js
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

const REGION = process.env.AWS_REGION || 'us-west-2';
const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

const bedrock = new BedrockRuntimeClient({ region: REGION });

const SYSTEM_PROMPT = `You are a growing-context synthesis system for an azolla/duckweed cultivation pilot in the Philippines. Your only job is to synthesize what is known about one container's current condition, from the participant's own observations recorded since the last human action was taken on that container. You do not evaluate performance, you do not compare against other participants, and you do not give advice.

You will be given a sequence of observations, oldest first, ending with the most recent — all from the same container, all since the last action. Weight the most recent observation as most relevant to the container's current state; earlier ones are background context that may still matter (e.g. an unresolved problem mentioned days ago) but should not override what the most recent observation actually says. Never invent details not present in this material.

Any estimated quantity (phosphorus, pH) must be a rough inference from indirect cues in the text — never a measured value — and must carry its own basis explaining exactly what cue it was inferred from, and which observation (by date) it came from. If there is no cue to infer from, leave the estimate null and say so in uncertainty_flags rather than guessing a plausible-sounding number.`;

const TOOL_CONFIG = {
  tools: [{
    toolSpec: {
      name: 'record_azolla_state_context',
      description: 'Record the synthesized growing-context for this container',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            coverage_percent_estimate: { type: 'number', description: 'Rough coverage % if inferable from the observations text; omit if not.' },
            water_color: { type: 'string', description: 'Described or implied water color/clarity; omit if not mentioned.' },
            vessel_condition: { type: 'string', description: 'Described or implied container condition; omit if not mentioned.' },
            phosphorus_ppm_estimate: { type: 'number', description: 'Rough inferred phosphorus estimate in ppm, only if there is a real textual cue. Omit otherwise — do not guess a plausible default.' },
            phosphorus_estimate_basis: { type: 'string', description: 'Required alongside phosphorus_ppm_estimate: exactly what cue (and from which dated observation) the estimate was inferred from.' },
            ph_estimate: { type: 'number', description: 'Rough inferred pH estimate, only if there is a real textual cue. Omit otherwise.' },
            ph_estimate_basis: { type: 'string', description: 'Required alongside ph_estimate: exactly what cue it was inferred from.' },
            summary: { type: 'string', description: 'The synthesized current growing-context, weighted toward the most recent observation.' },
            uncertainty_flags: { type: 'array', items: { type: 'string' }, description: 'Anything relevant that could not be determined from the given material — including any estimate deliberately left out.' },
          },
          required: ['summary', 'uncertainty_flags'],
        },
      },
    },
  }],
  toolChoice: { tool: { name: 'record_azolla_state_context' } },
};

async function invokeBedrock(userPrompt) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    tools: TOOL_CONFIG.tools.map(t => ({
      name: t.toolSpec.name,
      description: t.toolSpec.description,
      input_schema: t.toolSpec.inputSchema.json,
    })),
    tool_choice: { type: 'tool', name: TOOL_CONFIG.toolChoice.tool.name },
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  });
  const response = await bedrock.send(command);
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  const toolUse = parsed.content.find(c => c.type === 'tool_use');
  return toolUse ? toolUse.input : null;
}

function buildUserPrompt(entries, sourceLabel) {
  const lines = entries.map((e) => `[${e.date}] ${e.text}`).join('\n\n');
  return `Container: Stefan's Azolla Container\nSource: ${sourceLabel}\n\nObservations (oldest first, most recent last):\n\n${lines}\n\nSynthesize the current growing-context for this container.`;
}

async function main() {
  const client = await pool.connect();
  let entries;
  try {
    const toolId = '7e6bfe0b-afb5-4d00-a38b-3b5d6fa7215f'; // Stefan's canonical container, post-merge
    const states = await client.query(`
      SELECT s.id, s.captured_at
      FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id = $1
      WHERE s.captured_at >= (
        SELECT max(captured_at) - interval '7 days' FROM states s2
        JOIN state_links sl2 ON sl2.state_id = s2.id AND sl2.entity_type = 'tool' AND sl2.entity_id = $1
      )
      ORDER BY s.captured_at
    `, [toolId]);

    entries = [];
    for (const s of states.rows) {
      const photos = await client.query(`SELECT photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`, [s.id]);
      const claim = await client.query(`SELECT content->>'content' as content FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'CLAIM'`, [s.id]);
      entries.push({
        date: s.captured_at.toISOString().slice(0, 10),
        raw: photos.rows.map(p => p.photo_description).filter(Boolean).join(' / ') || '(no text)',
        claim: claim.rows[0]?.content || '(no CLAIM perspective)',
      });
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`Testing on ${entries.length} observations (Stefan's last week):`);
  entries.forEach(e => console.log(`  [${e.date}] raw: ${e.raw.slice(0, 80)}...`));

  const rawPrompt = buildUserPrompt(entries.map(e => ({ date: e.date, text: e.raw })), 'raw photo/observation notes');
  const claimPrompt = buildUserPrompt(entries.map(e => ({ date: e.date, text: e.claim })), 'CLAIM perspective (distilled)');

  console.log('\n=== Calling Bedrock with RAW data ===');
  const rawResult = await invokeBedrock(rawPrompt);
  console.log(JSON.stringify(rawResult, null, 2));

  console.log('\n=== Calling Bedrock with CLAIM data ===');
  const claimResult = await invokeBedrock(claimPrompt);
  console.log(JSON.stringify(claimResult, null, 2));
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
