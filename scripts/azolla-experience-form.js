#!/usr/bin/env node

/**
 * Forms real SASR (State -> Action -> State -> Reward) experiences for a
 * container, per docs/specs/azolla-impact-power-model.md §5a:
 *
 * - State text = CLAIM (existing perspective, no new generation step).
 * - Experience boundaries are action-gated, not adjacency-gated: consecutive
 *   pairs are still extracted (ACTION_HYPOTHESIS, tuned against Stefan's
 *   real data), but an experience only closes when a real action is found.
 *   A pending_initial_state pointer carries forward across any run of
 *   plain (no-action) observations.
 * - One experience per closed transition, multiple action components
 *   allowed (not one experience per action).
 * - Reward is computed on demand from metric_snapshots (Coverage % delta),
 *   never stored redundantly.
 *
 * Usage: node scripts/azolla-experience-form.js <tool_id>
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';
const sqs = new SQSClient({ region: 'us-west-2' });

// Matches lambda/shared/embedding-composition.js composeActionEmbeddingSource exactly.
function composeActionEmbeddingSource(action) {
  return [action.title, action.description].filter(Boolean).join('. ');
}

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
  console.error('Usage: node scripts/azolla-experience-form.js <tool_id>');
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

// Tuned system prompt — see scripts/azolla-stefan-lastweek-sequence.js for
// the iteration history (tense/reference guidance, prior-action context,
// caption-based photo citation, action-vs-outcome-description separation).
const ACTION_HYPOTHESIS_SYSTEM_PROMPT = `You are an action-extraction system for an azolla/duckweed cultivation pilot. Given two of the same participant's observations of the same container — an earlier one and a later one, each with its own dated, individually-identified photos, plus the later observation's already-computed ENTROPY analysis for extra context — your only job is to extract what real human action(s), if any, the participant describes taking between them. This is extraction, not prediction: the participant is telling you what they did in their own words. An action must be something a person actually did — never "time passed" or "natural growth," and never something inferred purely from the change in appearance without the person describing having done it. If the text does not describe a human action between the two observations, say so explicitly (no_action_found=true) rather than inventing one to explain an observed change. Absence of a described action is a normal, honest, valid result — not a failure.

Pay close attention to tense and reference. Distinguish text that describes a NEW action taken in the window between these two observations from text that recalls, reflects on, or describes the outcome of an action already taken earlier — including an action already identified for the immediately preceding transition (given to you below, if any). Phrasing like "after putting X on the surface, it looks like..." or "I was curious if Y after doing Z, but..." is commentary on an already-known past action's outcome, not a report of a new one — do not create a new hypothesis for it. Only extract an action as new if the text itself describes it as newly done, not merely referenced in passing while describing a result.

Photos within a single observation are numbered in capture sequence (e.g. "photo 1/4", "photo 3/4") and are typically taken during the same visit. Use that sequence: if an earlier-numbered photo in an observation shows the state before an action and a later-numbered photo in that SAME observation shows the result (e.g. photo 1 "the bin was full", photo 3 "I removed duckweed to make space"), that within-observation progression is same-day, in-window evidence the action was taken during that visit — this applies even when the action's photos are all within the earlier of the two given observations, not just the later one. Do not discount an action as "before the window" just because all its evidence sits within the earlier observation — check whether that observation's own photo sequence shows the action happening during that visit before concluding it predates the window.

If more than one candidate action is plausible from the text, list each separately with its own confidence rather than picking one and hiding the ambiguity. Confidence here reflects extraction clarity (how clearly the text supports this specific reading), not likelihood of occurrence — if the participant describes it, it happened; the question is only how precisely the text pins down what "it" was.

Each hypothesis's description must stay focused on what was done and why — never on describing the resulting or later state, appearance, growth, or outcome. Growing-condition narration (coverage, color, how things look now) belongs to a separate state-level perspective (CLAIM), not to an action description. You may draw on later-observation text to justify why you believe an action happened, but do not restate that state-descriptive content as part of the action's own description.

For each hypothesis, classify its action_type:
- "transformative": physically changes the container's real condition — adding an input, harvesting, moving the container, changing the water, adjusting the setup. The container is different afterward, not just better understood.
- "entropy_reduction": does NOT change the container's real condition, but reduces uncertainty about it or about how to act on it — taking a measurement or reading, using a test kit, consulting AI, looking up documented best practice or a stated method. The container's condition was already whatever it was; the action just made it (or the right response to it) more known. Consulting AI counts as entropy_reduction even though no instrument was used — it is not a "measurement," but it is still an uncertainty-reducing act, not a transformative one.

For each hypothesis, also cite EVERY photo ID from EITHER observation that documents that action — not just the single best match. A photo counts as documenting the action either if it visually shows the action/input itself (e.g. a photo of a fertilizer bag), OR if the participant's own caption on that specific photo states they took the action (e.g. a caption saying "I removed duckweed to make space" is evidence for a duckweed-removal action, even if the image itself just shows the container afterward) — the caption is part of what that photo documents, not separate from it. If both observations have a photo independently describing the same ongoing or repeated action (e.g. the earlier observation says "I removed duckweed" and the later one says "as I remove duckweed only"), cite both — they corroborate each other, do not pick just one. A photo belonging to the EARLIER observation is not automatically "old news" — the earlier-vs-later distinction (see the tense/reference guidance above) is about whether text refers to an action from BEFORE the earlier observation's own timestamp, not about which of the two given observations a photo happens to belong to. A photo on the earlier observation whose caption describes an action taken as part of that same visit is valid, current evidence for this transition and must be cited, not treated as already-accounted-for background. Only cite a photo ID that was given to you, never invent one. Leave action_photo_ids empty only when truly no photo (image or caption) among those given documents the action.`;

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
            description: { type: 'string', description: 'What was done and why. Do NOT describe the resulting or later state, appearance, or outcome.' },
            action_type: { type: 'string', enum: ['transformative', 'entropy_reduction'] },
            confidence: { type: 'number', description: '0.0-1.0' },
            action_photo_ids: { type: 'array', items: { type: 'string' } },
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
    max_tokens: 1200,
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

async function resolveOrgMemberId(client, organizationId, cognitoUserId) {
  const res = await client.query(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND cognito_user_id = $2`,
    [organizationId, cognitoUserId]
  );
  return res.rows[0]?.id || null;
}

async function coverageFor(client, stateId, toolId) {
  const res = await client.query(`
    SELECT ms.value FROM metric_snapshots ms
    JOIN metrics m ON m.metric_id = ms.metric_id
    WHERE ms.state_id = $1 AND m.tool_id = $2 AND m.name = 'Coverage %'
  `, [stateId, toolId]);
  return res.rows[0] ? Number(res.rows[0].value) : null;
}

async function main() {
  const client = await pool.connect();
  try {
    const statesRes = await client.query(`
      SELECT s.id, s.organization_id, s.captured_by, s.captured_at
      FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id = $1
      ORDER BY s.captured_at
    `, [TOOL_ID]);
    const states = statesRes.rows;
    console.log(`${states.length} states for container ${TOOL_ID}`);

    // Attach photos, CLAIM, ENTROPY per state.
    for (const s of states) {
      const photos = await client.query(`SELECT id, photo_url, photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`, [s.id]);
      const claim = await client.query(`SELECT cp.content FROM state_perspectives sp JOIN claim_perspectives cp ON cp.id = sp.id WHERE sp.state_id = $1`, [s.id]);
      const ent = await client.query(`SELECT ep.content FROM state_perspectives sp JOIN entropy_perspectives ep ON ep.id = sp.id WHERE sp.state_id = $1`, [s.id]);
      s.photos = photos.rows;
      s.claim = claim.rows[0]?.content || null;
      s.entropy = ent.rows[0]?.content || null;
    }

    // Extract actions on every consecutive pair.
    const pairResults = [];
    for (let i = 1; i < states.length; i++) {
      const prior = states[i - 1];
      const final = states[i];
      const photoList = (s) => s.photos.map((p, idx) => `  [photo ${idx + 1}/${s.photos.length}, id ${p.id}] ${p.photo_description || '(no description)'}`).join('\n') || '  (no photos)';
      const entropyContext = final.entropy ? `\n\nLater observation's already-computed ENTROPY analysis (for context, not to be treated as ground truth about actions): ${final.entropy}` : '';
      const priorPairResult = pairResults[i - 2];
      const priorActionContext = (priorPairResult && !priorPairResult.no_action_found && priorPairResult.hypotheses.length)
        ? `\n\nAction(s) already identified for the immediately preceding transition (do NOT re-report these as new if the later observation is merely recalling or describing their outcome):\n${priorPairResult.hypotheses.map(h => `  - ${h.title}: ${h.description}`).join('\n')}`
        : '';
      const userPrompt = `Earlier observation [${prior.captured_at.toISOString().slice(0, 10)}], photos:\n${photoList(prior)}\n\nLater observation [${final.captured_at.toISOString().slice(0, 10)}], photos:\n${photoList(final)}${entropyContext}${priorActionContext}\n\nIdentify any human action(s) described as having happened between these two observations.`;
      const result = await invokeBedrock(ACTION_HYPOTHESIS_SYSTEM_PROMPT, userPrompt, ACTION_HYPOTHESIS_TOOL);
      pairResults.push(result);
      console.log(`[${prior.captured_at.toISOString().slice(0, 10)} -> ${final.captured_at.toISOString().slice(0, 10)}] no_action_found=${result.no_action_found}, ${result.hypotheses.length} action(s)`);
    }

    // Form experiences: action-gated boundaries, pending_initial_state carries forward.
    let pendingInitialIdx = 0;
    let experiencesCreated = 0;
    const pendingEmbeddingMessages = []; // sent only after COMMIT succeeds, not inside the transaction

    await client.query('BEGIN');
    try {
      for (let i = 1; i < states.length; i++) {
        const pairResult = pairResults[i - 1];
        if (pairResult.no_action_found || pairResult.hypotheses.length === 0) continue; // absorbed, don't close

        const initialState = states[pendingInitialIdx];
        const finalState = states[i];
        const experienceId = crypto.randomUUID();
        const orgMemberId = await resolveOrgMemberId(client, finalState.organization_id, finalState.captured_by);

        await client.query(
          `INSERT INTO experiences (id, entity_type, entity_id, organization_id, created_by, created_at)
           VALUES ($1, 'tool', $2, $3, $4, NOW())`,
          [experienceId, TOOL_ID, finalState.organization_id, orgMemberId]
        );
        await client.query(
          `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
           VALUES ($1, $2, 'initial_state', $3, NULL, $4, NOW())`,
          [crypto.randomUUID(), experienceId, initialState.id, finalState.organization_id]
        );
        await client.query(
          `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
           VALUES ($1, $2, 'final_state', $3, NULL, $4, NOW())`,
          [crypto.randomUUID(), experienceId, finalState.id, finalState.organization_id]
        );

        for (const h of pairResult.hypotheses) {
          const actionId = crypto.randomUUID();
          const actionTitle = h.title.slice(0, 250);
          const actionDescription = `${h.description}\n\n[action_type: ${h.action_type}] [azolla-sasr]`;
          await client.query(
            `INSERT INTO actions (id, title, description, status, organization_id, created_by, completed_at, asset_id, created_at, updated_at)
             VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, NOW(), NOW())`,
            [actionId, actionTitle, actionDescription, finalState.organization_id, finalState.captured_by, finalState.captured_at, TOOL_ID]
          );
          await client.query(
            `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
             VALUES ($1, $2, 'action', NULL, $3, $4, NOW())`,
            [crypto.randomUUID(), experienceId, actionId, finalState.organization_id]
          );

          // Real API-created actions queue embedding generation (lambda/actions/index.js);
          // this bypasses that path (direct SQL insert), so queue it explicitly here too —
          // otherwise these actions silently never become searchable. Deferred until
          // after COMMIT (see below) — an SQS send can't be rolled back with the transaction.
          const embeddingSource = composeActionEmbeddingSource({ title: actionTitle, description: actionDescription });
          if (embeddingSource.trim()) {
            pendingEmbeddingMessages.push({
              entity_type: 'action',
              entity_id: actionId,
              embedding_source: embeddingSource,
              organization_id: finalState.organization_id,
            });
          }
        }

        const initialCoverage = await coverageFor(client, initialState.id, TOOL_ID);
        const finalCoverage = await coverageFor(client, finalState.id, TOOL_ID);
        const reward = (initialCoverage != null && finalCoverage != null) ? (finalCoverage - initialCoverage) : null;

        console.log(`Experience ${experienceId.slice(0, 8)}: ${initialState.captured_at.toISOString().slice(0, 10)} -> ${finalState.captured_at.toISOString().slice(0, 10)}, ${pairResult.hypotheses.length} action(s), coverage ${initialCoverage}% -> ${finalCoverage}% (reward=${reward != null ? reward.toFixed(1) : 'unknown'})`);

        experiencesCreated++;
        pendingInitialIdx = i; // reset only after closing
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    for (const msg of pendingEmbeddingMessages) {
      await sqs.send(new SendMessageCommand({ QueueUrl: EMBEDDINGS_QUEUE_URL, MessageBody: JSON.stringify(msg) }));
    }
    console.log(`Queued ${pendingEmbeddingMessages.length} action embeddings.`);

    console.log(`\n${experiencesCreated} experiences created. ${states.length - 1 - experiencesCreated} plain transitions absorbed (no action).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
