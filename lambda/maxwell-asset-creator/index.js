const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');
const { broadcastInvalidation } = require('/opt/nodejs/broadcastInvalidation');
const { composeToolEmbeddingSource, composePartEmbeddingSource, composeStateEmbeddingSource } = require('/opt/nodejs/embedding-composition');

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

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
  if (event.requestBody?.content?.['application/json']?.properties) {
    for (const p of event.requestBody.content['application/json'].properties) {
      params[p.name] = p.value;
    }
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

async function handleCreateAsset(params, organizationId, cognitoUserId, actionGroup, apiPath, httpMethod) {
  // Validate required params
  if (!params.asset_type || !['tool', 'part'].includes(params.asset_type)) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'asset_type is required and must be "tool" or "part"',
    });
  }
  if (!params.name) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'name is required',
    });
  }
  if (!organizationId) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'organization_id is missing from session attributes',
    });
  }

  const assetId = randomUUID();
  const client = await getDbClient();

  try {
    await client.query('BEGIN');

    // Resolve internal user_id from cognito_user_id (the rest of the system uses user_id)
    let userId = null;
    if (cognitoUserId) {
      const userLookup = await client.query(
        `SELECT user_id FROM organization_members WHERE cognito_user_id = '${escapeLiteral(cognitoUserId)}' AND organization_id = '${escapeLiteral(organizationId)}' LIMIT 1`
      );
      if (userLookup.rows.length > 0) {
        userId = userLookup.rows[0].user_id;
      }
    }

    if (params.asset_type === 'tool') {
      const isLocation = params.is_location === 'true' || params.is_location === true;
      const status = params.status || 'available';

      const toolSql = `
        INSERT INTO tools (
          id, name, description, storage_location, serial_number,
          status, is_location, image_url, policy, organization_id,
          created_at, updated_at
        ) VALUES (
          '${assetId}',
          '${escapeLiteral(params.name)}',
          ${params.description ? `'${escapeLiteral(params.description)}'` : 'NULL'},
          ${params.storage_location ? `'${escapeLiteral(params.storage_location)}'` : 'NULL'},
          ${params.serial_number ? `'${escapeLiteral(params.serial_number)}'` : 'NULL'},
          '${escapeLiteral(status)}',
          ${isLocation},
          ${params.image_url ? `'${escapeLiteral(params.image_url)}'` : 'NULL'},
          ${params.policy ? `'${escapeLiteral(params.policy)}'` : 'NULL'},
          '${escapeLiteral(organizationId)}',
          NOW(),
          NOW()
        ) RETURNING id`;

      await client.query(toolSql);
    } else {
      // part
      const currentQuantity = params.current_quantity !== undefined ? parseInt(params.current_quantity, 10) || 1 : 1;
      const minimumQuantity = params.minimum_quantity !== undefined ? parseInt(params.minimum_quantity, 10) || 0 : 0;
      const sellable = params.sellable === 'true' || params.sellable === true;
      const costPerUnit = params.cost_per_unit !== undefined ? parseFloat(params.cost_per_unit) : null;

      const partSql = `
        INSERT INTO parts (
          id, name, description, storage_location, current_quantity,
          minimum_quantity, unit, sellable, cost_per_unit, image_url,
          policy, organization_id, created_at, updated_at
        ) VALUES (
          '${assetId}',
          '${escapeLiteral(params.name)}',
          ${params.description ? `'${escapeLiteral(params.description)}'` : 'NULL'},
          ${params.storage_location ? `'${escapeLiteral(params.storage_location)}'` : 'NULL'},
          ${currentQuantity},
          ${minimumQuantity},
          ${params.unit ? `'${escapeLiteral(params.unit)}'` : 'NULL'},
          ${sellable},
          ${costPerUnit !== null ? costPerUnit : 'NULL'},
          ${params.image_url ? `'${escapeLiteral(params.image_url)}'` : 'NULL'},
          ${params.policy ? `'${escapeLiteral(params.policy)}'` : 'NULL'},
          '${escapeLiteral(organizationId)}',
          NOW(),
          NOW()
        ) RETURNING id`;

      await client.query(partSql);
    }

    // Create initial state (observation)
    const stateText = params.initial_condition_text || 'Initial registration via Maxwell';
    const stateSql = `
      INSERT INTO states (
        organization_id, state_text, captured_by, captured_at
      ) VALUES (
        '${escapeLiteral(organizationId)}',
        '${escapeLiteral(stateText)}',
        ${userId ? `'${escapeLiteral(userId)}'` : 'NULL'},
        NOW()
      ) RETURNING id`;

    const stateResult = await client.query(stateSql);
    const stateId = stateResult.rows[0].id;

    // Create state_photo if image_url is provided
    if (params.image_url) {
      const photoDescription = params.photo_description || '';
      const photoSql = `
        INSERT INTO state_photos (
          state_id, photo_url, photo_description, photo_order
        ) VALUES (
          '${escapeLiteral(stateId)}',
          '${escapeLiteral(params.image_url)}',
          '${escapeLiteral(photoDescription)}',
          0
        )`;

      await client.query(photoSql);
    }

    // Create state_link to connect state to the new asset
    const linkSql = `
      INSERT INTO state_links (
        state_id, entity_type, entity_id
      ) VALUES (
        '${escapeLiteral(stateId)}',
        '${escapeLiteral(params.asset_type)}',
        '${escapeLiteral(assetId)}'
      )`;

    await client.query(linkSql);

    await client.query('COMMIT');

    // Queue embedding for the asset (fire-and-forget, non-fatal)
    try {
      const embeddingSource = params.asset_type === 'tool'
        ? composeToolEmbeddingSource({ name: params.name, description: params.description, policy: params.policy })
        : composePartEmbeddingSource({ name: params.name, description: params.description, policy: params.policy });

      if (embeddingSource && embeddingSource.trim()) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: EMBEDDINGS_QUEUE_URL,
          MessageBody: JSON.stringify({
            entity_type: params.asset_type,
            entity_id: assetId,
            embedding_source: embeddingSource,
            organization_id: organizationId,
          }),
        }));
      }
    } catch (sqsError) {
      console.error('Failed to queue asset embedding:', sqsError);
      // Non-fatal — continue with response
    }

    // Queue embedding for the initial state (fire-and-forget, non-fatal)
    try {
      const stateEmbeddingSource = composeStateEmbeddingSource({
        entity_names: [params.name],
        state_text: stateText,
        photo_descriptions: params.photo_description ? [params.photo_description] : [],
      });

      if (stateEmbeddingSource && stateEmbeddingSource.trim()) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: EMBEDDINGS_QUEUE_URL,
          MessageBody: JSON.stringify({
            entity_type: 'state',
            entity_id: stateId,
            embedding_source: stateEmbeddingSource,
            organization_id: organizationId,
          }),
        }));
      }
    } catch (sqsError) {
      console.error('Failed to queue state embedding:', sqsError);
      // Non-fatal — continue with response
    }

    // Broadcast cache invalidation to WebSocket clients
    try {
      await broadcastInvalidation({
        entityType: params.asset_type,
        entityId: assetId,
        mutationType: 'created',
        organizationId,
      });
    } catch (broadcastErr) {
      console.error('[ASSET-CREATOR] Broadcast failed:', broadcastErr.message);
      // Non-fatal — continue with response
    }

    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 201, {
      id: assetId,
      name: params.name,
      asset_type: params.asset_type,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('handleCreateAsset error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Failed to create asset',
    });
  } finally {
    client.release();
  }
}

