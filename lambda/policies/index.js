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

const STATUSES = ['active', 'deprecated'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// With the observations and experiences it rests on (its sources), oldest link first
const POLICY_COLUMNS = `id, title, description_text, reasoning, status, effective_from, effective_to, created_at, updated_at,
  ARRAY(SELECT ps.state_id FROM policy_sources ps WHERE ps.policy_id = policy.id AND ps.state_id IS NOT NULL ORDER BY ps.created_at, ps.id) AS observation_ids,
  ARRAY(SELECT ps.experience_id FROM policy_sources ps WHERE ps.policy_id = policy.id AND ps.experience_id IS NOT NULL ORDER BY ps.created_at, ps.id) AS experience_ids`;

// The two kinds of source: the field that lists them, the policy_sources column
// and which ids are really that kind in the caller's orgs. An observation is a
// person's, not a record the app keeps as a state.
const SOURCES = [
  {
    field: 'observation_ids', column: 'state_id', name: 'observation',
    findSql: `SELECT s.id FROM states s
      WHERE s.id = ANY($1::uuid[]) AND s.organization_id = ANY($2::uuid[])
        AND COALESCE(s.state_text, '') NOT LIKE '{"type":"positive_sum.%'
        AND COALESCE(s.state_text, '') NOT LIKE '[%'
        AND NOT EXISTS (SELECT 1 FROM state_links lo WHERE lo.state_id = s.id AND lo.entity_type = 'learning_objective')`,
  },
  {
    field: 'experience_ids', column: 'experience_id', name: 'experience',
    findSql: 'SELECT id FROM experiences WHERE id = ANY($1::uuid[]) AND organization_id = ANY($2::uuid[])',
  },
];

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
  // A policy can rest on sources from any of the caller's orgs, so these are
  // read before the X-Organization-Id header narrows them to one
  let memberOrgIds = [];
  try {
    memberOrgIds = JSON.parse(event.requestContext?.authorizer?.accessible_organization_ids || '[]');
  } catch (err) {
    console.error('Could not read the accessible organizations:', err);
  }
  const context = {
    organizationId,
    memberOrgIds: memberOrgIds.length > 0 ? memberOrgIds : [organizationId],
    cognitoUserId: authContext.cognito_user_id,
    permissions: authContext.permissions || [],
  };

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

// The reasoning behind a policy is optional: text, or nothing (null or blank clears it).
const isReasoning = (value) => value === null || typeof value === 'string';

// The source lists given in a request, each without repeats; a list left out is
// not in the result. A problem is returned for anything but lists of ids.
function sourceLists(body) {
  const lists = {};
  for (const { field } of SOURCES) {
    const ids = body[field];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && UUID.test(id))) {
      return { problem: `${field} must be a list of ids` };
    }
    lists[field] = [...new Set(ids.map((id) => id.toLowerCase()))];
  }
  return { lists };
}

// Makes each list given the policy's sources of that kind: new ones are added,
// those left out are removed and the rest are untouched. Only new ones are
// checked. Returns a problem, for the caller to undo, when one is not found.
async function saveSources(client, policyId, lists, { memberOrgIds }) {
  for (const { field, column, name, findSql } of SOURCES) {
    const wanted = lists[field];
    if (!wanted) continue;
    const current = (await client.query(
      `SELECT ${column} AS id FROM policy_sources WHERE policy_id = $1 AND ${column} IS NOT NULL`,
      [policyId]
    )).rows.map((row) => row.id);
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));
    if (added.length > 0) {
      const found = (await client.query(findSql, [added, memberOrgIds])).rows.map((row) => row.id);
      const missing = added.find((id) => !found.includes(id));
      if (missing) return `No ${name} ${missing} in your organizations`;
    }
    if (removed.length > 0) {
      await client.query(`DELETE FROM policy_sources WHERE policy_id = $1 AND ${column} = ANY($2::uuid[])`, [policyId, removed]);
    }
    if (added.length > 0) {
      await client.query(`INSERT INTO policy_sources (policy_id, ${column}) SELECT $1, UNNEST($2::uuid[])`, [policyId, added]);
    }
  }
  return null;
}

