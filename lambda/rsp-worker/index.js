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

// Combined observation text getter
function getCombinedStateText(state) {
  const photoTexts = (state.photos || []).map(p => p.photo_description).filter(Boolean).join('\n');
  return [state.state_text, photoTexts].filter(Boolean).join('\n');
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
            'has_analysis', EXISTS(
              SELECT 1 FROM state_links sl2 
              JOIN states s2 ON sl2.state_id = s2.id 
              WHERE sl2.entity_type = 'state_photo' 
                AND sl2.entity_id = sp.id 
                AND s2.state_text LIKE '[photo_analysis]%'
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
    const actionRes = await client.query('SELECT title, description, expected_state FROM actions WHERE id = $1', [actionLink.entity_id]);
    if (actionRes.rows.length > 0) {
      actionContext = `Action Title: "${actionRes.rows[0].title}"\nExisting State: "${actionRes.rows[0].description}"\nTarget State: "${actionRes.rows[0].expected_state || 'None'}"`;
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

  // Resolve LLM config
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
      const systemPrompt = "You are a professional assistant analyzing farmer logs and observations.";
      const userPrompt = "Describe what you see objectively.";
      const inferenceConfig = { max_tokens: 1000, temperature: 0.1 };
      
      const description = await invokeBedrock(
        bedrockRuntime, 
        llmConfig.model_id, 
        systemPrompt, 
        userPrompt, 
        inferenceConfig, 
        null, 
        [imgData]
      );
      
      if (!description || !description.trim()) throw new Error('Empty photo description');
      
      // Insert machine observation state
      const insertStateSql = `
        INSERT INTO states (organization_id, state_text, captured_by, captured_at)
        VALUES ($1, $2, 'system-nova-lite', NOW())
        RETURNING id
      `;
      const stateRes = await client.query(insertStateSql, [
        state.organization_id,
        `[photo_analysis] ${description.trim()}`
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
      `, [transStateId, llmConfig.id]);

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
    const visionConfigRes = await client.query(`SELECT * FROM llm_generation_configs WHERE model_id = 'us.amazon.nova-pro-v1:0' LIMIT 1`);
    if (visionConfigRes.rows.length > 0) {
      modelId = visionConfigRes.rows[0].model_id;
      systemPrompt = visionConfigRes.rows[0].system_prompt;
      inferenceConfig = visionConfigRes.rows[0].inference_config;
      configId = visionConfigRes.rows[0].id;
    } else {
      throw new Error('No explicit vision model configured.');
    }
  }

  const userPrompt = `
You are an Expert Agricultural Systems Architect and Master Farm Manager. Your role is to carefully analyze farm operations, synthesize complex biological, structural, and ecological data, and extract high-value, actionable insights.

Analyze the attached farm observation.
State Text: ${getCombinedStateText(state) || 'None'}
Action Context: ${actionContext}

Extract three distinct epistemic dimensions. CRITICAL INSTRUCTIONS:
- Be extremely concise and information-dense. 
- Use direct, declarative statements. 
- Do NOT repeat information across dimensions. Ensure each dimension offers unique analytical value.
- Do NOT use filler phrases (e.g., "This observation indicates...", "This observation increases entropy by...").

1. CLAIM: The raw, objective, observable assertion (based strictly on text + photos).
2. SIGNIFICANCE: Why is this observation important for achieving our goal? What mechanisms or conditions may have produced the observed outcome? What historical actions, environmental changes, inputs, or state transitions should be reviewed to identify likely causes? What hypotheses does this observation suggest, and what future observations or experiments could help distinguish between them?
3. ENTROPY: The delta in systemic learning. Does this resolve a mystery (reduction) or expose a new anomaly (increase)? State the exact mystery/anomaly cleanly.
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
              claim: { type: 'string', description: 'Raw, objective facts without preamble.' },
              significance: { type: 'string', description: 'Exploration of mechanisms, likely causes, required historical reviews, and hypotheses testing for future observations.' },
              entropy: { type: 'string', description: 'Delta in learning (mystery resolved or new anomaly exposed) without filler.' }
            },
            required: ['claim', 'significance', 'entropy']
          }
        }
      }
    }],
    toolChoice: { tool: { name: 'record_epistemic_extraction' } }
  };

  try {
    const toolInput = await invokeBedrock(modelId, systemPrompt, userPrompt, inferenceConfig, images, toolConfig);

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
                  'gps_longitude', pme.gps_longitude
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

        // Fetch default LLM Generation Config (using modern Claude 3.5 Haiku)
        const configRes = await client.query(`
          SELECT * FROM llm_generation_configs 
          WHERE model_id = 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
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

          const visionConfigRes = await client.query(`
            SELECT * FROM llm_generation_configs 
            WHERE model_id = 'us.amazon.nova-pro-v1:0'
            LIMIT 1
          `);
          if (visionConfigRes.rows.length > 0) {
            modelId = visionConfigRes.rows[0].model_id;
            systemPrompt = visionConfigRes.rows[0].system_prompt;
            inferenceConfig = visionConfigRes.rows[0].inference_config;
            configId = visionConfigRes.rows[0].id;
          } else if (images.length > 0 && modelId.includes('haiku')) {
            throw new Error('No explicit vision model configured.');
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

          const toolInput = await invokeBedrock(modelId, systemPrompt, userPrompt, inferenceConfig, images, toolConfig);
          
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
