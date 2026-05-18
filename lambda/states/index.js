const { getAuthorizerContext, buildOrganizationFilter } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');
const { getDbClient } = require('/opt/nodejs/db');
const { formatSqlValue } = require('/opt/nodejs/sqlUtils');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { composeStateEmbeddingSource } = require('/opt/nodejs/embedding-composition');

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

/**
 * Resolve state composition data and queue embedding generation via SQS.
 * Uses its own DB client from the pool since this runs after the main transaction's client is released.
 */
async function resolveAndQueueEmbedding(stateId, organizationId) {
  const client = await getDbClient();
  try {
    const result = await client.query(`
      SELECT
        s.state_text,
        COALESCE(
          array_agg(DISTINCT
            CASE sl.entity_type
              WHEN 'part' THEN p.name
              WHEN 'tool' THEN t.name
              WHEN 'action' THEN a.description
            END
          ) FILTER (WHERE sl.id IS NOT NULL),
          ARRAY[]::text[]
        ) AS entity_names,
        COALESCE(
          array_agg(DISTINCT sp.photo_description)
          FILTER (WHERE sp.photo_description IS NOT NULL AND sp.photo_description != ''),
          ARRAY[]::text[]
        ) AS photo_descriptions,
        COALESCE(
          json_agg(
            json_build_object('display_name', m.name, 'value', ms.value, 'unit', m.unit)
          ) FILTER (WHERE ms.snapshot_id IS NOT NULL),
          '[]'::json
        ) AS metrics
      FROM states s
      LEFT JOIN state_links sl ON sl.state_id = s.id
      LEFT JOIN parts p ON sl.entity_type = 'part' AND sl.entity_id = p.id
      LEFT JOIN tools t ON sl.entity_type = 'tool' AND sl.entity_id = t.id
      LEFT JOIN actions a ON sl.entity_type = 'action' AND sl.entity_id = a.id
      LEFT JOIN state_photos sp ON sp.state_id = s.id
      LEFT JOIN metric_snapshots ms ON ms.state_id = s.id
      LEFT JOIN metrics m ON ms.metric_id = m.metric_id
      WHERE s.id = $1
      GROUP BY s.id, s.state_text
    `, [stateId]);

    if (result.rows.length === 0) {
      console.warn('State not found for embedding resolution:', stateId);
      return;
    }

    const row = result.rows[0];
    const embeddingSource = composeStateEmbeddingSource({
      entity_names: row.entity_names,
      state_text: row.state_text,
      photo_descriptions: row.photo_descriptions,
      metrics: row.metrics
    });

    if (!embeddingSource || !embeddingSource.trim()) {
      console.log('Empty embedding source for state', stateId, '— skipping SQS send');
      return;
    }

    await sqs.send(new SendMessageCommand({
      QueueUrl: EMBEDDINGS_QUEUE_URL,
      MessageBody: JSON.stringify({
        entity_type: 'state',
        entity_id: stateId,
        embedding_source: embeddingSource,
        organization_id: organizationId
      })
    }));

    console.log('Queued embedding for state', stateId);
  } finally {
    client.release();
  }
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
  const { httpMethod, pathParameters } = event;

  if (httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const authContext = getAuthorizerContext(event);
  const organizationId = authContext.organization_id;

  if (!organizationId) {
    console.error('❌ ERROR: organization_id missing from authorizer context');
    return errorResponse(500, 'Server configuration error', headers);
  }

  try {
    switch (httpMethod) {
      case 'GET':
        return pathParameters?.id 
          ? await getState(pathParameters.id, authContext, headers)
          : await listStates(event, authContext, headers);
      case 'POST':
        return await createState(event, authContext, headers);
      case 'PUT':
        return await updateState(event, pathParameters?.id, authContext, headers);
      case 'DELETE':
        return await deleteState(pathParameters?.id, authContext, headers);
      default:
        return errorResponse(405, 'Method not allowed', headers);
    }
  } catch (error) {
    console.error('❌ ERROR:', error);
    return errorResponse(500, error.message, headers);
  }
};

async function listStates(event, authContext, headers) {
  const client = await getDbClient();
  
  try {
    const queryParams = event.queryStringParameters || {};
    const { entity_type, entity_id } = queryParams;
    
    const orgFilter = buildOrganizationFilter(authContext, 's');
    console.log('🔍 listStates orgFilter:', JSON.stringify(orgFilter));
    console.log('🔍 authContext:', JSON.stringify(authContext));
    console.log('🔍 queryParams:', JSON.stringify(queryParams));
    
    const whereClause = orgFilter.condition;
    
    // Add entity filtering if provided
    let entityFilter = '';
    if (entity_type && entity_id) {
      entityFilter = ` AND sl.entity_type = ${formatSqlValue(entity_type)} AND sl.entity_id = ${formatSqlValue(entity_id)}::uuid`;
    }
    
    const sql = `
      SELECT 
        s.id,
        s.organization_id,
        s.state_text as observation_text,
        s.captured_by,
        s.captured_at,
        s.created_at,
        s.updated_at,
        om.full_name as captured_by_name,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', sp.id,
              'photo_url', sp.photo_url,
              'photo_description', sp.photo_description,
              'photo_order', sp.photo_order
            ) ORDER BY sp.photo_order
          ) FROM state_photos sp WHERE sp.state_id = s.id),
          '[]'
        ) as photos,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', sl2.id,
              'entity_type', sl2.entity_type,
              'entity_id', sl2.entity_id
            )
          ) FROM state_links sl2 WHERE sl2.state_id = s.id),
          '[]'
        ) as links
      FROM states s
      LEFT JOIN organization_members om ON s.captured_by = om.user_id
      LEFT JOIN state_links sl ON s.id = sl.state_id
      WHERE ${whereClause}${entityFilter}
        AND (s.state_text IS NULL OR s.state_text NOT LIKE '[learning_objective]%')
        AND (s.state_text IS NULL OR s.state_text NOT LIKE '[capability_profile]%')
      GROUP BY s.id, s.organization_id, s.state_text, s.captured_by, s.captured_at, s.created_at, s.updated_at, om.full_name
      ORDER BY s.captured_at DESC
    `;

    console.log('🔍 Full SQL:', sql);
    const result = await client.query(sql);
    return successResponse(result.rows, headers);
  } finally {
    client.release();
  }
}

async function getState(id, authContext, headers) {
  const client = await getDbClient();
  
  try {
    const orgFilter = buildOrganizationFilter(authContext, 's');
    console.log('🔍 orgFilter:', JSON.stringify(orgFilter));
    console.log('🔍 id:', id, 'type:', typeof id);
    
    const sql = `
      SELECT 
        s.id,
        s.organization_id,
        s.state_text as observation_text,
        s.captured_by,
        s.captured_at,
        s.created_at,
        s.updated_at,
        om.full_name as captured_by_name,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', sp.id,
              'photo_url', sp.photo_url,
              'photo_description', sp.photo_description,
              'photo_order', sp.photo_order
            ) ORDER BY sp.photo_order
          ) FROM state_photos sp WHERE sp.state_id = s.id),
          '[]'
        ) as photos,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', sl.id,
              'entity_type', sl.entity_type,
              'entity_id', sl.entity_id
            )
          ) FROM state_links sl WHERE sl.state_id = s.id),
          '[]'
        ) as links
      FROM states s
      LEFT JOIN organization_members om ON s.captured_by = om.user_id
      WHERE s.id = ${formatSqlValue(id)}::uuid AND ${orgFilter.condition}
      GROUP BY s.id, s.organization_id, s.state_text, s.captured_by, s.captured_at, s.created_at, s.updated_at, om.full_name
    `;

    console.log('🔍 Full SQL:', sql);
    const result = await client.query(sql);
    
    if (result.rows.length === 0) {
      return errorResponse(404, 'State not found', headers);
    }
    
    return successResponse(result.rows[0], headers);
  } finally {
    client.release();
  }
}

async function createState(event, authContext, headers) {
  const body = JSON.parse(event.body || '{}');
  const { state_text, captured_at, photos = [], links = [] } = body;
  const organizationId = authContext.organization_id;
  const userId = authContext.user_id;

  // Note: Validation is handled on frontend - observations can have text, photos, or metrics
  // Metrics are saved separately via snapshots endpoint after state creation

  const client = await getDbClient();
  
  try {
    await client.query('BEGIN');

    const stateSql = `
      INSERT INTO states (
        organization_id,
        state_text,
        captured_by,
        captured_at
      ) VALUES (
        ${formatSqlValue(organizationId)},
        ${formatSqlValue(state_text)},
        ${formatSqlValue(userId)},
        ${formatSqlValue(captured_at || new Date().toISOString())}
      )
      RETURNING *
    `;
    
    const stateResult = await client.query(stateSql);
    const state = stateResult.rows[0];

    if (photos.length > 0) {
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        await client.query(`
          INSERT INTO state_photos (
            state_id,
            photo_url,
            photo_description,
            photo_order
          ) VALUES (
            ${formatSqlValue(state.id)},
            ${formatSqlValue(photo.photo_url)},
            ${formatSqlValue(photo.photo_description)},
            ${formatSqlValue(photo.photo_order ?? i)}
          )
        `);
      }
    }

    if (links.length > 0) {
      for (const link of links) {
        await client.query(`
          INSERT INTO state_links (
            state_id,
            entity_type,
            entity_id
          ) VALUES (
            ${formatSqlValue(state.id)},
            ${formatSqlValue(link.entity_type)},
            ${formatSqlValue(link.entity_id)}
          )
        `);
      }
    }

    await client.query('COMMIT');

    // Explicitly await queueing to prevent AWS Lambda environment freeze
    try {
      await resolveAndQueueEmbedding(state.id, organizationId);
      console.log('Successfully queued state embedding for state', state.id);
    } catch (err) {
      console.error('Failed to queue state embedding:', err);
    }

    return await getState(state.id, authContext, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateState(event, id, authContext, headers) {
  const body = JSON.parse(event.body || '{}');
  const { state_text, captured_at, photos, links } = body;
  const organizationId = authContext.organization_id;
  const userId = authContext.user_id;

  const client = await getDbClient();
  
  try {
    await client.query('BEGIN');

    // Check permissions before update
    const permissionCheckSql = `
      SELECT captured_by, organization_id
      FROM states
      WHERE id = ${formatSqlValue(id)}::uuid
    `;
    const permissionResult = await client.query(permissionCheckSql);
    
    if (permissionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse(404, 'State not found', headers);
    }
    
    const state = permissionResult.rows[0];
    
    // Check if user is creator or has admin permission
    const isCreator = state.captured_by === userId;
    const isAdmin = authContext.permissions?.includes('data:write:all');
    
    if (!isCreator && !isAdmin) {
      await client.query('ROLLBACK');
      return errorResponse(403, 'You do not have permission to edit this state', headers);
    }
    
    // Verify organization match
    if (state.organization_id !== organizationId) {
      await client.query('ROLLBACK');
      return errorResponse(403, 'State does not belong to your organization', headers);
    }

    // Note: Validation is handled on frontend - observations can have text, photos, or metrics
    // Metrics are saved separately via snapshots endpoint

    const updates = [];
    if (state_text !== undefined) updates.push(`state_text = ${formatSqlValue(state_text)}`);
    if (captured_at !== undefined) updates.push(`captured_at = ${formatSqlValue(captured_at)}`);
    
    if (updates.length > 0) {
      const sql = `
        UPDATE states
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = ${formatSqlValue(id)}::uuid AND organization_id = ${formatSqlValue(organizationId)}::uuid
        RETURNING *
      `;
      
      const result = await client.query(sql);
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return errorResponse(404, 'State not found', headers);
      }
    }

    if (photos !== undefined) {
      await client.query(`DELETE FROM state_photos WHERE state_id = ${formatSqlValue(id)}`);
      
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        await client.query(`
          INSERT INTO state_photos (
            state_id,
            photo_url,
            photo_description,
            photo_order
          ) VALUES (
            ${formatSqlValue(id)},
            ${formatSqlValue(photo.photo_url)},
            ${formatSqlValue(photo.photo_description)},
            ${formatSqlValue(photo.photo_order ?? i)}
          )
        `);
      }
    }

    if (links !== undefined) {
      await client.query(`DELETE FROM state_links WHERE state_id = ${formatSqlValue(id)}`);
      
      for (const link of links) {
        await client.query(`
          INSERT INTO state_links (
            state_id,
            entity_type,
            entity_id
          ) VALUES (
            ${formatSqlValue(id)},
            ${formatSqlValue(link.entity_type)},
            ${formatSqlValue(link.entity_id)}
          )
        `);
      }
    }

    await client.query('COMMIT');

    // Explicitly await queueing to prevent AWS Lambda environment freeze
    try {
      await resolveAndQueueEmbedding(id, organizationId);
      console.log('Successfully queued state embedding for state', id);
    } catch (err) {
      console.error('Failed to queue state embedding:', err);
    }

    return await getState(id, authContext, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteState(id, authContext, headers) {
  const organizationId = authContext.organization_id;
  const client = await getDbClient();
  
  try {
    const sql = `
      DELETE FROM states
      WHERE id = ${formatSqlValue(id)}::uuid AND organization_id = ${formatSqlValue(organizationId)}::uuid
      RETURNING id
    `;
    
    const result = await client.query(sql);
    
    if (result.rows.length === 0) {
      return errorResponse(404, 'State not found', headers);
    }
    
    return successResponse({ message: 'State deleted', id }, headers);
  } finally {
    client.release();
  }
}
