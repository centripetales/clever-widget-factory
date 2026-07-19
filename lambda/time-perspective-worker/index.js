/**
 * time-perspective-worker Lambda
 *
 * Computes daily time summaries by analyzing all observations for a given day
 * and using Bedrock Claude (tool_use) to produce structured time estimates.
 *
 * Results are stored as [summary:day] states with JSON, linked to source
 * observations via state_links, and queued for embedding generation.
 *
 * Invocation payload:
 * {
 *   organization_id: string,
 *   dates: string[],         // ['2026-07-12', '2026-07-11']
 *   force_recompute: boolean // if true, recompute even if fresh summary exists
 * }
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');

// ─── Environment validation ──────────────────────────────────────────────────
const requiredEnv = ['AWS_REGION'];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

// User IDs for context
const STEFAN_ID = '08617390-b001-708d-f61e-07a1698282ec';
const MAE_ID = '68d173b0-60f1-70ea-6084-338e74051fcc';
const LESTER_ID = '1891f310-c071-705a-2c72-0d0a33c92bf0';

const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// ─── Bedrock tool_use schema ─────────────────────────────────────────────────
const TOOL_CONFIG = {
  tools: [{
    name: 'record_daily_summary',
    description: 'Record the structured daily time summary',
    input_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'string', description: 'Cognito user ID of the person' },
              activity: { type: 'string', description: 'What was done' },
              hours: { type: 'number', description: 'Estimated hours' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
              evidence: { type: 'string', description: 'Why this estimate — cite timestamps, stated durations, or inference' },
              source_ids: { type: 'array', items: { type: 'string' }, description: 'The observation IDs (UUIDs from the "id:" field) that informed this entry' },
              energy_weights: {
                type: 'object',
                properties: {
                  dynamis: { type: 'number' },
                  oikonomia: { type: 'number' },
                  techne: { type: 'number' }
                },
                required: ['dynamis', 'oikonomia', 'techne']
              },
              boundary_type: { type: 'string', enum: ['internal', 'external'] },
              tags: { type: 'array', items: { type: 'string', enum: ['agriculture', 'compliance', 'infrastructure', 'maintenance', 'procurement', 'admin', 'product', 'reactive'] } }
            },
            required: ['user_id', 'activity', 'hours', 'confidence', 'evidence', 'source_ids', 'energy_weights', 'boundary_type', 'tags']
          }
        },
        notes: { type: 'string', description: 'Unaccounted time, gaps, or caveats about the day' }
      },
      required: ['entries', 'notes']
    }
  }],
  tool_choice: { type: 'tool', name: 'record_daily_summary' }
};

const SYSTEM_PROMPT = `You are estimating how people at Stargazer Farm spent their time on a specific day. You will be given all observations (work logs with photos) recorded that day across all team members.

Your job: produce one entry per person per distinct activity, estimating hours spent.

Evidence strength (use the strongest available):
1. Photo timestamps bracketing an activity (strongest)
2. Explicitly stated duration in text ("spent 3 hours", "the whole day")
3. Time gaps between observations
4. Known patterns (see below)

Known team patterns:
- Stefan (${STEFAN_ID}): typically computer/AI/admin work until 14:00-15:00, then outdoor/agriculture
- Stefan documents observations on behalf of Mae frequently
- Electrical work typically involves Stefan + Lester together
- Morning chicken care is routine (~0.5-1 hour)
- "whole morning" ≈ 4 hours, "spent the day" ≈ 8 hours, "afternoon" ≈ 4 hours

Travel and multi-person rules:
- ANY trip to Roxas (notary, BIR, SEC, SSS, PAGIBIG, LGU, banks, LBC) = FULL DAY (8 hours) per person. The drive is 1 hour each way + waiting + processing. A Roxas trip consumes the entire working day.
- Lester is the only one who drives the tricycle to Roxas. If a Roxas trip happened, Lester was there.
- If Stefan documents a Roxas trip AND Mae/Lester have no observations that day, assume they went too. Create a SEPARATE entry for EACH person involved.
- Even if the observation is brief ("went to notary"), the time cost is the full trip (8 hours per person), not just the task duration at the office.
- Confidence for Roxas travel time should be "high" — it's a known fixed cost, not an inference.

Rules:
- ASSUME a full working day (8 hours) for each person who has ANY observation that day OR is mentioned in someone else's observation. The goal is to estimate what filled their day, not just what was explicitly documented.
- If a person has NO observations AND is not mentioned by anyone else that day, OMIT them entirely — they may be out/absent.
- If someone recorded one observation about a physical task (construction, electrical, agriculture), assume that task filled MOST of their working day unless evidence suggests otherwise.
- Do NOT merge unrelated activities into one entry. Each distinct task gets its own entry even if they were documented in the same observation. BIR filing is not the same as writing a report is not the same as attending a meeting.
- Use judgment to infer what ELSE someone likely did that day based on patterns, even if not explicitly documented. E.g., Stefan working on software/AI in the morning is a near-certainty on most days. Mark inferred activities with confidence "low".
- Do NOT force totals to equal exactly 8 hours, but DO aim to account for a full working day per person. Flag genuinely unaccounted time in notes.
- If evidence is insufficient for a specific activity, set confidence to "unknown"
- energy_weights must sum to 1.0 (dynamis=exploration/growth, oikonomia=sustaining operations, techne=improving how work is done)
- boundary_type: "internal" for farm/org operations, "external" for government/vendor/agency interactions
- tags: use ONLY from this list (one or more per entry): agriculture, compliance, infrastructure, maintenance, procurement, admin, product, reactive
  - agriculture: planting, harvesting, livestock, soil, irrigation, crops
  - compliance: government regulatory (BIR, SEC, DENR, SSS, PAGIBIG, permits, filings)
  - infrastructure: construction, electrical, plumbing, solar, buildings, fencing
  - maintenance: routine upkeep, cleaning, repairs, feeding schedules
  - procurement: buying, sourcing, deliveries, vendor interactions
  - admin: planning, paperwork, digital/computer work, coordination, meetings
  - product: processing, packaging, sales, sari-sari, value-add (wine, biochar)
  - reactive: unplanned response to something breaking, an emergency, or urgent external demand
- Include unaccounted time in notes field`;

// ─── Core processing ─────────────────────────────────────────────────────────

/**
 * Fetch all observations for a given day (PHT timezone).
 */
