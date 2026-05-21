const { Pool } = require('pg');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getAuthorizerContext, hasPermission } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');
const { composeFinancialRecordEmbeddingSource } = require('/opt/nodejs/embedding-composition');
const success = (data) => successResponse(data);
const error = (message, statusCode = 500) => errorResponse(statusCode, message);

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

/**
 * Recompute balance_after for all Cash records in an org from a given date forward.
 * Call this after any insert/update/delete that affects Cash transactions.
 */
async function recomputeCashBalances(dbClient, organizationId) {
  await dbClient.query(`
    WITH ordered_cash AS (
      SELECT id,
             -SUM(amount) OVER (
               ORDER BY transaction_date, created_at
               ROWS UNBOUNDED PRECEDING
             ) AS running_balance
      FROM financial_records
      WHERE organization_id = $1 AND payment_method = 'Cash'
    )
    UPDATE financial_records fr
    SET balance_after = oc.running_balance
    FROM ordered_cash oc
    WHERE fr.id = oc.id
  `, [organizationId]);
}

exports.handler = async (event) => {
  console.log('cwf-financial-records-lambda invoked:', {
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters
  });

  const { httpMethod, path, pathParameters, queryStringParameters } = event;

  // Extract auth context
  let authContext;
  let organizationId;

  try {
    authContext = getAuthorizerContext(event);
    organizationId = authContext?.organization_id;
  } catch (err) {
    console.error('Error getting authorizer context:', err);
    organizationId = null;
  }

  if (!organizationId) {
    return error('Organization ID not found', 401);
  }

  const cognitoUserId = authContext.cognito_user_id;
  const permissions = authContext.permissions || [];

  try {
    // POST /api/financial-records - Create record
    if (httpMethod === 'POST' && path === '/api/financial-records') {
      return await createRecord(event, { organizationId, cognitoUserId, permissions });
    }

    // GET /api/financial-records - List records
    if (httpMethod === 'GET' && path === '/api/financial-records') {
      return await listRecords(queryStringParameters, { organizationId, cognitoUserId, permissions });
    }

    // GET /api/financial-records/:id - Get single record
    if (httpMethod === 'GET' && pathParameters?.id) {
      return await getRecord(pathParameters.id, { organizationId, cognitoUserId, permissions });
    }

    // PUT /api/financial-records/:id - Update record
    if (httpMethod === 'PUT' && pathParameters?.id) {
      return await updateRecord(event, pathParameters.id, { organizationId, cognitoUserId, permissions });
    }

    // DELETE /api/financial-records/:id - Delete record
    if (httpMethod === 'DELETE' && pathParameters?.id) {
      return await deleteRecord(pathParameters.id, { organizationId, cognitoUserId, permissions });
    }

    return error('Not found', 404);

  } catch (err) {
    console.error('Error:', err);
    return error('Internal server error', 500);
  }
};


// --- Stub route handlers (to be implemented in subsequent tasks) ---

