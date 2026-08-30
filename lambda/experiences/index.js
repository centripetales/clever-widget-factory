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
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

const bedrock = new BedrockRuntimeClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

// Matches lambda/shared/embedding-composition.js composeActionPolicySource
// and scripts/azolla-experience-form.js's copy of the same function.
function composeActionPolicySource(action) {
  return [action.title, action.policy].filter(Boolean).join('. ');
}

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

// v1 of the "Draft Experience" prompt — a person has already picked one
// anchor (an observation or an action) and written a note saying what they
// want captured; this proposes only what's missing around it. Expect this to
// need real iteration once we see actual output, same as any tuned prompt.
const DRAFT_PROMPT_VERSION = 'draft-experience-v1';

const DRAFT_SYSTEM_PROMPT = `You are a precise technical field-log transcriber for an azolla/duckweed cultivation pilot, helping a person write up one specific experience — a real action that transitioned a container from one state to another — that they have already decided is worth recording. A person has pointed you at one anchor, either an action they already took or one observation they made, and added a short note saying what they want captured. Your job is to propose the missing piece(s) of the S -> A -> S' write-up, grounded strictly in the real context given to you (the anchor itself, nearby observations, and any existing CLAIM text) plus the person's note.

Whenever you write a description, prioritize technical density over readability: every reading, quantity, material specific, and concrete detail present in the evidence belongs in it — never trade away a number, unit, or material name for a smoother sentence.

**When in doubt, leave it blank or write less.** Every field you propose should be grounded in the evidence and the person's note — never invent a plausible-sounding detail to fill a gap. A short, honest field is the correct result when the evidence is thin; it is not a failure.

When classifying an action, use:
- "transformative": physically changes the container's real condition — adding an input, harvesting, moving the container, changing the water, adjusting the setup.
- "entropy_reduction": does NOT change the container's real condition, but reduces uncertainty about it — a measurement, a test-kit reading, consulting AI, looking up documented best practice.

When proposing an expected_state (the goal/intent behind an action), ground it in an actual observed value or condition when possible, and leave it out (with no confidence) when there's no real basis for one — a normal, honest, valid result.

The person's own note is the most important signal for what to focus on and how to frame the write-up — prioritize it over your own guesses about what might be interesting.`;

const DRAFT_FROM_STATE_TOOL = {
  name: 'record_draft_experience',
  description: 'Propose the action and the other boundary state for an experience anchored on one observation, treated as the final state.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string', description: 'What was done and why, at full technical density. Do NOT describe the resulting/later state.' },
      action_type: { type: 'string', enum: ['transformative', 'entropy_reduction'] },
      confidence: { type: 'number', description: '0.0-1.0' },
      action_photo_ids: { type: 'array', items: { type: 'string' }, description: 'IDs (from the context given) of photos that document this action.' },
      expected_state: { type: 'string', description: 'Omit if no real basis exists in the evidence.' },
      expected_state_confidence: { type: 'number', description: '0.0-1.0. Omit if expected_state is omitted.' },
      expected_state_basis: { type: 'string', description: 'What specific observed value/condition this goal responds to. Required alongside expected_state.' },
      initial_state_text: { type: 'string', description: 'Proposed description of the condition before the action — the state this experience started from.' },
    },
    required: ['title', 'description', 'action_type', 'confidence', 'initial_state_text'],
  },
};

const DRAFT_FROM_ACTION_TOOL = {
  name: 'record_draft_experience_states',
  description: 'Propose the initial and final state for an experience anchored on a real, already-recorded action.',
  input_schema: {
    type: 'object',
    properties: {
      initial_state_text: { type: 'string', description: 'Proposed description of the condition before the action.' },
      final_state_text: { type: 'string', description: 'Proposed description of the condition after the action.' },
    },
    required: ['initial_state_text', 'final_state_text'],
  },
};

async function getOrCreateGenerationConfig(client, modelId, version, systemPrompt, inferenceConfig) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
    [modelId, version]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [modelId, version, systemPrompt, JSON.stringify(inferenceConfig)]
  );
  return inserted.rows[0].id;
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

