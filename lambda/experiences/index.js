const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const crypto = require('crypto');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');
const { broadcastInvalidation } = require('/opt/nodejs/broadcastInvalidation');
const success = (data) => successResponse(data);
const error = (message, statusCode = 500) => errorResponse(statusCode, message);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const REGION = process.env.AWS_REGION || 'us-west-2';
const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const EXPERIENCE_PERSPECTIVE_PROMPT_VERSION = 'experience-perspective-v5-technical-density';
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';
// Backstop, not a substitute for the prompt's own "when in doubt, drop it"
// instruction — a hard floor in code so a bad model call can't silently
// produce a low-confidence experience that flows into a real `actions` row.
const CONFIDENCE_FLOOR = 0.7;

const bedrock = new BedrockRuntimeClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

// Matches lambda/shared/embedding-composition.js composeActionPolicySource
// and scripts/azolla-experience-form.js's copy of the same function.
function composeActionPolicySource(action) {
  return [action.title, action.policy].filter(Boolean).join('. ');
}

// Same tuned prompt as scripts/azolla-experience-form.js (kept in sync manually,
// per this repo's existing per-lambda shared-code convention — see
// lambda/embeddings-processor/shared/ for another example of a duplicated-not-
// imported shared module). See that script's header comment for iteration history.
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

// experiences.created_by is NOT NULL, FK'd to organization_members.id — not
// the cognito user id from the authorizer context. Same helper as
// scripts/azolla-experience-form.js: falls back to any real member of the
// org rather than fail outright over an edge case in membership lookup.
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

async function getOrCreateExperiencePerspectiveConfig(client) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
    [MODEL_ID, EXPERIENCE_PERSPECTIVE_PROMPT_VERSION]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [MODEL_ID, EXPERIENCE_PERSPECTIVE_PROMPT_VERSION, EXPERIENCE_PERSPECTIVE_SYSTEM_PROMPT, JSON.stringify({ max_tokens: 1200, temperature: 0 })]
  );
  return inserted.rows[0].id;
}

// Same upsert-by-(state_id, perspective_type, llm_generation_config_id) keying
// as scripts/azolla-experience-form.js — a rerun under the same active prompt
// (e.g. because the observation text was edited) replaces its own row in
// place; a rerun under a new prompt version inserts fresh alongside it.
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

// The action's own CLAIM — same perspective_type as a state's CLAIM (migration
// 023: state_perspectives.action_id, exactly one of state_id/action_id set).
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

