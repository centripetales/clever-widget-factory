const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { getAuthorizerContext, hasPermission } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');
const { composeFinancialRecordEmbeddingSource } = require('/opt/nodejs/embedding-composition');
const success = (data) => successResponse(data);
const error = (message, statusCode = 500) => errorResponse(statusCode, message);

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';
// The queue observations are analyzed from (rsp-worker): saving an expense with photos queues its reading
const PERSPECTIVES_QUEUE_URL = process.env.PERSPECTIVES_QUEUE_URL;

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
  // The automatic reading, asked for by rsp-worker when an expense with photos is saved (not an HTTP call)
  if (event.internal === 'analyze_expense_photos' && !event.httpMethod) {
    return await analyzeExpensePhotos(event.recordId, event.organizationId);
  }

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
    // POST /api/financial-records/read-photos - the reading of photos before the expense is saved
    if (httpMethod === 'POST' && path === '/api/financial-records/read-photos') {
      return await readPhotosBeforeSave(event, { organizationId });
    }

    // PUT /api/financial-records/:id/fuel-fill - the fuel fill the person confirmed or corrected
    if (httpMethod === 'PUT' && pathParameters?.id && path.endsWith('/fuel-fill')) {
      return await saveFuelFill(event, pathParameters.id, { organizationId, cognitoUserId, permissions });
    }

    // POST /api/financial-records/:id/purchases/extract - purchases read from the photos (a draft, nothing saved)
    if (httpMethod === 'POST' && pathParameters?.id && path.endsWith('/purchases/extract')) {
      return await extractPurchases(pathParameters.id, { organizationId });
    }

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

    // Its photos are read in the background (rsp-worker, as observations are analyzed): purchases,
    // the fuel fill and its policy fill in what is still empty
    if (photoRows.length > 0 && PERSPECTIVES_QUEUE_URL) {
      try {
        await sqs.send(new SendMessageCommand({
          QueueUrl: PERSPECTIVES_QUEUE_URL,
          MessageBody: JSON.stringify({ stateId: createdState.id, perspective: 'EXPENSE_PHOTOS', recordId: createdRecord.id, organizationId })
        }));
      } catch (queueErr) {
        console.error('Failed to queue the reading of the photos:', queueErr);
      }
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

  // The policies its action follows
  const policiesResult = record.action_id
    ? await pool.query(
        'SELECT p.id, p.title, p.description_text, p.status FROM action_policies ap JOIN policy p ON p.id = ap.policy_id WHERE ap.action_id = $1 ORDER BY p.title',
        [record.action_id]
      )
    : { rows: [] };

  // Perspectives of its description: what was read from the photos, and by which model
  const perspectivesResult = record.state_id
    ? await pool.query(
        'SELECT sp.id, sp.perspective_type, sp.content, sp.created_at, c.model_id, c.version FROM state_perspectives sp' +
        ' JOIN llm_generation_configs c ON c.id = sp.llm_generation_config_id' +
        ' WHERE sp.state_id = $1 AND sp.perspective_type = $2 AND sp.status = \'SUCCESS\' ORDER BY sp.created_at',
        [record.state_id, EXPENSE_PHOTOS_PERSPECTIVE]
      )
    : { rows: [] };

  // The fuel fill saved on it (the vehicle and its readings), editable; the vehicles to choose from
  // are listed when it has one or its photos were read as a fuel fill
  const fuelFill = await getFuelFill(id, organizationId);
  const isFuel = fuelFill || perspectivesResult.rows.some((row) => row.content?.vehicle || row.content?.policy_ids?.length > 0);
  const machines = isFuel ? (await vehiclesOf(organizationId)).map(machineInfo) : [];

  return success({ ...record, photos: photosResult.rows, edits: editsResult.rows, purchases: purchasesResult.rows, notes: notesResult.rows, policies: policiesResult.rows, perspectives: perspectivesResult.rows, fuel_fill: fuelFill, machines, vendor: vendorResult.rows[0] || null });
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

// The cheapest Bedrock model that read both test photos correctly (a handwritten
// receipt, and a receipt with the odometer in the same photo). Nova Lite and Nova 2
// Lite misread a line or the odometer; every model fails without the description.
const EXTRACT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });
const MAX_EXTRACT_PHOTOS = 4;
const ASSETS_BUCKET_URL = 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com';

