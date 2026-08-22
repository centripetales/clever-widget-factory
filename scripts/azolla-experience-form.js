#!/usr/bin/env node

/**
 * Forms real SASR (State -> Action -> State -> Reward) experiences for a
 * container, per docs/specs/azolla-impact-power-model.md §5a:
 *
 * - State text = CLAIM (existing perspective, no new generation step).
 * - Experience boundaries are action-gated, not adjacency-gated: consecutive
 *   pairs are still extracted (EXPERIENCE_PERSPECTIVE, tuned against Stefan's
 *   real data), but an experience only closes when a real action is found.
 *   A pending_initial_state pointer carries forward across any run of
 *   plain (no-experience) observations.
 * - One experience per closed transition, multiple action components
 *   allowed (not one experience per action).
 * - Reward is computed on demand from metric_snapshots (Coverage % delta),
 *   never stored redundantly.
 * - Duplicate-reporting defense: each extraction is given the most recent
 *   PRIOR experience found so far (action + the state it resulted in),
 *   walking back past any absorbed no-experience pairs — not just the
 *   immediately preceding one — since a participant referencing an action
 *   from several observations back is genuinely ambiguous without that
 *   context and is otherwise easy to double-count.
 *
 * Usage: node scripts/azolla-experience-form.js <tool_id> [--dry-run]
 *   --dry-run: runs the extraction and prints what would be written (EXPERIENCE_PERSPECTIVE
 *   content, actions, experiences), but makes no DB writes and sends no SQS messages.
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';
const sqs = new SQSClient({ region: 'us-west-2' });

// Matches lambda/shared/embedding-composition.js composeActionEmbeddingSource.
// evidence_description/observations from that function's JSDoc example aren't
// real columns on `actions` (verified against the live schema) — the fields
// that actually exist and get used are title/description/policy/expected_state.
function composeActionEmbeddingSource(action) {
  return [action.title, action.description, action.policy, action.expected_state].filter(Boolean).join('. ');
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
const DRY_RUN = process.argv.includes('--dry-run');
if (!TOOL_ID) {
  console.error('Usage: node scripts/azolla-experience-form.js <tool_id> [--dry-run]');
  process.exit(1);
}
if (DRY_RUN) console.log('--dry-run: no DB writes, no SQS messages will be sent.\n');

const REGION = process.env.AWS_REGION || 'us-west-2';
const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const EXPERIENCE_PERSPECTIVE_PROMPT_VERSION = 'experience-perspective-v5-technical-density';

// Backstop, not a substitute for the prompt's own "when in doubt, drop it"
// instruction — a hard floor in code so a bad model call can't silently
// produce a low-confidence experience that flows into a real `actions` row.
const CONFIDENCE_FLOOR = 0.7;

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
// the iteration history (tense/reference guidance, prior-experience context,
// caption-based photo citation, action-vs-outcome-description separation).
const EXPERIENCE_PERSPECTIVE_SYSTEM_PROMPT = `You are a precise technical field-log transcriber for an azolla/duckweed cultivation pilot — not a casual summarizer. Given two of the same participant's observations of the same container — an earlier one and a later one, each with its own free-text note and its own dated, individually-identified photos, plus the later observation's already-computed ENTROPY analysis for extra context — your only job is to extract what real human action(s), if any, the participant REPORTS having done between them. Each one you find is a candidate experience: a real action that transitioned the container from one state to another. This is extraction, not prediction: the participant is telling you what they did in their own words. An action must be something a person actually did — never "time passed" or "natural growth," and never something inferred purely from the change in appearance without the person describing having done it. If the text does not describe a human action between the two observations, say so explicitly (experience_found=false) rather than inventing one to explain an observed change. Absence of a described action is a normal, honest, valid result — not a failure.

Whenever you write a description, prioritize technical density over readability. Every reading, quantity, material specific, and concrete detail present in the evidence belongs in the description — never trade a detail away for a shorter or smoother sentence. If two phrasings are both accurate but one keeps an exact figure, unit, or material name and the other generalizes it away, always choose the one that keeps it, even if it reads more awkwardly. A description that omits a number, amount, or specific the evidence actually gives you is a failure of this task, not a stylistic choice.

**When in doubt, drop it.** Missing a real experience is a minor loss; fabricating one poisons the record. If you are genuinely unsure whether text reports a new action or is commentary about one already known, do not create an experience for it — experience_found=false, or omit that specific candidate, is the correct call. Never resolve ambiguity by guessing toward inclusion.

**Report vs. speculation — the core test.** A sentence reports an action when the doing is what the sentence itself asserts. It is speculation/commentary — not a report — when the doing is merely presupposed, referenced in passing, or already known, while the sentence actually asserts something else (usually an effect, opinion, or uncertainty about that doing). Apply this test: is "did X" the main clause, or is it backgrounded inside a subordinate clause / relative clause / past-outcome frame while the sentence's real assertion is about something else?
  - "I added manure to the bin" → REPORT. The doing is the assertion.
  - "The manure I added seemed to have helped" → NOT a new report. "Added" sits in a relative clause ("the manure [that] I added"); the actual assertion is "seemed to have helped" — an opinion about an already-known past action's effect.
  - "I removed duckweed to make space to grow more" → REPORT.
  - "As I remove duckweed only, the azolla is spreading" → borderline: habitual/ongoing framing ("as I remove... only") describing a general practice while asserting something about its effect, not reporting one discrete new act. Apply the same test — if the sentence's real assertion is about the effect/pattern rather than the act itself, do not treat it as fresh evidence of a new action in this window.
  - "I was curious if Y after doing Z, but..." → NOT a report. Commentary about a prior, already-known action.

**Evidence anchoring and strength.** Every experience must include a report_span — the exact, verbatim substring (from a photo caption or the observation note) that satisfies the report test above. If you cannot quote a contiguous span that itself reads as a report (not a description of an effect), do not create the experience. Photo-anchored evidence (the report_span comes from a caption on a specific cited photo, or the photo itself visually documents the input/action) is inherently stronger than text-only evidence from the observation note with no corresponding photo — text-only reports are more likely to be recollection of, or commentary on, an action from an earlier window (especially the most recent experience already recorded, given to you below). Weight confidence accordingly: prefer a lower confidence, or dropping the experience entirely, when the only evidence is text-only AND a similar action was already recorded as the most recent experience.

**Read holistically.** Each observation has its own free-text note plus separate captions on each of its photos — these are different database fields describing the same visit, not independent sources. Combine them: a note saying "added manure" plus a photo caption saying "chicken manure, about 3 cups, composted a year" describe the same single action more fully together than either alone — cite the photo and quote whichever field's phrasing is the clearest report. Do not require the same fact to be repeated in every field to count it.

Pay close attention to tense and reference beyond the report/speculation test above. Distinguish text describing a NEW action taken in the window between these two observations from text that recalls or describes the outcome of an action already taken earlier — including the most recent experience already recorded (given to you below, if any, along with the state it resulted in). Only extract an action as new if the text itself reports it as newly done. A participant referencing something backward is often genuinely ambiguous about whether they already reported it — when in doubt, treat it as the outcome of the most recent recorded experience rather than a new one, especially if the described action is similar to it.

Photos within a single observation are numbered in capture sequence (e.g. "photo 1/4", "photo 3/4") and are typically taken during the same visit. Use that sequence: if an earlier-numbered photo in an observation shows the state before an action and a later-numbered photo in that SAME observation shows the result (e.g. photo 1 "the bin was full", photo 3 "I removed duckweed to make space"), that within-observation progression is same-day, in-window evidence the action was taken during that visit — this applies even when the action's photos are all within the earlier of the two given observations, not just the later one. Do not discount an action as "before the window" just because all its evidence sits within the earlier observation — check whether that observation's own photo sequence shows the action happening during that visit before concluding it predates the window.

If more than one candidate experience is plausible from the text, list each separately with its own confidence rather than picking one and hiding the ambiguity. Confidence here reflects extraction clarity (how clearly the text supports this specific reading, and how strong the evidence anchoring is per the guidance above) — not likelihood of occurrence.

Each experience's description must stay focused on what was done and why — never on describing the resulting or later state, appearance, growth, or outcome. Growing-condition narration (coverage, color, how things look now) belongs to a separate state-level perspective (CLAIM), not to an action description. You may draw on later-observation text to justify why you believe an action happened, but do not restate that state-descriptive content as part of the action's own description. Within that scope, apply the technical-density rule above at full strength: any reading, quantity, or material specific tied to the action itself belongs in the description verbatim. "Tested phosphate levels" is an unacceptable description if the evidence says the reading was closest to 10 ppm — the correct description is "Tested phosphate levels, reading closest to 10 ppm." This matters most for entropy_reduction actions, where the measured value is usually the entire point of the action, but it applies equally to transformative actions whenever the evidence gives a concrete quantity or material detail — "sprinkled a quarter cup of aged (about a year old) chicken manure," not "added manure."

For each experience, classify its action_type:
- "transformative": physically changes the container's real condition — adding an input, harvesting, moving the container, changing the water, adjusting the setup. The container is different afterward, not just better understood.
- "entropy_reduction": does NOT change the container's real condition, but reduces uncertainty about it or about how to act on it — taking a measurement or reading, using a test kit, consulting AI, looking up documented best practice or a stated method. The container's condition was already whatever it was; the action just made it (or the right response to it) more known. Consulting AI counts as entropy_reduction even though no instrument was used — it is not a "measurement," but it is still an uncertainty-reducing act, not a transformative one.

For each experience, also cite EVERY photo ID from EITHER observation that documents that action — not just the single best match. A photo counts as documenting the action either if it visually shows the action/input itself (e.g. a photo of a fertilizer bag), OR if the participant's own caption on that specific photo independently passes the report test above for this action. If both observations have a photo independently reporting the same action (not just referencing it), cite both — they corroborate each other. Do not cite a photo whose caption only references or presupposes the action without itself reporting it. A photo belonging to the EARLIER observation is not automatically "old news" — the earlier-vs-later distinction is about whether text refers to an action from BEFORE the earlier observation's own timestamp, not about which of the two given observations a photo happens to belong to. Only cite a photo ID that was given to you, never invent one. Leave action_photo_ids empty only when truly no photo (image or caption) among those given documents the action — this is expected and fine for a text-only report, subject to the extra scrutiny above.

Additionally, for each experience, try to infer an "expected_state" — the goal or intent behind the action, addressing a specific observed condition. This is forward-looking ("where we want to get to"), distinct from the action's own description ("what was done"). Ground it in an actual observed value or condition when possible — e.g. if a phosphorus reading of 0.5 ppm/L is mentioned, and that's described or implied as low relative to what azolla needs, the expected_state might be "raise phosphorus from ~0.5 ppm/L toward an adequate range for azolla growth." Only produce an expected_state when there's a real basis for it in the text — do not invent a plausible-sounding generic goal ("improve container health") when nothing in the text actually supports a specific one. Give expected_state_confidence (0.0-1.0) reflecting how well-grounded this specific inference is — low if you're stretching, high if the text clearly implies this exact goal. Leave expected_state null (and confidence null) when there's no real basis to infer one — that is a normal, honest, valid result, not a failure.`;

const EXPERIENCE_PERSPECTIVE_TOOL = {
  name: 'record_experiences',
  description: 'Record candidate experience(s) — a real human action and the evidence for it — reported between two observations, or that none was found',
  input_schema: {
    type: 'object',
    properties: {
      experience_found: { type: 'boolean', description: 'True if at least one experience (a reported action) was found between the two observations.' },
      experiences: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string', description: 'What was done and why, written with full technical density — every reading, quantity, and material specific from the evidence must be kept, not summarized away. Do NOT describe the resulting or later state, appearance, or outcome.' },
            report_span: { type: 'string', description: 'The exact, verbatim substring from a photo caption or the observation note that reports this action (passes the report-vs-speculation test). Required — if no such span exists, do not create this experience.' },
            action_type: { type: 'string', enum: ['transformative', 'entropy_reduction'] },
            confidence: { type: 'number', description: '0.0-1.0' },
            action_photo_ids: { type: 'array', items: { type: 'string' } },
            expected_state: { type: 'string', description: 'The inferred goal/intent, addressing a specific observed condition. Omit if no real basis exists.' },
            expected_state_confidence: { type: 'number', description: 'How well-grounded the expected_state inference is, 0.0-1.0. Omit if expected_state is omitted.' },
            expected_state_basis: { type: 'string', description: 'What specific observed value/condition this goal responds to. Required alongside expected_state.' },
          },
          required: ['title', 'description', 'report_span', 'action_type', 'confidence', 'action_photo_ids'],
        },
      },
    },
    required: ['experience_found', 'experiences'],
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

// experiences.created_by is NOT NULL, FK'd to organization_members.id — but the
// state closing an experience isn't always captured by a real person (e.g. the
// synthetic share-grant backfill state, captured_by = the all-zeros system user,
// which has no organization_members row). Falls back to any real member of the
// org rather than crash the whole materialization transaction over an
// unattributable system-generated state.
async function resolveOrgMemberId(client, organizationId, cognitoUserId) {
  const res = await client.query(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND cognito_user_id = $2`,
    [organizationId, cognitoUserId]
  );
  if (res.rows[0]?.id) return res.rows[0].id;
  const fallback = await client.query(
    `SELECT id FROM organization_members WHERE organization_id = $1 ORDER BY id LIMIT 1`,
    [organizationId]
  );
  return fallback.rows[0]?.id || null;
}

async function coverageFor(client, stateId, toolId) {
  const res = await client.query(`
    SELECT ms.value FROM metric_snapshots ms
    JOIN metrics m ON m.metric_id = ms.metric_id
    WHERE ms.state_id = $1 AND m.tool_id = $2 AND m.name = 'Coverage %'
  `, [stateId, toolId]);
  return res.rows[0] ? Number(res.rows[0].value) : null;
}

async function getOrCreateExperiencePerspectiveConfig(client) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
    [MODEL_ID, EXPERIENCE_PERSPECTIVE_PROMPT_VERSION]
  );
  if (existing.rows.length) return existing.rows[0].id;
  // Dry run: don't persist a new config row just for a throwaway preview run —
  // saveExperiencePerspective is never called in dry-run mode, so no id is needed.
  if (DRY_RUN) return null;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [MODEL_ID, EXPERIENCE_PERSPECTIVE_PROMPT_VERSION, EXPERIENCE_PERSPECTIVE_SYSTEM_PROMPT, JSON.stringify({ max_tokens: 1200, temperature: 0 })]
  );
  return inserted.rows[0].id;
}

// Persists the real extraction result into the EXPERIENCE_PERSPECTIVE perspective
// (state_perspectives.state_id = the LATER state of the pair, .content holds
// prior_state_id/experience_found/experiences as jsonb — no dedicated child
// table; new perspective types use the shared `content` column going
// forward instead of a new <type>_perspectives table each time).
// Deliberately does NOT persist an initial_state_id/final_state_id boundary —
// that carried-forward SASR stitching stays purely in the deterministic
// write-phase below (main()'s second loop), not duplicated into extraction output.
//
// Upserts keyed on (state_id, perspective_type, llm_generation_config_id) — not
// just (state_id, perspective_type) like CLAIM/SIGNIFICANCE/ENTROPY. This gives
// both properties at once: a rerun under the SAME active prompt (e.g. because the
// underlying observation text was edited) replaces its own row in place, so there's
// no stale duplicate sitting alongside the fresh one; a rerun under a NEW/tuned
// prompt (EXPERIENCE_PERSPECTIVE_PROMPT_VERSION bumped, so a different config row)
// inserts fresh rather than clobbering the prior version's output, which stays
// available for contrast. "The active prompt" is simply whatever config the script
// currently points to — bumping the version is what marks a real prompt change.
async function saveExperiencePerspective(client, configId, priorStateId, finalStateId, result) {
  const content = JSON.stringify({
    prior_state_id: priorStateId,
    experience_found: result.experience_found,
    experiences: result.experiences,
    model: MODEL_ID,
  });
  const existing = await client.query(
    `SELECT id FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'EXPERIENCE_PERSPECTIVE' AND llm_generation_config_id = $2`,
    [finalStateId, configId]
  );
  if (existing.rows.length) {
    const perspectiveId = existing.rows[0].id;
    await client.query(
      `UPDATE state_perspectives SET status = 'SUCCESS', error_message = NULL, content = $1, created_at = NOW() WHERE id = $2`,
      [content, perspectiveId]
    );
    return perspectiveId;
  }
  const perspectiveId = crypto.randomUUID();
  await client.query(
    `INSERT INTO state_perspectives (id, state_id, perspective_type, llm_generation_config_id, status, content) VALUES ($1, $2, 'EXPERIENCE_PERSPECTIVE', $3, 'SUCCESS', $4)`,
    [perspectiveId, finalStateId, configId, content]
  );
  return perspectiveId;
}

// The action's own CLAIM — same perspective_type as a state's CLAIM (see migration
// 023: state_perspectives.action_id, exactly one of state_id/action_id set per row).
// A CLAIM is "a technically-dense factual account of this entity," and that's
// exactly what h.description already is for an action — it just wasn't living
// anywhere queryable before, only inert text inside actions.scoring_data.
// Same upsert-by-(entity, config) keying as saveExperiencePerspective, for the
// same reason: a rerun under the same active prompt replaces this action's claim
// in place, a rerun under a new prompt version inserts fresh alongside it.
async function saveActionClaim(client, configId, actionId, description, reportSpan) {
  const content = JSON.stringify({ content: description, report_span: reportSpan });
  const existing = await client.query(
    `SELECT id FROM state_perspectives WHERE action_id = $1 AND perspective_type = 'CLAIM' AND llm_generation_config_id = $2`,
    [actionId, configId]
  );
  if (existing.rows.length) {
    const perspectiveId = existing.rows[0].id;
    await client.query(
      `UPDATE state_perspectives SET status = 'SUCCESS', error_message = NULL, content = $1, created_at = NOW() WHERE id = $2`,
      [content, perspectiveId]
    );
    return perspectiveId;
  }
  const perspectiveId = crypto.randomUUID();
  await client.query(
    `INSERT INTO state_perspectives (id, action_id, perspective_type, llm_generation_config_id, status, content) VALUES ($1, $2, 'CLAIM', $3, 'SUCCESS', $4)`,
    [perspectiveId, actionId, configId, content]
  );
  return perspectiveId;
}

async function main() {
  const client = await pool.connect();
  try {
    // Excludes system-generated states (captured_by = the all-zeros placeholder —
    // the established repo-wide convention for "no real user," see
    // scripts/azolla-weekly-report.js's SYSTEM_CAPTURED_BY and lambda/core's
    // POST /shares handler). Without this, a synthetic state like the
    // org-processor backfill's "Shared tool ... with Azolla Kapwa (backfill)"
    // share-grant record gets read as a real observation and its own text
    // ("Shared tool...") correctly, but wrongly, extracts as a farmer action —
    // confirmed reproducing on two independent containers (Stefan's, Wilfred's).
    const statesRes = await client.query(`
      SELECT s.id, s.organization_id, s.captured_by, s.captured_at, s.state_text
      FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id = $1
      WHERE s.captured_by != '00000000-0000-0000-0000-000000000000'
      ORDER BY s.captured_at
    `, [TOOL_ID]);
    const states = statesRes.rows;
    console.log(`${states.length} states for container ${TOOL_ID}`);

    // actions.assigned_to FKs to profiles.user_id — not every observation's
    // captured_by has a profiles row (participant accounts created outside the
    // normal signup flow, e.g. via SMS-based intake, may never get one). Assigning
    // to a captured_by with no profile row is a hard FK violation that rolls back
    // the whole materialization transaction, so resolve valid ones up front and
    // fall back to unassigned (NULL) rather than crash the batch over one farmer's
    // missing profile.
    const profilesRes = await client.query(
      `SELECT DISTINCT p.user_id FROM profiles p WHERE p.user_id = ANY($1)`,
      [[...new Set(states.map((s) => s.captured_by))]]
    );
    const validAssignees = new Set(profilesRes.rows.map((r) => r.user_id));

    // Attach photos, CLAIM, ENTROPY per state.
    for (const s of states) {
      const photos = await client.query(`SELECT id, photo_url, photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`, [s.id]);
      const claim = await client.query(`SELECT content->>'content' as content FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'CLAIM'`, [s.id]);
      const ent = await client.query(`SELECT content->>'content' as content FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'ENTROPY'`, [s.id]);
      s.photos = photos.rows;
      s.claim = claim.rows[0]?.content || null;
      s.entropy = ent.rows[0]?.content || null;
    }

    const photoIdToStateId = new Map();
    for (const s of states) for (const p of s.photos) photoIdToStateId.set(p.id, s.id);

    const configId = await getOrCreateExperiencePerspectiveConfig(client);

    // Extract experiences on every consecutive pair.
    const pairResults = [];
    for (let i = 1; i < states.length; i++) {
      const prior = states[i - 1];
      const final = states[i];
      // Holistic evidence: the observation's own free-text note and each photo's
      // caption are separate DB fields but describe the same visit — pass both,
      // not just photo captions, so fragments across fields (e.g. the note says
      // "added manure" while a photo caption says "chicken manure, ~3 cups") can
      // be combined into one fuller, better-supported report instead of each
      // being read in isolation.
      const photoList = (s) => s.photos.map((p, idx) => `  [photo ${idx + 1}/${s.photos.length}, id ${p.id}] ${p.photo_description || '(no description)'}`).join('\n') || '  (no photos)';
      const describeState = (s) => `  Observation note: ${s.state_text ? `"${s.state_text}"` : '(none)'}\n  Photos:\n${photoList(s)}`;
      const entropyContext = final.entropy ? `\n\nLater observation's already-computed ENTROPY analysis (for context, not to be treated as ground truth about actions): ${final.entropy}` : '';

      // Most recent experience so far, walking back past any absorbed no-experience
      // pairs — not just the immediately preceding one (pairResults[i-2] would miss
      // a real action from further back). This is the main defense against duplicate
      // reporting: pairResults currently holds entries for pairs 0..i-2 (comparisons
      // states[k]<->states[k+1]), so the resulting state of pairResults[k] is states[k+1].
      let lastExperience = null;
      for (let k = pairResults.length - 1; k >= 0; k--) {
        if (pairResults[k].experience_found && pairResults[k].experiences.length) {
          lastExperience = { pairResult: pairResults[k], resultingState: states[k + 1] };
          break;
        }
      }
      const priorActionContext = lastExperience
        ? `\n\nMost recent experience already recorded (do NOT re-report these action(s) as new if the later observation is merely recalling or describing their outcome):\n${lastExperience.pairResult.experiences.map(h => `  - ${h.title}: ${h.description}`).join('\n')}\n  State that experience resulted in: ${lastExperience.resultingState.claim || '(no CLAIM available)'}`
        : '';
      const userPrompt = `Earlier observation [${prior.captured_at.toISOString().slice(0, 10)}]:\n${describeState(prior)}\n\nLater observation [${final.captured_at.toISOString().slice(0, 10)}]:\n${describeState(final)}${entropyContext}${priorActionContext}\n\nIdentify any human action(s) described as having happened between these two observations, and infer expected_state where grounded.`;
      const result = await invokeBedrock(EXPERIENCE_PERSPECTIVE_SYSTEM_PROMPT, userPrompt, EXPERIENCE_PERSPECTIVE_TOOL);

      // Hard confidence floor — see CONFIDENCE_FLOOR comment. Dropped experiences
      // are logged but never reach the perspective or downstream actions.
      const kept = result.experiences.filter((h) => h.confidence >= CONFIDENCE_FLOOR);
      const dropped = result.experiences.length - kept.length;
      if (dropped > 0) console.log(`  dropped ${dropped} experience(s) below confidence floor ${CONFIDENCE_FLOOR}`);
      const filteredResult = { experience_found: result.experience_found && kept.length > 0, experiences: kept };

      pairResults.push(filteredResult);
      // Captured for provenance: materialization below stamps every experiences/actions
      // row it creates with exactly which EXPERIENCE_PERSPECTIVE record (and therefore
      // which prompt version, via llm_generation_config_id) produced it — auditable
      // without having to infer it from timing or re-derive it after the fact.
      filteredResult.perspectiveId = DRY_RUN ? null : await saveExperiencePerspective(client, configId, prior.id, final.id, filteredResult);
      console.log(`[${prior.captured_at.toISOString().slice(0, 10)} -> ${final.captured_at.toISOString().slice(0, 10)}] experience_found=${filteredResult.experience_found}, ${filteredResult.experiences.length} experience(s)`);
      for (const h of filteredResult.experiences) {
        console.log(`    - [${h.action_type}, conf=${h.confidence}] ${h.title}: ${h.description}`);
        console.log(`      report_span: "${h.report_span}"`);
        if (h.expected_state) console.log(`      expected_state (conf=${h.expected_state_confidence}): ${h.expected_state}`);
      }
    }

    // Replace this container's prior materialization from the SAME active prompt
    // (configId) before creating fresh rows — handles the "data changed, rerun under
    // an unchanged prompt" case cleanly (no stale duplicate sitting next to the fresh
    // one), while leaving any OTHER prompt version's actions/experiences untouched so
    // they remain available to contrast against. Scoped by scoring_data/metadata's
    // llm_generation_config_id, stamped on every row this script creates (see below).
    const staleActionsRes = await client.query(
      `SELECT id FROM actions WHERE asset_id = $1 AND scoring_data->>'llm_generation_config_id' = $2`,
      [TOOL_ID, configId]
    );
    const staleActionIds = staleActionsRes.rows.map(r => r.id);
    if (staleActionIds.length > 0) {
      console.log(`Replacing ${staleActionIds.length} action(s) from a prior run under the same prompt (${EXPERIENCE_PERSPECTIVE_PROMPT_VERSION})`);
    }
    if (!DRY_RUN && staleActionIds.length > 0) {
      await client.query(`DELETE FROM state_links WHERE entity_type = 'action' AND entity_id = ANY($1)`, [staleActionIds]);
      await client.query(`DELETE FROM unified_embeddings WHERE entity_type = 'action' AND entity_id = ANY($1)`, [staleActionIds]);
      await client.query(`DELETE FROM actions WHERE id = ANY($1)`, [staleActionIds]); // cascades experience_components, action_scores, and (migration 023) the action's own CLAIM perspective row
      await client.query(
        `DELETE FROM experiences WHERE entity_type = 'tool' AND entity_id = $1 AND metadata->>'llm_generation_config_id' = $2`,
        [TOOL_ID, configId]
      ); // cascades remaining experience_components (initial_state/final_state rows)
    }

    // Form experiences: action-gated boundaries, pending_initial_state carries forward.
    let pendingInitialIdx = 0;
    let experiencesCreated = 0;
    const pendingEmbeddingMessages = []; // sent only after COMMIT succeeds, not inside the transaction

    // Dry run: every write below goes through this instead of client.query directly,
    // so the whole experience-forming pass runs (ids generated, console output printed)
    // with no actual DB mutation. Reads (resolveOrgMemberId, coverageFor) still hit the
    // DB directly since they're needed to print realistic reward/expected_state output.
    const write = (sql, params) => (DRY_RUN ? Promise.resolve() : client.query(sql, params));

    if (!DRY_RUN) await client.query('BEGIN');
    try {
      for (let i = 1; i < states.length; i++) {
        const pairResult = pairResults[i - 1];
        if (!pairResult.experience_found || pairResult.experiences.length === 0) continue; // absorbed, don't close

        const initialState = states[pendingInitialIdx];
        const finalState = states[i];
        const experienceId = crypto.randomUUID();
        const orgMemberId = await resolveOrgMemberId(client, finalState.organization_id, finalState.captured_by);

        const experienceMetadata = {
          experience_perspective_id: pairResult.perspectiveId || null,
          llm_generation_config_id: configId || null,
        };
        await write(
          `INSERT INTO experiences (id, entity_type, entity_id, organization_id, created_by, created_at, metadata)
           VALUES ($1, 'tool', $2, $3, $4, NOW(), $5)`,
          [experienceId, TOOL_ID, finalState.organization_id, orgMemberId, JSON.stringify(experienceMetadata)]
        );
        await write(
          `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
           VALUES ($1, $2, 'initial_state', $3, NULL, $4, NOW())`,
          [crypto.randomUUID(), experienceId, initialState.id, finalState.organization_id]
        );
        await write(
          `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
           VALUES ($1, $2, 'final_state', $3, NULL, $4, NOW())`,
          [crypto.randomUUID(), experienceId, finalState.id, finalState.organization_id]
        );

        for (const h of pairResult.experiences) {
          const actionId = crypto.randomUUID();
          const actionTitle = h.title.slice(0, 250);
          // description = "Existing State" in the UI — the situation BEFORE the
          // action (initial_state's CLAIM), not the action's own description.
          // The action's own what/why (h.description) isn't duplicated into a
          // text field at all — it lives in the linked observation (state_links
          // below) and, for search, in the embedding source directly.
          const actionDescription = initialState.claim || null;
          const expectedState = h.expected_state || null;
          // scoring_data is the catch-all for classification/scoring metadata that
          // doesn't have its own UI field — NOT for the action's own technically-dense
          // account of what happened, which is now a proper CLAIM perspective row
          // (action_id-scoped, see migration 023 + saveActionClaim below) instead of
          // inert text buried in this jsonb blob. Always populated, not conditional
          // on expected_state existing.
          const scoringData = {
            action_type: h.action_type,
            extraction_confidence: h.confidence,
            expected_state_confidence: h.expected_state_confidence || null,
            expected_state_basis: h.expected_state_basis || null,
            // Provenance for auditability: exactly which EXPERIENCE_PERSPECTIVE run
            // (and via llm_generation_config_id, which prompt version) produced this
            // action — same values as experiences.metadata for the enclosing experience.
            experience_perspective_id: pairResult.perspectiveId || null,
            llm_generation_config_id: configId || null,
          };

          // assigned_to = the same person as created_by, when possible: the Actions
          // UI defaults its assignee filter to "Me" (assigned_to === current user),
          // so an unassigned action is invisible by default even to the person who
          // did it. Only possible when that person has a profiles row (assigned_to's
          // FK target) — falls back to unassigned (NULL) otherwise. created_by has
          // no such constraint, so it's always set regardless.
          const assignedTo = validAssignees.has(finalState.captured_by) ? finalState.captured_by : null;
          await write(
            // policy: intentionally left null — not used for this data.
            `INSERT INTO actions (id, title, description, expected_state, scoring_data, status, organization_id, created_by, assigned_to, completed_at, asset_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9, $10, NOW(), NOW())`,
            [actionId, actionTitle, actionDescription, expectedState, scoringData ? JSON.stringify(scoringData) : null, finalState.organization_id, finalState.captured_by, assignedTo, finalState.captured_at, TOOL_ID]
          );
          if (!DRY_RUN) await saveActionClaim(client, configId, actionId, h.description, h.report_span);
          await write(
            `INSERT INTO experience_components (id, experience_id, component_type, state_id, action_id, organization_id, created_at)
             VALUES ($1, $2, 'action', NULL, $3, $4, NOW())`,
            [crypto.randomUUID(), experienceId, actionId, finalState.organization_id]
          );

          // Link the action to whichever state(s) its cited evidence photos
          // actually belong to — the standard CWF mechanism (state_links,
          // entity_type='action') for connecting an action to its documenting
          // observation(s), same pattern used everywhere else in this app.
          const citedStateIds = new Set();
          for (const photoId of h.action_photo_ids || []) {
            const owningState = photoIdToStateId.get(photoId);
            if (owningState) citedStateIds.add(owningState);
          }
          if (citedStateIds.size === 0) citedStateIds.add(finalState.id); // fallback: always link at least the final state
          for (const stateId of citedStateIds) {
            await write(
              `INSERT INTO state_links (id, state_id, entity_type, entity_id, created_at) VALUES ($1, $2, 'action', $3, NOW())`,
              [crypto.randomUUID(), stateId, actionId]
            );
          }

          // Real API-created actions queue embedding generation (lambda/actions/index.js);
          // this bypasses that path (direct SQL insert), so queue it explicitly here too —
          // otherwise these actions silently never become searchable. Deferred until
          // after COMMIT (see below) — an SQS send can't be rolled back with the transaction.
          const embeddingSource = composeActionEmbeddingSource({ title: actionTitle, description: actionDescription, expected_state: expectedState });
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

        console.log(`Experience ${experienceId.slice(0, 8)}: ${initialState.captured_at.toISOString().slice(0, 10)} -> ${finalState.captured_at.toISOString().slice(0, 10)}, ${pairResult.experiences.length} action(s), coverage ${initialCoverage}% -> ${finalCoverage}% (reward=${reward != null ? reward.toFixed(1) : 'unknown'})`);

        experiencesCreated++;
        pendingInitialIdx = i; // reset only after closing
      }

      if (!DRY_RUN) await client.query('COMMIT');
    } catch (e) {
      if (!DRY_RUN) await client.query('ROLLBACK');
      throw e;
    }

    if (DRY_RUN) {
      console.log(`Would queue ${pendingEmbeddingMessages.length} action embeddings.`);
    } else {
      for (const msg of pendingEmbeddingMessages) {
        await sqs.send(new SendMessageCommand({ QueueUrl: EMBEDDINGS_QUEUE_URL, MessageBody: JSON.stringify(msg) }));
      }
      console.log(`Queued ${pendingEmbeddingMessages.length} action embeddings.`);
    }

    console.log(`\n${experiencesCreated} experiences created. ${states.length - 1 - experiencesCreated} plain transitions absorbed (no action).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
