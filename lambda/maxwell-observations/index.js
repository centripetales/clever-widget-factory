const { getAuthorizerContext, buildOrganizationFilter, hasPermission } = require('/opt/nodejs/authorizerContext');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });
const MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';

async function queryJSON(sql) {
  const client = await getDbClient();
  try {
    const result = await client.query(sql);
    return result.rows;
  } finally {
    client.release();
  }
}

function parseActionGroupParams(event) {
  const params = {};
  const rawParams = event.parameters || [];
  for (const p of rawParams) {
    params[p.name] = p.value;
  }
  return params;
}

function buildActionGroupResponse(actionGroup, apiPath, httpMethod, statusCode, body) {
  return {
    messageVersion: '1.0',
    response: {
      actionGroup,
      apiPath,
      httpMethod,
      httpStatusCode: statusCode,
      responseBody: {
        'application/json': {
          body: JSON.stringify(body),
        },
      },
    },
  };
}

async function generateEmbeddingV1(text) {
  const command = new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v1',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: text })
  });
  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.embedding;
}

async function handleIdentifyDroneMonitoringTargets(params, organizationId, buildActionGroupResponse, actionGroup, apiPath, httpMethod) {
  const userDirective = params.user_directive;

  if (!userDirective) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing required parameter: user_directive',
    });
  }

  try {
    // 1. GENERATE QUERY EMBEDDING
    const queryEmbedding = await generateEmbeddingV1(userDirective);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // 2. QUERY PGVECTOR FOR SEMANTIC MATCHES (Federated)
    const sqlEmbeddings = `
      WITH query_vector AS (
        SELECT '${embeddingStr}'::vector AS vec
      ),
      assets AS (
        SELECT entity_type, entity_id, (1 - (embedding <=> (SELECT vec FROM query_vector))) as similarity
        FROM unified_embeddings
        WHERE organization_id = '${escapeLiteral(organizationId)}' AND entity_type IN ('tool', 'part')
        ORDER BY embedding <=> (SELECT vec FROM query_vector)
        LIMIT 50
      ),
      claims AS (
        SELECT entity_type, entity_id, (1 - (embedding <=> (SELECT vec FROM query_vector))) as similarity
        FROM unified_embeddings
        WHERE organization_id = '${escapeLiteral(organizationId)}' AND entity_type = 'claim_perspective'
        ORDER BY embedding <=> (SELECT vec FROM query_vector)
        LIMIT 20
      ),
      significance AS (
        SELECT entity_type, entity_id, (1 - (embedding <=> (SELECT vec FROM query_vector))) as similarity
        FROM unified_embeddings
        WHERE organization_id = '${escapeLiteral(organizationId)}' AND entity_type = 'significance_perspective'
        ORDER BY embedding <=> (SELECT vec FROM query_vector)
        LIMIT 20
      ),
      entropy AS (
        SELECT entity_type, entity_id, (1 - (embedding <=> (SELECT vec FROM query_vector))) as similarity
        FROM unified_embeddings
        WHERE organization_id = '${escapeLiteral(organizationId)}' AND entity_type = 'entropy_perspective'
        ORDER BY embedding <=> (SELECT vec FROM query_vector)
        LIMIT 20
      )
      SELECT * FROM assets
      UNION ALL SELECT * FROM claims
      UNION ALL SELECT * FROM significance
      UNION ALL SELECT * FROM entropy;
    `;
    const semanticMatches = await queryJSON(sqlEmbeddings);

    if (userDirective.includes('DEBUG_SIM')) {
      return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, { raw_matches: semanticMatches });
    }

    const SIMILARITY_THRESHOLD = 0.55; // Threshold to drop noisy/irrelevant context
    const filteredMatches = semanticMatches.filter(m => m.similarity > SIMILARITY_THRESHOLD);

    const assetIds = filteredMatches.filter(m => m.entity_type === 'tool' || m.entity_type === 'part').map(m => `'${m.entity_id}'`);
    const perspectiveIds = filteredMatches.filter(m => m.entity_type.endsWith('_perspective')).map(m => `'${m.entity_id}'`);

    const assetFilter = assetIds.length > 0 ? `IN (${assetIds.join(',')})` : `= '00000000-0000-0000-0000-000000000000'`;
    const stateFilter = perspectiveIds.length > 0 ? `IN (SELECT state_id FROM state_perspectives WHERE id IN (${perspectiveIds.join(',')}))` : `= '00000000-0000-0000-0000-000000000000'`;

    // 3. QUERY 1: ASSETS (Initial Images with GPS)
    const sqlAssets = `
      SELECT 
        t.id as location_id,
        'Asset: ' || t.name || ' - ' || COALESCE(t.description, '') as description,
        t.created_at as captured_at,
        'Initial Registration' as last_observation,
        COALESCE(pme_primary.gps_latitude, recent_gps.gps_latitude) as lat,
        COALESCE(pme_primary.gps_longitude, recent_gps.gps_longitude) as lon,
        NULL as entropy_context
      FROM tools t
      LEFT JOIN photo_metadata_extractions pme_primary 
        ON t.image_url IS NOT NULL 
        AND t.image_url != '' 
        AND pme_primary.photo_url LIKE '%' || split_part(t.image_url, '/', -1)
      LEFT JOIN LATERAL (
        SELECT pme.gps_latitude, pme.gps_longitude
        FROM state_links sl
        JOIN states s ON sl.state_id = s.id
        JOIN state_photos sp ON s.id = sp.state_id
        JOIN photo_metadata_extractions pme ON pme.photo_url LIKE '%' || split_part(sp.photo_url, '/', -1)
        WHERE sl.entity_type = 'tool' AND sl.entity_id = t.id
          AND pme.gps_latitude IS NOT NULL
        ORDER BY s.captured_at DESC
        LIMIT 1
      ) recent_gps ON true
      WHERE t.organization_id = '${escapeLiteral(organizationId)}'
        AND t.id ${assetFilter}
      UNION ALL
      SELECT 
        p.id as location_id,
        'Stock: ' || p.name || ' - ' || COALESCE(p.description, '') as description,
        p.created_at as captured_at,
        'Initial Registration' as last_observation,
        COALESCE(pme_primary.gps_latitude, recent_gps.gps_latitude) as lat,
        COALESCE(pme_primary.gps_longitude, recent_gps.gps_longitude) as lon,
        NULL as entropy_context
      FROM parts p
      LEFT JOIN photo_metadata_extractions pme_primary 
        ON p.image_url IS NOT NULL 
        AND p.image_url != '' 
        AND pme_primary.photo_url LIKE '%' || split_part(p.image_url, '/', -1)
      LEFT JOIN LATERAL (
        SELECT pme.gps_latitude, pme.gps_longitude
        FROM state_links sl
        JOIN states s ON sl.state_id = s.id
        JOIN state_photos sp ON s.id = sp.state_id
        JOIN photo_metadata_extractions pme ON pme.photo_url LIKE '%' || split_part(sp.photo_url, '/', -1)
        WHERE sl.entity_type = 'part' AND sl.entity_id = p.id
          AND pme.gps_latitude IS NOT NULL
        ORDER BY s.captured_at DESC
        LIMIT 1
      ) recent_gps ON true
      WHERE p.organization_id = '${escapeLiteral(organizationId)}'
        AND p.id ${assetFilter}
    `;

    // 4. QUERY 2: STRATIFICATIONS / OBSERVATIONS (States with GPS)
    const sqlStates = `
      SELECT 
        s.id as location_id,
        'Observation: ' || s.state_text as description,
        s.captured_at,
        sp.photo_description as last_observation,
        pme.gps_latitude as lat,
        pme.gps_longitude as lon,
        (SELECT content FROM entropy_perspectives ep JOIN state_perspectives s_p ON ep.id = s_p.id WHERE s_p.state_id = s.id LIMIT 1) as entropy_context
      FROM states s
      JOIN state_photos sp ON s.id = sp.state_id
      LEFT JOIN photo_metadata_extractions pme 
        ON sp.photo_url IS NOT NULL 
        AND sp.photo_url != '' 
        AND pme.photo_url LIKE '%' || split_part(sp.photo_url, '/', -1)
      WHERE s.organization_id = '${escapeLiteral(organizationId)}'
        AND s.id ${stateFilter}
    `;

    // Execute both queries
    const [assets, states] = await Promise.all([
      queryJSON(sqlAssets),
      queryJSON(sqlStates)
    ]);

    let locations = [...assets, ...states];
    locations.sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at));
    locations = locations.slice(0, 150);

    const projectedLocations = locations.map((loc, index) => ({
      id: index,
      desc: loc.description,
      context: loc.entropy_context || undefined,
      has_gps: (loc.lat !== null && loc.lon !== null)
    }));

    const prompt = `Human: You are Maxwell, the Decision Support Synthesis Engine for Clever Widget Factory.
You are currently executing the "Drone Target Identification" skill.
The user states: "${userDirective}"

You automatically queried the pgvector database using a Semantic Search Embedding of the user's directive to find relevant assets and observations.

The current system time is: ${new Date().toISOString()}

Here are the retrieved physical locations in our GPS registry (both initial asset registrations and observation states). 
To save context window space, raw coordinates have been stripped and replaced with a simple "has_gps" boolean, and location UUIDs have been replaced with a simple integer "id".

${JSON.stringify(projectedLocations, null, 2)}

Your task:
1. Filter the locations to ONLY those that match the user's intent. Do not say coordinates are missing if 'has_gps' is true! If the user is looking for a condition (like fallen fruit), consider parent assets (like a tree) as highly relevant routing targets.
2. Detail the exact physical execution instructions the drone requires to fulfill this request at each valid location with coordinates (e.g., flight altitude, camera angle).
3. Explicitly state that you are using the Drone Target Identification skill and mention that you performed a semantic vector search across the database based on the user's directive.
4. For any relevant assets that lack GPS coordinates (has_gps is false), simply inform the user of this data gap. Note that if they wish to automate flights for these assets in the future, they would need to manually collect geo-tagged photos. Do not command the user to do this; leave the prioritization and decision entirely to their discretion.
5. Recommend whether the drone should be dispatched to the available GPS locations.
6. Output your response STRICTLY as a JSON object with two keys:
   - "synthesis_report": A human-readable markdown text detailing your hypotheses, expected outcomes, the skill and search method used, filtering logic, and proposed flight/manual data collection specifications.
   - "proposed_flight_manifest": A machine-readable array of objects. Each object must have "id" (the integer id from the projected list) and "flight_specs" (with approach_altitude_ft, camera_tilt_deg, focus_distance_ft). Only include locations where 'has_gps' is true in this manifest array.

Do not wrap the JSON in Markdown code blocks, just output the raw JSON.

Assistant:`;

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const llmOutput = responseBody.content[0].text.trim();

    let parsedOutput;
    try {
      const cleanedOutput = llmOutput.replace(/^```json\n?/, '').replace(/```$/, '').trim();
      parsedOutput = JSON.parse(cleanedOutput);
    } catch (err) {
      console.error('Failed to parse LLM JSON:', err, 'Raw Output:', llmOutput);
      parsedOutput = {
        synthesis_report: llmOutput,
        proposed_flight_manifest: []
      };
    }

    if (parsedOutput && parsedOutput.proposed_flight_manifest) {
      parsedOutput.proposed_flight_manifest = parsedOutput.proposed_flight_manifest.map(item => {
        const loc = locations[item.id];
        if (!loc) return null;
        return {
          location_id: loc.location_id,
          gps: {
            lat: loc.lat,
            lon: loc.lon
          },
          flight_specs: item.flight_specs
        };
      }).filter(Boolean);
    }

    if (parsedOutput && typeof parsedOutput === 'object') {
       parsedOutput.semantic_search_used = true;
    }

    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, parsedOutput);
  } catch (error) {
    console.error('Identify Drone Targets error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Internal error identifying drone targets: ' + error.message,
    });
  }
}