// What produced a perspective is kept with it: this model and these instructions (a new
// version when they change) are an llm_generation_configs row each perspective points to.
const EXTRACT_VERSION = 'expense-photos-v4';
const UNKNOWN_VENDOR_NAME = 'Unknown vendor';
// Looks things up on the web (Bedrock's web grounding), cheapest model that has it
const WEB_LOOKUP_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';
const EXTRACT_INFERENCE = { maxTokens: 1000, temperature: 0 };
const EXTRACT_SYSTEM_PROMPT = `You read the photos attached to a financial record in the Philippines (amounts in ₱ pesos). You are given the person's description of it, the record's total, the machines we track (each with its meter) and our policies.
Purchases: read the purchase lines from the receipt. Use the description only as context to help read unclear handwriting: the receipt is the source. Each line: purchase_text is the item as named, with any detail from the description that identifies it (e.g. the type of cement); quantity and unit as written; amount is the line's total price; unit_price only if written. Use null for what is not written. If the receipt shows only a total and no lines, give one line for the whole expense: the item the description names, with the record's total as its amount.
Fuel: if this is fuel bought for one of the machines, fuel gives machine_id (chosen from the description and the photos), meter_reading, liters and octane; otherwise fuel is null. meter_reading is the machine's meter reading in the unit given (for an odometer, whole kilometers: leave out a last digit shown separately in a box or a different colour, that is tenths). liters is the amount dispensed, from the pump display or the receipt's quantity written with its decimals. Each is taken from the photos (null when not visible). octane is the grade shown, if any.
Observed: report only what you can see in the photos, it is not a judgement. odometer is true if a photo shows a machine's meter, receipt if one shows a receipt, pump if one shows the pump's display. false means not observed.
Vendor: vendor.organization_id is the id of the vendor from the list whose business name is printed on the receipt as the seller (the same business, even if abbreviated); null if the receipt does not clearly name one of them. Do not guess. vendor.printed_name is the seller's name as printed, or null.
Policies: policy_ids lists each policy whose title or text describes what this record is (for example, fuel bought for one of the machines follows a policy about fueling a vehicle); none if no policy applies.
Reply with JSON only: {"purchases":[{"purchase_text":string,"quantity":number|null,"unit":string|null,"unit_price":number|null,"amount":number}],"fuel":{"machine_id":string|null,"meter_reading":number|null,"liters":number|null,"octane":string|null}|null,"observed":{"odometer":boolean,"receipt":boolean,"pump":boolean},"vendor":{"organization_id":string|null,"printed_name":string|null},"policy_ids":[string]}`;
const EXPENSE_PHOTOS_PERSPECTIVE = 'EXPENSE_PHOTOS';

// The model takes images up to 5 MB once they are base64-encoded (a third larger), so about 3.9 MB as they are, and a
// phone's original can be larger: halve its sides until it is small enough (a receipt stays readable at a quarter
// of the pixels). A shrunk image is a JPEG.
const MAX_IMAGE_BYTES = 3500000;
function shrinkForModel(bytes, format) {
  if (bytes.length <= MAX_IMAGE_BYTES || (format !== 'jpeg' && format !== 'png')) return { bytes, format };
  let image = format === 'png'
    ? (() => { const png = PNG.sync.read(Buffer.from(bytes)); return { width: png.width, height: png.height, data: png.data }; })()
    : jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  for (let pass = 0; pass < 3; pass++) {
    const width = image.width >> 1;
    const height = image.height >> 1;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          const at = (row, col) => image.data[((y * 2 + row) * image.width + (x * 2 + col)) * 4 + c];
          data[(y * width + x) * 4 + c] = (at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1)) >> 2;
        }
      }
    }
    image = { width, height, data };
    const encoded = jpeg.encode(image, 85).data;
    if (encoded.length <= MAX_IMAGE_BYTES) return { bytes: new Uint8Array(encoded), format: 'jpeg' };
  }
  return { bytes, format };
}

function imageFormat(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'webp';
  return null;
}

// The vehicles: tools that track an Odometer (km). The rate goes to their km/l metric
// (a view, not saved), and the liters to Fuel Consumed.
async function vehiclesOf(organizationId) {
  return (await pool.query(
    `SELECT t.id, t.name, mm.metric_id AS meter_metric_id, mm.name AS meter_name, mm.unit AS meter_unit,
            CASE WHEN lower(mm.name) = 'odometer' THEN 'km/l' ELSE 'L/h' END AS rate_unit,
            (SELECT k.metric_id FROM metrics k WHERE k.entity_type = 'tool' AND k.entity_id = t.id AND k.active
                AND lower(k.name) = CASE WHEN lower(mm.name) = 'odometer' THEN 'km/l' ELSE 'l/h' END LIMIT 1) AS rate_metric_id,
            (SELECT f.metric_id FROM metrics f WHERE f.entity_type = 'tool' AND f.entity_id = t.id AND f.active AND lower(f.name) = 'fuel consumed' LIMIT 1) AS fuel_metric_id
       FROM tools t JOIN metrics mm ON mm.entity_type = 'tool' AND mm.entity_id = t.id AND mm.active AND lower(mm.name) = 'odometer'
      WHERE t.organization_id = $1 AND t.status != 'removed'`,
    [organizationId]
  )).rows;
}

// The policies this organization has in force: what an action follows
async function activePolicies(organizationId) {
  return (await pool.query(
    `SELECT id, title, description_text FROM policy
      WHERE organization_id = $1 AND status = 'active'
        AND (effective_from IS NULL OR effective_from <= CURRENT_DATE) AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`,
    [organizationId]
  )).rows;
}