async function handleGetCategories(params, organizationId, actionGroup, apiPath, httpMethod) {
  if (!organizationId) {
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
      error: 'organization_id is missing from session attributes',
    });
  }

  try {
    const sql = `
      SELECT DISTINCT category FROM (
        SELECT category FROM tools WHERE organization_id = '${escapeLiteral(organizationId)}' AND category IS NOT NULL AND category != ''
        UNION
        SELECT category FROM parts WHERE organization_id = '${escapeLiteral(organizationId)}' AND category IS NOT NULL AND category != ''
      ) combined ORDER BY category ASC`;

    const rows = await queryJSON(sql);

    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, {
      categories: rows.map(r => r.category)
    });
  } catch (error) {
    console.error('handleGetCategories error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Failed to retrieve categories',
    });
  }
}

async function handleGetImageMetadata(params, organizationId, actionGroup, apiPath, httpMethod) {
  try {
    const rawUrl = params.photo_url || params.filename;
    if (!rawUrl) {
      return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 400, {
        error: 'photo_url or filename parameter is required',
      });
    }

    // Extract just the filename from an S3 URL or path
    const filename = rawUrl.split('/').pop();

    const sql = `
      SELECT gps_latitude, gps_longitude, gps_altitude, captured_at, device_make, device_model
      FROM photo_metadata_extractions
      WHERE photo_url LIKE '%' || '${escapeLiteral(filename)}'
      LIMIT 1`;

    const rows = await queryJSON(sql);

    if (rows.length === 0) {
      return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, {
        has_gps: false,
        message: 'No metadata found for this image',
      });
    }

    const row = rows[0];
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 200, {
      has_gps: !!(row.gps_latitude && row.gps_longitude),
      gps_latitude: row.gps_latitude,
      gps_longitude: row.gps_longitude,
      gps_altitude: row.gps_altitude,
      captured_at: row.captured_at,
      device: row.device_make ? `${row.device_make} ${row.device_model || ''}`.trim() : null,
    });
  } catch (error) {
    console.error('handleGetImageMetadata error:', error);
    return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 500, {
      error: 'Failed to retrieve image metadata',
    });
  }
}

exports.handler = async (event) => {
  console.log('Maxwell asset-creator event:', JSON.stringify(event, null, 2));

  const actionGroup = event.actionGroup || 'MaxwellAssetCreator';
  const apiPath = event.apiPath || '/create-asset';
  const httpMethod = event.httpMethod || 'POST';

  const sessionAttributes = event.sessionAttributes || {};
  const organizationId = sessionAttributes.organization_id || sessionAttributes.organizationId;
  const cognitoUserId = sessionAttributes.cognito_user_id || sessionAttributes.cognitoUserId;

  const params = parseActionGroupParams(event);

  if (apiPath === '/create-asset') {
    return await handleCreateAsset(params, organizationId, cognitoUserId, actionGroup, apiPath, httpMethod);
  }

  if (apiPath === '/get-categories') {
    return await handleGetCategories(params, organizationId, actionGroup, apiPath, httpMethod);
  }

  if (apiPath === '/get-image-metadata') {
    return await handleGetImageMetadata(params, organizationId, actionGroup, apiPath, httpMethod);
  }

  return buildActionGroupResponse(actionGroup, apiPath, httpMethod, 404, {
    error: `Unknown apiPath: ${apiPath}`,
  });
};