async function fetchDayObservations(client, organizationId, date) {
  const sql = `
    SELECT 
      s.id, s.state_text, s.captured_at, s.captured_by,
      om.full_name as captured_by_name,
      (SELECT json_agg(json_build_object(
        'photo_url', sp.photo_url,
        'photo_description', sp.photo_description,
        'ai_description', (
          SELECT s2.state_text FROM state_links sl2
          JOIN states s2 ON sl2.state_id = s2.id
          WHERE sl2.entity_type = 'state_photo' AND sl2.entity_id = sp.id
            AND s2.state_text LIKE '[photo_analysis]%'
          LIMIT 1
        )
      )) FROM state_photos sp WHERE sp.state_id = s.id) as photos,
      (SELECT json_agg(json_build_object(
        'entity_type', sl.entity_type,
        'entity_id', sl.entity_id,
        'entity_name', COALESCE(a.title, t.name, p.name)
      )) FROM state_links sl
      LEFT JOIN actions a ON sl.entity_type = 'action' AND sl.entity_id = a.id
      LEFT JOIN tools t ON sl.entity_type = 'tool' AND sl.entity_id = t.id
      LEFT JOIN parts p ON sl.entity_type = 'part' AND sl.entity_id = p.id
      WHERE sl.state_id = s.id) as linked_entities
    FROM states s
    LEFT JOIN organization_members om ON s.captured_by::text = om.cognito_user_id::text
      AND om.organization_id = s.organization_id
    WHERE s.organization_id = '${escapeLiteral(organizationId)}'
      AND (s.captured_at AT TIME ZONE 'Asia/Manila')::date = '${escapeLiteral(date)}'
      AND (s.state_text IS NULL OR s.state_text NOT LIKE '[summary:%')
      AND (s.state_text IS NULL OR s.state_text NOT LIKE '[stale]%')
      AND (s.state_text IS NULL OR s.state_text NOT LIKE '[photo_analysis]%')
      AND (s.state_text IS NULL OR s.state_text NOT LIKE '[learning_objective]%')
      AND (s.state_text IS NULL OR s.state_text NOT LIKE '[capability_profile]%')
      AND (s.state_text IS NULL OR s.state_text NOT LIKE '{"type":"maxwell_interaction"%')
    ORDER BY s.captured_at
  `;
  const result = await client.query(sql);
  return result.rows;
}