// Reads the photos (nothing is written): the purchases, the fuel fill, what was observed and the
// policies the record follows. The record may not exist yet (read before it is saved).
async function readExpensePhotos({ organizationId, description, amount, transactionDate, photoUrls, excludeRecordId }) {
  const machines = await vehiclesOf(organizationId);
  const policies = await activePolicies(organizationId);
  const vendors = await knownVendors(organizationId);

  const images = [];
  for (const photoUrl of photoUrls.slice(0, MAX_EXTRACT_PHOTOS)) {
    // Photos are stored as a full URL or as a key in the assets bucket (as the app reads them)
    const url = /^https?:\/\//.test(photoUrl) ? photoUrl : `${ASSETS_BUCKET_URL}/${photoUrl.replace(/^\//, '')}`;
    const response = await fetch(url);
    if (!response.ok) return { failure: error(`Could not load photo ${photoUrl}`, 502) };
    const original = new Uint8Array(await response.arrayBuffer());
    const detected = imageFormat(original);
    const { bytes, format } = detected ? shrinkForModel(original, detected) : { bytes: original, format: null };
    if (format && bytes.length <= 3900000) images.push({ image: { format, source: { bytes } } });
  }
  if (images.length === 0) return { failure: error('The photos are not in a format that can be read', 400) };

  const context = `The person described it as: "${description || ''}"
The record's total is ₱${Number(amount)}.
Machines: ${JSON.stringify(machines.map((m) => ({ id: m.id, name: m.name, meter: `${m.meter_name} (${m.meter_unit})` })))}
Vendors: ${JSON.stringify(vendors.map((vendor) => ({ id: vendor.id, name: vendor.name })))}
Policies: ${JSON.stringify(policies.map((policy) => ({ id: policy.id, title: policy.title, policy: policy.description_text })))}`;

  const reply = await bedrock.send(new ConverseCommand({
    modelId: EXTRACT_MODEL_ID,
    system: [{ text: EXTRACT_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [...images, { text: context }] }],
    inferenceConfig: EXTRACT_INFERENCE
  }));
  const text = reply.output.message.content.map((part) => part.text || '').join('');

  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (parseErr) {
    console.error('Unreadable extraction reply:', text);
    return { failure: error('The photos could not be read into purchases', 502) };
  }
  const purchases = (Array.isArray(parsed.purchases) ? parsed.purchases : [])
    .filter((purchase) => typeof purchase.purchase_text === 'string' && purchase.purchase_text.trim() && isNumber(purchase.amount))
    .map((purchase) => ({
      purchase_text: purchase.purchase_text.trim(),
      quantity: isNumber(purchase.quantity) && purchase.quantity > 0 ? purchase.quantity : null,
      unit: typeof purchase.unit === 'string' && purchase.unit.trim() ? purchase.unit.trim() : null,
      unit_price: isNumber(purchase.unit_price) && purchase.unit_price >= 0 ? purchase.unit_price : null,
      amount: purchase.amount
    }));

  const fuel = machines.length > 0 ? await fuelFill(parsed.fuel, machines, excludeRecordId, transactionDate) : null;
  const followed = policies
    .filter((policy) => Array.isArray(parsed.policy_ids) && parsed.policy_ids.includes(policy.id))
    .map((policy) => ({ id: policy.id, title: policy.title }));
  const printed = parsed.vendor || {};
  const vendor = {
    organization_id: vendors.some((v) => v.id === printed.organization_id) ? printed.organization_id : null,
    printed_name: typeof printed.printed_name === 'string' && printed.printed_name.trim() ? printed.printed_name.trim() : null
  };
  const seen = parsed.observed || {};
  const observed = { odometer: seen.odometer === true, receipt: seen.receipt === true, pump: seen.pump === true };

  // The vehicles are listed too, so the person can correct which one it was
  return {
    result: { purchases, fuel, observed, vendor, machines: machines.map(machineInfo), policies: followed, model: EXTRACT_MODEL_ID, usage: reply.usage },
    raw: parsed.fuel || {}
  };
}

// Reads a saved record's photos, with its description as context, and keeps the reading as a
// perspective of its description (what was seen in each part, as the model returned it)
async function readRecordPhotos(recordId, organizationId) {
  const recordResult = await pool.query(
    'SELECT amount, transaction_date FROM financial_records WHERE id = $1 AND organization_id = $2',
    [recordId, organizationId]
  );
  if (recordResult.rows.length === 0) return { failure: error('Record not found', 404) };

  const stateLink = await pool.query(DESCRIPTION_STATE_LOOKUP, [recordId]);
  const stateId = stateLink.rows[0]?.state_id;
  const description = stateId
    ? (await pool.query('SELECT state_text FROM states WHERE id = $1', [stateId])).rows[0]?.state_text
    : null;
  const photoRows = stateId
    ? (await pool.query('SELECT photo_url FROM state_photos WHERE state_id = $1 ORDER BY photo_order LIMIT $2', [stateId, MAX_EXTRACT_PHOTOS])).rows
    : [];
  if (photoRows.length === 0) return { failure: error('This record has no photos to read', 400) };

  const read = await readExpensePhotos({
    organizationId, description, amount: recordResult.rows[0].amount, transactionDate: recordResult.rows[0].transaction_date,
    photoUrls: photoRows.map((row) => row.photo_url), excludeRecordId: recordId
  });
  if (read.failure) return read;

  const { result, raw } = read;
  await saveExpensePerspective(stateId, {
    vehicle: result.fuel ? { id: result.fuel.machine.id, name: result.fuel.machine.name.trim() } : null,
    odometer: { observed: result.observed.odometer, reading: isNumber(raw.meter_reading) ? raw.meter_reading : null },
    receipt: { observed: result.observed.receipt, purchases: result.purchases },
    pump: { observed: result.observed.pump, liters: isNumber(raw.liters) ? raw.liters : null, octane: typeof raw.octane === 'string' && raw.octane.trim() ? raw.octane.trim() : null },
    vendor: result.vendor,
    policy_ids: result.policies.map((policy) => policy.id)
  });
  return { result, stateId };
}

