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

  // Verify eligibility
  const linksRes = await client.query('SELECT * FROM state_links WHERE state_id = $1', [state.id]);
  const qualifyingTypes = ['observation', 'action'];
  const isEligible = linksRes.rows.some(link => qualifyingTypes.includes(link.entity_type));
  if (!isEligible) {
    throw new Error(`State ${state.id} does not qualify for perspective processing. Linked entities: ${JSON.stringify(linksRes.rows.map(r => r.entity_type))}`);
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
  const images = [];
  const photoMap = new Map();
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

  // Phase 1: Run Photo Analysis for any photos missing descriptions
  let analyzedAny = false;
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
        // Mark as processing
        await client.query(`
          UPDATE pending_perspectives 
          SET status = 'PROCESSING', attempt_count = attempt_count + 1 
          WHERE id = $1
        `, [record.id]);

        // 2. Fetch full state context, including photos and metrics
        const stateSql = `
          SELECT 
            s.id, s.organization_id, s.state_text, s.captured_at,
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

        // 2.5 Fetch state links and action context
        const linksRes = await client.query('SELECT * FROM state_links WHERE state_id = $1', [state.id]);
        const qualifyingTypes = ['observation', 'action'];
        const isEligible = linksRes.rows.some(link => qualifyingTypes.includes(link.entity_type));
        if (!isEligible) {
          throw new Error(`State ${state.id} does not qualify for perspective processing. Linked entities: ${JSON.stringify(linksRes.rows.map(r => r.entity_type))}`);
        }

        const actionLink = linksRes.rows.find(link => link.entity_type === 'action');
        let actionContext = 'None';
        if (actionLink) {
          const actionRes = await client.query('SELECT title, description, expected_state FROM actions WHERE id = $1', [actionLink.entity_id]);
          if (actionRes.rows.length > 0) {
            actionContext = `Action Title: "${actionRes.rows[0].title}"\nExisting State: "${actionRes.rows[0].description}"\nTarget State: "${actionRes.rows[0].expected_state || 'None'}"`;
            
            // Fetch previous observations for this action to provide more context on what is normal
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

        // Fetch default LLM Generation Config (using Claude 3.5 Sonnet)
        const configRes = await client.query(`
          SELECT * FROM llm_generation_configs 
          WHERE model_id = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'
          LIMIT 1
        `);
        const llmConfig = configRes.rows.length > 0 ? configRes.rows[0] : (await client.query('SELECT * FROM llm_generation_configs ORDER BY created_at DESC LIMIT 1')).rows[0];
        if (!llmConfig) {
          throw new Error('No LLM generation config found in llm_generation_configs');
        }

        // ─── 3. Unified Phronesis Extraction ───
        try {
          // Download state photos
          const images = [];
          const photoUrls = (state.photos || []).map(p => p.photo_url).filter(Boolean);
          for (const url of photoUrls) {
            try {
              const imgData = await downloadPhoto(url);
              images.push(imgData);
            } catch (err) {
              console.error(`Failed to download photo ${url}:`, err.message);
            }
          }

          let modelId = llmConfig.model_id;
          let systemPrompt = llmConfig.system_prompt;
          let inferenceConfig = llmConfig.inference_config;
          let configId = llmConfig.id;

          if (images.length > 0 && modelId.includes('haiku')) {
            throw new Error('Haiku does not support images. Please use Sonnet or Nova Pro.');
          }

          const userPrompt = `
Analyze the attached farm observation.
State Text: ${getCombinedStateText(state) || 'None'}
Action Context: ${actionContext}

Your task is to extract three epistemic dimensions:
1. CLAIM: The explicit, observable assertion made by the human, supported strictly by the evidence in the photos. If no text exists, simply state the objective facts visible.
2. SIGNIFICANCE: The implicit value or intent. How does this observation impact the expected target state, explain systemic variation, or affect our understanding of the experiment/process?
3. ENTROPY: The systemic learning. Does this observation resolve a mystery (Phronesis/Entropy Reduction) or does it identify a new anomaly/open question (Entropy Increase)?

Extract these three dimensions clearly and concisely.
`;

          const toolConfig = {
            tools: [
              {
                toolSpec: {
                  name: "record_epistemic_extraction",
                  description: "Record the three epistemic dimensions of the observation",
                  inputSchema: {
                    json: {
                      type: "object",
                      properties: {
                        claim: { type: "string", description: "The explicit, observable assertion." },
                        significance: { type: "string", description: "How it impacts target state or explains variation." },
                        entropy: { type: "string", description: "The systemic learning or mystery resolution." }
                      },
                      required: ["claim", "significance", "entropy"]
                    }
                  }
                }
              }
            ],
            toolChoice: {
              tool: { name: "record_epistemic_extraction" }
            }
          };

          // perspectives should not need to look at images directly; they rely on text + AI descriptions
          const toolInput = await invokeBedrock(modelId, systemPrompt, userPrompt, inferenceConfig, [], toolConfig);
          
          await client.query('BEGIN');
          
          // Insert CLAIM
          const claimRes = await client.query(`
            INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status)
            VALUES ($1, 'CLAIM', $2, 'SUCCESS') RETURNING id
          `, [state.id, configId]);
          await client.query(`
            INSERT INTO claim_perspectives (id, content) VALUES ($1, $2)
          `, [claimRes.rows[0].id, toolInput.claim]);

          // Insert SIGNIFICANCE
          const sigRes = await client.query(`
            INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status)
            VALUES ($1, 'SIGNIFICANCE', $2, 'SUCCESS') RETURNING id
          `, [state.id, configId]);
          await client.query(`
            INSERT INTO significance_perspectives (id, content) VALUES ($1, $2)
          `, [sigRes.rows[0].id, toolInput.significance]);

          // Insert ENTROPY
          const entRes = await client.query(`
            INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status)
            VALUES ($1, 'ENTROPY', $2, 'SUCCESS') RETURNING id
          `, [state.id, configId]);
          await client.query(`
            INSERT INTO entropy_perspectives (id, content) VALUES ($1, $2)
          `, [entRes.rows[0].id, toolInput.entropy]);

          await client.query('COMMIT');
          console.log('[PHRONESIS] Successfully extracted and saved 3 dimensions.');

          // Queue embeddings
          const queueTypes = [
            { id: claimRes.rows[0].id, type: 'claim_perspective', text: toolInput.claim },
            { id: sigRes.rows[0].id, type: 'significance_perspective', text: toolInput.significance },
            { id: entRes.rows[0].id, type: 'entropy_perspective', text: toolInput.entropy }
          ];

          for (const q of queueTypes) {
            try {
              await sqs.send(new SendMessageCommand({
                QueueUrl: EMBEDDINGS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  entity_type: q.type,
                  entity_id: q.id,
                  embedding_source: q.text,
                  organization_id: state.organization_id
                })
              }));
            } catch (sqsErr) {
              console.error(`[SQS] Failed to queue embedding for ${q.type}:`, sqsErr);
            }
          }

        } catch (err) {
          await client.query('ROLLBACK');
          console.error('[PHRONESIS] Extraction failed:', err.message);
          // Mark failure under CLAIM as representative
          await client.query(`
            INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, error_message)
            VALUES ($1, 'CLAIM', $2, 'FAILED', $3)
          `, [state.id, llmConfig.id, err.message]);
        }

        // Completion: Mark pending perspective row as DONE
        await client.query(`
          UPDATE pending_perspectives 
          SET status = 'DONE', processed_at = NOW(), last_error = NULL 
          WHERE id = $1
        `, [record.id]);

        // Broadcast websocket invalidation so connected clients refresh
        await broadcastInvalidation({
          entityType: 'state',
          entityId: state.id,
          mutationType: 'updated',
          organizationId: state.organization_id
        });

      } catch (err) {
        console.error(`Error processing state perspective record ${record.id}:`, err);
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
