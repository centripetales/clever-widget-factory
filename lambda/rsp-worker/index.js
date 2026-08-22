const { Client } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const https = require('https');

const { broadcastInvalidation } = require('/opt/nodejs/broadcastInvalidation');
const { broadcastWs } = require('/opt/nodejs/broadcastWs');

// ─── Environment validation (no implicit fallbacks per project rule) ──────────
const requiredEnv = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'AWS_REGION'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
};

const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

// Helper to download photos securely using Node's native https module
function downloadPhoto(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download photo: Status Code ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64Data = buffer.toString('base64');
        let mimeType = 'image/jpeg';
        if (url.endsWith('.png')) mimeType = 'image/png';
        else if (url.endsWith('.webp')) mimeType = 'image/webp';
        resolve({ base64Data, mimeType });
      });
    }).on('error', reject);
  });
}

// Bedrock invocation helper supporting regional IDs and multimodal payloads
async function invokeBedrock(modelId, systemPrompt, userPrompt, inferenceConfig = {}, images = [], toolConfig = null) {
  let body;
  const isAnthropic = modelId.includes('anthropic');

  if (isAnthropic) {
    const content = [];

    // Format images if provided
    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.base64Data
        }
      });
    }

    // Add user text prompt
    content.push({
      type: 'text',
      text: userPrompt
    });

    body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: inferenceConfig.max_tokens || 2000,
      temperature: inferenceConfig.temperature !== undefined ? inferenceConfig.temperature : 0.0,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: content
        }
      ]
    };
    if (toolConfig) {
      body.tools = toolConfig.tools.map(t => ({
        name: t.toolSpec.name,
        description: t.toolSpec.description,
        input_schema: t.toolSpec.inputSchema.json
      }));
      if (toolConfig.toolChoice) {
        body.tool_choice = {
          type: 'tool',
          name: toolConfig.toolChoice.tool.name
        };
      }
    }
  } else {
    const content = [];

    // Format images for Amazon Nova
    for (const img of images) {
      const format = img.mimeType.replace('image/', '');
      content.push({
        image: {
          format: format,
          source: {
            bytes: img.base64Data
          }
        }
      });
    }

    // Add user text prompt
    content.push({
      text: userPrompt
    });

    body = {
      inferenceConfig: {
        maxTokens: inferenceConfig.max_tokens || 2000,
        temperature: inferenceConfig.temperature !== undefined ? inferenceConfig.temperature : 0.0
      },
      system: [
        {
          text: systemPrompt
        }
      ],
      messages: [
        {
          role: 'user',
          content: content
        }
      ]
    };
    if (toolConfig) body.toolConfig = toolConfig;
  }

  const command = new InvokeModelCommand({
    modelId: modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  });

  const response = await bedrockRuntime.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  if (isAnthropic) {
    if (!responseBody.content || responseBody.content.length === 0) {
      throw new Error('Empty completion response from Bedrock');
    }
    const toolUse = responseBody.content.find(c => c.type === 'tool_use');
    if (toolUse) return toolUse.input;
    return responseBody.content[0].text;
  } else {
    if (!responseBody.output?.message?.content || responseBody.output.message.content.length === 0) {
      throw new Error('Empty completion response from Amazon Nova');
    }
    const toolUse = responseBody.output.message.content.find(c => c.toolUse);
    if (toolUse) return toolUse.toolUse.input;
    return responseBody.output.message.content[0].text;
  }
}

// Helper to extract JSON block safely from LLM text response
function parseLLMJson(text) {
  try {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/{[\s\S]*}/);
    const cleaned = match ? match[1] || match[0] : text;
    return JSON.parse(cleaned.trim());
  } catch (e) {
    throw new Error(`Failed to parse JSON response: ${e.message}. Raw: ${text}`);
  }
}

// Combined observation text getter (includes human caption and AI visual descriptions)
function getCombinedStateText(state) {
  const photoTexts = (state.photos || []).map(p => {
    const humanDesc = p.photo_description || '';
    const aiDesc = p.ai_description ? p.ai_description.replace('[photo_analysis]', '').trim() : '';
    if (humanDesc && aiDesc) {
      return `Human Caption: ${humanDesc}\nVisual Description: ${aiDesc}`;
    }
    return humanDesc || aiDesc;
  }).filter(Boolean).join('\n\n');
  return [state.state_text, photoTexts].filter(Boolean).join('\n\n');
}