// The reading as a draft for the person to confirm (the perspective is kept; nothing else is written)
async function extractPurchases(recordId, { organizationId }) {
  const read = await readRecordPhotos(recordId, organizationId);
  return read.failure || success(read.result);
}

// The reading of photos before the expense is saved: nothing is written
async function readPhotosBeforeSave(event, { organizationId }) {
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (parseErr) {
    return error('Invalid JSON in request body', 400);
  }
  const photoUrls = body?.photo_urls;
  if (!Array.isArray(photoUrls) || photoUrls.length === 0 || !photoUrls.every((url) => typeof url === 'string')) return error('photo_urls must be a list of photos', 400);
  if (!isNumber(body.amount)) return error('amount is required', 400);
  const read = await readExpensePhotos({
    organizationId, description: typeof body.description === 'string' ? body.description : '', amount: body.amount,
    transactionDate: body.transaction_date || new Date().toISOString(), photoUrls, excludeRecordId: null
  });
  return read.failure || success(read.result);
}

// The automatic reading when an expense is saved: its photos are read and what was read fills the
// fields that are still empty (purchases, the vehicle's readings, the policy the action follows).
// What a person has already entered or confirmed is left as it is.
async function analyzeExpensePhotos(recordId, organizationId) {
  const read = await readRecordPhotos(recordId, organizationId);
  if (read.failure) {
    console.error('Automatic reading failed for', recordId, read.failure.body);
    return { ok: false };
  }
  const { result } = read;

  const purchaseCount = Number((await pool.query('SELECT count(*) FROM financial_record_purchases WHERE financial_record_id = $1', [recordId])).rows[0].count);
  if (purchaseCount === 0 && result.purchases.length > 0) {
    const failure = await writePurchases(recordId, organizationId, result.purchases);
    if (failure) console.error('Could not save the purchases read for', recordId, failure.body);
  }
  await assignVendor(recordId, organizationId, result.vendor);
  const lookups = await linkPurchaseParts(recordId, organizationId);
  if (lookups.length > 0 && read.stateId) {
    await pool.query(
      `UPDATE state_perspectives SET content = content || jsonb_build_object('part_lookups', $3::jsonb)
        WHERE state_id = $1 AND perspective_type = $2`,
      [read.stateId, EXPENSE_PHOTOS_PERSPECTIVE, JSON.stringify(lookups)]
    );
  }
  await linkPolicies(recordId, organizationId, result.policies.map((policy) => policy.id));
  if (result.fuel && !(await getFuelFill(recordId, organizationId))) {
    const failure = await writeFuelFill(recordId, organizationId, {
      machine_id: result.fuel.machine.id, meter_reading: result.fuel.meter_reading, liters: result.fuel.liters
    });
    if (failure) console.error('Could not save the fuel fill read for', recordId, failure.body);
  }
  return { ok: true };
}

// Vendors this organization has dealt with: organizations with no people, from its receipts and parts
async function knownVendors(organizationId) {
  return (await pool.query(
    `SELECT o.id, o.name FROM organizations o
      WHERE o.is_active AND o.name <> $2
        AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.is_active)
        AND (o.id IN (SELECT vendor_organization_id FROM financial_records WHERE organization_id = $1 AND vendor_organization_id IS NOT NULL)
             OR o.id IN (SELECT organization_id FROM parts WHERE created_by_organization_id = $1))
      ORDER BY o.name`,
    [organizationId, UNKNOWN_VENDOR_NAME]
  )).rows;
}

// Where a receipt goes when we cannot tell who it is from: moving it to the right vendor later is easier than
// undoing a vendor made from a guess
async function unknownVendorId() {
  return (await pool.query('SELECT id FROM organizations WHERE name = $1 AND is_active LIMIT 1', [UNKNOWN_VENDOR_NAME])).rows[0]?.id ?? null;
}

// The record's vendor when it has none: the one its receipt clearly names, else Unknown vendor
async function assignVendor(recordId, organizationId, vendor) {
  const record = (await pool.query('SELECT vendor_organization_id FROM financial_records WHERE id = $1 AND organization_id = $2', [recordId, organizationId])).rows[0];
  if (!record || record.vendor_organization_id) return;
  const vendorId = vendor?.organization_id || await unknownVendorId();
  if (!vendorId) {
    console.error(`No "${UNKNOWN_VENDOR_NAME}" organization to give expense ${recordId}`);
    return;
  }
  await pool.query('UPDATE financial_records SET vendor_organization_id = $1, updated_at = NOW() WHERE id = $2 AND vendor_organization_id IS NULL', [vendorId, recordId]);
}

