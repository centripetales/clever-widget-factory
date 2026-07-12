const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');
const { generateEmbeddingV1 } = require('./shared/embeddings');

const VALID_ENTITY_TYPES = [
  'part', 'tool', 'action', 'issue', 'policy',
  'financial_record', 'state', 'action_existing_state', 'state_space_model'
];

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

/**
 * Map entity type to its relevant date column for filtering.
 */
function getDateColumn(entityType) {
  switch (entityType) {
    case 'action': return 'a.created_at';
    case 'financial_record': return 'fr.transaction_date';
    case 'part': return 'p.created_at';
    case 'tool': return 't.created_at';
    case 'issue': return 'i.created_at';
    case 'policy': return 'po.created_at';
    case 'state':
    case 'action_existing_state':
    case 'state_space_model':
      return 'ue.created_at';
    default: return null;
  }
}

/**
 * Build a per-type subquery for the UNION ALL.
 */
function buildSubquery(entityType, embeddingVector, safeOrgId, perTypeLimit, dateFrom, dateTo) {
  const baseSelect = `
  ue.entity_type,
  ue.entity_id,
  ue.embedding_source,
  1 - (ue.embedding <=> ${embeddingVector}) AS similarity`;

  const baseWhere = `ue.entity_type = '${escapeLiteral(entityType)}'
    AND ue.organization_id = '${safeOrgId}'::uuid`;

  const orderLimit = `ORDER BY similarity DESC
  LIMIT ${perTypeLimit}`;

  // Build date filter based on entity type's relevant date column
  let dateFilter = '';
  if (dateFrom || dateTo) {
    const dateCol = getDateColumn(entityType);
    if (dateCol) {
      if (dateFrom) dateFilter += ` AND ${dateCol} >= '${escapeLiteral(dateFrom)}'::timestamptz`;
      if (dateTo) dateFilter += ` AND ${dateCol} <= '${escapeLiteral(dateTo)}'::timestamptz + interval '1 day'`;
    }
  }

  switch (entityType) {
    case 'part':
      return `(SELECT ${baseSelect},
  json_build_object(
    'name', p.name,
    'description', p.description,
    'category', p.category,
    'storage_location', p.storage_location,
    'current_quantity', p.current_quantity,
    'unit', p.unit,
    'cost_per_unit', p.cost_per_unit,
    'sellable', p.sellable
  ) AS details
FROM unified_embeddings ue
JOIN parts p ON ue.entity_id = p.id AND p.organization_id = '${safeOrgId}'::uuid
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;

    case 'tool':
      return `(SELECT ${baseSelect},
  json_build_object(
    'name', t.name,
    'description', t.description,
    'category', t.category,
    'storage_location', t.storage_location,
    'status', t.status
  ) AS details
FROM unified_embeddings ue
JOIN tools t ON ue.entity_id = t.id AND t.organization_id = '${safeOrgId}'::uuid
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;

    case 'action':
      return `(SELECT ${baseSelect},
  json_build_object(
    'title', a.title,
    'description', a.description,
    'status', a.status,
    'created_at', a.created_at,
    'completed_at', a.completed_at
  ) AS details
FROM unified_embeddings ue
JOIN actions a ON ue.entity_id = a.id AND a.organization_id = '${safeOrgId}'::uuid
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;

    case 'issue':
      return `(SELECT ${baseSelect},
  json_build_object(
    'description', i.description,
    'issue_type', i.issue_type,
    'status', i.status,
    'resolution_notes', i.resolution_notes
  ) AS details
FROM unified_embeddings ue
JOIN issues i ON ue.entity_id = i.id AND i.organization_id = '${safeOrgId}'::uuid
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;

    case 'policy':
      return `(SELECT ${baseSelect},
  json_build_object(
    'title', po.title,
    'description_text', po.description_text,
    'status', po.status,
    'effective_from', po.effective_from
  ) AS details
FROM unified_embeddings ue
JOIN policy po ON ue.entity_id = po.id
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;

    case 'financial_record':
      return `(SELECT ${baseSelect},
  json_build_object(
    'description', s.state_text,
    'amount', fr.amount,
    'transaction_date', fr.transaction_date,
    'payment_method', fr.payment_method,
    'created_by_name', COALESCE(om.full_name, 'Unknown')
  ) AS details
FROM unified_embeddings ue
JOIN financial_records fr ON ue.entity_id = fr.id AND fr.organization_id = '${safeOrgId}'::uuid
JOIN state_links sl ON sl.entity_id = fr.id AND sl.entity_type = 'financial_record'
JOIN states s ON s.id = sl.state_id
LEFT JOIN organization_members om ON fr.created_by::text = om.cognito_user_id::text AND om.organization_id = fr.organization_id
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;

    // state, action_existing_state, state_space_model — embedding-only types
    default:
      return `(SELECT ${baseSelect},
  json_build_object('description', ue.embedding_source) AS details
FROM unified_embeddings ue
WHERE ${baseWhere}${dateFilter}
${orderLimit})`;
  }
}


exports.handler = async (event) => {
  console.log('Maxwell unified search event:', JSON.stringify(event, null, 2));

  const actionGroup = event.actionGroup || 'UnifiedSearch';
  const apiPath = event.apiPath || '/unifiedSearch';
  const httpMethod = event.httpMethod || 'POST';

  // Extract org context from session attributes (forwarded by cwf-maxwell-chat)
  const sessionAttributes = event.sessionAttributes || {};
  const organizationId = sessionAttributes.organization_id || sessionAttributes.organizationId;

  // Parse parameters from Bedrock Action Group format
  const params = parseActionGroupParams(event);
  const { query, entity_types, per_type_limit, date_from, date_to } = params;

  // Validate required parameters
  if (!query || query.trim() === '') {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing required parameter: query',
    });
  }
  if (!organizationId) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'Missing organization context in session attributes',
    });
  }

  // Parse entity_types filter
  let activeTypes = VALID_ENTITY_TYPES;
  if (entity_types && entity_types.trim() !== '') {
    const requested = entity_types.split(',').map((t) => t.trim()).filter(Boolean);
    const filtered = requested.filter((t) => VALID_ENTITY_TYPES.includes(t));
    if (filtered.length > 0) {
      activeTypes = filtered;
    }
  }

  const perTypeLimit = parseInt(per_type_limit, 10) || 3;
  const safeOrgId = escapeLiteral(organizationId);

  let client;
  try {
    // Generate embedding for the query
    let embedding;
    try {
      embedding = await generateEmbeddingV1(query);
    } catch (embeddingError) {
      console.error('Embedding generation error:', embeddingError);
      return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
        error: 'Failed to generate embedding for the provided query',
      });
    }

    const embeddingVector = `'[${embedding.join(',')}]'::vector`;

    // Build UNION ALL SQL — one subquery per active entity type
    const subqueries = activeTypes.map((type) =>
      buildSubquery(type, embeddingVector, safeOrgId, perTypeLimit, date_from, date_to)
    );

    const sql = `SELECT * FROM (
${subqueries.join('\nUNION ALL\n')}
) combined
ORDER BY similarity DESC`;

    client = await getDbClient();
    const result = await client.query(sql);
    const rows = result.rows;

    // Format results
    const results = rows.map((row) => ({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      embedding_source: row.embedding_source,
      similarity: parseFloat(row.similarity),
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
    }));

    // Compute result_counts
    const resultCounts = {};
    for (const r of results) {
      resultCounts[r.entity_type] = (resultCounts[r.entity_type] || 0) + 1;
    }

    const message =
      results.length > 0
        ? `Found ${results.length} result${results.length === 1 ? '' : 's'} across ${Object.keys(resultCounts).length} entity type${Object.keys(resultCounts).length === 1 ? '' : 's'}`
        : 'No matching results found for this query';

    const instructions = results.length > 0
      ? `You are answering a question using cross-domain search results from the organization's knowledge base. Results include multiple entity types — group them by type when presenting to the user.

ENTITY TYPE PRESENTATION:
- For financial_record results: Show amounts in ₱ (Philippine Peso). AMOUNT SIGN CONVENTION: Positive amounts are EXPENSES (money going out). Negative amounts are INCOME/SALES (money coming in). Calculate totals/averages when multiple financial records are returned.
- For part results: Mention name, quantity, storage location, and cost when relevant.
- For tool results: Mention name, status, and storage location.
- For action results: Mention title, status, and completion date.
- For issue results: Mention description, type, status, and resolution.
- For policy results: Mention title and description.
- For state/observation results: Present the observation text with context.

Always mention which entity types contributed to your answer. Use ONLY the data provided.
IMPORTANT: As the LAST line of your answer, include a <referenced_records> tag containing a JSON array of entity_id values for ONLY the records you actually referenced. Example: <referenced_records>["id1","id2"]</referenced_records>`
      : 'No matching results were found. Inform the user and suggest they try different search terms.';

    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, {
      results,
      result_counts: resultCounts,
      message,
      instructions,
    });
  } catch (error) {
    console.error('Maxwell unified search error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Internal error performing unified search',
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};

// Export internals for testing
exports.parseActionGroupParams = parseActionGroupParams;
exports.buildActionGroupResponse = buildActionGroupResponse;
exports.buildSubquery = buildSubquery;
exports.VALID_ENTITY_TYPES = VALID_ENTITY_TYPES;