async function createRecord(event, authContext) {
  const { organizationId, cognitoUserId } = authContext;

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (parseErr) {
    console.error('Error parsing request body:', parseErr);
    return error('Invalid JSON in request body', 400);
  }

  const { transaction_date, description, amount, payment_method, photos } = body;

  // Validate required fields
  const missingFields = [];
  if (!transaction_date) missingFields.push('transaction_date');
  if (!description) missingFields.push('description');
  if (amount === undefined || amount === null) missingFields.push('amount');
  if (!payment_method) missingFields.push('payment_method');

  if (missingFields.length > 0) {
    return error(`Missing required fields: ${missingFields.join(', ')}`, 400);
  }

  // Validate payment_method enum
  const validPaymentMethods = ['Cash', 'SCash', 'GCash', 'Wise'];
  if (!validPaymentMethods.includes(payment_method)) {
    return error("payment_method must be one of: Cash, SCash, GCash, Wise", 400);
  }

  // Use a database transaction for atomicity
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. INSERT financial_records (no description/photos columns)
    const recordResult = await client.query(
      `INSERT INTO financial_records
       (organization_id, created_by, transaction_date, amount, payment_method, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING *`,
      [organizationId, cognitoUserId, transaction_date, amount, payment_method]
    );
    const createdRecord = recordResult.rows[0];

    // Compute and store balance_after for Cash records
    if (payment_method === 'Cash') {
      await recomputeCashBalances(client, organizationId);
      const balResult = await client.query(
        'SELECT balance_after FROM financial_records WHERE id = $1',
        [createdRecord.id]
      );
      createdRecord.balance_after = parseFloat(balResult.rows[0].balance_after);
    }

    // 2. INSERT states with state_text = description
    const stateResult = await client.query(
      `INSERT INTO states
       (organization_id, state_text, captured_by, captured_at, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW())
       RETURNING *`,
      [organizationId, description, cognitoUserId]
    );
    const createdState = stateResult.rows[0];

    // 3. INSERT state_links linking state to financial_record
    await client.query(
      `INSERT INTO state_links (state_id, entity_type, entity_id)
       VALUES ($1, 'financial_record', $2)`,
      [createdState.id, createdRecord.id]
    );

    // 4. INSERT state_photos for each photo (if any)
    const photoRows = [];
    if (photos && Array.isArray(photos) && photos.length > 0) {
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        const photoResult = await client.query(
          `INSERT INTO state_photos (state_id, photo_url, photo_description, photo_order)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [createdState.id, photo.photo_url, photo.photo_description || null, photo.photo_order || i]
        );
        photoRows.push(photoResult.rows[0]);
      }
    }

    await client.query('COMMIT');

    // Queue embedding for the financial_record entity
    const embeddingSource = composeFinancialRecordEmbeddingSource({
      state_text: description,
      photo_descriptions: (photos || []).map(p => p.photo_description).filter(Boolean)
    });

    if (embeddingSource.trim()) {
      sqs.send(new SendMessageCommand({
        QueueUrl: EMBEDDINGS_QUEUE_URL,
        MessageBody: JSON.stringify({
          entity_type: 'financial_record',
          entity_id: createdRecord.id,
          embedding_source: embeddingSource,
          organization_id: organizationId
        })
      }))
      .then(() => console.log('Queued embedding for financial_record', createdRecord.id))
      .catch(err => console.error('Failed to queue embedding:', err));
    }

    // Return the created record with description and photos populated from the state
    return success({
      ...createdRecord,
      description: createdState.state_text,
      photos: photoRows,
      state_id: createdState.id
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listRecords(queryParams, authContext) {
  const { organizationId, cognitoUserId, permissions } = authContext;
  const params = queryParams || {};

  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 1000, 1), 5000);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);

  // Build filtered records query
  const conditions = ['fr.organization_id = $1'];
  const queryValues = [organizationId];
  let paramIndex = 2;

  // Permission scoping: data:read:all or data:read:org sees all org records, otherwise only own
  // NULL created_by records are NOT visible to non-leadership users (NULL won't match)
  if (!hasPermission({ permissions }, 'data:read:all') && !hasPermission({ permissions }, 'data:read:org')) {
    conditions.push('fr.created_by = $' + paramIndex);
    queryValues.push(cognitoUserId);
    paramIndex++;
  }

  // Optional filters
  if (params.payment_method) {
    conditions.push('fr.payment_method = $' + paramIndex);
    queryValues.push(params.payment_method);
    paramIndex++;
  }

  if (params.start_date) {
    conditions.push('fr.transaction_date >= $' + paramIndex);
    queryValues.push(params.start_date);
    paramIndex++;
  }

  if (params.end_date) {
    conditions.push('fr.transaction_date <= $' + paramIndex);
    queryValues.push(params.end_date);
    paramIndex++;
  }

  if (params.created_by) {
    conditions.push('fr.created_by = $' + paramIndex);
    queryValues.push(params.created_by);
    paramIndex++;
  }

  const whereClause = conditions.join(' AND ');

  // Run three queries in parallel:
  // 1. Filtered + paginated records with creator name + description from states
  // 2. Total count of filtered records
  // 3. Running balance (always org-wide Cash, not affected by filters)
  const limitParam = '$' + paramIndex;
  const offsetParam = '$' + (paramIndex + 1);

  const recordsQuery = pool.query(
    'SELECT fr.*, s.state_text AS description, s.id AS state_id,' +
    ' COALESCE(om.full_name, \'Unknown\') AS created_by_name' +
    ' FROM financial_records fr' +
    ' LEFT JOIN state_links sl ON sl.entity_id = fr.id AND sl.entity_type = \'financial_record\'' +
    ' LEFT JOIN states s ON s.id = sl.state_id' +
    ' LEFT JOIN organization_members om' +
    '   ON fr.created_by::text = om.cognito_user_id::text' +
    '   AND om.organization_id = fr.organization_id' +
    ' WHERE ' + whereClause +
    ' ORDER BY fr.transaction_date DESC, fr.created_at DESC' +
    ' LIMIT ' + limitParam + ' OFFSET ' + offsetParam,
    [...queryValues, limit, offset]
  );

  const countQuery = pool.query(
    'SELECT COUNT(*)::int AS total_count' +
    ' FROM financial_records fr' +
    ' WHERE ' + whereClause,
    queryValues
  );

  const balanceQuery = pool.query(
    'SELECT COALESCE(-SUM(amount), 0) AS running_balance' +
    ' FROM financial_records' +
    ' WHERE organization_id = $1' +
    '   AND payment_method = \'Cash\'',
    [organizationId]
  );

  const [recordsResult, countResult, balanceResult] = await Promise.all([
    recordsQuery,
    countQuery,
    balanceQuery
  ]);

  return success({
    records: recordsResult.rows,
    running_balance: parseFloat(balanceResult.rows[0].running_balance),
    total_count: countResult.rows[0].total_count
  });
}

async function getRecord(id, authContext) {
  const { organizationId, cognitoUserId, permissions } = authContext;

  // Fetch record scoped to organization, with creator name + description from states
  const recordResult = await pool.query(
    'SELECT fr.*, s.state_text AS description, s.id AS state_id,' +
    ' COALESCE(om.full_name, \'Unknown\') AS created_by_name' +
    ' FROM financial_records fr' +
    ' LEFT JOIN state_links sl ON sl.entity_id = fr.id AND sl.entity_type = \'financial_record\'' +
    ' LEFT JOIN states s ON s.id = sl.state_id' +
    ' LEFT JOIN organization_members om' +
    '   ON fr.created_by::text = om.cognito_user_id::text' +
    '   AND om.organization_id = fr.organization_id' +
    ' WHERE fr.id = $1 AND fr.organization_id = $2',
    [id, organizationId]
  );

  if (recordResult.rows.length === 0) {
    return error('Record not found', 404);
  }

  const record = recordResult.rows[0];

  // Permission check: owner or data:read:all/data:read:org
  // NULL created_by → only leadership/admin can view
  const isOwner = record.created_by && record.created_by.toString() === cognitoUserId.toString();
  if (!isOwner && !hasPermission({ permissions }, 'data:read:all') && !hasPermission({ permissions }, 'data:read:org')) {
    return error('Not authorized to view this record', 403);
  }

  // Fetch photos from state_photos via state_links with rich model metadata joins
  const photosResult = await pool.query(
    'SELECT sp.*, ' +
    '  s_trans.state_text AS transcription, ' +
    '  pap.model_id, ' +
    '  pap.version, ' +
    '  pap.system_prompt ' +
    ' FROM state_photos sp' +
    ' JOIN state_links sl ON sl.state_id = sp.state_id' +
    ' LEFT JOIN state_links sl_trans ON sl_trans.entity_type = \'state_photo\' AND sl_trans.entity_id = sp.id' +
    ' LEFT JOIN states s_trans ON sl_trans.state_id = s_trans.id AND s_trans.state_text LIKE \'[photo_analysis]%\'' +
    ' LEFT JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = \'photo_analysis_param\'' +
    ' LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id' +
    ' WHERE sl.entity_id = $1 AND sl.entity_type = \'financial_record\'' +
    ' ORDER BY sp.photo_order',
    [id]
  );

  // Fetch edit history with editor names, sorted by edited_at DESC
  const editsResult = await pool.query(
    'SELECT fre.*, COALESCE(om.full_name, \'Unknown\') AS edited_by_name' +
    ' FROM financial_record_edits fre' +
    ' LEFT JOIN organization_members om' +
    '   ON fre.edited_by::text = om.cognito_user_id::text' +
    '   AND om.organization_id = $2' +
    ' WHERE fre.record_id = $1' +
    ' ORDER BY fre.edited_at DESC',
    [id, organizationId]
  );

  return success({ ...record, photos: photosResult.rows, edits: editsResult.rows });
}

async function updateRecord(event, id, authContext) {
  const { organizationId, cognitoUserId, permissions } = authContext;

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (parseErr) {
    console.error('Error parsing request body:', parseErr);
    return error('Invalid JSON in request body', 400);
  }

  // Fetch existing record scoped to organization
  const recordResult = await pool.query(
    'SELECT * FROM financial_records WHERE id = $1 AND organization_id = $2',
    [id, organizationId]
  );

  if (recordResult.rows.length === 0) {
    return error('Record not found', 404);
  }

  const existing = recordResult.rows[0];

  // Authorization: owner or data:write:all/data:write:org
  // NULL created_by → only leadership/admin can edit
  const isOwner = existing.created_by && existing.created_by.toString() === cognitoUserId.toString();
  if (!isOwner && !hasPermission({ permissions }, 'data:write:all') && !hasPermission({ permissions }, 'data:write:org')) {
    return error('Not authorized to edit this record', 403);
  }

  // Fetch linked state_id (needed for description/photo updates)
  const stateLinkResult = await pool.query(
    'SELECT sl.state_id FROM state_links sl WHERE sl.entity_id = $1 AND sl.entity_type = \'financial_record\'',
    [id]
  );
  const stateId = stateLinkResult.rows.length > 0 ? stateLinkResult.rows[0].state_id : null;

  // Validate payment_method if provided
  if (body.payment_method !== undefined) {
    const validPaymentMethods = ['Cash', 'SCash', 'GCash', 'Wise'];
    if (!validPaymentMethods.includes(body.payment_method)) {
      return error('payment_method must be one of: Cash, SCash, GCash, Wise', 400);
    }
  }

  // Editable fields on financial_records table ONLY
  const editableFields = ['transaction_date', 'amount', 'payment_method'];

  // Collect changed fields for audit trail
  const changes = [];
  for (const field of editableFields) {
    if (body[field] === undefined) continue;

    const oldVal = existing[field];
    const newVal = body[field];

    const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
    const newStr = newVal === null || newVal === undefined ? null : String(newVal);

    if (oldStr !== newStr) {
      changes.push({ field, oldValue: oldStr, newValue: newStr });
    }
  }

  // Check if description or photos changed (these go to the linked state)
  const hasDescriptionChange = body.description !== undefined;
  const hasPhotosChange = body.photos !== undefined;

  // If nothing changed at all, return existing record
  if (changes.length === 0 && !hasDescriptionChange && !hasPhotosChange) {
    const balanceResult = await pool.query(
      'SELECT COALESCE(-SUM(amount), 0) AS running_balance FROM financial_records WHERE organization_id = $1 AND payment_method = \'Cash\'',
      [organizationId]
    );
    const fullRecord = await pool.query(
      'SELECT fr.*, s.state_text AS description, s.id AS state_id,' +
      ' COALESCE(om.full_name, \'Unknown\') AS created_by_name' +
      ' FROM financial_records fr' +
      ' LEFT JOIN state_links sl ON sl.entity_id = fr.id AND sl.entity_type = \'financial_record\'' +
      ' LEFT JOIN states s ON s.id = sl.state_id' +
      ' LEFT JOIN organization_members om' +
      '   ON fr.created_by::text = om.cognito_user_id::text' +
      '   AND om.organization_id = fr.organization_id' +
      ' WHERE fr.id = $1',
      [id]
    );
    const photosResult = await pool.query(
      'SELECT sp.* FROM state_photos sp WHERE sp.state_id = $1 ORDER BY sp.photo_order',
      [stateId]
    );
    return success({
      ...fullRecord.rows[0],
      photos: photosResult.rows,
      running_balance: parseFloat(balanceResult.rows[0].running_balance)
    });
  }

  // Use a database transaction for atomicity
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update financial_records fields if any changed
    if (changes.length > 0) {
      const setClauses = [];
      const updateValues = [];
      let paramIdx = 1;

      for (const field of editableFields) {
        if (body[field] === undefined) continue;
        setClauses.push(field + ' = $' + paramIdx);
        updateValues.push(body[field]);
        paramIdx++;
      }

      setClauses.push('updated_at = NOW()');

      updateValues.push(id);
      const idParam = '$' + paramIdx;
      paramIdx++;
      updateValues.push(organizationId);
      const orgParam = '$' + paramIdx;

      await client.query(
        'UPDATE financial_records SET ' + setClauses.join(', ') +
        ' WHERE id = ' + idParam + ' AND organization_id = ' + orgParam,
        updateValues
      );

      // Insert audit trail rows for each changed field
      for (const change of changes) {
        await client.query(
          'INSERT INTO financial_record_edits (record_id, edited_by, edited_at, field_changed, old_value, new_value) VALUES ($1, $2, NOW(), $3, $4, $5)',
          [id, cognitoUserId, change.field, change.oldValue, change.newValue]
        );
      }
    }

    // Update linked state description if provided
    if (hasDescriptionChange && stateId) {
      await client.query(
        'UPDATE states SET state_text = $1, updated_at = NOW() WHERE id = $2',
        [body.description, stateId]
      );
    }

    // Manage state_photos if photos provided
    if (hasPhotosChange && stateId) {
      // Delete existing photos for this state
      await client.query('DELETE FROM state_photos WHERE state_id = $1', [stateId]);

      // Insert new photos
      const newPhotos = body.photos || [];
      if (Array.isArray(newPhotos)) {
        for (let i = 0; i < newPhotos.length; i++) {
          const photo = newPhotos[i];
          await client.query(
            'INSERT INTO state_photos (state_id, photo_url, photo_description, photo_order) VALUES ($1, $2, $3, $4)',
            [stateId, photo.photo_url, photo.photo_description || null, photo.photo_order || i]
          );
        }
      }
    }

    // Recompute Cash balances if amount or payment_method changed
    const cashFieldChanged = changes.some(c => c.field === 'amount' || c.field === 'payment_method');
    if (cashFieldChanged) {
      await recomputeCashBalances(client, organizationId);
    }

    await client.query('COMMIT');

    // Recompute running balance (Cash only)
    const balanceResult = await pool.query(
      'SELECT COALESCE(-SUM(amount), 0) AS running_balance FROM financial_records WHERE organization_id = $1 AND payment_method = \'Cash\'',
      [organizationId]
    );

    // Fetch updated record with creator name + description from state
    const fullRecord = await pool.query(
      'SELECT fr.*, s.state_text AS description, s.id AS state_id,' +
      ' COALESCE(om.full_name, \'Unknown\') AS created_by_name' +
      ' FROM financial_records fr' +
      ' LEFT JOIN state_links sl ON sl.entity_id = fr.id AND sl.entity_type = \'financial_record\'' +
      ' LEFT JOIN states s ON s.id = sl.state_id' +
      ' LEFT JOIN organization_members om' +
      '   ON fr.created_by::text = om.cognito_user_id::text' +
      '   AND om.organization_id = fr.organization_id' +
      ' WHERE fr.id = $1',
      [id]
    );

    // Fetch photos from state
    const photosResult = await pool.query(
      'SELECT sp.* FROM state_photos sp WHERE sp.state_id = $1 ORDER BY sp.photo_order',
      [stateId]
    );

    const updatedRecord = fullRecord.rows[0];

    // Queue embedding regeneration for the financial_record when description or photos change (fire-and-forget)
    if ((hasDescriptionChange || hasPhotosChange) && stateId) {
      // Fetch updated photo descriptions from state_photos
      const updatedPhotos = await pool.query(
        'SELECT photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order',
        [stateId]
      );
      const photoDescs = updatedPhotos.rows.map(r => r.photo_description).filter(Boolean);

      const embeddingSource = composeFinancialRecordEmbeddingSource({
        state_text: hasDescriptionChange ? body.description : updatedRecord.description,
        photo_descriptions: photoDescs
      });

      if (embeddingSource.trim()) {
        sqs.send(new SendMessageCommand({
          QueueUrl: EMBEDDINGS_QUEUE_URL,
          MessageBody: JSON.stringify({
            entity_type: 'financial_record',
            entity_id: id,
            embedding_source: embeddingSource,
            organization_id: organizationId
          })
        }))
        .then(() => console.log('Queued embedding for financial_record', id))
        .catch(err => console.error('Failed to queue embedding:', err));
      }
    }

    return success({
      ...updatedRecord,
      photos: photosResult.rows,
      running_balance: parseFloat(balanceResult.rows[0].running_balance)
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteRecord(id, authContext) {
  const { organizationId, cognitoUserId, permissions } = authContext;

  // Fetch record scoped to organization
  const recordResult = await pool.query(
    'SELECT * FROM financial_records WHERE id = $1 AND organization_id = $2',
    [id, organizationId]
  );

  if (recordResult.rows.length === 0) {
    return error('Record not found', 404);
  }

  const record = recordResult.rows[0];

  // Authorization: owner or data:write:all/data:write:org
  // NULL created_by → only leadership/admin can delete
  const isOwner = record.created_by && record.created_by.toString() === cognitoUserId.toString();
  if (!isOwner && !hasPermission({ permissions }, 'data:write:all') && !hasPermission({ permissions }, 'data:write:org')) {
    return error('Not authorized to delete this record', 403);
  }

  // Look up linked state before deleting the financial_record
  const stateLinkResult = await pool.query(
    'SELECT sl.state_id FROM state_links sl WHERE sl.entity_id = $1 AND sl.entity_type = \'financial_record\'',
    [id]
  );
  const stateId = stateLinkResult.rows.length > 0 ? stateLinkResult.rows[0].state_id : null;

  // Delete record (CASCADE handles financial_record_edits cleanup)
  await pool.query(
    'DELETE FROM financial_records WHERE id = $1 AND organization_id = $2',
    [id, organizationId]
  );

  // Recompute Cash balances if deleted record was Cash
  if (record.payment_method === 'Cash') {
    await recomputeCashBalances(pool, organizationId);
  }

  // Delete linked state if found (CASCADE handles state_photos and state_links)
  if (stateId) {
    await pool.query(
      'DELETE FROM states WHERE id = $1',
      [stateId]
    );
  }

  // Embedding cleanup: financial_record embeddings are cascade-deleted by the
  // database trigger on financial_records. State embeddings are cascade-deleted
  // when the linked state is deleted above.

  return success({ message: 'Record deleted' });
}