async function titanEmbedding(text) {
  const reply = await bedrock.send(new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v1', contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ inputText: text })
  }));
  return JSON.parse(new TextDecoder().decode(reply.body)).embedding;
}

const JSON_IN = (text) => {
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (parseErr) { return null; }
};

const SAME_PRODUCT_PROMPT = 'You match a purchase line from a receipt to the vendor\'s catalog. Reply with JSON only: {"part_id": string|null}. Give a part_id only when the line is clearly the same product as that part: same kind, grade, brand and size. Similar is not enough. If none is clearly the same, part_id is null.';

// The vendor's part this line clearly is, or null. Search proposes the closest parts by meaning, and a strict
// check decides: on lines already linked by hand it linked the right part 88% of the time and merged a new
// item into another part 3% of the time (search alone merged about 30%).
async function matchVendorPart(line, vendorId, organizationId) {
  const exact = (await pool.query(
    `SELECT id FROM parts WHERE organization_id = $1 AND created_by_organization_id = $2 AND lower(btrim(name)) = lower(btrim($3)) LIMIT 1`,
    [vendorId, organizationId, line.purchase_text]
  )).rows[0];
  if (exact) return exact.id;

  const vector = `[${(await titanEmbedding(line.purchase_text)).join(',')}]`;
  const candidates = (await pool.query(
    `SELECT p.id, p.name, p.description, p.unit, 1 - (ue.embedding <=> $3::vector) AS similarity
       FROM unified_embeddings ue JOIN parts p ON ue.entity_type = 'part' AND p.id = ue.entity_id
      WHERE p.organization_id = $1 AND p.created_by_organization_id = $2
      ORDER BY ue.embedding <=> $3::vector LIMIT 3`,
    [vendorId, organizationId, vector]
  )).rows.filter((candidate) => Number(candidate.similarity) >= 0.3);
  if (candidates.length === 0) return null;

  const reply = await bedrock.send(new ConverseCommand({
    modelId: EXTRACT_MODEL_ID,
    system: [{ text: SAME_PRODUCT_PROMPT }],
    messages: [{ role: 'user', content: [{ text: `Receipt line: ${JSON.stringify(line.purchase_text)}${line.unit ? `, sold by the ${line.unit}` : ''}\nVendor parts: ${JSON.stringify(candidates.map((c) => ({ part_id: c.id, name: c.name, description: c.description, unit: c.unit })))}` }] }],
    inferenceConfig: { maxTokens: 100, temperature: 0 }
  }));
  const answer = JSON_IN(reply.output.message.content.map((part) => part.text || '').join(''));
  return candidates.some((c) => c.id === answer?.part_id) ? answer.part_id : null;
}