exports.handler = async (event) => {
  console.log('Maxwell observations event:', JSON.stringify(event, null, 2));

  const actionGroup = event.actionGroup || 'GetEntityObservations';
  const apiPath = event.apiPath || '/getEntityObservations';
  const httpMethod = event.httpMethod || 'GET';

  const sessionAttributes = event.sessionAttributes || {};
  const organizationId = sessionAttributes.organization_id || sessionAttributes.organizationId;

  const params = parseActionGroupParams(event);

  if (apiPath === '/identifyDroneMonitoringTargets') {
    return await handleIdentifyDroneMonitoringTargets(params, organizationId, buildActionGroupResponse, actionGroup, apiPath, httpMethod);
  }

  let entityId = sessionAttributes.entityId || params.entityId;
  let entityType = sessionAttributes.entityType || params.entityType;

  if (entityId === '{session.entityId}' || entityId === '{session.entity_id}') {
    entityId = sessionAttributes.entityId;
  }
  if (entityType === '{session.entityType}' || entityType === '{session.entity_type}') {
    entityType = sessionAttributes.entityType;
  }

  const { dateFrom, dateTo } = params;

  if (!entityId) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing required parameter: entityId',
    });
  }
  if (!entityType) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing required parameter: entityType',
    });
  }
  const validEntityTypes = ['tool', 'part', 'action'];
  if (!validEntityTypes.includes(entityType)) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: `Invalid entityType. Must be one of: ${validEntityTypes.join(', ')}`,
    });
  }
  if (!organizationId) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing organization context in session attributes',
    });
  }

  try {
    const dateFilters = [];
    if (dateFrom) {
      dateFilters.push(`s.captured_at >= '${escapeLiteral(dateFrom)}'::timestamptz`);
    }
    if (dateTo) {
      dateFilters.push(`s.captured_at <= '${escapeLiteral(dateTo)}'::timestamptz + interval '1 day'`);
    }
    const dateFilterClause = dateFilters.length > 0 ? `AND ${dateFilters.join(' AND ')}` : '';

    const sql = `
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS json_agg
      FROM (
        SELECT
          s.state_text          AS observation_text,
          s.captured_at         AS observed_at,
          COALESCE(om.full_name, s.captured_by::text) AS observed_by_name,
          COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'photo_url',         sp.photo_url,
                  'photo_description', sp.photo_description,
                  'transcription', (
                    SELECT s_trans.state_text 
                    FROM state_links sl_trans
                    JOIN states s_trans ON sl_trans.state_id = s_trans.id
                    WHERE sl_trans.entity_type = 'state_photo' 
                      AND sl_trans.entity_id = sp.id 
                      AND s_trans.state_text LIKE '[photo_analysis]%'
                    LIMIT 1
                  )
                ) ORDER BY sp.photo_order
              )
              FROM state_photos sp
              WHERE sp.state_id = s.id
            ),
            '[]'::json
          ) AS photos,
          COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'metric_name', m.name,
                  'value',       ms.value,
                  'unit',        m.unit
                )
              )
              FROM metric_snapshots ms
              JOIN metrics m ON ms.metric_id = m.metric_id
              WHERE ms.state_id = s.id
            ),
            '[]'::json
          ) AS metrics
        FROM states s
        JOIN state_links sl ON sl.state_id = s.id
        LEFT JOIN organization_members om
          ON s.captured_by::text = om.cognito_user_id::text
          AND s.organization_id = om.organization_id
        WHERE sl.entity_type          = '${escapeLiteral(entityType)}'
          AND sl.entity_id::text      = '${escapeLiteral(entityId)}'
          AND s.organization_id::text = '${escapeLiteral(organizationId)}'
          ${dateFilterClause}
        ORDER BY s.captured_at DESC
      ) t;
    `;

    const rows = await queryJSON(sql);
    const observations = rows?.[0]?.json_agg || [];

    const message =
      observations.length > 0
        ? `Found ${observations.length} observation${observations.length === 1 ? '' : 's'}`
        : 'No observations have been recorded for this entity';

    const instructions = observations.length > 0
      ? 'Analyze the observations chronologically. Cite dates and observer names. When observations include photos, display them inline using markdown: ![photo_description](photo_url). Place photos near the relevant text as evidence. When metrics are present, include them in your analysis. Present patterns objectively without judgment.'
      : 'No observations exist for this entity. Inform the user clearly and suggest they record observations to build a history.';

    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, {
      observations,
      message,
      instructions,
    });
  } catch (error) {
    console.error('Maxwell observations error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Internal error retrieving observations',
    });
  }
};
