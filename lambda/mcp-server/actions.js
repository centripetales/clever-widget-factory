import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Writes go through the app's own services (cwf-actions-lambda,
// cwf-states-lambda), so they get the same fields, search data, claims and
// live refresh as in the app. The event mirrors what API Gateway sends: the
// authorizer's own context for the person (so they may do exactly what the
// app lets them), and X-Organization-Id to work in another of their orgs, as
// the app's organization switcher does.
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' });
const AUTHORIZER = 'cwf-api-authorizer';

async function invoke(functionName, payload) {
  const res = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(payload)) }));
  const reply = JSON.parse(Buffer.from(res.Payload).toString());
  if (res.FunctionError) throw new Error(reply?.errorMessage || `${functionName} failed`);
  return reply;
}

async function invokeApp(functionName, path, body, { cognitoUserId, orgId }, { method = 'POST', id } = {}) {
  const authorizer = await invoke(AUTHORIZER, { contextFor: cognitoUserId });
  const reply = await invoke(functionName, {
    httpMethod: method,
    path,
    pathParameters: id ? { id } : undefined,
    headers: orgId ? { 'X-Organization-Id': orgId } : {},
    body: JSON.stringify(body),
    requestContext: { authorizer },
  });
  const data = typeof reply.body === 'string' ? JSON.parse(reply.body) : reply.body;
  if (!(reply.statusCode >= 200 && reply.statusCode < 300)) {
    throw new Error(data?.error || `${functionName} answered ${reply.statusCode}`);
  }
  return data;
}

export async function createAction({ cognitoUserId, action }) {
  return (await invokeApp('cwf-actions-lambda', '/api/actions', action, { cognitoUserId })).data;
}

// Only the fields given change, in the action's org (orgId).
export async function updateAction({ cognitoUserId, orgId, actionId, changes }) {
  return (await invokeApp('cwf-actions-lambda', `/api/actions/${actionId}`, changes, { cognitoUserId, orgId }, { method: 'PUT', id: actionId })).data;
}

// The states service answers with the saved observation itself.
export async function createObservation({ cognitoUserId, observation }) {
  return invokeApp('cwf-states-lambda', '/api/states', observation, { cognitoUserId });
}

// Only the fields given change, but `links` replaces all of an observation's
// links, so it must be the full list. The states service decides who may edit
// it (the person who recorded it, or an admin), as in the app.
export async function updateObservation({ cognitoUserId, orgId, observationId, changes }) {
  return invokeApp('cwf-states-lambda', `/api/states/${observationId}`, changes, { cognitoUserId, orgId }, { method: 'PUT', id: observationId });
}

// The app stores policy as rich text (HTML); spoken plans arrive as plain text.
export function policyToHtml(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.trim().split(/\n\s*\n/).map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}
