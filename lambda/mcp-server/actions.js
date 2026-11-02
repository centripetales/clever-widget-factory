import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Writes go through the app's own services (cwf-actions-lambda,
// cwf-states-lambda), so they get the same fields, search data, claims and
// live refresh as in the app. The event mirrors what API Gateway and the
// authorizer send.
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' });

async function invokeApp(functionName, path, body, { cognitoUserId, orgIds }, { method = 'POST', id } = {}) {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    Payload: Buffer.from(JSON.stringify({
      httpMethod: method,
      path,
      pathParameters: id ? { id } : undefined,
      headers: {},
      body: JSON.stringify(body),
      requestContext: {
        authorizer: {
          organization_id: orgIds[0],
          accessible_organization_ids: JSON.stringify(orgIds),
          cognito_user_id: cognitoUserId,
        },
      },
    })),
  }));
  const reply = JSON.parse(Buffer.from(res.Payload).toString());
  const data = typeof reply.body === 'string' ? JSON.parse(reply.body) : reply.body;
  if (res.FunctionError || !(reply.statusCode >= 200 && reply.statusCode < 300)) {
    throw new Error(data?.error || reply.errorMessage || `${functionName} answered ${reply.statusCode}`);
  }
  return data;
}

export async function createAction({ cognitoUserId, orgIds, action }) {
  return (await invokeApp('cwf-actions-lambda', '/api/actions', action, { cognitoUserId, orgIds })).data;
}

// Only the fields given change; the actions service scopes the edit to the
// first org, so pass the action's org first.
export async function updateAction({ cognitoUserId, orgIds, actionId, changes }) {
  return (await invokeApp('cwf-actions-lambda', `/api/actions/${actionId}`, changes, { cognitoUserId, orgIds }, { method: 'PUT', id: actionId })).data;
}

// The states service answers with the saved observation itself.
export async function createObservation({ cognitoUserId, orgIds, observation }) {
  return invokeApp('cwf-states-lambda', '/api/states', observation, { cognitoUserId, orgIds });
}

// An edit replaces all of an observation's links, so `links` must be the full
// list. The states service only lets the person who recorded it edit it.
export async function setObservationLinks({ cognitoUserId, orgIds, observationId, links }) {
  return invokeApp('cwf-states-lambda', `/api/states/${observationId}`, { links }, { cognitoUserId, orgIds }, { method: 'PUT', id: observationId });
}

// The app stores policy as rich text (HTML); spoken plans arrive as plain text.
export function policyToHtml(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.trim().split(/\n\s*\n/).map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}