// ─── Helper: fetch p50 estimated processing seconds from history ─────────────
async function getEstimatedSeconds(client, hasImages) {
  try {
    const res = await client.query(`
      SELECT EXTRACT(EPOCH FROM (processed_at - created_at)) AS duration
      FROM pending_perspectives
      WHERE status = 'DONE' AND processed_at IS NOT NULL
      ORDER BY processed_at DESC
      LIMIT 20
    `);
    if (res.rows.length === 0) return hasImages ? 30 : 15;
    const durations = res.rows.map(r => parseFloat(r.duration)).sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)];
    return Math.ceil(p50);
  } catch {
    return hasImages ? 30 : 15;
  }
}

// ─── Org-scoped processors (state → shared-to-org auto-processing) ───────────
// Entity types that can be share-granted to another org via POST /shares
// (lambda/core/index.js). Must stay consistent with the equivalent check in
// lambda/states/index.js (producer side) — same convention as qualifyingTypes
// above being a manual duplicate of QUALIFYING_LINK_TYPES there.
const SHAREABLE_LINK_TYPES = ['tool', 'part', 'action'];

// Whether a state is linked to an entity (tool/part/action) that's been share-granted
// to an org configured to run the given processor (organizations.ai_config.processors,
// e.g. "azolla_coverage"). Mirrors the join GET /shares/{entityType}/{entityId} already
// uses (lambda/core/index.js), filtered to a specific processor name.
async function stateLinkedToProcessorEnabledOrg(client, stateId, knownLinks, processorName) {
  const relevant = knownLinks.filter(l => SHAREABLE_LINK_TYPES.includes(l.entity_type));
  if (relevant.length === 0) return false;
  const res = await client.query(
    `SELECT 1
     FROM state_links our_link
     JOIN state_links share_entity_link
       ON share_entity_link.entity_type = our_link.entity_type
      AND share_entity_link.entity_id = our_link.entity_id
     JOIN state_links share_org_link
       ON share_org_link.state_id = share_entity_link.state_id
      AND share_org_link.entity_type = 'organization'
     JOIN organizations o ON o.id = share_org_link.entity_id::uuid
     WHERE our_link.state_id = $1
       AND our_link.entity_type = ANY($2)
       AND o.ai_config -> 'processors' @> to_jsonb($3::text)
     LIMIT 1`,
    [stateId, SHAREABLE_LINK_TYPES, processorName]
  );
  return res.rows.length > 0;
}

// ─── "azolla_coverage" processor: vision-LLM coverage % estimate ─────────────
// Ported from scripts/azolla-duckweed-observation.js (offline) + the metric-wiring
// half of scripts/azolla-wire-coverage-metric.js — same prompt/schema/model, same
// derived-state + state_perspectives shape, so historical and live data land in
// identical tables with no read-side changes.
const AZOLLA_COVERAGE_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const AZOLLA_COVERAGE_PROMPT_VERSION = 'azolla-duckweed-v1';

const AZOLLA_COVERAGE_SYSTEM_PROMPT = `You are a data extraction system supporting azolla/duckweed cultivation. Your only job is to report what is directly visible in the photo, as structured data. Do not assess health, growth quality, or compare against an ideal state. If something can't be determined from the image, say so explicitly in uncertainty_flags rather than guessing.

This program cultivates azolla and duckweed as part of a research trial in the Philippines.

When choosing plant_sample_points, only pick points that fall on visible plant material — never on open water, container walls, or background. These points seed an automated image segmentation step, and a point on the wrong thing will make that step segment the wrong object entirely. If you are not confident a point lands on plant material, mark its confidence as "low" rather than omitting it.`;

