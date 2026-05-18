const { getAuthorizerContext, buildOrganizationFilter, hasPermission } = require('/opt/nodejs/authorizerContext');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');

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
                  'photo_description', sp.photo_description
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