/**
 * Check if a fresh summary already exists for this day.
 */
async function getExistingSummary(client, organizationId, date) {
  const result = await client.query(`
    SELECT id, state_text FROM states
    WHERE organization_id = '${escapeLiteral(organizationId)}'
      AND state_text LIKE '[summary:day]%'
      AND state_text LIKE '%"date":"${escapeLiteral(date)}"%'
    LIMIT 1
  `);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const isStale = row.state_text.startsWith('[stale]');
  return { id: row.id, isStale };
}

/**
 * Build the user prompt from the day's observations.
 */
function buildUserPrompt(date, observations) {
  const dayOfWeek = new Date(date + 'T00:00:00+08:00').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Manila' });

  const obsText = observations.map((obs, i) => {
    const photoText = obs.photos?.map(p => {
      const parts = [];
      if (p.photo_description) parts.push(`caption: ${p.photo_description}`);
      if (p.ai_description) parts.push(`AI: ${p.ai_description.replace('[photo_analysis] ', '')}`);
      return parts.join(', ');
    }).join(' | ') || 'none';

    const linkedText = obs.linked_entities?.map(e => `${e.entity_type}: "${e.entity_name}"`).join(', ') || 'none';

    return `--- Observation ${i + 1} (id: ${obs.id}) ---
Recorded by: ${obs.captured_by_name || 'Unknown'} (${obs.captured_by})
Time: ${obs.captured_at}
Text: ${obs.state_text || '(no text)'}
Linked to: ${linkedText}
Photos: ${photoText}`;
  }).join('\n\n');

  return `Date: ${date} (${dayOfWeek})

Team members:
- Stefan Hamilton (${STEFAN_ID})
- Mae Dela Torre (${MAE_ID})
- Lester Paniel (${LESTER_ID})

Observations recorded this day (${observations.length} total):

${obsText}

Produce a time estimate for each person for each distinct activity.`;
}

/**
 * Invoke Bedrock with tool_use to get structured daily summary.
 */
async function invokeBedrock(userPrompt) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0.1,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    tools: TOOL_CONFIG.tools,
    tool_choice: TOOL_CONFIG.tool_choice,
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  });

  const response = await bedrockRuntime.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));

  // Extract tool_use result
  const toolUse = result.content?.find(c => c.type === 'tool_use');
  if (!toolUse) {
    throw new Error('No tool_use response from Bedrock');
  }
  return toolUse.input;
}

/**
 * Store the daily summary as a state, link to sources, and queue embedding.
 */
async function storeSummary(client, organizationId, date, summaryData, sourceObservationIds) {
  const jsonPayload = JSON.stringify({ date, ...summaryData });
  const stateText = `[summary:day] ${jsonPayload}`;

  // Insert summary state
  const insertResult = await client.query(`
    INSERT INTO states (organization_id, state_text, captured_by, captured_at)
    VALUES ($1, $2, $3, NOW())
    RETURNING id
  `, [organizationId, stateText, STEFAN_ID]);

  const summaryStateId = insertResult.rows[0].id;

  // Link to each source observation
  for (const sourceId of sourceObservationIds) {
    await client.query(`
      INSERT INTO state_links (state_id, entity_type, entity_id)
      VALUES ($1, 'state', $2)
    `, [summaryStateId, sourceId]);
  }

  // Queue embedding generation
  const nameMap = { [STEFAN_ID]: 'Stefan', [MAE_ID]: 'Mae', [LESTER_ID]: 'Lester' };
  const embeddingSource = composeTimeSummaryEmbeddingSource({ date, ...summaryData }, nameMap);

  await sqs.send(new SendMessageCommand({
    QueueUrl: EMBEDDINGS_QUEUE_URL,
    MessageBody: JSON.stringify({
      entity_type: 'state',
      entity_id: summaryStateId,
      embedding_source: embeddingSource,
      organization_id: organizationId,
    }),
  }));

  return summaryStateId;
}