// Runs the work in one transaction; a response with an error status undoes it.
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const response = await work(client);
    await client.query(response.statusCode < 300 ? 'COMMIT' : 'ROLLBACK');
    return response;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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
  const { title, description_text, reasoning = null, status = 'active', effective_from = null, effective_to = null } = body;
  if (typeof title !== 'string' || !title.trim()) return error('title is required', 400);
  if (typeof description_text !== 'string' || !description_text.trim()) return error('description_text is required', 400);
  if (!isReasoning(reasoning)) return error('reasoning must be text', 400);
  if (!STATUSES.includes(status)) return error(`status must be one of ${STATUSES.join(', ')}`, 400);

  const { lists, problem } = sourceLists(body);
  if (problem) return error(problem, 400);

  return await inTransaction(async (client) => {
    const { id } = (await client.query(
      `INSERT INTO policy (organization_id, title, description_text, reasoning, status, effective_from, effective_to, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [context.organizationId, title.trim(), description_text.trim(), reasoning?.trim() || null, status, effective_from, effective_to,
        context.cognitoUserId]
    )).rows[0];
    const sourceProblem = await saveSources(client, id, lists, context);
    if (sourceProblem) return error(sourceProblem, 400);
    // Read back after the links are saved, so the sources are in it
    const result = await client.query(`SELECT ${POLICY_COLUMNS} FROM policy WHERE id = $1`, [id]);
    return success({ policy: result.rows[0] });
  });
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
  if (body.reasoning !== undefined) {
    if (!isReasoning(body.reasoning)) return error('reasoning must be text', 400);
    changes.reasoning = body.reasoning?.trim() || null;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return error(`status must be one of ${STATUSES.join(', ')}`, 400);
    changes.status = body.status;
  }
  if (body.effective_from !== undefined) changes.effective_from = body.effective_from;
  if (body.effective_to !== undefined) changes.effective_to = body.effective_to;
  const { lists, problem } = sourceLists(body);
  if (problem) return error(problem, 400);
  const fields = Object.keys(changes);
  if (fields.length === 0 && Object.keys(lists).length === 0) return error('Nothing to change', 400);

  return await inTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE policy SET ${[...fields.map((field, i) => `${field} = $${i + 3}`), 'updated_at = NOW()'].join(', ')}
        WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [id, context.organizationId, ...fields.map((field) => changes[field])]
    );
    if (updated.rows.length === 0) return error('Policy not found', 404);
    const sourceProblem = await saveSources(client, id, lists, context);
    if (sourceProblem) return error(sourceProblem, 400);
    const result = await client.query(`SELECT ${POLICY_COLUMNS} FROM policy WHERE id = $1`, [id]);
    return success({ policy: result.rows[0] });
  });
}

async function actionInOrg(actionId, organizationId) {
  if (!UUID.test(actionId)) return null;
  const result = await pool.query('SELECT id, created_by FROM actions WHERE id = $1 AND organization_id = $2', [actionId, organizationId]);
  return result.rows[0] || null;
}

async function getActionPolicies(actionId, { organizationId }) {
  if (!(await actionInOrg(actionId, organizationId))) return error('Action not found', 404);
  const result = await pool.query(
    `SELECT p.id, p.title, p.description_text, p.reasoning, p.status
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
    // With whether the action already follows each: a retired policy stays on
    // the actions that follow it, and is not linked to any other.
    const found = await pool.query(
      `SELECT p.id, p.status, EXISTS (SELECT 1 FROM action_policies ap WHERE ap.action_id = $3 AND ap.policy_id = p.id) AS linked
         FROM policy p WHERE p.id = ANY($1::uuid[]) AND p.organization_id = $2`,
      [wanted, context.organizationId, actionId]
    );
    const missing = wanted.find((id) => !found.rows.some((row) => row.id === id));
    if (missing) return error(`Policy ${missing} is not a policy of this organization`, 400);
    const retired = found.rows.find((row) => row.status === 'deprecated' && !row.linked);
    if (retired) return error(`Policy ${retired.id} is retired, so it cannot be newly linked`, 400);
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
