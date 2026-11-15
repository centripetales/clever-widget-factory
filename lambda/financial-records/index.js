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

// A transaction's description is its first observation. Later observations
// (e.g. what someone would have done otherwise, for its rewards) are linked to
// it too, so every read picks the first one.
const DESCRIPTION_STATE_JOIN =
  ' LEFT JOIN LATERAL (' +
  '   SELECT ds.id, ds.state_text FROM state_links sl JOIN states ds ON ds.id = sl.state_id' +
  '   WHERE sl.entity_id = fr.id AND sl.entity_type = \'financial_record\'' +
  '   ORDER BY ds.created_at, ds.id LIMIT 1' +
  ' ) s ON true';
const DESCRIPTION_STATE_LOOKUP =
  'SELECT sl.state_id FROM state_links sl JOIN states ds ON ds.id = sl.state_id' +
  ' WHERE sl.entity_id = $1 AND sl.entity_type = \'financial_record\'' +
  ' ORDER BY ds.created_at, ds.id LIMIT 1';

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

  // Clear stale balance_after on records no longer using Cash
  await dbClient.query(`
    UPDATE financial_records
    SET balance_after = NULL
    WHERE organization_id = $1 AND payment_method != 'Cash' AND balance_after IS NOT NULL
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
    // GET/PUT /api/financial-records/:id/purchases - the record's line purchases
    if (pathParameters?.id && path.endsWith('/purchases')) {
      if (httpMethod === 'GET') return await getPurchases(pathParameters.id, { organizationId });
      if (httpMethod === 'PUT') return await savePurchases(event, pathParameters.id, { organizationId, cognitoUserId, permissions });
    }

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

// The action's title is the record's description, cut to 80 characters.
function actionTitle(description, transactionDate) {
  const text = typeof description === 'string' ? description.trim() : '';
  const title = text || `Transaction ${new Date(transactionDate).toISOString().slice(0, 10)}`;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

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

    // Look up creator name (same join GET endpoints use) so the response
    // is immediately complete instead of relying on a later cache refetch
    const creatorResult = await client.query(
      'SELECT full_name FROM organization_members' +
      ' WHERE cognito_user_id::text = $1::text AND organization_id = $2',
      [cognitoUserId, organizationId]
    );
    createdRecord.created_by_name = creatorResult.rows[0]?.full_name || 'Unknown';

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

    // 3b. The purchase is an action (completed, dated the transaction date,
    // assigned to whoever recorded it). Experiences, rewards and Positive Sum
    // analysis hang off it; the record keeps the money. It carries no states of
    // its own and no rewards are built until someone asks for them.
    const actionResult = await client.query(
      `INSERT INTO actions (id, organization_id, title, status,
         created_by, updated_by, assigned_to, participants, required_tools, attachments,
         created_at, updated_at, completed_at)
       VALUES (gen_random_uuid(), $1, $2, 'completed', $3, $3, $3, '{}'::uuid[], '{}'::text[], '{}'::text[],
         NOW(), NOW(), $4)
       RETURNING id`,
      [organizationId, actionTitle(description, transaction_date), cognitoUserId, transaction_date]
    );
    await client.query('UPDATE financial_records SET action_id = $1 WHERE id = $2', [actionResult.rows[0].id, createdRecord.id]);
    createdRecord.action_id = actionResult.rows[0].id;

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
    DESCRIPTION_STATE_JOIN +
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
    DESCRIPTION_STATE_JOIN +
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
    '  COALESCE(pap.model_id, lgc.model_id) AS model_id, ' +
    '  pap.version, ' +
    '  COALESCE(pap.system_prompt, lgc.system_prompt) AS system_prompt ' +
    ' FROM state_photos sp' +
    ' JOIN state_links sl ON sl.state_id = sp.state_id' +
    ' LEFT JOIN state_links sl_trans ON sl_trans.entity_type = \'state_photo\' AND sl_trans.entity_id = sp.id' +
    ' LEFT JOIN states s_trans ON sl_trans.state_id = s_trans.id AND s_trans.state_text LIKE \'[photo_analysis]%\'' +
    ' LEFT JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = \'photo_analysis_param\'' +
    ' LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id' +
    ' LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id' +
    ' WHERE sl.entity_type = \'financial_record\' AND sp.state_id = $1' +
    ' ORDER BY sp.photo_order',
    [record.state_id]
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

  // Line purchases (with the vendor part each was matched to) and the vendor
  const purchasesResult = await pool.query(
    'SELECT i.id, i.purchase_text, i.quantity, i.unit, i.amount, i.unit_price, i.part_id, p.name AS part_name' +
    ' FROM financial_record_purchases i LEFT JOIN parts p ON p.id = i.part_id' +
    ' WHERE i.financial_record_id = $1 ORDER BY i.created_at, i.id',
    [id]
  );
  const vendorResult = record.vendor_organization_id
    ? await pool.query('SELECT id, name FROM organizations WHERE id = $1', [record.vendor_organization_id])
    : { rows: [] };

  // Notes: the observations linked to it after its description (e.g. what Claude
  // found reading the receipt), oldest first; bookkeeping states are not notes
  const notesResult = await pool.query(
    'SELECT s.id, s.state_text, s.captured_at, COALESCE(om.full_name, \'Unknown\') AS captured_by_name' +
    ' FROM state_links sl JOIN states s ON s.id = sl.state_id' +
    ' LEFT JOIN organization_members om' +
    '   ON om.cognito_user_id::text = s.captured_by::text AND om.organization_id = s.organization_id' +
    ' WHERE sl.entity_type = \'financial_record\' AND sl.entity_id = $1' +
    '   AND s.id IS DISTINCT FROM $2 AND s.state_text NOT LIKE \'{"type":"positive_sum.%\'' +
    ' ORDER BY s.created_at, s.id',
    [id, record.state_id]
  );

  return success({ ...record, photos: photosResult.rows, edits: editsResult.rows, purchases: purchasesResult.rows, notes: notesResult.rows, vendor: vendorResult.rows[0] || null });
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
    DESCRIPTION_STATE_LOOKUP,
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

  // The vendor is an organization (any active one), or null to clear it
  if (body.vendor_organization_id) {
    const vendor = await pool.query('SELECT 1 FROM organizations WHERE id = $1 AND is_active', [body.vendor_organization_id]);
    if (vendor.rows.length === 0) return error('vendor_organization_id is not an organization', 400);
  }

  // Editable fields on financial_records table ONLY
  const editableFields = ['transaction_date', 'amount', 'payment_method', 'vendor_organization_id'];

  // Collect changed fields for audit trail
  const changes = [];
  for (const field of editableFields) {
    if (body[field] === undefined) continue;

    const oldVal = existing[field];
    const newVal = body[field];

    // pg returns NUMERIC as a string ("-5000.00") and DATE as a Date object,
    // so normalize both sides before comparing to avoid false audit entries
    const normalize = (val) => {
      if (val === null || val === undefined) return null;
      if (field === 'amount') return String(Number(val));
      if (field === 'transaction_date') {
        return val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
      }
      return String(val);
    };
    const oldStr = normalize(oldVal);
    const newStr = normalize(newVal);

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
      DESCRIPTION_STATE_JOIN +
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

    // The record's action follows its description (title) and date (completed_at)
    if (existing.action_id) {
      if (hasDescriptionChange && stateId) {
        await client.query(
          'UPDATE actions SET title = $1, updated_at = NOW() WHERE id = $2',
          [actionTitle(body.description, existing.transaction_date), existing.action_id]
        );
      }
      if (changes.some(c => c.field === 'transaction_date')) {
        await client.query(
          'UPDATE actions SET completed_at = $1, updated_at = NOW() WHERE id = $2',
          [body.transaction_date, existing.action_id]
        );
      }
    }

    // Manage state_photos if photos provided: photos are matched by URL, so
    // those kept stay as they are (and keep what is attached to them), changed
    // descriptions or order are updated, new ones added and removed ones deleted
    if (hasPhotosChange && stateId) {
      const newPhotos = Array.isArray(body.photos) ? body.photos : [];
      const existingPhotos = (await client.query(
        'SELECT id, photo_url, photo_description, photo_order FROM state_photos WHERE state_id = $1',
        [stateId]
      )).rows;
      const byUrl = new Map(existingPhotos.map((row) => [row.photo_url, row]));
      const keepUrls = new Set(newPhotos.map((photo) => photo.photo_url));

      for (const row of existingPhotos) {
        if (!keepUrls.has(row.photo_url)) {
          await client.query('DELETE FROM state_photos WHERE id = $1', [row.id]);
        }
      }

      for (let i = 0; i < newPhotos.length; i++) {
        const photo = newPhotos[i];
        const description = photo.photo_description || null;
        const order = photo.photo_order || i;
        const row = byUrl.get(photo.photo_url);
        if (!row) {
          await client.query(
            'INSERT INTO state_photos (state_id, photo_url, photo_description, photo_order) VALUES ($1, $2, $3, $4)',
            [stateId, photo.photo_url, description, order]
          );
        } else if ((row.photo_description || null) !== description || row.photo_order !== order) {
          await client.query(
            'UPDATE state_photos SET photo_description = $2, photo_order = $3 WHERE id = $1',
            [row.id, description, order]
          );
        }
      }
    }

    // Recompute Cash balances if amount, payment_method, or transaction_date changed
    const cashFieldChanged = changes.some(c => c.field === 'amount' || c.field === 'payment_method' || c.field === 'transaction_date');
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
      DESCRIPTION_STATE_JOIN +
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

const PURCHASE_COLUMNS = 'id, financial_record_id, purchase_text, quantity, unit, amount, unit_price, part_id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getPurchases(recordId, { organizationId }) {
  const record = await pool.query('SELECT id FROM financial_records WHERE id = $1 AND organization_id = $2', [recordId, organizationId]);
  if (record.rows.length === 0) return error('Record not found', 404);
  const purchases = await pool.query(
    `SELECT ${PURCHASE_COLUMNS} FROM financial_record_purchases WHERE financial_record_id = $1 ORDER BY created_at, id`,
    [recordId]
  );
  return success({ purchases: purchases.rows });
}

const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);

// Why a purchase is not acceptable, or null.
function purchaseProblem(purchase) {
  if (typeof purchase.purchase_text !== 'string' || !purchase.purchase_text.trim()) return 'purchase_text is required';
  if (!isNumber(purchase.amount)) return `amount is required for "${purchase.purchase_text}"`;
  if (purchase.quantity != null && !(isNumber(purchase.quantity) && purchase.quantity > 0)) return `quantity must be above 0 for "${purchase.purchase_text}"`;
  if (purchase.unit_price != null && !(isNumber(purchase.unit_price) && purchase.unit_price >= 0)) return `unit_price must be 0 or more for "${purchase.purchase_text}"`;
  if (purchase.part_id != null && !(typeof purchase.part_id === 'string' && UUID.test(purchase.part_id))) return `part_id must be a part id for "${purchase.purchase_text}"`;
  return null;
}

// The purchases given are the record's purchases: those with an id are updated (only
// when something changed), those without are added, and the record's other
// purchases are removed. Unit price is worked out from amount and quantity when
// not given. A purchase's part is the vendor's part it was matched to: one the
// org can see (its own, or one it added to a vendor's organization), and in
// the record's vendor organization when the record has one.
async function savePurchases(event, recordId, { organizationId, cognitoUserId, permissions }) {
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (parseErr) {
    return error('Invalid JSON in request body', 400);
  }
  const purchases = body?.purchases;
  if (!Array.isArray(purchases)) return error('purchases must be a list', 400);
  const problem = purchases.map(purchaseProblem).find(Boolean);
  if (problem) return error(problem, 400);

  const recordResult = await pool.query(
    'SELECT created_by, vendor_organization_id FROM financial_records WHERE id = $1 AND organization_id = $2',
    [recordId, organizationId]
  );
  if (recordResult.rows.length === 0) return error('Record not found', 404);

  // Same rule as editing the record: its recorder, or write permission
  const createdBy = recordResult.rows[0].created_by;
  const isOwner = createdBy && createdBy.toString() === cognitoUserId.toString();
  if (!isOwner && !hasPermission({ permissions }, 'data:write:all') && !hasPermission({ permissions }, 'data:write:org')) {
    return error('Not authorized to edit this record', 403);
  }

  const partIds = [...new Set(purchases.map((purchase) => purchase.part_id).filter(Boolean))];
  if (partIds.length > 0) {
    const vendorId = recordResult.rows[0].vendor_organization_id;
    const parts = (await pool.query(
      'SELECT id, organization_id FROM parts WHERE id = ANY($1::uuid[]) AND (organization_id = $2 OR created_by_organization_id = $2)',
      [partIds, organizationId]
    )).rows;
    const byId = new Map(parts.map((part) => [part.id, part]));
    const missing = partIds.find((id) => !byId.has(id));
    if (missing) return error(`Part ${missing} is not a part this organization can use`, 400);
    const elsewhere = parts.find((part) => vendorId && part.organization_id !== vendorId && part.organization_id !== organizationId);
    if (elsewhere) return error(`Part ${elsewhere.id} is not a part of this record's vendor`, 400);
  }

  const client = await pool.connect();
  const queued = [];
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      `SELECT ${PURCHASE_COLUMNS} FROM financial_record_purchases WHERE financial_record_id = $1 FOR UPDATE`,
      [recordId]
    )).rows;
    const byId = new Map(existing.map((row) => [row.id, row]));
    const unknown = purchases.find((purchase) => purchase.id && !byId.has(purchase.id));
    if (unknown) {
      await client.query('ROLLBACK');
      return error(`Purchase ${unknown.id} is not a purchase of this record`, 400);
    }

    const keep = new Set(purchases.filter((purchase) => purchase.id).map((purchase) => purchase.id));
    for (const row of existing) {
      if (!keep.has(row.id)) await client.query('DELETE FROM financial_record_purchases WHERE id = $1', [row.id]);
    }

    for (const purchase of purchases) {
      const quantity = purchase.quantity ?? null;
      const unitPrice = purchase.unit_price ?? (quantity ? Math.round((purchase.amount / quantity) * 1e4) / 1e4 : null);
      const unit = purchase.unit ?? null;
      const partId = purchase.part_id ?? null;
      const text = purchase.purchase_text.trim();
      if (purchase.id) {
        const row = byId.get(purchase.id);
        const same = row.purchase_text === text && row.unit === unit && row.part_id === partId && Number(row.amount) === purchase.amount &&
          (row.quantity === null ? quantity === null : Number(row.quantity) === quantity) &&
          (row.unit_price === null ? unitPrice === null : Number(row.unit_price) === unitPrice);
        if (same) continue;
        await client.query(
          'UPDATE financial_record_purchases SET purchase_text = $2, quantity = $3, unit = $4, amount = $5, unit_price = $6, part_id = $7, updated_at = NOW() WHERE id = $1',
          [purchase.id, text, quantity, unit, purchase.amount, unitPrice, partId]
        );
        if (row.purchase_text !== text) queued.push({ id: purchase.id, text });
      } else {
        const inserted = await client.query(
          'INSERT INTO financial_record_purchases (financial_record_id, organization_id, purchase_text, quantity, unit, amount, unit_price, part_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
          [recordId, organizationId, text, quantity, unit, purchase.amount, unitPrice, partId]
        );
        queued.push({ id: inserted.rows[0].id, text });
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Embeddings are regenerated for new or reworded purchases (fire-and-forget);
  // a removed purchase's embedding goes with it by trigger.
  for (const { id, text } of queued) {
    sqs.send(new SendMessageCommand({
      QueueUrl: EMBEDDINGS_QUEUE_URL,
      MessageBody: JSON.stringify({
        entity_type: 'financial_record_purchase',
        entity_id: id,
        embedding_source: text,
        organization_id: organizationId
      })
    }))
    .then(() => console.log('Queued embedding for financial_record_purchase', id))
    .catch(err => console.error('Failed to queue embedding:', err));
  }

  return await getPurchases(recordId, { organizationId });
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
    DESCRIPTION_STATE_LOOKUP,
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

  // Its action goes too, as when an action is deleted: experiences lose that
  // leg (and are deleted when nothing is left in them), and its links go
  if (record.action_id) {
    const affected = await pool.query(
      'DELETE FROM experience_components WHERE action_id = $1 RETURNING experience_id',
      [record.action_id]
    );
    const experienceIds = [...new Set(affected.rows.map(r => r.experience_id))];
    if (experienceIds.length > 0) {
      await pool.query(
        `DELETE FROM experiences e WHERE e.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM experience_components ec WHERE ec.experience_id = e.id)`,
        [experienceIds]
      );
    }
    await pool.query(`DELETE FROM state_links WHERE entity_type = 'action' AND entity_id = $1`, [record.action_id]);
    await pool.query('DELETE FROM actions WHERE id = $1', [record.action_id]);
  }

  // Embedding cleanup: financial_record embeddings are cascade-deleted by the
  // database trigger on financial_records. State embeddings are cascade-deleted
  // when the linked state is deleted above.

  return success({ message: 'Record deleted' });
}
