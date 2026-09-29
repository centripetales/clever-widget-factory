// Maxwell (Bedrock agent) action group "PositiveSum", served by the same
// routes as the web app so validation and membership checks are shared.
// Identity comes from session attributes set server-side by the Maxwell
// worker (cognito_user_id); memberships are read from the database.
const { Client } = require('pg');
const { handlePositiveSum } = require('./positiveSum');

// Only Maxwell may call these operations.
const MAXWELL_AGENT_ID = process.env.MAXWELL_AGENT_ID || 'CNV04Q1OAZ';

function isAgentEvent(event) {
  return !!(event && event.messageVersion && event.actionGroup && event.apiPath);
}

// Bedrock passes query parameters and JSON body properties as [{ name, value }].
function agentParams(event) {
  const params = {};
  for (const p of event.parameters || []) params[p.name] = p.value;
  for (const p of event.requestBody?.content?.['application/json']?.properties || []) params[p.name] = p.value;
  return params;
}

// Array parameters arrive as strings: '["a","b"]', '[a, b]' or 'a,b'.
function toList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const text = String(value).trim();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* fall through */ }
  return text.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function envelope(event, statusCode, body) {
  return {
    messageVersion: '1.0',
    response: {
      actionGroup: event.actionGroup,
      apiPath: event.apiPath,
      httpMethod: event.httpMethod,
      httpStatusCode: statusCode,
      responseBody: { 'application/json': { body: JSON.stringify(body) } },
    },
  };
}

async function memberships(dbConfig, cognitoUserId) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT organization_id, role FROM organization_members WHERE cognito_user_id = $1 AND is_active = true`,
      [cognitoUserId]
    );
    return rows;
  } finally {
    await client.end();
  }
}

// Translate an agent operation into the equivalent web request.
function toRequest(event, params) {
  const session = event.sessionAttributes || {};
  if (event.apiPath === '/getGoalContext') {
    const goalId = params.goal_id || session.entityId;
    return { httpMethod: 'GET', path: `/api/positive-sum/goals/${goalId}/context`, body: null };
  }
  if (event.apiPath === '/createOption') {
    const goalIds = toList(params.goal_ids);
    return {
      httpMethod: 'POST',
      path: '/api/positive-sum/options',
      body: {
        goal_ids: goalIds.length ? goalIds : (session.entityId ? [session.entityId] : []),
        source_option_ids: toList(params.source_option_ids),
        title: params.title,
        initial_state: params.initial_state,
        policy: params.policy,
        final_state: params.final_state,
        capacity: Number(params.capacity) || 1,
        parent_option_id: params.parent_option_id || null,
        conversation_state_ids: [],
      },
    };
  }
  return null;
}

async function handleAgentEvent(event, { dbConfig, queueEmbedding, notify }) {
  if (event.agent?.id !== MAXWELL_AGENT_ID) return envelope(event, 403, { error: 'Unknown agent' });
  const cognitoUserId = event.sessionAttributes?.cognito_user_id;
  if (!cognitoUserId) return envelope(event, 401, { error: 'Missing user in session' });

  const params = agentParams(event);
  const request = toRequest(event, params);
  if (!request) return envelope(event, 404, { error: `Unknown operation ${event.apiPath}` });

  const authContext = {
    cognito_user_id: cognitoUserId,
    organization_memberships: await memberships(dbConfig, cognitoUserId),
  };
  try {
    const { statusCode, data } = await handlePositiveSum({
      event: { httpMethod: request.httpMethod, path: request.path, body: request.body && JSON.stringify(request.body) },
      authContext,
      dbConfig,
      queueEmbedding,
      notify,
    });
    return envelope(event, statusCode, data);
  } catch (error) {
    return envelope(event, error.statusCode || 500, { error: error.message });
  }
}

module.exports = { isAgentEvent, handleAgentEvent, toList, toRequest };
