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

/**
 * Parse parameters from Bedrock Action Group event.
 * Bedrock passes parameters as an array: [{ name, type, value }, ...]
 */
function parseActionGroupParams(event) {
  const params = {};
  const rawParams = event.parameters || [];
  for (const p of rawParams) {
    params[p.name] = p.value;
  }
  return params;
}

/**
 * Build the Bedrock Action Group response envelope.
 */
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

async function handleAnalyzeInterventions(params, organizationId, buildActionGroupResponse, actionGroup, apiPath, httpMethod) {
  const userDirective = params.user_directive;
  
  if (!userDirective) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing required parameter: user_directive',
    });
  }

  try {
    const sql = `
      SELECT 
        s.id as location_id,
        s.state_text as description,
        s.captured_at,
        sp.photo_description as last_observation,
        pme.gps_latitude as lat,
        pme.gps_longitude as lon,
        (SELECT content FROM entropy_perspectives ep JOIN state_perspectives s_p ON ep.id = s_p.id WHERE s_p.state_id = s.id LIMIT 1) as entropy_context
      FROM states s
      JOIN state_photos sp ON s.id = sp.state_id
      JOIN photo_metadata_extractions pme ON sp.photo_url = pme.photo_url
      WHERE pme.gps_latitude IS NOT NULL
        AND s.organization_id = '${escapeLiteral(organizationId)}'
      ORDER BY s.captured_at DESC
      LIMIT 20;
    `;

    const locations = await queryJSON(sql);

    const prompt = `Human: You are Maxwell, the Decision Support Synthesis Engine for Clever Widget Factory.
The user states: "${userDirective}"

The current system time is: ${new Date().toISOString()}

Here are the known physical locations in our GPS registry and their last known states (derived from our reality stratification pipeline). Pay careful attention to the "captured_at" timestamp.

${JSON.stringify(locations, null, 2)}

Your task:
1. Filter the locations to ONLY those that match the user's intent.
2. Detail the exact physical execution instructions the drone requires to fulfill this request at each valid location (e.g., flight altitude, camera angle).
3. Recommend whether the drone should be dispatched to these GPS coordinates.
4. Output your response STRICTLY as a JSON object with two keys:
   - "synthesis_report": A human-readable markdown text detailing your hypotheses, expected outcomes, filtering logic, and proposed flight specifications.
   - "proposed_flight_manifest": A machine-readable array of objects. Each object must have "location_id", "gps" (with lat and lon), and "flight_specs" (with approach_altitude_ft, camera_tilt_deg, focus_distance_ft).

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
      // Remove possible markdown wrapping if the LLM ignores instructions
      const cleanedOutput = llmOutput.replace(/^```json\n?/, '').replace(/```$/, '').trim();
      parsedOutput = JSON.parse(cleanedOutput);
    } catch (err) {
      console.error('Failed to parse LLM JSON:', err, 'Raw Output:', llmOutput);
      parsedOutput = {
        synthesis_report: llmOutput,
        proposed_flight_manifest: []
      };
    }

    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, parsedOutput);
  } catch (error) {
    console.error('Analyze Interventions error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Internal error analyzing interventions: ' + error.message,
    });
  }
}


exports.handler = async (event) => {
  console.log('Maxwell observations event:', JSON.stringify(event, null, 2));

  const actionGroup = event.actionGroup || 'GetEntityObservations';
  const apiPath = event.apiPath || '/getEntityObservations';
  const httpMethod = event.httpMethod || 'GET';

  // Extract org context from session attributes (forwarded by cwf-maxwell-chat)
  const sessionAttributes = event.sessionAttributes || {};
  const organizationId = sessionAttributes.organization_id || sessionAttributes.organizationId;

  // Parse parameters from Bedrock Action Group format
  const params = parseActionGroupParams(event);

  if (apiPath === '/analyzeInterventions') {
    return await handleAnalyzeInterventions(params, organizationId, buildActionGroupResponse, actionGroup, apiPath, httpMethod);
  }
  
  // Try to get entityId and entityType from session attributes first, then fall back to parameters
  // This handles the case where the Agent passes literal "{session.entityId}" strings
  let entityId = sessionAttributes.entityId || params.entityId;
  let entityType = sessionAttributes.entityType || params.entityType;
  
  // If we got literal placeholder strings, use session attributes instead
  if (entityId === '{session.entityId}' || entityId === '{session.entity_id}') {
    entityId = sessionAttributes.entityId;
  }
  if (entityType === '{session.entityType}' || entityType === '{session.entity_type}') {
    entityType = sessionAttributes.entityType;
  }
  
  const { dateFrom, dateTo } = params;

  // Validate required parameters
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
    // Build optional date range filters
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

    // Self-contained instructions tell the agent how to present these results.
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