// What an unfamiliar item is. What we already know comes first (a part of ours with that name and a description,
// from any vendor); otherwise the web, through Bedrock's web grounding. Not found: null, and nothing is guessed.
async function whatItemIs(line, vendorName, organizationId) {
  const known = (await pool.query(
    `SELECT description, category FROM parts WHERE created_by_organization_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND description IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
    [organizationId, line.purchase_text]
  )).rows[0];
  if (known) return { description: known.description, category: known.category, source: null };

  const categories = (await pool.query(
    'SELECT DISTINCT category FROM parts WHERE created_by_organization_id = $1 AND category IS NOT NULL ORDER BY category LIMIT 60', [organizationId]
  )).rows.map((row) => row.category);
  const reply = await bedrock.send(new ConverseCommand({
    modelId: WEB_LOOKUP_MODEL_ID,
    messages: [{ role: 'user', content: [{ text:
      `A receipt from ${vendorName} (Philippines) has the line "${line.purchase_text}"${line.unit ? `, sold by the ${line.unit}` : ''}${line.unit_price ? ` at ₱${line.unit_price}` : ''}. Look up what this product is. Reply with JSON only: {"what_it_is": "a plain short description: the generic product first, then brand or grade if any", "found": boolean, "category": "one or two words, the generic kind of product", "source": "the website (domain) that says what this exact product is, or null"}. ${categories.length > 0 ? `Use one of these existing categories if it fits: ${JSON.stringify(categories)}. ` : ''}found is true only when what you find clearly says what this exact product is. If you are guessing or the sources are unclear, found is false. It is also false for anything that is not a product (a discount, a return, a fee, a note).` }] }],
    toolConfig: { tools: [{ systemTool: { name: 'nova_grounding' } }] },
    inferenceConfig: { maxTokens: 600, temperature: 0 }
  }));
  const answer = JSON_IN(reply.output.message.content.map((part) => part.text || '').join(''));
  if (!answer || answer.found !== true || typeof answer.what_it_is !== 'string' || !answer.what_it_is.trim()) return null;
  // Nothing is believed that no page says
  if (typeof answer.source !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(answer.source.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0])) return null;
  // A description that hedges is a guess
  if (/\b(likely|possibly|probably|perhaps|may be|might|appears to|seems|could be|unclear)\b/i.test(answer.what_it_is)) return null;
  // The description says only what the item is; where the web said so is kept on the expense's perspective,
  // since a source in the part's text would be embedded with it
  return {
    description: answer.what_it_is.trim().replace(/[.\s]+$/, ''),
    category: typeof answer.category === 'string' && answer.category.trim() ? answer.category.trim() : null,
    source: answer.source.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]
  };
}

// A new part of the vendor's: named as the receipt writes it, described in plain words
async function createVendorPart(line, what, vendorId, organizationId) {
  const partId = randomUUID();
  const price = line.unit_price ?? (line.quantity ? Math.round((line.amount / line.quantity) * 100) / 100 : null);
  await pool.query(
    `INSERT INTO parts (id, name, description, category, current_quantity, minimum_quantity, unit, organization_id, sellable, cost_per_unit, created_by_organization_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, 0, $5, $6, false, $7, $8, NOW(), NOW())`,
    [partId, line.purchase_text.trim(), what.description, what.category, line.unit, vendorId, price, organizationId]
  );
  await sqs.send(new SendMessageCommand({
    QueueUrl: EMBEDDINGS_QUEUE_URL,
    MessageBody: JSON.stringify({ entity_type: 'part', entity_id: partId, embedding_source: [line.purchase_text.trim(), what.description].filter(Boolean).join('. '), organization_id: vendorId })
  })).catch((err) => console.error('Failed to queue embedding for part:', err));
  return partId;
}

// Links each of the record's purchases to the vendor's part: the one it clearly is, else a new part when we can
// tell what it is. Under Unknown vendor, or when nothing is clear, a line stays unlinked: nothing is guessed.
// Returns the parts made from a web lookup, with the site that said what each is.
async function linkPurchaseParts(recordId, organizationId) {
  const record = (await pool.query('SELECT vendor_organization_id FROM financial_records WHERE id = $1 AND organization_id = $2', [recordId, organizationId])).rows[0];
  const vendorId = record?.vendor_organization_id;
  if (!vendorId || vendorId === await unknownVendorId()) return [];
  const vendorName = (await pool.query('SELECT name FROM organizations WHERE id = $1', [vendorId])).rows[0]?.name || 'a vendor';

  const lines = (await pool.query(
    'SELECT id, purchase_text, quantity, unit, unit_price, amount FROM financial_record_purchases WHERE financial_record_id = $1 AND part_id IS NULL ORDER BY created_at, id',
    [recordId]
  )).rows;
  const lookups = [];
  for (const line of lines) {
    try {
      let partId = await matchVendorPart(line, vendorId, organizationId);
      if (!partId) {
        const what = await whatItemIs(line, vendorName, organizationId);
        if (what) {
          partId = await createVendorPart(line, what, vendorId, organizationId);
          if (what.source) lookups.push({ line: line.purchase_text, part_id: partId, source: what.source });
        }
      }
      if (partId) await pool.query('UPDATE financial_record_purchases SET part_id = $1, updated_at = NOW() WHERE id = $2', [partId, line.id]);
    } catch (err) {
      console.error(`Could not link "${line.purchase_text}" of ${recordId} to a part:`, err.message);
    }
  }
  return lookups;
}

// The policies the record's action follows, with these added
async function linkPolicies(recordId, organizationId, policyIds) {
  if (policyIds.length === 0) return;
  await pool.query(
    `INSERT INTO action_policies (action_id, policy_id)
     SELECT fr.action_id, p.id FROM financial_records fr, policy p
      WHERE fr.id = $1 AND fr.organization_id = $2 AND fr.action_id IS NOT NULL AND p.organization_id = $2 AND p.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [recordId, organizationId, policyIds]
  );
}

const ratePerUnit = (machine, reading, liters, previous) => {
  const used = reading !== null && previous && reading > previous.meter_reading ? reading - previous.meter_reading : null;
  if (used === null || liters === null) return null;
  return Math.round((machine.rate_unit === 'km/l' ? used / liters : liters / used) * 100) / 100;
};

// The machine's previous reading, not counting any this record already made
async function previousReading(machine, recordId, transactionDate) {
  const row = (await pool.query(
    `SELECT ms.value, s.captured_at FROM metric_snapshots ms JOIN states s ON s.id = ms.state_id
      WHERE ms.metric_id = $1 AND s.captured_at < $2
        AND NOT EXISTS (SELECT 1 FROM state_links sl WHERE sl.state_id = s.id AND sl.entity_type = 'financial_record' AND sl.entity_id = $3)
      ORDER BY s.captured_at DESC LIMIT 1`,
    [machine.meter_metric_id, transactionDate, recordId]
  )).rows[0];
  return row ? { meter_reading: Number(row.value), date: row.captured_at } : null;
}

// The fuel fill saved on the record's description: the vehicle it was for, with its readings.
// The rate (km/l) is worked out from them, not saved.
async function getFuelFill(recordId, organizationId) {
  const stateId = (await pool.query(DESCRIPTION_STATE_LOOKUP, [recordId])).rows[0]?.state_id;
  const machines = await vehiclesOf(organizationId);
  if (!stateId || machines.length === 0) return null;
  const link = (await pool.query(
    `SELECT entity_id FROM state_links WHERE state_id = $1 AND entity_type = 'tool' AND entity_id = ANY($2::uuid[]) LIMIT 1`,
    [stateId, machines.map((m) => m.id)]
  )).rows[0];
  if (!link) return null;
  const machine = machines.find((m) => m.id === link.entity_id);
  const values = (await pool.query(
    'SELECT metric_id, value FROM metric_snapshots WHERE state_id = $1 AND metric_id = ANY($2::uuid[])',
    [stateId, [machine.meter_metric_id, machine.fuel_metric_id].filter(Boolean)]
  )).rows;
  const meter = values.find((row) => row.metric_id === machine.meter_metric_id);
  const fuel = values.find((row) => row.metric_id === machine.fuel_metric_id);
  const reading = meter ? Number(meter.value) : null;
  const liters = fuel ? Number(fuel.value) : null;
  const date = (await pool.query('SELECT transaction_date FROM financial_records WHERE id = $1', [recordId])).rows[0]?.transaction_date;
  const previous = await previousReading(machine, recordId, date);
  return { machine: machineInfo(machine), meter_reading: reading, liters, previous, rate: ratePerUnit(machine, reading, liters, previous) };
}

// Saves the fuel fill on the record's description: the vehicle (a link to it) and its readings
// (the odometer and the liters). Readings not given are removed; another vehicle's are cleared.
// With no machine_id the record is not a fuel fill.
async function writeFuelFill(recordId, organizationId, fill) {
  const stateId = (await pool.query(DESCRIPTION_STATE_LOOKUP, [recordId])).rows[0]?.state_id;
  if (!stateId) return error('The record has no description to hold the fuel fill', 400);
  const machines = await vehiclesOf(organizationId);
  const machine = fill.machine_id ? machines.find((m) => m.id === fill.machine_id) : null;
  if (fill.machine_id && !machine) return error('That is not a vehicle of this organization', 400);
  const others = machines.filter((m) => m.id !== machine?.id);
  const reading = fill.meter_reading ?? null;
  const liters = fill.liters ?? null;
  if ((reading !== null && !isNumber(reading)) || (liters !== null && !isNumber(liters))) return error('The readings must be numbers', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Another vehicle's link and readings on this description are removed
    if (others.length > 0) {
      await client.query(`DELETE FROM state_links WHERE state_id = $1 AND entity_type = 'tool' AND entity_id = ANY($2::uuid[])`, [stateId, others.map((m) => m.id)]);
      await client.query(
        'DELETE FROM metric_snapshots WHERE state_id = $1 AND metric_id = ANY($2::uuid[])',
        [stateId, others.flatMap((m) => [m.meter_metric_id, m.fuel_metric_id]).filter(Boolean)]
      );
    }
    if (machine) {
      await client.query(
        `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'tool', $2) ON CONFLICT (state_id, entity_type, entity_id) DO NOTHING`,
        [stateId, machine.id]
      );
      for (const [metricId, value] of [[machine.meter_metric_id, reading], [machine.fuel_metric_id, liters]]) {
        if (!metricId) continue;
        if (value === null) {
          await client.query('DELETE FROM metric_snapshots WHERE state_id = $1 AND metric_id = $2', [stateId, metricId]);
        } else {
          await client.query(
            `INSERT INTO metric_snapshots (state_id, metric_id, value) VALUES ($1, $2, $3)
             ON CONFLICT (state_id, metric_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [stateId, metricId, String(value)]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return null;
}

// PUT /api/financial-records/:id/fuel-fill - the fuel fill the person confirmed or corrected
async function saveFuelFill(event, recordId, { organizationId, cognitoUserId, permissions }) {
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (parseErr) {
    return error('Invalid JSON in request body', 400);
  }
  const recordResult = await pool.query('SELECT created_by FROM financial_records WHERE id = $1 AND organization_id = $2', [recordId, organizationId]);
  if (recordResult.rows.length === 0) return error('Record not found', 404);
  const createdBy = recordResult.rows[0].created_by;
  const isOwner = createdBy && createdBy.toString() === cognitoUserId.toString();
  if (!isOwner && !hasPermission({ permissions }, 'data:write:all') && !hasPermission({ permissions }, 'data:write:org')) {
    return error('Not authorized to edit this record', 403);
  }
  const failure = await writeFuelFill(recordId, organizationId, body || {});
  if (failure) return failure;
  if (Array.isArray(body?.policy_ids) && body.policy_ids.every((id) => typeof id === 'string' && UUID.test(id))) {
    await linkPolicies(recordId, organizationId, body.policy_ids);
  }
  return success({ fuel_fill: await getFuelFill(recordId, organizationId) });
}

// The config (model and instructions) the reader runs with, created the first time
async function getExtractConfig() {
  const existing = await pool.query('SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1', [EXTRACT_MODEL_ID, EXTRACT_VERSION]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await pool.query(
    'INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config) VALUES ($1, $2, $3, $4) RETURNING id',
    [EXTRACT_MODEL_ID, EXTRACT_VERSION, EXTRACT_SYSTEM_PROMPT, JSON.stringify({ max_tokens: EXTRACT_INFERENCE.maxTokens, temperature: EXTRACT_INFERENCE.temperature })]
  );
  return inserted.rows[0].id;
}

// One perspective of the photos per description: reading the photos again updates it
async function saveExpensePerspective(stateId, content) {
  const configId = await getExtractConfig();
  const existing = await pool.query(
    'SELECT id FROM state_perspectives WHERE state_id = $1 AND perspective_type = $2 ORDER BY created_at DESC LIMIT 1',
    [stateId, EXPENSE_PHOTOS_PERSPECTIVE]
  );
  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE state_perspectives SET content = $2, llm_generation_config_id = $3, status = 'SUCCESS', error_message = NULL, created_at = NOW() WHERE id = $1`,
      [existing.rows[0].id, JSON.stringify(content), configId]
    );
  } else {
    await pool.query(
      `INSERT INTO state_perspectives (state_id, perspective_type, llm_generation_config_id, status, content) VALUES ($1, $2, $3, 'SUCCESS', $4)`,
      [stateId, EXPENSE_PHOTOS_PERSPECTIVE, configId, JSON.stringify(content)]
    );
  }
}

const machineInfo = (machine) => ({
  id: machine.id, name: machine.name, meter_name: machine.meter_name, meter_unit: machine.meter_unit, rate_unit: machine.rate_unit,
  meter_metric_id: machine.meter_metric_id, rate_metric_id: machine.rate_metric_id, fuel_metric_id: machine.fuel_metric_id
});

// The farthest a machine goes between two fills
const MAX_METER_BETWEEN_FILLS = 1000;

// A drum odometer is often misread: a last digit that is tenths, a part-rolled drum read
// as a leading digit, or a leading digit missed. Given the previous reading, the candidate
// that is above it and within a plausible distance is the reading (the one nearest to
// it); when none fits, the reading stays as it was read. On photos the reader got wrong,
// this brought odometers from 1 in 10 right to 7 in 10.
function fitMeterReading(read, previous) {
  const digits = String(Math.trunc(read));
  const candidates = new Set([read, Math.trunc(read / 10), Number(`1${digits}`)]);
  for (let i = 1; i < digits.length; i++) candidates.add(Number(digits.slice(i)));
  const fits = [...candidates]
    .filter((candidate) => candidate >= previous - 1 && candidate <= previous + MAX_METER_BETWEEN_FILLS)
    .sort((a, b) => Math.abs(a - previous) - Math.abs(b - previous));
  return fits.length > 0 ? fits[0] : read;
}

// What was read of a fill-up, with the rate it gives: distance since the machine's previous
// odometer reading per liter added (km/l), or liters added per hour on its hour meter (L/h).
// A fill to full is the policy, so the liters are what was consumed since the last fill.
async function fuelFill(fuel, machines, recordId, transactionDate) {
  const machine = machines.find((m) => m.id === fuel?.machine_id);
  if (!machine) return null;
  const readAs = isNumber(fuel.meter_reading) ? fuel.meter_reading : null;
  const liters = isNumber(fuel.liters) && fuel.liters > 0 ? fuel.liters : null;

  const previous = await previousReading(machine, recordId, transactionDate);
  const reading = readAs !== null && previous ? fitMeterReading(readAs, previous.meter_reading) : readAs;

  return {
    machine: machineInfo(machine),
    meter_reading: reading,
    // What was read, when it was corrected to fit the previous reading
    meter_reading_read: reading !== readAs ? readAs : null,
    liters,
    octane: typeof fuel.octane === 'string' && fuel.octane.trim() ? fuel.octane.trim() : null,
    previous,
    rate: ratePerUnit(machine, reading, liters, previous)
  };
}

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
    'SELECT created_by FROM financial_records WHERE id = $1 AND organization_id = $2',
    [recordId, organizationId]
  );
  if (recordResult.rows.length === 0) return error('Record not found', 404);

  // Same rule as editing the record: its recorder, or write permission
  const createdBy = recordResult.rows[0].created_by;
  const isOwner = createdBy && createdBy.toString() === cognitoUserId.toString();
  if (!isOwner && !hasPermission({ permissions }, 'data:write:all') && !hasPermission({ permissions }, 'data:write:org')) {
    return error('Not authorized to edit this record', 403);
  }

  const failure = await writePurchases(recordId, organizationId, purchases);
  if (failure) return failure;
  return await getPurchases(recordId, { organizationId });
}

// Writes the purchases (as savePurchases describes), for the HTTP route and for the automatic
// reading alike; returns an error response, or null when they were saved.
async function writePurchases(recordId, organizationId, purchases) {
  const problem = purchases.map(purchaseProblem).find(Boolean);
  if (problem) return error(problem, 400);
  const recordResult = await pool.query(
    'SELECT vendor_organization_id FROM financial_records WHERE id = $1 AND organization_id = $2',
    [recordId, organizationId]
  );
  if (recordResult.rows.length === 0) return error('Record not found', 404);

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

  return null;
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