// Shapes experience_components rows into the API's `components` object.
//
// All three legs are ARRAYS. An experience legitimately has multiple states
// and multiple actions per leg — e.g. start with ash, measure phosphorus and
// take a water sample (two actions), end with the phosphorus reading and the
// water reading (two final states). The readings ARE the end state, and a
// reading is a metric_snapshot keyed to a state, so collapsing a leg to one
// state would lose real measurement data. See
// docs/specs/azolla-impact-power-model.md.
//
// Legs may also be EMPTY — an experience with no final state yet is normal
// (the outcome hasn't been observed), not a validation failure.
//
// Callers pass rows already ordered by leg then chronologically.
async function hydrateComponents(rows) {
  // states has no `photos` column — photos live in state_photos keyed by state_id.
  const stateIds = [...new Set(rows.map((c) => c.state_id).filter(Boolean))];

  const photosByStateId = new Map();
  const metricsByStateId = new Map();
  if (stateIds.length > 0) {
    const [photosRes, metricsRes] = await Promise.all([
      // photo_metadata_extractions.captured_at is the photo's own EXIF/file
      // date — a synthesized state's own captured_at is when the write-up
      // was made, not when the observation actually happened, so date-range
      // displays should prefer the photo's date when one was extracted.
      pool.query(
        `SELECT sp.state_id, sp.id, sp.photo_url, sp.photo_description, pme.captured_at AS photo_captured_at
         FROM state_photos sp
         LEFT JOIN photo_metadata_extractions pme ON pme.photo_url = sp.photo_url
         WHERE sp.state_id = ANY($1) ORDER BY sp.photo_order`,
        [stateIds]
      ),
      // Metrics are what make a measurement-shaped final state meaningful —
      // surfacing them lets the UI show "Phosphorus: >10 mg/L" as real data
      // rather than only as prose inside state_text.
      pool.query(
        `SELECT ms.state_id, ms.snapshot_id, ms.value, m.name, m.unit
         FROM metric_snapshots ms
         JOIN metrics m ON m.metric_id = ms.metric_id
         WHERE ms.state_id = ANY($1)`,
        [stateIds]
      ),
    ]);
    for (const p of photosRes.rows) {
      if (!photosByStateId.has(p.state_id)) photosByStateId.set(p.state_id, []);
      photosByStateId.get(p.state_id).push({
        id: p.id,
        photo_url: p.photo_url,
        photo_description: p.photo_description,
        captured_at: p.photo_captured_at || null,
      });
    }
    for (const m of metricsRes.rows) {
      if (!metricsByStateId.has(m.state_id)) metricsByStateId.set(m.state_id, []);
      metricsByStateId.get(m.state_id).push({
        snapshot_id: m.snapshot_id,
        name: m.name,
        value: m.value,
        unit: m.unit,
      });
    }
  }

  const components = { initial_states: [], actions: [], final_states: [] };
  for (const comp of rows) {
    if (comp.component_type === 'initial_state' || comp.component_type === 'final_state') {
      const lane = comp.component_type === 'initial_state' ? components.initial_states : components.final_states;
      lane.push({
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
          photos: photosByStateId.get(comp.state_id) || [],
          metrics: metricsByStateId.get(comp.state_id) || [],
        } : null,
      });
    } else if (comp.component_type === 'action') {
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
          expected_state: comp.action_expected_state,
          action_type: comp.action_type,
          completed_at: comp.action_completed_at,
          created_at: comp.action_created_at,
        } : null,
      });
    }
  }
  return components;
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
    // POST /api/experiences/draft - a person has picked one anchor (an
    // observation or an action they already recognize as worth writing up)
    // and added a note steering what to capture. Proposes only the missing
    // piece(s) around that anchor — never writes anything real; the proposal
    // is persisted as its own untouched state_perspectives row so it stays
    // available for contrast against whatever the person actually saves.
    if (httpMethod === 'POST' && path.endsWith('/draft')) {
      let body;
      try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        return error('Invalid JSON in request body', 400);
      }
      const { entity_type, entity_id, anchor_type, anchor_id, note } = body || {};
      if (!entity_type || !entity_id || !anchor_type || !anchor_id) {
        return error('entity_type, entity_id, anchor_type, and anchor_id are required', 400);
      }
      if (!['state', 'action'].includes(anchor_type)) {
        return error('anchor_type must be "state" or "action"', 400);
      }

      const configId = await getOrCreateGenerationConfig(
        pool, MODEL_ID, DRAFT_PROMPT_VERSION, DRAFT_SYSTEM_PROMPT, { max_tokens: 1200, temperature: 0 }
      );

      const describeState = (s, photos) => {
        const photoList = (photos || [])
          .map((p, idx) => `  [photo ${idx + 1}/${photos.length}, id ${p.id}] ${p.photo_description || '(no description)'}`)
          .join('\n') || '  (no photos)';
        return `  Observation note: ${s.state_text ? `"${s.state_text}"` : '(none)'}\n  Photos:\n${photoList}`;
      };

      let userPrompt;
      let tool;

      if (anchor_type === 'state') {
        const anchorRes = await pool.query(
          `SELECT id, state_text, captured_at FROM states WHERE id = $1 AND organization_id = $2`,
          [anchor_id, organizationId]
        );
        if (anchorRes.rows.length === 0) return error('Anchor observation not found', 404);
        const anchor = anchorRes.rows[0];

        const photosRes = await pool.query(
          `SELECT id, photo_url, photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`,
          [anchor.id]
        );
        const claimRes = await pool.query(
          `SELECT content->>'content' AS content FROM state_perspectives WHERE state_id = $1 AND perspective_type = 'CLAIM'`,
          [anchor.id]
        );

        // Nearest neighboring observations of the same container, for
        // pairing context — not a rigid pair, just whatever's close in time.
        const neighborsRes = await pool.query(
          `SELECT s.id, s.state_text, s.captured_at, (s.captured_at < $2) AS is_prior
           FROM states s
           JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = $3 AND sl.entity_id = $4
           WHERE s.id != $1 AND s.organization_id = $5
           ORDER BY ABS(EXTRACT(EPOCH FROM (s.captured_at - $2::timestamptz)))
           LIMIT 4`,
          [anchor.id, anchor.captured_at, entity_type, entity_id, organizationId]
        );

        const neighborText = neighborsRes.rows.length
          ? '\n\nNearby observations of the same container, for context on what changed around this time:\n' +
            neighborsRes.rows.map((n) => `[${n.is_prior ? 'earlier' : 'later'}, ${new Date(n.captured_at).toISOString().slice(0, 10)}] ${n.state_text || '(no note)'}`).join('\n')
          : '';
        const claimText = claimRes.rows[0]?.content ? `\n\nThis observation's own CLAIM account: ${claimRes.rows[0].content}` : '';

        userPrompt = `The person is writing up an experience anchored on this observation, treated as the FINAL state (the outcome):\n${describeState(anchor, photosRes.rows)}${claimText}${neighborText}\n\nPerson's note: ${note || '(none given)'}\n\nPropose the action that led to this outcome, and initial_state_text describing the condition beforehand.`;
        tool = DRAFT_FROM_STATE_TOOL;
      } else {
        const actionRes = await pool.query(
          `SELECT id, title, description, expected_state, completed_at, scoring_data->>'action_type' AS action_type
           FROM actions WHERE id = $1 AND organization_id = $2`,
          [anchor_id, organizationId]
        );
        if (actionRes.rows.length === 0) return error('Anchor action not found', 404);
        const anchor = actionRes.rows[0];

        const claimRes = await pool.query(
          `SELECT content->>'content' AS content FROM state_perspectives WHERE action_id = $1 AND perspective_type = 'CLAIM'`,
          [anchor.id]
        );
        const linkedRes = await pool.query(
          `SELECT s.id, s.state_text, s.captured_at
           FROM states s
           JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'action' AND sl.entity_id = $1
           ORDER BY s.captured_at`,
          [anchor.id]
        );

        const linkedText = linkedRes.rows.length
          ? '\n\nObservations already linked to this action:\n' + linkedRes.rows.map((s) => `[${new Date(s.captured_at).toISOString().slice(0, 10)}] ${s.state_text || '(no note)'}`).join('\n')
          : '';

        userPrompt = `The person is writing up an experience anchored on this already-recorded action — do not propose action fields, only the two boundary states:\n  Title: ${anchor.title}\n  Description: ${anchor.description || '(none)'}\n  Type: ${anchor.action_type || '(unclassified)'}\n  Expected state / goal: ${anchor.expected_state || '(none recorded)'}\n  Completed: ${anchor.completed_at ? new Date(anchor.completed_at).toISOString().slice(0, 10) : '(unknown)'}\n  Its own CLAIM account: ${claimRes.rows[0]?.content || '(none)'}${linkedText}\n\nPerson's note: ${note || '(none given)'}\n\nPropose initial_state_text (the condition before this action) and final_state_text (the condition after).`;
        tool = DRAFT_FROM_ACTION_TOOL;
      }

      const proposal = await invokeBedrock(DRAFT_SYSTEM_PROMPT, userPrompt, tool);
      if (!proposal) return error('The model did not return a proposal', 502);

      // Always a fresh row, never an upsert — a different note deserves its
      // own permanent record, and every draft attempt stays around for
      // contrast, not just the latest one per anchor.
      const perspectiveId = crypto.randomUUID();
      const content = JSON.stringify({ anchor_type, anchor_id, note: note || null, proposal, model: MODEL_ID });
      await pool.query(
        `INSERT INTO state_perspectives (id, ${anchor_type === 'state' ? 'state_id' : 'action_id'}, perspective_type, llm_generation_config_id, status, content)
         VALUES ($1, $2, 'EXPERIENCE_PERSPECTIVE', $3, 'SUCCESS', $4)`,
        [perspectiveId, anchor_id, configId, content]
      );

      return success({
        perspective_id: perspectiveId,
        llm_generation_config_id: configId,
        anchor_type,
        anchor_id,
        proposal,
      });
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
               a.expected_state as action_expected_state,
               a.completed_at as action_completed_at,
               a.scoring_data->>'action_type' as action_type,
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
               END,
               -- chronological within each lane; no position column exists and
               -- none is needed (docs/specs/azolla-impact-power-model.md)
               COALESCE(s.captured_at, a.completed_at, ec.created_at) ASC`,
            [experience.id]
          );

          const components = await hydrateComponents(componentsResult.rows);

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
           a.expected_state as action_expected_state,
           a.completed_at as action_completed_at,
           a.scoring_data->>'action_type' as action_type,
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
           END,
           COALESCE(s.captured_at, a.completed_at, ec.created_at) ASC`,
        [experienceId]
      );

      const components = await hydrateComponents(componentsResult.rows);

      // Action CLAIMs: the technically-dense account of what was done, plus
      // any person-authored edit stored on the experience. The original
      // perspective is never overwritten — keeping both makes the
      // AI-vs-human delta computable later.
      const actionIds = components.actions.map((c) => c.action_id).filter(Boolean);
      if (actionIds.length > 0) {
        const claimsRes = await pool.query(
          `SELECT action_id, content->>'content' AS claim, content->>'report_span' AS report_span
           FROM state_perspectives
           WHERE action_id = ANY($1) AND perspective_type = 'CLAIM'`,
          [actionIds]
        );
        const claimByActionId = new Map(claimsRes.rows.map((r) => [r.action_id, r]));
        const edits = experience.metadata?.action_claim_edits || {};
        // An action's linked photos (state_links) are real data, often
        // including shots irrelevant to this particular write-up — an
        // experience is a deliberate distillation of a state transition,
        // not a mirror of everything attached to the action. Which of an
        // action's photos actually belong in this write-up is therefore an
        // explicit per-experience pick (opt-in), not an opt-out from
        // "everything by default" — stored on the experience, same as the
        // CLAIM edits above.
        const photoInclusions = experience.metadata?.action_photo_inclusions || {};
        for (const comp of components.actions) {
          const c = claimByActionId.get(comp.action_id);
          if (comp.action) {
            comp.action.claim = c?.claim || null;
            comp.action.report_span = c?.report_span || null;
            comp.action.claim_edit = edits[comp.action_id] || null;
            comp.action.included_photo_urls = photoInclusions[comp.action_id] || [];
          }
        }
      }

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
      const {
        initial_state_id, final_state_id,       // deprecated singular forms
        initial_state_ids, final_state_ids,     // current plural forms
        action_ids,
        action_claim_edits,
        action_photo_inclusions,
        experience_perspective_id,
        llm_generation_config_id,
      } = body;

      // Singular forms fold into the plural ones so older callers keep working.
      const nextInitialStateIds = Array.isArray(initial_state_ids)
        ? initial_state_ids
        : (initial_state_id ? [initial_state_id] : null);
      const nextFinalStateIds = Array.isArray(final_state_ids)
        ? final_state_ids
        : (final_state_id ? [final_state_id] : null);

      const existingRes = await pool.query(
        `SELECT id FROM experiences WHERE id = $1 AND organization_id = $2`,
        [experienceId, organizationId]
      );
      if (existingRes.rows.length === 0) {
        return error('Experience not found', 404);
      }

      // Add/remove diffing, identical for all three legs. Passing [] clears a
      // leg — legitimate, since an experience with no final state yet is a
      // normal in-progress state, not an error.
      const diffLeg = async (client, componentType, idColumn, nextIds) => {
        if (!Array.isArray(nextIds)) return; // omitted entirely = leave untouched
        const currentRes = await client.query(
          `SELECT ${idColumn} AS id FROM experience_components WHERE experience_id = $1 AND component_type = $2`,
          [experienceId, componentType]
        );
        const current = new Set(currentRes.rows.map((r) => r.id));
        const next = new Set(nextIds);
        const toRemove = [...current].filter((id) => !next.has(id));
        const toAdd = [...next].filter((id) => !current.has(id));

        if (toRemove.length > 0) {
          await client.query(
            `DELETE FROM experience_components WHERE experience_id = $1 AND component_type = $2 AND ${idColumn} = ANY($3)`,
            [experienceId, componentType, toRemove]
          );
        }
        for (const id of toAdd) {
          await client.query(
            `INSERT INTO experience_components (experience_id, component_type, ${idColumn}, organization_id, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [experienceId, componentType, id, organizationId]
          );
        }
      };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await diffLeg(client, 'initial_state', 'state_id', nextInitialStateIds);
        await diffLeg(client, 'final_state', 'state_id', nextFinalStateIds);
        await diffLeg(client, 'action', 'action_id', action_ids);

        // A person's edit of an action's CLAIM lands on the experience, never
        // on the action's own CLAIM perspective — that stays the AI baseline,
        // so delta(original, edit) remains computable.
        if (action_claim_edits && typeof action_claim_edits === 'object') {
          await client.query(
            `UPDATE experiences
             SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                            jsonb_build_object('action_claim_edits',
                              COALESCE(metadata->'action_claim_edits', '{}'::jsonb) || $1::jsonb)
             WHERE id = $2`,
            [JSON.stringify(action_claim_edits), experienceId]
          );
        }

        // Which of an action's already-linked photos are actually part of
        // this write-up — an explicit, opt-in pick (default: none) rather
        // than an opt-out from "show everything." The underlying state_links
        // are untouched, so the photos stay reachable (and pickable) from
        // the container's history regardless of what's included here.
        if (action_photo_inclusions && typeof action_photo_inclusions === 'object') {
          await client.query(
            `UPDATE experiences
             SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                            jsonb_build_object('action_photo_inclusions',
                              COALESCE(metadata->'action_photo_inclusions', '{}'::jsonb) || $1::jsonb)
             WHERE id = $2`,
            [JSON.stringify(action_photo_inclusions), experienceId]
          );
        }

        // Points back at the untouched AI draft (state_perspectives row) this
        // experience was written from, if any — so delta(AI draft, what the
        // person actually saved) stays computable. Set once, at whichever
        // save first supplies it; never cleared by a later save that omits it.
        if (experience_perspective_id) {
          await client.query(
            `UPDATE experiences
             SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                            jsonb_build_object('experience_perspective_id', $1::text, 'llm_generation_config_id', $2::text)
             WHERE id = $3`,
            [experience_perspective_id, llm_generation_config_id || null, experienceId]
          );
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

    // DELETE /api/experiences/:id - Delete an experience and its component
    // links. The underlying states/actions are untouched — this only removes
    // the write-up grouping them together.
    if (httpMethod === 'DELETE' && pathParameters?.id) {
      const experienceId = pathParameters.id;

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
        await client.query(`DELETE FROM experience_components WHERE experience_id = $1`, [experienceId]);
        await client.query(`DELETE FROM experiences WHERE id = $1`, [experienceId]);
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
          mutationType: 'deleted',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[EXPERIENCES] Broadcast failed:', err.message);
      }

      return success({ id: experienceId, deleted: true });
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
      
      const {
        entity_type, entity_id,
        initial_state_id, final_state_id, action_id,        // deprecated singular forms
        initial_state_ids, final_state_ids, action_ids,     // current plural forms
        action_photo_inclusions,
        experience_perspective_id,
        llm_generation_config_id,
      } = body;

      // Only the entity is genuinely required. A final state is NOT — an
      // experience with an initial state and an action but no observed
      // outcome yet is a normal in-progress experiment, and forcing one here
      // would make people invent an outcome to satisfy the API.
      if (!entity_type || !entity_id) {
        return error('entity_type and entity_id are required', 400);
      }

      // Singular forms are deprecated but still accepted (StockDetails.tsx).
      // Combine and de-dupe with the plural forms.
      const allInitialStateIds = [...new Set([...(initial_state_ids || []), ...(initial_state_id ? [initial_state_id] : [])])];
      const allFinalStateIds = [...new Set([...(final_state_ids || []), ...(final_state_id ? [final_state_id] : [])])];
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

        // Set at creation time so these aren't lost if the experience is
        // never subsequently updated: which of an action's linked photos are
        // actually picked for this write-up (opt-in — default none), and
        // (when this experience was written from an AI draft) the pointer
        // back to that untouched draft for future contrast.
        const initialMetadata = {
          ...(action_photo_inclusions && typeof action_photo_inclusions === 'object' ? { action_photo_inclusions } : {}),
          ...(experience_perspective_id ? { experience_perspective_id, llm_generation_config_id: llm_generation_config_id || null } : {}),
        };

        // Create experience record
        const experienceResult = await client.query(
          `INSERT INTO experiences
           (entity_type, entity_id, organization_id, created_by, created_at, metadata)
           VALUES ($1, $2, $3, $4, NOW(), $5)
           RETURNING *`,
          [entity_type, entity_id, organizationId, orgMemberId, JSON.stringify(initialMetadata)]
        );

        const experience = experienceResult.rows[0];

        const insertComponent = (componentType, idColumn, id) => client.query(
          `INSERT INTO experience_components (experience_id, component_type, ${idColumn}, organization_id, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [experience.id, componentType, id, organizationId]
        );

        for (const id of allInitialStateIds) await insertComponent('initial_state', 'state_id', id);
        for (const id of allActionIds) await insertComponent('action', 'action_id', id);
        for (const id of allFinalStateIds) await insertComponent('final_state', 'state_id', id);

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

        // Read the components back through the same path GET uses, so the
        // create response and the fetch response are the same shape.
        const createdComponentsRes = await pool.query(
          `SELECT
             ec.id, ec.experience_id, ec.component_type, ec.state_id, ec.action_id,
             ec.organization_id, ec.created_at,
             s.id as state_id_detail, s.state_text, s.captured_at,
             a.id as action_id_detail, a.title as action_title,
             a.description as action_description,
             a.expected_state as action_expected_state,
             a.completed_at as action_completed_at,
             a.scoring_data->>'action_type' as action_type,
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
             END,
             COALESCE(s.captured_at, a.completed_at, ec.created_at) ASC`,
          [experience.id]
        );

        return success({
          ...experience,
          components: await hydrateComponents(createdComponentsRes.rows)
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