const AZOLLA_COVERAGE_TOOL_CONFIG = {
  tools: [{
    toolSpec: {
      name: 'record_growth_observation',
      description: 'Record structured, purely observational data extracted from an azolla/duckweed cultivation photo.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            vessel_present: { type: 'boolean' },
            vessel_type: { type: 'string' },
            vessel_frame_occupancy_percent: { type: ['number', 'null'], description: 'Rough estimate of what percent of the frame the vessel occupies. Null if vessel_present is false or not determinable.' },
            plant_material_visible: { type: 'boolean' },
            plant_sample_points: {
              type: 'array',
              description: '1-3 points (fractions of frame width/height, 0.0-1.0) that fall on visible plant material.',
              items: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
                },
                required: ['x', 'y', 'confidence']
              }
            },
            plant_coverage_percent_estimate: { type: ['number', 'null'], description: 'Estimate as a percentage of the visible water surface, not the whole photo frame.' },
            water_visible_percent_estimate: { type: ['number', 'null'] },
            dominant_plant_color: { type: 'string', enum: ['green', 'yellow-green', 'red-tinged', 'brown', 'mixed', 'not_visible'] },
            species_guess: { type: 'string', enum: ['azolla', 'duckweed', 'mixed', 'indistinguishable', 'not_visible'] },
            species_guess_basis: { type: 'string' },
            lighting_condition: { type: 'string', enum: ['direct_sun', 'shade', 'overcast', 'indoor', 'backlit', 'unknown'] },
            frame_contains_non_vessel_vegetation: { type: 'boolean', description: 'True if there is visible plant material in the frame that is clearly not inside/part of the vessel (e.g. background leaves, garden plants).' },
            most_interesting_observation: { type: 'string', description: 'The single most noteworthy, specific thing visible in this photo that a quick glance might miss. State ONLY what is directly visible (position, count, shape, color, arrangement) — do not infer a cause, mechanism, or explanation for why it looks that way. If you cannot confidently identify what an object or feature specifically is, describe its visible properties (shape, color, size, position) rather than naming what it is — e.g. write "an elongated white streak" rather than "a pipette" unless you are certain. A hedged, generic description is more useful than a specific but unconfirmed one.' },
            notable_organisms_visible: {
              type: 'array',
              description: 'Any animals, insects, or other organisms directly visible in the photo that are not the azolla/duckweed crop itself (e.g. a duck, a frog, tadpoles, insects). One short factual description per organism (what it is or looks like, roughly where in the frame). State only what is visible — do not infer whether it is beneficial, harmful, or why it is there. Empty array if none visible.',
              items: { type: 'string' }
            },
            uncertainty_flags: { type: 'array', items: { type: 'string' } }
          },
          required: ['vessel_present', 'vessel_type', 'plant_material_visible', 'plant_sample_points', 'dominant_plant_color', 'species_guess', 'species_guess_basis', 'lighting_condition', 'frame_contains_non_vessel_vegetation', 'most_interesting_observation', 'notable_organisms_visible', 'uncertainty_flags']
        }
      }
    }
  }],
  toolChoice: { tool: { name: 'record_growth_observation' } }
};

async function getOrCreateAzollaCoverageModelConfig(client) {
  const existing = await client.query(
    `SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1`,
    [AZOLLA_COVERAGE_MODEL_ID, AZOLLA_COVERAGE_PROMPT_VERSION]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [AZOLLA_COVERAGE_MODEL_ID, AZOLLA_COVERAGE_PROMPT_VERSION, AZOLLA_COVERAGE_SYSTEM_PROMPT, JSON.stringify({ max_tokens: 1000, temperature: 0 })]
  );
  return inserted.rows[0].id;
}

async function getOrCreateCoverageMetric(client, toolId, orgId) {
  const existing = await client.query(
    "SELECT metric_id FROM metrics WHERE tool_id = $1 AND name = 'Coverage %'",
    [toolId]
  );
  if (existing.rows.length > 0) return existing.rows[0].metric_id;
  const inserted = await client.query(
    `INSERT INTO metrics (tool_id, name, unit, details, organization_id)
     VALUES ($1, 'Coverage %', '%', 'Vision-LLM-estimated azolla/duckweed coverage of the visible water surface.', $2)
     RETURNING metric_id`,
    [toolId, orgId]
  );
  return inserted.rows[0].metric_id;
}