exports.handler = async (event) => {
  const startTime = Date.now();

  const { httpMethod, pathParameters, queryStringParameters, path } = event;
  
  let authContext;
  let organizationId;
  let userId;
  
  try {
    authContext = getAuthorizerContext(event);
    organizationId = authContext?.organization_id;
    userId = authContext?.user_id;
  } catch (err) {
    console.error('Error getting authorizer context:', err);
    organizationId = null;
    userId = null;
  }

  if (!organizationId) {
    return error('Organization ID not found', 401);
  }

  try {
    // POST /api/experiences/suggestions - run the tuned extraction over a
    // container's full observation history, saving EXPERIENCE_PERSPECTIVE
    // rows (idempotent upsert per pair). Proposes only — never creates a
    // real action; a person confirms via /use below. Same path as the GET
    // below (which lists suggestions) — POST generates them, by design.
    if (httpMethod === 'POST' && path.endsWith('/suggestions')) {
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        return error('Invalid JSON in request body', 400);
      }
      const { entity_type, entity_id } = body || {};
      if (!entity_type || !entity_id) {
        return error('entity_type and entity_id are required', 400);
      }
      if (entity_type !== 'tool') {
        return error('Generating suggestions is only supported for entity_type "tool"', 400);
      }

      // Excludes system-generated states (captured_by = the all-zeros
      // placeholder) — see scripts/azolla-experience-form.js for why: a
      // synthetic share-grant state otherwise reads as a farmer action.
      const statesRes = await pool.query(`
        SELECT s.id, s.organization_id, s.captured_by, s.captured_at, s.state_text
        FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id = $1
        WHERE s.captured_by != '00000000-0000-0000-0000-000000000000' AND s.organization_id = $2
        ORDER BY s.captured_at
      `, [entity_id, organizationId]);
      const states = statesRes.rows;
      if (states.length < 2) {
        return success({ pairs_processed: 0, experiences_found: 0, message: 'Not enough observations to find suggestions yet.' });
      }

      for (const s of states) {
        const photos = await pool.query(`SELECT id, photo_url, photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`, [s.id]);
        const claim = await pool.query(`SELECT content->>'content' as content FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'CLAIM'`, [s.id]);
        const ent = await pool.query(`SELECT content->>'content' as content FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'ENTROPY'`, [s.id]);
        s.photos = photos.rows;
        s.claim = claim.rows[0]?.content || null;
        s.entropy = ent.rows[0]?.content || null;
      }

      const configId = await getOrCreateExperiencePerspectiveConfig(pool);

      const pairResults = [];
      let experiencesFound = 0;
      for (let i = 1; i < states.length; i++) {
        const prior = states[i - 1];
        const final = states[i];
        const photoList = (s) => s.photos.map((p, idx) => `  [photo ${idx + 1}/${s.photos.length}, id ${p.id}] ${p.photo_description || '(no description)'}`).join('\n') || '  (no photos)';
        const describeState = (s) => `  Observation note: ${s.state_text ? `"${s.state_text}"` : '(none)'}\n  Photos:\n${photoList(s)}`;
        const entropyContext = final.entropy ? `\n\nLater observation's already-computed ENTROPY analysis (for context, not to be treated as ground truth about actions): ${final.entropy}` : '';

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

        const kept = result.experiences.filter((h) => h.confidence >= CONFIDENCE_FLOOR);
        const filteredResult = { experience_found: result.experience_found && kept.length > 0, experiences: kept };
        pairResults.push(filteredResult);
        await saveExperiencePerspective(pool, configId, prior.id, final.id, filteredResult);
        if (filteredResult.experience_found) experiencesFound += filteredResult.experiences.length;
      }

      return success({ pairs_processed: states.length - 1, experiences_found: experiencesFound });
    }

    // GET /api/experiences/suggestions - lists what POST to this same path generated:
    // un-dismissed, unconfirmed hypotheses
    // from the latest EXPERIENCE_PERSPECTIVE for a container's states.
    if (httpMethod === 'GET' && path.endsWith('/suggestions')) {
      const entity_type = queryStringParameters?.entity_type;
      const entity_id = queryStringParameters?.entity_id;
      if (!entity_type || !entity_id) {
        return error('entity_type and entity_id are required', 400);
      }

      const statesRes = await pool.query(`
        SELECT s.id, s.captured_at
        FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = $1 AND sl.entity_id = $2
        WHERE s.organization_id = $3
        ORDER BY s.captured_at
      `, [entity_type, entity_id, organizationId]);
      const stateIds = statesRes.rows.map(r => r.id);
      if (stateIds.length === 0) return success({ data: [] });

      const perspectivesRes = await pool.query(`
        SELECT id, state_id, content, created_at
        FROM state_perspectives
        WHERE state_id = ANY($1) AND perspective_type = 'EXPERIENCE_PERSPECTIVE'
      `, [stateIds]);

      // Which (perspective_id, hypothesis_index) pairs already became a real action.
      const usedRes = await pool.query(`
        SELECT scoring_data->>'experience_perspective_id' AS perspective_id,
               scoring_data->>'hypothesis_index' AS hypothesis_index
        FROM actions
        WHERE scoring_data->>'experience_perspective_id' = ANY(
          SELECT id::text FROM state_perspectives WHERE state_id = ANY($1) AND perspective_type = 'EXPERIENCE_PERSPECTIVE'
        )
      `, [stateIds]);
      const usedSet = new Set(usedRes.rows.map(r => `${r.perspective_id}:${r.hypothesis_index}`));

      const photosRes = await pool.query(`SELECT id, state_id, photo_url, photo_description FROM state_photos WHERE state_id = ANY($1)`, [stateIds]);
      const photosById = new Map(photosRes.rows.map(p => [p.id, p]));
      const stateById = new Map(statesRes.rows.map(s => [s.id, s]));

      const suggestions = [];
      for (const persp of perspectivesRes.rows) {
        const content = persp.content || {};
        const dismissed = new Set(content.dismissed_indices || []);
        (content.experiences || []).forEach((h, idx) => {
          if (dismissed.has(idx)) return;
          if (usedSet.has(`${persp.id}:${idx}`)) return;
          suggestions.push({
            perspective_id: persp.id,
            hypothesis_index: idx,
            final_state_id: persp.state_id,
            prior_state_id: content.prior_state_id,
            final_captured_at: stateById.get(persp.state_id)?.captured_at,
            title: h.title,
            description: h.description,
            action_type: h.action_type,
            confidence: h.confidence,
            expected_state: h.expected_state || null,
            expected_state_confidence: h.expected_state_confidence || null,
            expected_state_basis: h.expected_state_basis || null,
            photos: (h.action_photo_ids || []).map(id => photosById.get(id)).filter(Boolean),
            created_at: persp.created_at,
          });
        });
      }

      suggestions.sort((a, b) => new Date(b.final_captured_at) - new Date(a.final_captured_at));
      return success({ data: suggestions });
    }

    // POST /api/experiences/dismiss - mark one hypothesis dismissed in place,
    // via jsonb_set on its own EXPERIENCE_PERSPECTIVE row. No new table/column;
    // re-running the suggestions generator over an overlapping window must not re-surface it.
    if (httpMethod === 'POST' && path.endsWith('/dismiss')) {
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        return error('Invalid JSON in request body', 400);
      }
      const { perspective_id, hypothesis_index } = body || {};
      if (!perspective_id || hypothesis_index === undefined || hypothesis_index === null) {
        return error('perspective_id and hypothesis_index are required', 400);
      }

      const persp = await pool.query(
        `SELECT sp.content FROM state_perspectives sp JOIN states s ON s.id = sp.state_id
         WHERE sp.id = $1 AND sp.perspective_type = 'EXPERIENCE_PERSPECTIVE' AND s.organization_id = $2`,
        [perspective_id, organizationId]
      );
      if (persp.rows.length === 0) return error('Perspective not found', 404);

      const content = persp.rows[0].content || {};
      const dismissed = new Set(content.dismissed_indices || []);
      dismissed.add(hypothesis_index);
      const updatedContent = { ...content, dismissed_indices: [...dismissed] };

      await pool.query(`UPDATE state_perspectives SET content = $1 WHERE id = $2`, [JSON.stringify(updatedContent), perspective_id]);
      return success({ perspective_id, hypothesis_index, dismissed: true });
    }

    // POST /api/experiences/use - a person confirms one AI-proposed hypothesis:
    // creates the real actions row (status='completed', the action already
    // happened) + its own CLAIM perspective + state_links(entity_type='action')
    // to whichever state(s) its cited photos belong to — the same mechanism
    // used everywhere else in the app to connect an action to its evidence.
    // Does NOT create experience_components — building the initial/final-state
    // write-up is a separate, person-driven step (the experience builder).
    if (httpMethod === 'POST' && path.endsWith('/use')) {
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        return error('Invalid JSON in request body', 400);
      }
      const { perspective_id, hypothesis_index, title, description, action_type, expected_state } = body || {};
      if (!perspective_id || hypothesis_index === undefined || hypothesis_index === null || !title) {
        return error('perspective_id, hypothesis_index, and title are required', 400);
      }

      const perspRes = await pool.query(
        `SELECT sp.id, sp.state_id AS final_state_id, sp.content
         FROM state_perspectives sp JOIN states s ON s.id = sp.state_id
         WHERE sp.id = $1 AND sp.perspective_type = 'EXPERIENCE_PERSPECTIVE' AND s.organization_id = $2`,
        [perspective_id, organizationId]
      );
      if (perspRes.rows.length === 0) return error('Perspective not found', 404);
      const persp = perspRes.rows[0];
      const hypothesis = (persp.content?.experiences || [])[hypothesis_index];
      if (!hypothesis) return error('Hypothesis not found at that index', 404);

      const finalStateRes = await pool.query(
        `SELECT s.id, s.organization_id, s.captured_by, s.captured_at,
                (SELECT entity_id FROM state_links WHERE state_id = s.id AND entity_type = 'tool' LIMIT 1) AS tool_id
         FROM states s WHERE s.id = $1`,
        [persp.final_state_id]
      );
      const finalState = finalStateRes.rows[0];
      if (!finalState) return error('Underlying state not found', 404);

      const profileRes = await pool.query(`SELECT 1 FROM profiles WHERE user_id = $1`, [finalState.captured_by]);
      const assignedTo = profileRes.rows.length > 0 ? finalState.captured_by : null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const configId = await getOrCreateExperiencePerspectiveConfig(client);
        const actionId = crypto.randomUUID();
        const scoringData = {
          action_type: action_type || hypothesis.action_type,
          extraction_confidence: hypothesis.confidence,
          expected_state_confidence: hypothesis.expected_state_confidence || null,
          expected_state_basis: hypothesis.expected_state_basis || null,
          experience_perspective_id: perspective_id,
          hypothesis_index,
        };
        // description: intentionally left null — the action's own what/why
        // lives in its CLAIM perspective (saveActionClaim below); the existing
        // state is a real state_links pointer (below), not a text copy.
        await client.query(
          `INSERT INTO actions (id, title, expected_state, scoring_data, status, organization_id, created_by, assigned_to, completed_at, asset_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, $9, NOW(), NOW())`,
          [actionId, title.slice(0, 250), expected_state || hypothesis.expected_state || null, JSON.stringify(scoringData), finalState.organization_id, userId, assignedTo, finalState.captured_at, finalState.tool_id]
        );
        // description here is the person's edited text from the Suggestion
        // card's Edit mode, if they changed it — falls back to the original
        // hypothesis wording when they didn't. This is the action's own
        // what/why account, so it belongs in the CLAIM, not on the action row.
        await saveActionClaim(client, configId, actionId, description || hypothesis.description, hypothesis.report_span);

        // Link the action to its prior state (context/existing state) — the
        // same pointer scripts/azolla-experience-form.js links for this same
        // hypothesis. Same entity_type='action' link, same undifferentiated
        // kind as the evidence citations below.
        if (persp.content?.prior_state_id) {
          await client.query(
            `INSERT INTO state_links (id, state_id, entity_type, entity_id, created_at) VALUES ($1, $2, 'action', $3, NOW())`,
            [crypto.randomUUID(), persp.content.prior_state_id, actionId]
          );
        }

        // Link the action to whichever state(s) its cited evidence photos
        // actually belong to (same mechanism as scripts/azolla-experience-form.js).
        const photoIds = hypothesis.action_photo_ids || [];
        const citedStateIds = new Set();
        if (photoIds.length > 0) {
          const owningRes = await client.query(`SELECT DISTINCT state_id FROM state_photos WHERE id = ANY($1)`, [photoIds]);
          owningRes.rows.forEach(r => citedStateIds.add(r.state_id));
        }
        if (citedStateIds.size === 0) citedStateIds.add(finalState.id);
        for (const stateId of citedStateIds) {
          if (stateId === persp.content?.prior_state_id) continue; // already linked above, don't duplicate
          await client.query(
            `INSERT INTO state_links (id, state_id, entity_type, entity_id, created_at) VALUES ($1, $2, 'action', $3, NOW())`,
            [crypto.randomUUID(), stateId, actionId]
          );
        }

        await client.query('COMMIT');

        const embeddingSource = composeActionPolicySource({ title: title.slice(0, 250), policy: null });
        if (embeddingSource.trim()) {
          try {
            await sqs.send(new SendMessageCommand({
              QueueUrl: EMBEDDINGS_QUEUE_URL,
              MessageBody: JSON.stringify({ entity_type: 'action_policy', entity_id: actionId, embedding_source: embeddingSource, organization_id: finalState.organization_id }),
            }));
          } catch (sqsErr) {
            console.error('[EXPERIENCES] Failed to queue action embedding:', sqsErr.message);
          }
        }

        try {
          await broadcastInvalidation({
            entityType: 'action',
            entityId: actionId,
            mutationType: 'created',
            organizationId: finalState.organization_id,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null,
          });
        } catch (err) {
          console.error('[EXPERIENCES] Broadcast failed:', err.message);
        }

        const actionRes = await pool.query(`SELECT * FROM actions WHERE id = $1`, [actionId]);
        return success(actionRes.rows[0]);
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    }

    // GET /api/experiences - List experiences with filters
    if (httpMethod === 'GET' && path === '/api/experiences') {
      const entity_type = queryStringParameters?.entity_type;
      const entity_id = queryStringParameters?.entity_id;
      const limit = parseInt(queryStringParameters?.limit || '50', 10);
      const offset = parseInt(queryStringParameters?.offset || '0', 10);

      // Build query with filters
      let query = `
        SELECT 
          e.id,
          e.entity_type,
          e.entity_id,
          e.organization_id,
          e.created_by,
          e.created_at
        FROM experiences e
        WHERE e.organization_id = $1
      `;
      const params = [organizationId];
      let paramIndex = 2;

      if (entity_type) {
        query += ` AND e.entity_type = $${paramIndex}`;
        params.push(entity_type);
        paramIndex++;
      }

      if (entity_id) {
        query += ` AND e.entity_id = $${paramIndex}`;
        params.push(entity_id);
        paramIndex++;
      }

      query += ` ORDER BY e.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const experiencesResult = await pool.query(query, params);

      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total
        FROM experiences e
        WHERE e.organization_id = $1
      `;
      const countParams = [organizationId];
      let countParamIndex = 2;

      if (entity_type) {
        countQuery += ` AND e.entity_type = $${countParamIndex}`;
        countParams.push(entity_type);
        countParamIndex++;
      }

      if (entity_id) {
        countQuery += ` AND e.entity_id = $${countParamIndex}`;
        countParams.push(entity_id);
        countParamIndex++;
      }

      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total, 10);

      // Fetch components for each experience
      const experiences = await Promise.all(
        experiencesResult.rows.map(async (experience) => {
          const componentsResult = await pool.query(
            `SELECT
               ec.id,
               ec.experience_id,
               ec.component_type,
               ec.state_id,
               ec.action_id,
               ec.organization_id,
               ec.created_at,
               s.id as state_id_detail,
               s.state_text,
               s.captured_at,
               a.id as action_id_detail,
               a.title as action_title,
               a.description as action_description,
               a.created_at as action_created_at
             FROM experience_components ec
             LEFT JOIN states s ON ec.state_id = s.id
             LEFT JOIN actions a ON ec.action_id = a.id
             WHERE ec.experience_id = $1
             ORDER BY
               CASE ec.component_type
                 WHEN 'initial_state' THEN 1
                 WHEN 'action' THEN 2
                 WHEN 'final_state' THEN 3
               END`,
            [experience.id]
          );

          // states has no `photos` column — photos live in state_photos, keyed
          // by state_id (see the pattern already used above for suggestion cards).
          const stateIds = [...new Set(componentsResult.rows.map((c) => c.state_id).filter(Boolean))];
          const photosByStateId = new Map();
          if (stateIds.length > 0) {
            const photosRes = await pool.query(
              `SELECT state_id, id, photo_url, photo_description FROM state_photos WHERE state_id = ANY($1) ORDER BY photo_order`,
              [stateIds]
            );
            for (const p of photosRes.rows) {
              if (!photosByStateId.has(p.state_id)) photosByStateId.set(p.state_id, []);
              photosByStateId.get(p.state_id).push(p);
            }
          }

          const components = {};
          componentsResult.rows.forEach((comp) => {
            if (comp.component_type === 'initial_state' || comp.component_type === 'final_state') {
              components[comp.component_type] = {
                id: comp.id,
                experience_id: comp.experience_id,
                component_type: comp.component_type,
                state_id: comp.state_id,
                organization_id: comp.organization_id,
                created_at: comp.created_at,
                state: comp.state_id_detail ? {
                  id: comp.state_id_detail,
                  state_text: comp.state_text,
                  captured_at: comp.captured_at,
                  photos: photosByStateId.get(comp.state_id) || []
                } : null
              };
            } else if (comp.component_type === 'action') {
              if (!components.actions) components.actions = [];
              components.actions.push({
                id: comp.id,
                experience_id: comp.experience_id,
                component_type: comp.component_type,
                action_id: comp.action_id,
                organization_id: comp.organization_id,
                created_at: comp.created_at,
                action: comp.action_id_detail ? {
                  id: comp.action_id_detail,
                  title: comp.action_title,
                  description: comp.action_description,
                  created_at: comp.action_created_at
                } : null
              });
            }
          });

          return {
            ...experience,
            components
          };
        })
      );

      return success({
        data: experiences,
        pagination: {
          total,
          limit,
          offset
        }
      });
    }

    // GET /api/experiences/:id - Get single experience with all components
    if (httpMethod === 'GET' && pathParameters?.id) {
      const experienceId = pathParameters.id;

      // Fetch experience
      const experienceResult = await pool.query(
        `SELECT * FROM experiences WHERE id = $1 AND organization_id = $2`,
        [experienceId, organizationId]
      );

      if (experienceResult.rows.length === 0) {
        return error('Experience not found', 404);
      }

      const experience = experienceResult.rows[0];

      // Fetch entity details based on entity_type
      let entity = null;
      if (experience.entity_type === 'tool') {
        const toolResult = await pool.query(
          `SELECT id, name, category FROM tools WHERE id = $1`,
          [experience.entity_id]
        );
        entity = toolResult.rows[0] || null;
      } else if (experience.entity_type === 'part') {
        const partResult = await pool.query(
          `SELECT id, name, category FROM parts WHERE id = $1`,
          [experience.entity_id]
        );
        entity = partResult.rows[0] || null;
      }

      // Fetch components with details
      const componentsResult = await pool.query(
        `SELECT
           ec.id,
           ec.experience_id,
           ec.component_type,
           ec.state_id,
           ec.action_id,
           ec.organization_id,
           ec.created_at,
           s.id as state_id_detail,
           s.state_text,
           s.captured_at,
           a.id as action_id_detail,
           a.title as action_title,
           a.description as action_description,
           a.created_at as action_created_at
         FROM experience_components ec
         LEFT JOIN states s ON ec.state_id = s.id
         LEFT JOIN actions a ON ec.action_id = a.id
         WHERE ec.experience_id = $1
         ORDER BY
           CASE ec.component_type
             WHEN 'initial_state' THEN 1
             WHEN 'action' THEN 2
             WHEN 'final_state' THEN 3
           END`,
        [experienceId]
      );

      // states has no `photos` column — photos live in state_photos, keyed by state_id.
      const detailStateIds = [...new Set(componentsResult.rows.map((c) => c.state_id).filter(Boolean))];
      const detailPhotosByStateId = new Map();
      if (detailStateIds.length > 0) {
        const photosRes = await pool.query(
          `SELECT state_id, id, photo_url, photo_description FROM state_photos WHERE state_id = ANY($1) ORDER BY photo_order`,
          [detailStateIds]
        );
        for (const p of photosRes.rows) {
          if (!detailPhotosByStateId.has(p.state_id)) detailPhotosByStateId.set(p.state_id, []);
          detailPhotosByStateId.get(p.state_id).push(p);
        }
      }

      const components = {};
      componentsResult.rows.forEach((comp) => {
        if (comp.component_type === 'initial_state' || comp.component_type === 'final_state') {
          components[comp.component_type] = {
            id: comp.id,
            experience_id: comp.experience_id,
            component_type: comp.component_type,
            state_id: comp.state_id,
            organization_id: comp.organization_id,
            created_at: comp.created_at,
            state: comp.state_id_detail ? {
              id: comp.state_id_detail,
              state_text: comp.state_text,
              captured_at: comp.captured_at,
              photos: detailPhotosByStateId.get(comp.state_id) || []
            } : null
          };
        } else if (comp.component_type === 'action') {
          if (!components.actions) components.actions = [];
          components.actions.push({
            id: comp.id,
            experience_id: comp.experience_id,
            component_type: comp.component_type,
            action_id: comp.action_id,
            organization_id: comp.organization_id,
            created_at: comp.created_at,
            action: comp.action_id_detail ? {
              id: comp.action_id_detail,
              title: comp.action_title,
              description: comp.action_description,
              created_at: comp.action_created_at
            } : null
          });
        }
      });

      return success({
        ...experience,
        entity,
        components
      });
    }

    // PUT /api/experiences/:id - Edit an existing experience: repoint
    // initial_state, and/or replace the full set of attached actions.
    // final_state's own text/photos are edited directly via PUT /api/states/:id
    // (same mechanism AddObservation.tsx already uses) — not duplicated here.
    if (httpMethod === 'PUT' && pathParameters?.id) {
      const experienceId = pathParameters.id;
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        return error('Invalid JSON in request body', 400);
      }
      const { initial_state_id, final_state_id, action_ids } = body;

      const existingRes = await pool.query(
        `SELECT id FROM experiences WHERE id = $1 AND organization_id = $2`,
        [experienceId, organizationId]
      );
      if (existingRes.rows.length === 0) {
        return error('Experience not found', 404);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (initial_state_id) {
          await client.query(
            `UPDATE experience_components SET state_id = $1 WHERE experience_id = $2 AND component_type = 'initial_state'`,
            [initial_state_id, experienceId]
          );
        }
        if (final_state_id) {
          await client.query(
            `UPDATE experience_components SET state_id = $1 WHERE experience_id = $2 AND component_type = 'final_state'`,
            [final_state_id, experienceId]
          );
        }

        if (Array.isArray(action_ids)) {
          const currentRes = await client.query(
            `SELECT action_id FROM experience_components WHERE experience_id = $1 AND component_type = 'action'`,
            [experienceId]
          );
          const currentActionIds = new Set(currentRes.rows.map((r) => r.action_id));
          const nextActionIds = new Set(action_ids);

          const toRemove = [...currentActionIds].filter((id) => !nextActionIds.has(id));
          const toAdd = [...nextActionIds].filter((id) => !currentActionIds.has(id));

          if (toRemove.length > 0) {
            await client.query(
              `DELETE FROM experience_components WHERE experience_id = $1 AND component_type = 'action' AND action_id = ANY($2)`,
              [experienceId, toRemove]
            );
          }
          for (const actionId of toAdd) {
            await client.query(
              `INSERT INTO experience_components (experience_id, component_type, action_id, organization_id, created_at)
               VALUES ($1, 'action', $2, $3, NOW())`,
              [experienceId, actionId, organizationId]
            );
          }
        }

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      try {
        await broadcastInvalidation({
          entityType: 'experience',
          entityId: experienceId,
          mutationType: 'updated',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[EXPERIENCES] Broadcast failed:', err.message);
      }

      return success({ id: experienceId, updated: true });
    }

    // POST /api/experiences - Create new experience
    if (httpMethod === 'POST' && path === '/api/experiences') {
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        console.error('Error parsing request body:', parseErr);
        return error('Invalid JSON in request body', 400);
      }
      
      const { entity_type, entity_id, initial_state_id, action_id, action_ids, final_state_id } = body;

      // Validate required fields
      if (!entity_type || !entity_id || !final_state_id) {
        return error('entity_type, entity_id, and final_state_id are required', 400);
      }

      // action_id is deprecated but still accepted for backward compat (StockDetails.tsx);
      // action_ids is the current, multi-action-capable field. Combine and de-dupe.
      const allActionIds = [...new Set([...(action_ids || []), ...(action_id ? [action_id] : [])])];

      // Validate entity_type
      if (!['tool', 'part'].includes(entity_type)) {
        return error('entity_type must be "tool" or "part"', 400);
      }

      // Start transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const orgMemberId = await resolveOrgMemberId(client, organizationId, userId);

        // Create experience record
        const experienceResult = await client.query(
          `INSERT INTO experiences
           (entity_type, entity_id, organization_id, created_by, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           RETURNING *`,
          [entity_type, entity_id, organizationId, orgMemberId]
        );

        const experience = experienceResult.rows[0];

        // Create components object to return
        const components = {};

        // Create initial_state component if provided
        if (initial_state_id) {
          const initialStateResult = await client.query(
            `INSERT INTO experience_components 
             (experience_id, component_type, state_id, organization_id, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING *`,
            [experience.id, 'initial_state', initial_state_id, organizationId]
          );

          // Fetch state details
          const stateResult = await client.query(
            `SELECT id, state_text, captured_at, photos FROM states WHERE id = $1`,
            [initial_state_id]
          );

          components.initial_state = {
            ...initialStateResult.rows[0],
            state: stateResult.rows[0]
          };
        }

        // Create one action component per provided action id
        if (allActionIds.length > 0) {
          components.actions = [];
          for (const actionId of allActionIds) {
            const actionResult = await client.query(
              `INSERT INTO experience_components
               (experience_id, component_type, action_id, organization_id, created_at)
               VALUES ($1, $2, $3, $4, NOW())
               RETURNING *`,
              [experience.id, 'action', actionId, organizationId]
            );

            // Fetch action details
            const actionDetailsResult = await client.query(
              `SELECT id, title, description, created_at FROM actions WHERE id = $1`,
              [actionId]
            );

            components.actions.push({
              ...actionResult.rows[0],
              action: actionDetailsResult.rows[0]
            });
          }
        }

        // Create final_state component (required)
        const finalStateResult = await client.query(
          `INSERT INTO experience_components 
           (experience_id, component_type, state_id, organization_id, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           RETURNING *`,
          [experience.id, 'final_state', final_state_id, organizationId]
        );

        // Fetch state details
        const finalStateDetailsResult = await client.query(
          `SELECT id, state_text, captured_at, photos FROM states WHERE id = $1`,
          [final_state_id]
        );

        components.final_state = {
          ...finalStateResult.rows[0],
          state: finalStateDetailsResult.rows[0]
        };

        await client.query('COMMIT');

        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'experience',
            entityId: experience.id,
            mutationType: 'created',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[EXPERIENCES] Broadcast failed:', err.message);
        }

        return success({
          ...experience,
          components
        });

      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    }

    return error('Not found', 404);

  } catch (err) {
    console.error('Error:', err);
    return error(err.message, 500);
  }
};
