const { getAuthorizerContext, buildOrganizationFilter } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');
const { getDbClient } = require('/opt/nodejs/db');
const { formatSqlValue } = require('/opt/nodejs/sqlUtils');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { composeStateEmbeddingSource } = require('/opt/nodejs/embedding-composition');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { broadcastInvalidation } = require('/opt/nodejs/broadcastInvalidation');
const crypto = require('crypto');

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';
const PERSPECTIVES_QUEUE_URL = process.env.PERSPECTIVES_QUEUE_URL;
if (!PERSPECTIVES_QUEUE_URL) throw new Error('Missing required environment variable: PERSPECTIVES_QUEUE_URL');

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

/**
 * Helper function to handle observation (state) sharing updates.
 */
async function handleSharingUpdate(dbClient, stateId, isShared, organizationId) {
  const targetRisk = isShared ? 0.0 : 0.8;

  // 1. Sets/updates state_risk_profiles aggregate_risk to 0.0 (shared) or 0.8 (private) for stateId.
  await dbClient.query(`
    INSERT INTO state_risk_profiles (state_id, aggregate_risk)
    VALUES ($1, $2)
    ON CONFLICT (state_id)
    DO UPDATE SET aggregate_risk = $2, updated_at = NOW()
  `, [stateId, targetRisk]);

  // 2. Updates target risk profiles for all state_photos attached to the state in photo_metadata_extractions.
  const photosRes = await dbClient.query(`
    SELECT photo_url FROM state_photos WHERE state_id = $1
  `, [stateId]);

  if (photosRes.rows && photosRes.rows.length > 0) {
    for (const row of photosRes.rows) {
      await dbClient.query(`
        INSERT INTO photo_metadata_extractions (photo_url, aggregate_risk)
        VALUES ($1, $2)
        ON CONFLICT (photo_url)
        DO UPDATE SET aggregate_risk = $2, updated_at = NOW()
      `, [row.photo_url, targetRisk]);
    }
  }

  // 3. Adds a pending entry to rsp_outbox if sharing is enabled (isShared === true).
  if (isShared) {
    const idempotencyKey = crypto.createHash('sha256').update(stateId + '-' + Date.now()).digest('hex');
    await dbClient.query(`
      INSERT INTO rsp_outbox (state_id, idempotency_key, status, triggered_at)
      VALUES ($1, $2, 'PENDING', NOW())
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [stateId, idempotencyKey]);
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
    const { entity_type, entity_id, limit: limitParam } = queryParams;
    
    let limit = 200;
    if (limitParam) {
      const parsedLimit = parseInt(limitParam, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = Math.min(parsedLimit, 1000);
      }
    }
    
    const orgFilter = buildOrganizationFilter(authContext, 's');

    
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
          (SELECT srp.aggregate_risk = 0.0 FROM state_risk_profiles srp WHERE srp.state_id = s.id),
          false
        ) as shared_with_partners,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', sp.id,
              'photo_url', sp.photo_url,
              'photo_description', sp.photo_description,
              'photo_order', sp.photo_order,
              'transcription', (
                SELECT s_trans.state_text 
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'transcription_created_at', (
                SELECT s_trans.created_at 
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'model_id', (
                SELECT COALESCE(pap.model_id, lgc.model_id)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'system_prompt', (
                SELECT COALESCE(pap.system_prompt, lgc.system_prompt)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              )
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
        ) as links,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'perspective_type', sp.perspective_type,
              'content', COALESCE(c.content, sig.content, e.content),
              'created_at', sp.created_at,
              'model_id', lgc.model_id,
              'system_prompt', lgc.system_prompt
            )
          ) FROM state_perspectives sp
            LEFT JOIN claim_perspectives c ON c.id = sp.id
            LEFT JOIN significance_perspectives sig ON sig.id = sp.id
            LEFT JOIN entropy_perspectives e ON e.id = sp.id
            LEFT JOIN llm_generation_configs lgc ON lgc.id = sp.llm_generation_config_id
          WHERE sp.state_id = s.id),
          '[]'
        ) as perspectives
      FROM states s
      LEFT JOIN organization_members om ON s.captured_by = om.user_id
      LEFT JOIN state_links sl ON s.id = sl.state_id
      WHERE ${whereClause}${entityFilter}
        AND (s.state_text IS NULL OR s.state_text NOT LIKE '[learning_objective]%')
        AND (s.state_text IS NULL OR s.state_text NOT LIKE '[capability_profile]%')
        
      GROUP BY s.id, s.organization_id, s.state_text, s.captured_by, s.captured_at, s.created_at, s.updated_at, om.full_name
      ORDER BY s.captured_at DESC
      LIMIT ${limit}
    `;


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
          (SELECT srp.aggregate_risk = 0.0 FROM state_risk_profiles srp WHERE srp.state_id = s.id),
          false
        ) as shared_with_partners,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', sp.id,
              'photo_url', sp.photo_url,
              'photo_description', sp.photo_description,
              'photo_order', sp.photo_order,
              'transcription', (
                SELECT s_trans.state_text 
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'transcription_created_at', (
                SELECT s_trans.created_at 
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'model_id', (
                SELECT COALESCE(pap.model_id, lgc.model_id)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'system_prompt', (
                SELECT COALESCE(pap.system_prompt, lgc.system_prompt)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              )
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
        ) as links,
        COALESCE(
          (SELECT json_agg(
            json_build_object(
              'perspective_type', sp.perspective_type,
              'content', COALESCE(c.content, sig.content, e.content),
              'created_at', sp.created_at,
              'model_id', lgc.model_id,
              'system_prompt', lgc.system_prompt
            )
          ) FROM state_perspectives sp
            LEFT JOIN claim_perspectives c ON c.id = sp.id
            LEFT JOIN significance_perspectives sig ON sig.id = sp.id
            LEFT JOIN entropy_perspectives e ON e.id = sp.id
            LEFT JOIN llm_generation_configs lgc ON lgc.id = sp.llm_generation_config_id
          WHERE sp.state_id = s.id),
          '[]'
        ) as perspectives
      FROM states s
      LEFT JOIN organization_members om ON s.captured_by = om.user_id
      WHERE s.id = ${formatSqlValue(id)}::uuid AND ${orgFilter.condition}
      GROUP BY s.id, s.organization_id, s.state_text, s.captured_by, s.captured_at, s.created_at, s.updated_at, om.full_name
    `;


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
  const { action, state_text, captured_at, photos = [], links = [], shared_with_partners } = body;
  const organizationId = authContext.organization_id;
  const userId = authContext.user_id;

  if (action === 'analyze_photo') {
    return await analyzePhoto(body, authContext, headers);
  }

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
    const insertedPhotos = [];

    if (photos.length > 0) {
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        const photoResult = await client.query(`
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
          ) RETURNING id
        `);
        insertedPhotos.push({
          id: photoResult.rows[0].id,
          photo_url: photo.photo_url
        });
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

    const hasActionLink = links.some(link => link.entity_type === 'action');
    const isNarrativeState = state_text === 'Shared narrative and impact overview for action';
    const canBeShared = !hasActionLink || isNarrativeState;
    const actualSharedWithPartners = canBeShared ? (shared_with_partners === true || shared_with_partners === 'true') : false;

    await handleSharingUpdate(client, state.id, actualSharedWithPartners, organizationId);

    await client.query('COMMIT');

    // Broadcast cache invalidation
    try {
      await broadcastInvalidation({
        entityType: 'state',
        entityId: state.id,
        mutationType: 'created',
        organizationId,
        excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
      });
    } catch (err) {
      console.error('Failed to broadcast cache invalidation:', err);
    }

    try {
      const pClient = await getDbClient();
      await pClient.query('INSERT INTO pending_perspectives (state_id) VALUES ($1)', [state.id]);
      pClient.release();
      await sqs.send(new SendMessageCommand({
        QueueUrl: PERSPECTIVES_QUEUE_URL,
        MessageBody: JSON.stringify({ stateId: state.id, organizationId })
      }));
    } catch (pErr) {
      console.error('Failed to queue observation for perspectives:', pErr);
    }

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
  const { state_text, captured_at, photos, links, shared_with_partners } = body;
  const organizationId = authContext.organization_id;
  const userId = authContext.user_id;

  const client = await getDbClient();
  
  try {
    const { action, photo_id, requested_model } = body;

    // Handle custom photo reanalysis request
    if (action === 'reanalyze_photo' && photo_id) {
      console.log(`[Reanalyze] Triggering re-analysis for photo ${photo_id} using model ${requested_model}`);
      
      await client.query('BEGIN');
      
      // 1. Delete existing [photo_analysis] states linked to this photo
      const oldStatesRes = await client.query(`
        SELECT state_id FROM state_links 
        WHERE entity_type = 'state_photo' AND entity_id = $1
      `, [photo_id]);
      const oldStateIds = oldStatesRes.rows.map(r => r.state_id);
      
      if (oldStateIds.length > 0) {
        await client.query(`DELETE FROM state_links WHERE state_id = ANY($1)`, [oldStateIds]);
        await client.query(`DELETE FROM states WHERE id = ANY($1) AND state_text LIKE '[photo_analysis]%'`, [oldStateIds]);
      }
      
      // 2. Set requested_model on the state_photo
      await client.query(`
        UPDATE state_photos 
        SET requested_model = $1 
        WHERE id = $2
      `, [requested_model || 'us.anthropic.claude-sonnet-4-20250514-v1:0', photo_id]);
      
      await client.query('COMMIT');
      
      // 3. Queue SQS perspective run
      try {
        const pClient = await getDbClient();
        await pClient.query('INSERT INTO pending_perspectives (state_id) VALUES ($1)', [id]);
        pClient.release();
        
        await sqs.send(new SendMessageCommand({
          QueueUrl: PERSPECTIVES_QUEUE_URL,
          MessageBody: JSON.stringify({ stateId: id, organizationId })
        }));
        console.log('[Reanalyze] Queued perspective run successfully.');
      } catch (pErr) {
        console.error('[Reanalyze] Failed to queue perspectives:', pErr);
      }
      
      return await getState(id, authContext, headers);
    }

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
      // 1. Fetch existing photos for this state
      const existingPhotosRes = await client.query(`
        SELECT id, photo_url, photo_description, photo_order 
        FROM state_photos 
        WHERE state_id = ${formatSqlValue(id)}::uuid
      `);
      const existingPhotos = existingPhotosRes.rows;
      const existingUrls = existingPhotos.map(p => p.photo_url);
      
      const incomingUrls = photos.map(p => p.photo_url);
      
      // 2. Identify photos to delete (in existing but not in incoming)
      const toDelete = existingPhotos.filter(p => !incomingUrls.includes(p.photo_url));
      if (toDelete.length > 0) {
        const deleteIds = toDelete.map(p => p.id);
        await client.query(`
          DELETE FROM state_photos 
          WHERE id = ANY($1::uuid[])
        `, [deleteIds]);
      }
      
      // 3. Keep track of newly added photo records to trigger analysis
      const newlyAddedPhotos = [];
      
      // 4. Handle incoming photos: insert new ones, update existing ones
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        const existing = existingPhotos.find(p => p.photo_url === photo.photo_url);
        
        if (existing) {
          // Update order and description of existing photo
          await client.query(`
            UPDATE state_photos
            SET 
              photo_description = ${formatSqlValue(photo.photo_description)},
              photo_order = ${formatSqlValue(photo.photo_order ?? i)}
            WHERE id = $1
          `, [existing.id]);
        } else {
          // Insert new photo
          const photoResult = await client.query(`
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
            ) RETURNING id
          `);
          newlyAddedPhotos.push({
            id: photoResult.rows[0].id,
            photo_url: photo.photo_url
          });
        }
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

    if (shared_with_partners !== undefined) {
      let hasActionLink = false;
      if (links !== undefined) {
        hasActionLink = links.some(link => link.entity_type === 'action');
      } else {
        const linksRes = await client.query(`
          SELECT 1 FROM state_links 
          WHERE state_id = $1 AND entity_type = 'action'
          LIMIT 1
        `, [id]);
        hasActionLink = linksRes.rows.length > 0;
      }

      let isNarrativeState = false;
      if (state_text !== undefined) {
        isNarrativeState = state_text === 'Shared narrative and impact overview for action';
      } else {
        const stateRes = await client.query(`
          SELECT state_text FROM states WHERE id = $1
        `, [id]);
        isNarrativeState = stateRes.rows[0]?.state_text === 'Shared narrative and impact overview for action';
      }

      const canBeShared = !hasActionLink || isNarrativeState;
      const actualSharedWithPartners = canBeShared ? (shared_with_partners === true || shared_with_partners === 'true') : false;
      await handleSharingUpdate(client, id, actualSharedWithPartners, organizationId);
    }

    await client.query('COMMIT');

    // Broadcast cache invalidation
    try {
      await broadcastInvalidation({
        entityType: 'state',
        entityId: id,
        mutationType: 'updated',
        organizationId,
        excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
      });
    } catch (err) {
      console.error('Failed to broadcast cache invalidation:', err);
    }

    try {
      const pClient = await getDbClient();
      await pClient.query('INSERT INTO pending_perspectives (state_id) VALUES ($1)', [id]);
      pClient.release();
      await sqs.send(new SendMessageCommand({
        QueueUrl: PERSPECTIVES_QUEUE_URL,
        MessageBody: JSON.stringify({ stateId: id, organizationId })
      }));
    } catch (pErr) {
      console.error('Failed to queue observation for perspectives:', pErr);
    }

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

/**
 * Executes a multimodal vision description pass via AWS Bedrock Nova Lite
 * for the uploaded photos, linking the generated machine observations to standard photos and parameter registries.
 */
async function runPhotoAnalysis(dbClient, organizationId, insertedPhotos) {
  const warnings = [];
  try {
    const paramsResult = await dbClient.query(`
      SELECT id, model_id, system_prompt, inference_config 
      FROM photo_analysis_params 
      WHERE prompt_key = 'photo_analysis'
      LIMIT 1
    `);
    
    if (paramsResult.rows.length === 0) {
      console.warn('No active photo analysis parameters found for prompt key "photo_analysis"');
      return warnings;
    }
    
    const params = paramsResult.rows[0];
    const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

    for (const photo of insertedPhotos) {
      try {
        console.log(`Downloading photo for photo analysis: ${photo.photo_url}`);
        const response = await fetch(photo.photo_url);
        if (!response.ok) {
          throw new Error(`HTTP fetch failed with status: ${response.status} ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Data = buffer.toString('base64');
        
        let format = 'jpeg';
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
          format = 'png';
        } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
          format = 'webp';
        }
        let mediaType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';

        const systemPrompt = params.system_prompt || 'Describe what you see objectively.';
        
        const payload = {
          messages: [
            {
              role: "user",
              content: [
                {
                  image: {
                    format: mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpeg',
                    source: {
                      bytes: base64Data
                    }
                  }
                },
                {
                  text: systemPrompt
                }
              ]
            }
          ],
          system: [
            {
              text: "You are a professional assistant analyzing farmer logs and observations."
            }
          ],
          inferenceConfig: {
            maxTokens: params.inference_config?.max_tokens || 1000,
            temperature: params.inference_config?.temperature || 0.1
          }
        };

        console.log(`Invoking Bedrock Nova Lite (${params.model_id})...`);
        const command = new InvokeModelCommand({
          modelId: params.model_id,
          body: JSON.stringify(payload),
          contentType: 'application/json',
          accept: 'application/json'
        });

        const bedrockResponse = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
        
        const description = responseBody?.output?.message?.content?.[0]?.text;
        if (!description || !description.trim()) {
          throw new Error('Empty transcription returned from model');
        }

        console.log('Transcription retrieved successfully.');

        // Insert machine observations state
        const insertStateSql = `
          INSERT INTO states (organization_id, state_text, captured_by, captured_at)
          VALUES ($1, $2, 'system-nova-lite', NOW())
          RETURNING id
        `;
        const stateRes = await dbClient.query(insertStateSql, [
          organizationId,
          `[photo_analysis] ${description}`
        ]);
        const transStateId = stateRes.rows[0].id;

        // Establish Relational state_links
        await dbClient.query(`
          INSERT INTO state_links (state_id, entity_type, entity_id)
          VALUES ($1, 'state_photo', $2)
        `, [transStateId, photo.id]);

        await dbClient.query(`
          INSERT INTO state_links (state_id, entity_type, entity_id)
          VALUES ($1, 'photo_analysis_param', $2)
        `, [transStateId, params.id]);

        // Queue vector embeddings for this transcription state
        try {
          await resolveAndQueueEmbedding(transStateId, organizationId);
        } catch (queueErr) {
          console.error('Failed SQS queue for transcription state:', queueErr);
        }

      } catch (innerError) {
        console.error(`Error processing photo ${photo.photo_url}:`, innerError);
        warnings.push(`Photo analysis failed for S3 asset: ${innerError.message}`);
      }
    }
  } catch (outerError) {
    console.error('Failed to initialize Bedrock vision parameters or client:', outerError);
    warnings.push(`Bedrock model access failed: ${outerError.message}`);
  }
  return warnings;
}