// Runs the vision-LLM coverage estimate for every not-yet-analyzed photo on this
// state, then writes the resulting average as this state's "Coverage %" metric
// snapshot on its linked tool. Errors are logged, not thrown — a failure here
// shouldn't fail an otherwise-successful CLAIM/SIGNIFICANCE/ENTROPY extraction
// (or vice versa; these are independent processors on the same state).
async function runAzollaCoverageProcessor(client, state, linkRows) {
  const toolLink = linkRows.find(l => l.entity_type === 'tool');
  if (!toolLink) {
    console.log('[RSP] azolla_coverage: state', state.id, 'has no linked tool, nothing to attach a metric to — skipping');
    return;
  }

  const photos = (state.photos || []).filter(p => p.photo_url);
  if (photos.length === 0) return;

  const configId = await getOrCreateAzollaCoverageModelConfig(client);
  const coverageEstimates = [];

  for (const photo of photos) {
    const already = await client.query(
      `SELECT 1 FROM state_links sl
       JOIN state_perspectives sper ON sper.state_id = sl.state_id
       WHERE sl.entity_type = 'state_photo' AND sl.entity_id = $1
         AND sper.perspective_type = 'AZOLLA_DUCKWEED_OBSERVATION'
       LIMIT 1`,
      [photo.id]
    );
    if (already.rows.length > 0) continue; // already scored (e.g. a retry) — skip re-running the vision call

    try {
      const imgData = await downloadPhoto(photo.photo_url);
      const result = await invokeBedrock(
        AZOLLA_COVERAGE_MODEL_ID,
        AZOLLA_COVERAGE_SYSTEM_PROMPT,
        'Analyze this photo and record the structured observation.',
        { max_tokens: 1000, temperature: 0 },
        [imgData],
        AZOLLA_COVERAGE_TOOL_CONFIG
      );

      await client.query('BEGIN');
      const derivedStateRes = await client.query(
        `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
         VALUES ($1, $2, $3, NOW()) RETURNING id`,
        [state.organization_id, '[azolla_duckweed_observation] vision LLM structured extraction', state.captured_by]
      );
      const derivedStateId = derivedStateRes.rows[0].id;

      await client.query(
        `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'state_photo', $2)`,
        [derivedStateId, photo.id]
      );

      const perspRes = await client.query(
        `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status)
         VALUES ($1, 'AZOLLA_DUCKWEED_OBSERVATION', $2, 'SUCCESS') RETURNING id`,
        [derivedStateId, configId]
      );
      await client.query(
        `INSERT INTO azolla_duckweed_observation_perspectives
          (id, vessel_present, vessel_type, vessel_frame_occupancy_percent, plant_material_visible,
           plant_coverage_percent_estimate, water_visible_percent_estimate, dominant_plant_color,
           species_guess, species_guess_basis, lighting_condition, frame_contains_non_vessel_vegetation,
           most_interesting_observation, plant_sample_points, uncertainty_flags, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          perspRes.rows[0].id, result.vessel_present, result.vessel_type, result.vessel_frame_occupancy_percent,
          result.plant_material_visible, result.plant_coverage_percent_estimate, result.water_visible_percent_estimate,
          result.dominant_plant_color, result.species_guess, result.species_guess_basis, result.lighting_condition,
          result.frame_contains_non_vessel_vegetation, result.most_interesting_observation,
          JSON.stringify(result.plant_sample_points || []), JSON.stringify(result.uncertainty_flags || []),
          JSON.stringify(result)
        ]
      );
      await client.query('COMMIT');

      if (typeof result.plant_coverage_percent_estimate === 'number') {
        coverageEstimates.push(result.plant_coverage_percent_estimate);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[RSP] azolla_coverage: failed for photo ${photo.id}:`, err.message);
    }
  }

  if (coverageEstimates.length === 0) return;

  // Max, not mean, across this observation's photos — matching
  // scripts/azolla-coverage-chart.py's convention: someone who honestly
  // photographs a sparse corner of their container alongside a fuller one
  // shouldn't have that average away the fuller shot's real coverage.
  const maxCoverage = Math.max(...coverageEstimates);
  const metricId = await getOrCreateCoverageMetric(client, toolLink.entity_id, state.organization_id);
  await client.query(
    `INSERT INTO metric_snapshots (state_id, metric_id, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (state_id, metric_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [state.id, metricId, maxCoverage.toFixed(2)]
  );
  console.log(`[RSP] azolla_coverage: wrote Coverage % = ${maxCoverage.toFixed(2)} for state ${state.id}`);
}

// ─── Core processing logic for a single pending_perspectives record ───────────
async function processPendingRecord(client, record) {
  // Mark as processing
  await client.query(`
    UPDATE pending_perspectives 
    SET status = 'PROCESSING', attempt_count = attempt_count + 1 
    WHERE id = $1
  `, [record.id]);

  // Fetch full state context including photos
  const stateSql = `
    SELECT 
      s.id, s.organization_id, s.state_text, s.captured_by, s.captured_at,
      (
        SELECT json_agg(
          jsonb_build_object(
            'id', sp.id,
            'photo_url', sp.photo_url,
            'photo_description', sp.photo_description,
            'photo_order', sp.photo_order,
            'gps_latitude', pme.gps_latitude,
            'gps_longitude', pme.gps_longitude,
            'requested_model', sp.requested_model,
            'has_analysis', EXISTS(
              SELECT 1 FROM state_links sl2 
              JOIN states s2 ON sl2.state_id = s2.id 
              WHERE sl2.entity_type = 'state_photo' 
                AND sl2.entity_id = sp.id 
                AND s2.state_text LIKE '[photo_analysis]%'
            ),
            'ai_description', (
              SELECT s2.state_text FROM state_links sl2
              JOIN states s2 ON sl2.state_id = s2.id
              WHERE sl2.entity_type = 'state_photo'
                AND sl2.entity_id = sp.id
                AND s2.state_text LIKE '[photo_analysis]%'
              LIMIT 1
            )
          )
        ) 
        FROM state_photos sp 
        LEFT JOIN photo_metadata_extractions pme ON sp.photo_url = pme.photo_url
        WHERE sp.state_id = s.id
      ) as photos,
      (SELECT json_agg(ms) FROM metric_snapshots ms WHERE ms.state_id = s.id) as metrics
    FROM states s
    WHERE s.id = $1
  `;
  const stateResult = await client.query(stateSql, [record.state_id]);
  if (stateResult.rows.length === 0) throw new Error(`State not found: ${record.state_id}`);
  const state = stateResult.rows[0];

  // Verify eligibility. Two independent processors can apply to the same state —
  // the original text-only epistemic extraction (CLAIM/SIGNIFICANCE/ENTROPY), and
  // any org-scoped processor (e.g. azolla_coverage) the state's linked tool/part/
  // action is share-granted into. Neither gates the other; only fail the whole job
  // if nothing at all applies (nothing should have been queued in that case).
  const linksRes = await client.query('SELECT * FROM state_links WHERE state_id = $1', [state.id]);
  const qualifyingTypes = ['observation', 'action']; // must match QUALIFYING_LINK_TYPES in lambda/states/index.js
  const runsEpistemicPerspectives = linksRes.rows.some(link => qualifyingTypes.includes(link.entity_type));
  const runsAzollaCoverage = await stateLinkedToProcessorEnabledOrg(client, state.id, linksRes.rows, 'azolla_coverage');
  if (!runsEpistemicPerspectives && !runsAzollaCoverage) {
    throw new Error(`State ${state.id} does not qualify for any perspective/processor. Linked entities: ${JSON.stringify(linksRes.rows.map(r => r.entity_type))}`);
  }

  if (runsAzollaCoverage) {
    try {
      await runAzollaCoverageProcessor(client, state, linksRes.rows);
    } catch (err) {
      console.error('[RSP] azolla_coverage processor failed for state', state.id, err);
    }
  }

  if (!runsEpistemicPerspectives) {
    // Mark pending_perspectives row as DONE — an azolla-only state (no action/observation
    // link) has nothing further to do here.
    await client.query(
      `UPDATE pending_perspectives SET status = 'DONE', processed_at = NOW(), last_error = NULL WHERE id = $1`,
      [record.id]
    );
    await broadcastInvalidation({
      entityType: 'state',
      entityId: state.id,
      mutationType: 'updated',
      organizationId: state.organization_id
    });
    console.log('[RSP] Broadcast complete for state', state.id, '(azolla_coverage only, no epistemic perspectives)');
    return;
  }

  // Build action context
  const actionLink = linksRes.rows.find(link => link.entity_type === 'action');
  let actionContext = 'None';
  if (actionLink) {
    const actionRes = await client.query('SELECT title, description, expected_state, policy FROM actions WHERE id = $1', [actionLink.entity_id]);
    if (actionRes.rows.length > 0) {
      const a = actionRes.rows[0];
      // Strip HTML from policy field so the LLM sees clean text
      const policyText = a.policy ? a.policy.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : null;
      actionContext = `Action Title: "${a.title}"\nExisting State: "${a.description}"\nTarget State: "${a.expected_state || 'None'}"${policyText ? `\nStated Method / Best Practice:\n${policyText}` : ''}`;
      const priorStatesRes = await client.query(`
        SELECT s.state_text, s.captured_at 
        FROM state_links sl
        JOIN states s ON sl.state_id = s.id
        WHERE sl.entity_id = $1 AND sl.entity_type = 'action'
        AND s.id != $2
        ORDER BY s.captured_at DESC
        LIMIT 5
      `, [actionLink.entity_id, state.id]);
      if (priorStatesRes.rows.length > 0) {
        const priorTexts = priorStatesRes.rows.map(r => `[${r.captured_at}] ${r.state_text || 'No text'}`).join('\n');
        actionContext += `\n\nRecent Prior Observations for this Action:\n${priorTexts}`;
      }
    }
  }

  // Resolve default LLM config — use Sonnet 4 (same model used by capability + states lambdas)
  const configRes = await client.query(`SELECT * FROM llm_generation_configs WHERE model_id = 'us.anthropic.claude-sonnet-4-20250514-v1:0' LIMIT 1`);
  const llmConfig = configRes.rows.length > 0 ? configRes.rows[0] : (await client.query('SELECT * FROM llm_generation_configs ORDER BY created_at DESC LIMIT 1')).rows[0];
  if (!llmConfig) throw new Error('No LLM generation config found in llm_generation_configs');

  // Broadcast perspectives:processing with estimated completion time
  const hasImages = (state.photos || []).some(p => p.photo_url);
  const estimatedSeconds = await getEstimatedSeconds(client, hasImages);
  await broadcastWs({
    type: 'perspectives:processing',
    payload: { stateId: state.id, estimatedSeconds },
    organizationId: state.organization_id
  });

  // Download photos and track mapping
  // Disabled: photo_analysis is off and perspectives use text only. Re-enable when funding allows.
  const PHOTO_DOWNLOAD_ENABLED = false;
  const images = [];
  const photoMap = new Map();
  if (PHOTO_DOWNLOAD_ENABLED) {
    for (const photo of (state.photos || [])) {
      if (!photo.photo_url) continue;
      try {
        const imgData = await downloadPhoto(photo.photo_url);
        images.push(imgData);
        photoMap.set(photo.photo_url, imgData);
      } catch (err) {
        console.error(`Failed to download photo ${photo.photo_url}:`, err.message);
      }
    }
  }

  // Phase 1: Run Photo Analysis (Disabled as per user request to remove generic image descriptions)
  let analyzedAny = false;
  /*
  for (const photo of (state.photos || [])) {
    if (photo.has_analysis) continue;
    const imgData = photoMap.get(photo.photo_url);
    if (!imgData) continue;

    console.log(`[RSP] Running async photo analysis for ${photo.id}...`);
    try {
      // Resolve photo-specific model config (default to cheap Nova Lite as requested, allow override)
      let currentConfig;
      const novaLiteRes = await client.query(`SELECT * FROM llm_generation_configs WHERE model_id = 'us.amazon.nova-lite-v1:0' LIMIT 1`);
      currentConfig = novaLiteRes.rows.length > 0 ? novaLiteRes.rows[0] : llmConfig;
      
      if (photo.requested_model) {
        console.log(`[RSP] Photo requested specific model: ${photo.requested_model}`);
        const specificRes = await client.query(`SELECT * FROM llm_generation_configs WHERE model_id = $1 LIMIT 1`, [photo.requested_model]);
        if (specificRes.rows.length > 0) {
          currentConfig = specificRes.rows[0];
        }
      }

      let systemPrompt = "";
      let userPrompt = "";

      const isNovaLite = currentConfig.model_id && currentConfig.model_id.includes('nova-lite');

      if (isNovaLite) {
        systemPrompt = "You are a helpful assistant. Your job is to describe the provided photo objectively and pull any text visible in the image.";
        userPrompt = "Describe the photo objectively in detail, and extract/transcribe any text or numbers that are visible in the image.";
        if (state.state_text && state.state_text.trim()) {
          userPrompt += `\n\nUser's Observation Context:\n"${state.state_text.trim()}"\n\nUse this observation context only to help locate or describe relevant items, but do not hallucinate details.`;
        }
      } else {
        systemPrompt = "You are a professional agricultural data extractor on an organic farm. Your objective is to extract dense, purely factual visual information from images. Do not provide judgments, health assessments, diagnoses, or theories. Document objective observations concisely to minimize token usage.";
        userPrompt = "Extract all factual visual data from this image. List visible plants, animals, structures, text, and equipment. Use dense, compact formatting with zero redundancy. Do not assess condition or suggest causes.";
        if (state.state_text && state.state_text.trim()) {
          userPrompt += `\n\nUser's Observation Context:\n"${state.state_text.trim()}"\n\nUse the context strictly to locate relevant items, but do not hallucinate details. Maintain dense, compact, factual formatting.`;
        }
      }
      const inferenceConfig = currentConfig.inference_config || { max_tokens: 1000, temperature: 0.1 };
      
      const description = await invokeBedrock(
        currentConfig.model_id, 
        systemPrompt, 
        userPrompt, 
        inferenceConfig, 
        [imgData]
      );
      
      if (!description || !description.trim()) throw new Error('Empty photo description');
      
      // Insert machine observation state
      const insertStateSql = `
        INSERT INTO states (organization_id, state_text, captured_by, captured_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id
      `;
      const stateRes = await client.query(insertStateSql, [
        state.organization_id,
        `[photo_analysis] ${description.trim()}`,
        state.captured_by
      ]);
      const transStateId = stateRes.rows[0].id;

      // Link to the photo
      await client.query(`
        INSERT INTO state_links (state_id, entity_type, entity_id)
        VALUES ($1, 'state_photo', $2)
      `, [transStateId, photo.id]);

      // Link to the LLM config
      await client.query(`
        INSERT INTO state_links (state_id, entity_type, entity_id)
        VALUES ($1, 'photo_analysis_param', $2)
      `, [transStateId, currentConfig.id]);

      analyzedAny = true;
    } catch (err) {
      console.error(`[RSP] Failed async photo analysis for ${photo.id}:`, err);
    }
  }

  // If we analyzed any photos, broadcast invalidation immediately so the frontend
  // renders the new AI descriptions without waiting for perspectives to finish.
  if (analyzedAny) {
    try {
      await broadcastInvalidation({
        entityType: 'state',
        entityId: state.id,
        mutationType: 'updated',
        organizationId: state.organization_id
      });
      console.log('[RSP] Broadcasted invalidation for state photo analysis update:', state.id);
    } catch (broadcastErr) {
      console.error('[RSP] Failed to broadcast state photo analysis update:', broadcastErr);
    }
  }
  */

  let modelId = llmConfig.model_id;
  let systemPrompt = llmConfig.system_prompt;
  let inferenceConfig = llmConfig.inference_config;
  let configId = llmConfig.id;

  if (images.length > 0 && modelId.includes('haiku')) {
    throw new Error('Haiku does not support images. Please use Sonnet or Nova Pro.');
  }

  const userPrompt = `
You are an Expert Agricultural Systems Architect and Master Farm Manager embedded in a living operational record. Your role is to extract structured epistemic value from farm observations — not to give advice, not to speculate beyond what is stated.

Analyze the following observation:
Observation: ${getCombinedStateText(state) || 'None'}
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


  const toolConfig = {
    tools: [{
      toolSpec: {
        name: 'record_epistemic_extraction',
        description: 'Record the three epistemic dimensions of the observation',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              claim: { type: 'string', description: 'Raw, objective, directly observable facts as stated. No interpretation or inference.' },
              significance: { type: 'string', description: 'Meaningful gaps vs. stated policy or scope-appropriate best practice. If execution aligns with both, state that. Do not speculate on unmeasured variables. Do not invoke equipment or techniques implausible in this operational context.' },
              entropy: { type: 'string', description: 'Net change in system knowledge: which specific question was resolved (reduction) or which new unknown was exposed (increase). Be precise.' }
            },
            required: ['claim', 'significance', 'entropy']
          }
        }
      }
    }],
    toolChoice: { tool: { name: 'record_epistemic_extraction' } }
  };

  try {
    // perspectives should not need to look at images directly; they rely on text + AI descriptions
    const toolInput = await invokeBedrock(modelId, systemPrompt, userPrompt, inferenceConfig, [], toolConfig);

    await client.query('BEGIN');

    // Idempotency: delete any existing perspectives for this state before re-inserting
    const existingIds = (await client.query(
      `SELECT sp.id FROM state_perspectives sp WHERE sp.state_id = $1`, [state.id]
    )).rows.map(r => r.id);
    if (existingIds.length > 0) {
      await client.query(`DELETE FROM claim_perspectives WHERE id = ANY($1::uuid[])`, [existingIds]);
      await client.query(`DELETE FROM significance_perspectives WHERE id = ANY($1::uuid[])`, [existingIds]);
      await client.query(`DELETE FROM entropy_perspectives WHERE id = ANY($1::uuid[])`, [existingIds]);
      await client.query(`DELETE FROM state_perspectives WHERE state_id = $1`, [state.id]);
    }

    // Insert CLAIM
    const claimRes = await client.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status) VALUES ($1, 'CLAIM', $2, 'SUCCESS') RETURNING id`,
      [state.id, configId]
    );
    await client.query(`INSERT INTO claim_perspectives (id, content) VALUES ($1, $2)`, [claimRes.rows[0].id, toolInput.claim]);

    // Insert SIGNIFICANCE
    const sigRes = await client.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status) VALUES ($1, 'SIGNIFICANCE', $2, 'SUCCESS') RETURNING id`,
      [state.id, configId]
    );
    await client.query(`INSERT INTO significance_perspectives (id, content) VALUES ($1, $2)`, [sigRes.rows[0].id, toolInput.significance]);

    // Insert ENTROPY
    const entRes = await client.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status) VALUES ($1, 'ENTROPY', $2, 'SUCCESS') RETURNING id`,
      [state.id, configId]
    );
    await client.query(`INSERT INTO entropy_perspectives (id, content) VALUES ($1, $2)`, [entRes.rows[0].id, toolInput.entropy]);

    await client.query('COMMIT');
    console.log('[RSP] Successfully extracted and saved 3 perspective dimensions for state', state.id);

    // Queue embeddings
    for (const q of [
      { id: claimRes.rows[0].id, type: 'claim_perspective', text: toolInput.claim },
      { id: sigRes.rows[0].id, type: 'significance_perspective', text: toolInput.significance },
      { id: entRes.rows[0].id, type: 'entropy_perspective', text: toolInput.entropy }
    ]) {
      try {
        await sqs.send(new SendMessageCommand({
          QueueUrl: EMBEDDINGS_QUEUE_URL,
          MessageBody: JSON.stringify({ entity_type: q.type, entity_id: q.id, embedding_source: q.text, organization_id: state.organization_id })
        }));
      } catch (sqsErr) {
        console.error(`[SQS] Failed to queue embedding for ${q.type}:`, sqsErr);
      }
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[RSP] Extraction failed:', err.message);
    await client.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, error_message) VALUES ($1, 'CLAIM', $2, 'FAILED', $3)`,
      [state.id, llmConfig.id, err.message]
    );
    // Broadcast perspectives:complete — triggers cache invalidation on frontend to remove 'Finishing...'
    try {
      await broadcastInvalidation({
        entityType: 'state',
        entityId: state.id,
        mutationType: 'updated',
        organizationId: state.organization_id
      });
    } catch (bErr) {
      console.error('[RSP] Failed to broadcast invalidation on error:', bErr.message);
    }
    throw err; // re-throw so pending_perspectives gets FAILED status
  }

  // Mark pending_perspectives row as DONE
  await client.query(
    `UPDATE pending_perspectives SET status = 'DONE', processed_at = NOW(), last_error = NULL WHERE id = $1`,
    [record.id]
  );

  // Broadcast perspectives:complete — triggers cache invalidation on frontend
  await broadcastInvalidation({
    entityType: 'state',
    entityId: state.id,
    mutationType: 'updated',
    organizationId: state.organization_id
  });

  console.log('[RSP] Broadcast complete for state', state.id);
}

exports.handler = async (event) => {
  const client = new Client(dbConfig);
  try {
    await client.connect();

    // ── SQS-triggered invocation ──────────────────────────────────────────────
    if (Array.isArray(event.Records) && event.Records.length > 0) {
      console.log(`[RSP] SQS trigger: processing ${event.Records.length} record(s)`);
      for (const sqsRecord of event.Records) {
        const { stateId } = JSON.parse(sqsRecord.body);
        // Find or create the pending_perspectives row for this state
        let pendingRow = (await client.query(
          `SELECT id, state_id FROM pending_perspectives WHERE state_id = $1 AND status IN ('PENDING','PROCESSING') ORDER BY created_at DESC LIMIT 1`,
          [stateId]
        )).rows[0];
        if (!pendingRow) {
          // Create one if it was cleared or missing
          pendingRow = (await client.query(
            `INSERT INTO pending_perspectives (state_id, status) VALUES ($1, 'PENDING') RETURNING id, state_id`,
            [stateId]
          )).rows[0];
        }
        try {
          await processPendingRecord(client, pendingRow);
        } catch (err) {
          console.error(`[RSP] Failed processing state ${stateId}:`, err.message);
          await client.query(
            `UPDATE pending_perspectives SET status = 'FAILED', last_error = $1 WHERE id = $2`,
            [err.message, pendingRow.id]
          );
          throw err; // re-throw so SQS can retry / send to DLQ
        }
      }
      return { statusCode: 200, body: JSON.stringify({ processed: event.Records.length }) };
    }

    // ── Fallback: manual / scheduled DB poll (catch-up mode) ─────────────────
    console.log('[RSP] Manual invocation: polling pending_perspectives table');
    const pendingRecords = (await client.query(`
      SELECT id, state_id FROM pending_perspectives
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT 10
    `)).rows;

    for (const record of pendingRecords) {
      try {
        await processPendingRecord(client, record);
      } catch (err) {
        console.error(`Error processing state perspective record ${record.id}:`, err.message);
        await client.query(`
          UPDATE pending_perspectives
          SET status = 'FAILED', last_error = $1
          WHERE id = $2
        `, [err.message, record.id]);

        // Broadcast websocket invalidation to clear 'Finishing...' state on frontend
        try {
          const stateRes = await client.query('SELECT organization_id FROM states WHERE id = $1', [record.state_id]);
          if (stateRes.rows.length > 0) {
            await broadcastInvalidation({
              entityType: 'state',
              entityId: record.state_id,
              mutationType: 'updated',
              organizationId: stateRes.rows[0].organization_id
            });
          }
        } catch (bErr) {
          console.error('Failed to broadcast invalidation in manual mode catch:', bErr.message);
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ processed: pendingRecords.length }) };
  } catch (error) {
    console.error('RSP Worker general error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } finally {
    await client.end();
  }
};
