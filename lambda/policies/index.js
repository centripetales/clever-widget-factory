const { Pool } = require('pg');
const { getAuthorizerContext, hasPermission } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');

const success = (data) => successResponse(data);
const error = (message, statusCode = 500) => errorResponse(statusCode, message);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const STATUSES = ['draft', 'active', 'deprecated'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLICY_COLUMNS = 'id, title, description_text, status, effective_from, effective_to, created_at, updated_at';

exports.handler = async (event) => {
  const { httpMethod, path, pathParameters } = event;
  if (httpMethod === 'OPTIONS') return successResponse('');

  let authContext;
  try {
    authContext = getAuthorizerContext(event);
  } catch (err) {
    console.error('Error getting authorizer context:', err);
  }
  const organizationId = authContext?.organization_id;
  if (!organizationId) return error('Organization ID not found', 401);
  const context = { organizationId, cognitoUserId: authContext.cognito_user_id, permissions: authContext.permissions || [] };

  try {
    // GET/PUT /api/actions/:id/policies - the policies an action follows
    if (pathParameters?.id && path.includes('/actions/') && path.endsWith('/policies')) {
      if (httpMethod === 'GET') return await getActionPolicies(pathParameters.id, context);
      if (httpMethod === 'PUT') return await setActionPolicies(event, pathParameters.id, context);
    }
    if (path.includes('/policies')) {
      if (httpMethod === 'GET' && pathParameters?.id) return await getPolicy(pathParameters.id, context);
      if (httpMethod === 'GET') return await listPolicies(event.queryStringParameters, context);
      if (httpMethod === 'POST') return await createPolicy(event, context);
      if (httpMethod === 'PUT' && pathParameters?.id) return await updatePolicy(event, pathParameters.id, context);
    }
    return error('Not found', 404);
  } catch (err) {
    console.error('Policies lambda error:', err);
    return error(err.message || 'Internal server error', 500);
  }
};

const canWrite = ({ permissions }) => hasPermission({ permissions }, 'data:write:all') || hasPermission({ permissions }, 'data:write:org');

function parseBody(event) {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  } catch (parseErr) {
    return null;
  }
}

async function listPolicies(query, { organizationId }) {
  const status = query?.status;
  if (status && !STATUSES.includes(status)) return error(`status must be one of ${STATUSES.join(', ')}`, 400);
  const result = await pool.query(
    `SELECT ${POLICY_COLUMNS} FROM policy WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY title`,
    [organizationId, status || null]
  );
  return success({ policies: result.rows });
}

async function getPolicy(id, { organizationId }) {
  if (!UUID.test(id)) return error('Policy not found', 404);
  const result = await pool.query(`SELECT ${POLICY_COLUMNS} FROM policy WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
  if (result.rows.length === 0) return error('Policy not found', 404);
  return success({ policy: result.rows[0] });
}

async function createPolicy(event, context) {
  if (!canWrite(context)) return error('Not authorized to create policies', 403);
  const body = parseBody(event);
  if (!body) return error('Invalid JSON in request body', 400);
  const { title, description_text, status = 'draft', effective_from = null, effective_to = null } = body;
  if (typeof title !== 'string' || !title.trim()) return error('title is required', 400);
  if (typeof description_text !== 'string' || !description_text.trim()) return error('description_text is required', 400);
  if (!STATUSES.includes(status)) return error(`status must be one of ${STATUSES.join(', ')}`, 400);

  const result = await pool.query(
    `INSERT INTO policy (organization_id, title, description_text, status, effective_from, effective_to, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${POLICY_COLUMNS}`,
    [context.organizationId, title.trim(), description_text.trim(), status, effective_from, effective_to, context.cognitoUserId]
  );
  return success({ policy: result.rows[0] });
}

// Only the fields given change. A policy is retired by setting it deprecated,
// not deleted: actions that followed it keep following it.
async function updatePolicy(event, id, context) {
  if (!canWrite(context)) return error('Not authorized to edit policies', 403);
  if (!UUID.test(id)) return error('Policy not found', 404);
  const body = parseBody(event);
  if (!body) return error('Invalid JSON in request body', 400);

  const changes = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) return error('title cannot be empty', 400);
    changes.title = body.title.trim();
  }
  if (body.description_text !== undefined) {
    if (typeof body.description_text !== 'string' || !body.description_text.trim()) return error('description_text cannot be empty', 400);
    changes.description_text = body.description_text.trim();
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return error(`status must be one of ${STATUSES.join(', ')}`, 400);
    changes.status = body.status;
  }
  if (body.effective_from !== undefined) changes.effective_from = body.effective_from;
  if (body.effective_to !== undefined) changes.effective_to = body.effective_to;
  const fields = Object.keys(changes);
  if (fields.length === 0) return error('Nothing to change', 400);

  const result = await pool.query(
    `UPDATE policy SET ${fields.map((field, i) => `${field} = $${i + 3}`).join(', ')}, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 RETURNING ${POLICY_COLUMNS}`,
    [id, context.organizationId, ...fields.map((field) => changes[field])]
  );
  if (result.rows.length === 0) return error('Policy not found', 404);
  return success({ policy: result.rows[0] });
}

async function actionInOrg(actionId, organizationId) {
  if (!UUID.test(actionId)) return null;
  const result = await pool.query('SELECT id, created_by FROM actions WHERE id = $1 AND organization_id = $2', [actionId, organizationId]);
  return result.rows[0] || null;
}

async function getActionPolicies(actionId, { organizationId }) {
  if (!(await actionInOrg(actionId, organizationId))) return error('Action not found', 404);
  const result = await pool.query(
    `SELECT p.id, p.title, p.description_text, p.status
       FROM action_policies ap JOIN policy p ON p.id = ap.policy_id
      WHERE ap.action_id = $1 ORDER BY p.title`,
    [actionId]
  );
  return success({ policies: result.rows });
}

// The policies given are the ones the action follows: those it doesn't follow
// yet are added and the rest are removed; the ones already followed are untouched.
async function setActionPolicies(event, actionId, context) {
  const body = parseBody(event);
  if (!body) return error('Invalid JSON in request body', 400);
  const policyIds = body.policy_ids;
  if (!Array.isArray(policyIds) || !policyIds.every((id) => typeof id === 'string' && UUID.test(id))) {
    return error('policy_ids must be a list of policy ids', 400);
  }

  const action = await actionInOrg(actionId, context.organizationId);
  if (!action) return error('Action not found', 404);
  const isOwner = action.created_by && action.created_by.toString() === String(context.cognitoUserId);
  if (!isOwner && !canWrite(context)) return error('Not authorized to edit this action', 403);

  const wanted = [...new Set(policyIds)];
  if (wanted.length > 0) {
    const found = await pool.query('SELECT id FROM policy WHERE id = ANY($1::uuid[]) AND organization_id = $2', [wanted, context.organizationId]);
    const missing = wanted.find((id) => !found.rows.some((row) => row.id === id));
    if (missing) return error(`Policy ${missing} is not a policy of this organization`, 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM action_policies WHERE action_id = $1 AND NOT (policy_id = ANY($2::uuid[]))', [actionId, wanted]);
    await client.query(
      'INSERT INTO action_policies (action_id, policy_id) SELECT $1, UNNEST($2::uuid[]) ON CONFLICT DO NOTHING',
      [actionId, wanted]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return await getActionPolicies(actionId, context);
}
