#!/usr/bin/env node

/**
 * Proof-of-concept test: extends the tuned ACTION_HYPOTHESIS extraction to
 * also guess "expected_state" (the "Where we want to get to" UI field —
 * the inferred why/goal behind an action, addressing a specific observed
 * state, e.g. "0.5 ppm/L phosphorus is low relative to ideal azolla
 * conditions, so...") with a confidence score, stored separately from
 * extraction-clarity confidence so a threshold can later be applied to
 * cut off low-confidence guesses.
 *
 * Does NOT write to the DB — prints results only, for review before
 * wiring into scripts/azolla-experience-form.js for real.
 *
 * Usage: node scripts/azolla-expected-state-test.js <tool_id>
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

const TOOL_ID = process.argv[2];
if (!TOOL_ID) {
  console.error('Usage: node scripts/azolla-expected-state-test.js <tool_id>');
  process.exit(1);
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

const ACTION_HYPOTHESIS_SYSTEM_PROMPT = `You are an action-extraction system for an azolla/duckweed cultivation pilot. Given two of the same participant's observations of the same container — an earlier one and a later one, each with its own dated, individually-identified photos, plus the later observation's already-computed ENTROPY analysis for extra context — your only job is to extract what real human action(s), if any, the participant describes taking between them. This is extraction, not prediction: the participant is telling you what they did in their own words. An action must be something a person actually did — never "time passed" or "natural growth," and never something inferred purely from the change in appearance without the person describing having done it. If the text does not describe a human action between the two observations, say so explicitly (no_action_found=true) rather than inventing one to explain an observed change. Absence of a described action is a normal, honest, valid result — not a failure.

Pay close attention to tense and reference. Distinguish text that describes a NEW action taken in the window between these two observations from text that recalls, reflects on, or describes the outcome of an action already taken earlier — including an action already identified for the immediately preceding transition (given to you below, if any). Phrasing like "after putting X on the surface, it looks like..." or "I was curious if Y after doing Z, but..." is commentary on an already-known past action's outcome, not a report of a new one — do not create a new hypothesis for it. Only extract an action as new if the text itself describes it as newly done, not merely referenced in passing while describing a result.

Photos within a single observation are numbered in capture sequence (e.g. "photo 1/4", "photo 3/4") and are typically taken during the same visit. Use that sequence: if an earlier-numbered photo in an observation shows the state before an action and a later-numbered photo in that SAME observation shows the result, that within-observation progression is same-day, in-window evidence the action was taken during that visit — this applies even when the action's photos are all within the earlier of the two given observations, not just the later one. Do not discount an action as "before the window" just because all its evidence sits within the earlier observation — check whether that observation's own photo sequence shows the action happening during that visit before concluding it predates the window.

If more than one candidate action is plausible from the text, list each separately with its own confidence rather than picking one and hiding the ambiguity. This "confidence" reflects extraction clarity (how clearly the text supports this specific reading), not likelihood of occurrence.

Each hypothesis's description must stay focused on what was done and why — never on describing the resulting or later state, appearance, growth, or outcome. Growing-condition narration belongs to a separate state-level perspective (CLAIM), not to an action description.

For each hypothesis, classify its action_type:
- "transformative": physically changes the container's real condition.
- "entropy_reduction": does NOT change the container's real condition, but reduces uncertainty about it — a measurement, a test-kit reading, consulting AI, looking up best practice.

For each hypothesis, cite EVERY photo ID from EITHER observation that documents the action (image or caption), never invent one, leave empty only when truly nothing documents it.

Additionally, for each hypothesis, try to infer an "expected_state" — the goal or intent behind the action, addressing a specific observed condition. This is forward-looking ("where we want to get to"), distinct from the action's own description ("what was done"). Ground it in an actual observed value or condition when possible — e.g. if a phosphorus reading of 0.5 ppm/L is mentioned, and that's described or implied as low relative to what azolla needs, the expected_state might be "raise phosphorus from ~0.5 ppm/L toward an adequate range for azolla growth." Only produce an expected_state when there's a real basis for it in the text — do not invent a plausible-sounding generic goal ("improve container health") when nothing in the text actually supports a specific one. Give expected_state_confidence (0.0-1.0) reflecting how well-grounded this specific inference is — low if you're stretching, high if the text clearly implies this exact goal. Leave expected_state null (and confidence null) when there's no real basis to infer one — that is a normal, honest, valid result, not a failure.`;

const ACTION_HYPOTHESIS_TOOL = {
  name: 'record_action_hypotheses',
  description: 'Record candidate human action(s) between two observations, or that none was found',
  input_schema: {
    type: 'object',
    properties: {
      no_action_found: { type: 'boolean' },
      hypotheses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            action_type: { type: 'string', enum: ['transformative', 'entropy_reduction'] },
            confidence: { type: 'number' },
            action_photo_ids: { type: 'array', items: { type: 'string' } },
            expected_state: { type: 'string', description: 'The inferred goal/intent, addressing a specific observed condition. Omit if no real basis exists.' },
            expected_state_confidence: { type: 'number', description: 'How well-grounded the expected_state inference is, 0.0-1.0. Omit if expected_state is omitted.' },
            expected_state_basis: { type: 'string', description: 'What specific observed value/condition this goal responds to. Required alongside expected_state.' },
          },
          required: ['title', 'description', 'action_type', 'confidence', 'action_photo_ids'],
        },
      },
    },
    required: ['no_action_found', 'hypotheses'],
  },
};

async function invokeBedrock(systemPrompt, userPrompt, tool) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1500,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }],
    tool_choice: { type: 'tool', name: tool.name },
  };
  const command = new InvokeModelCommand({ modelId: MODEL_ID, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) });
  const response = await bedrock.send(command);
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  const toolUse = parsed.content.find(c => c.type === 'tool_use');
  return toolUse ? toolUse.input : null;
}

async function main() {
  const client = await pool.connect();
  try {
    const statesRes = await client.query(`
      SELECT s.id, s.captured_at
      FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id = $1
      ORDER BY s.captured_at
    `, [TOOL_ID]);
    const states = statesRes.rows;

    for (const s of states) {
      const photos = await client.query(`SELECT id, photo_url, photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`, [s.id]);
      const ent = await client.query(`SELECT ep.content FROM state_perspectives sp JOIN entropy_perspectives ep ON ep.id = sp.id WHERE sp.state_id = $1`, [s.id]);
      s.photos = photos.rows;
      s.entropy = ent.rows[0]?.content || null;
    }

    let pairResults = [];
    for (let i = 1; i < states.length; i++) {
      const prior = states[i - 1];
      const final = states[i];
      const photoList = (s) => s.photos.map((p, idx) => `  [photo ${idx + 1}/${s.photos.length}, id ${p.id}] ${p.photo_description || '(no description)'}`).join('\n') || '  (no photos)';
      const entropyContext = final.entropy ? `\n\nLater observation's already-computed ENTROPY analysis: ${final.entropy}` : '';
      const priorPairResult = pairResults[i - 2];
      const priorActionContext = (priorPairResult && !priorPairResult.no_action_found && priorPairResult.hypotheses.length)
        ? `\n\nAction(s) already identified for the immediately preceding transition (do NOT re-report):\n${priorPairResult.hypotheses.map(h => `  - ${h.title}: ${h.description}`).join('\n')}`
        : '';
      const userPrompt = `Earlier observation [${prior.captured_at.toISOString().slice(0, 10)}], photos:\n${photoList(prior)}\n\nLater observation [${final.captured_at.toISOString().slice(0, 10)}], photos:\n${photoList(final)}${entropyContext}${priorActionContext}\n\nIdentify any human action(s) described as having happened between these two observations, and infer expected_state where grounded.`;
      const result = await invokeBedrock(ACTION_HYPOTHESIS_SYSTEM_PROMPT, userPrompt, ACTION_HYPOTHESIS_TOOL);
      pairResults.push(result);

      console.log(`\n[${prior.captured_at.toISOString().slice(0, 10)} -> ${final.captured_at.toISOString().slice(0, 10)}] no_action_found=${result.no_action_found}`);
      result.hypotheses.forEach(h => {
        console.log(`  "${h.title}" [${h.action_type}]`);
        console.log(`    description: ${h.description}`);
        if (h.expected_state) {
          console.log(`    expected_state (conf ${h.expected_state_confidence}): ${h.expected_state}`);
          console.log(`    basis: ${h.expected_state_basis}`);
        } else {
          console.log(`    expected_state: (none — no real basis found)`);
        }
      });
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