async function analyzePhoto(body, authContext, headers) {
  const { photo_url, model_id = 'us.amazon.nova-lite-v1:0' } = body;
  if (!photo_url) {
    return errorResponse(400, 'photo_url is required', headers);
  }
  
  const client = await getDbClient();
  try {
    const paramsResult = await client.query(`
      SELECT system_prompt 
      FROM photo_analysis_params 
      WHERE prompt_key = 'photo_analysis'
      LIMIT 1
    `);
    
    let systemPrompt = "Describe the photo objectively in detail, and extract/transcribe any text, numbers, or GUIDs that are visible in the image.";
    if (paramsResult.rows.length > 0 && paramsResult.rows[0].system_prompt) {
      systemPrompt = paramsResult.rows[0].system_prompt;
    }
    
    systemPrompt += "\n\nCRITICAL: If there is any physical label, tag, QR code, or serial number in the photo, you MUST extract it exactly and place it at the very top of your response as: [GUID: <value>]. Example: [GUID: C-14].";
    
    console.log(`[AnalyzePhoto] Fetching photo from URL: ${photo_url}`);
    const fetchResponse = await fetch(photo_url);
    if (!fetchResponse.ok) {
      throw new Error(`Failed to fetch photo from URL: ${fetchResponse.status} ${fetchResponse.statusText}`);
    }
    
    const arrayBuffer = await fetchResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = buffer.toString('base64');
    
    let format = 'jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      format = 'png';
    } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      format = 'webp';
    }
    
    const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });
    
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              image: {
                format: format,
                source: {
                  bytes: base64Data
                }
              }
            },
            {
              text: "Please analyze this image, extract any GUID/tag, and write an objective description."
            }
          ]
        }
      ],
      system: [
        {
          text: systemPrompt
        }
      ],
      inferenceConfig: {
        maxTokens: 1000,
        temperature: 0.1
      }
    };
    
    console.log(`[AnalyzePhoto] Invoking Bedrock model ${model_id}...`);
    const command = new InvokeModelCommand({
      modelId: model_id,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      accept: 'application/json'
    });
    
    const bedrockResponse = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    
    const description = responseBody?.output?.message?.content?.[0]?.text;
    if (!description || !description.trim()) {
      throw new Error('Empty response returned from model');
    }
    
    const guids = [];
    const guidRegex = /\[GUID:\s*([^\]]+)\]/i;
    const match = description.match(guidRegex);
    if (match && match[1]) {
      guids.push(match[1].trim());
    }
    
    const cleanDescription = description.replace(/\[GUID:\s*([^\]]+)\]/gi, '').trim();
    
    return successResponse({
      description: cleanDescription,
      extracted_guids: guids
    }, headers);
    
  } catch (error) {
    console.error('[AnalyzePhoto] Error during photo analysis:', error);
    return errorResponse(500, `Photo analysis failed: ${error.message}`, headers);
  } finally {
    client.release();
  }
}