/**
 * Compose embedding source for semantic search.
 */
function composeTimeSummaryEmbeddingSource(summary, nameMap = {}) {
  const parts = [`Daily time summary for ${summary.date}`];
  for (const entry of (summary.entries || [])) {
    const name = nameMap[entry.user_id] || 'Unknown';
    const tags = entry.tags?.length > 0 ? ` (${entry.tags.join(', ')})` : '';
    parts.push(`${name} spent ${entry.hours} hours on ${entry.activity}${tags}`);
  }
  if (summary.notes) parts.push(`Notes: ${summary.notes}`);
  return parts.join('. ');
}

/**
 * Process a single day.
 */
async function processDay(client, organizationId, date, forceRecompute) {
  // Check existing
  const existing = await getExistingSummary(client, organizationId, date);
  if (existing && !existing.isStale && !forceRecompute) {
    console.log(`[TIME-PERSPECTIVE] ${date}: fresh summary exists, skipping`);
    return { date, observations_count: 0, success: true, skipped: true };
  }

  // Delete stale/existing summary if recomputing
  if (existing) {
    await client.query('DELETE FROM states WHERE id = $1', [existing.id]);
    console.log(`[TIME-PERSPECTIVE] ${date}: deleted stale summary ${existing.id}`);
  }

  // Fetch observations
  const observations = await fetchDayObservations(client, organizationId, date);
  if (observations.length === 0) {
    console.log(`[TIME-PERSPECTIVE] ${date}: no observations, skipping`);
    return { date, observations_count: 0, success: true, skipped: true };
  }

  console.log(`[TIME-PERSPECTIVE] ${date}: processing ${observations.length} observations`);

  // Build prompt and invoke Bedrock
  const userPrompt = buildUserPrompt(date, observations);
  const summaryData = await invokeBedrock(userPrompt);

  // Store result
  const sourceIds = observations.map(o => o.id);
  const summaryId = await storeSummary(client, organizationId, date, summaryData, sourceIds);

  console.log(`[TIME-PERSPECTIVE] ${date}: stored summary ${summaryId} with ${summaryData.entries?.length || 0} entries`);
  return { date, observations_count: observations.length, success: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('[TIME-PERSPECTIVE] Event:', JSON.stringify(event));

  // Support EventBridge scheduled invocation: detect scheduled event and default to today (PHT)
  let { organization_id, dates, force_recompute = false } = event;

  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
    // Nightly batch: compute today's date in PHT (UTC+8)
    const now = new Date();
    const phtDate = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().split('T')[0];
    dates = dates || [phtDate];
    organization_id = organization_id || '00000000-0000-0000-0000-000000000001';
    force_recompute = force_recompute || true; // recompute stale on nightly run
    console.log(`[TIME-PERSPECTIVE] Scheduled invocation — computing for ${phtDate}`);
  }

  if (!organization_id || !dates || !Array.isArray(dates) || dates.length === 0) {
    return { error: 'Missing required fields: organization_id, dates (array)' };
  }

  const computed = [];
  const errors = [];
  let client;

  try {
    client = await getDbClient();

    for (const date of dates) {
      try {
        const result = await processDay(client, organization_id, date, force_recompute);
        computed.push(result);
      } catch (err) {
        console.error(`[TIME-PERSPECTIVE] Error processing ${date}:`, err.message);
        errors.push({ date, error: err.message });
      }
    }
  } finally {
    if (client) client.release();
  }

  console.log(`[TIME-PERSPECTIVE] Complete: ${computed.length} computed, ${errors.length} errors`);
  return { computed, errors };
};
