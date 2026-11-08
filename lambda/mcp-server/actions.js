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

async function invokeApp(functionName, path, body, { cognitoUserId, orgId }, { method = 'POST', id, snapshotId } = {}) {
  const authorizer = await invoke(AUTHORIZER, { contextFor: cognitoUserId });
  const reply = await invoke(functionName, {
    httpMethod: method,
    path,
    pathParameters: id ? { id } : snapshotId ? { snapshot_id: snapshotId } : undefined,
    headers: orgId ? { 'X-Organization-Id': orgId } : {},
    body: JSON.stringify(body),
    requestContext: { authorizer },
  });
  const data = typeof reply.body === 'string' ? JSON.parse(reply.body) : reply.body;
  if (!(reply.statusCode >= 200 && reply.statusCode < 300)) {
    throw new Error([data?.error || `${functionName} answered ${reply.statusCode}`, ...(data?.errors || [])].join('; '));
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

// Metric values (snapshots) are saved separately from the observation, as the
// app does, in the observation's org (orgId; none for the primary org).
export async function createSnapshot({ cognitoUserId, orgId, observationId, metricId, value }) {
  return invokeApp('cwf-snapshots-lambda', `/api/states/${observationId}/snapshots`, { metric_id: metricId, value }, { cognitoUserId, orgId }, { id: observationId });
}

export async function updateSnapshot({ cognitoUserId, orgId, snapshotId, value }) {
  return invokeApp('cwf-snapshots-lambda', `/api/snapshots/${snapshotId}`, { value }, { cognitoUserId, orgId }, { method: 'PUT', snapshotId });
}

export async function deleteSnapshot({ cognitoUserId, orgId, snapshotId }) {
  return invokeApp('cwf-snapshots-lambda', `/api/snapshots/${snapshotId}`, {}, { cognitoUserId, orgId }, { method: 'DELETE', snapshotId });
}

// A stock change (positive adds, negative removes): the parts service applies
// it to the current stock and logs it, in one transaction, in the part's org.
export async function changeStock({ cognitoUserId, orgId, partId, change, reason }) {
  return invokeApp('cwf-core-lambda', '/api/parts_history', { part_id: partId, quantity_change: change, change_reason: reason }, { cognitoUserId, orgId });
}

// A new tool or part, through the parts and tools service as the app's add
// form does, in the primary org (none given).
export async function createAsset({ cognitoUserId, type, asset }) {
  return (await invokeApp('cwf-core-lambda', `/api/${type}s`, asset, { cognitoUserId })).data;
}

// Only the fields given change, in the asset's org (orgId). Tool edits are
// logged in its history by the service.
export async function updateAsset({ cognitoUserId, orgId, type, assetId, changes }) {
  return (await invokeApp('cwf-core-lambda', `/api/${type}s/${assetId}`, changes, { cognitoUserId, orgId }, { method: 'PUT', id: assetId })).data;
}

// Experiences go through the experiences service, as the app's experience
// screens do. It decides who may edit or delete one (whoever wrote it up, or
// an admin). New ones go in the primary org (none given).
export async function createExperience({ cognitoUserId, experience }) {
  return invokeApp('cwf-experiences-lambda', '/api/experiences', experience, { cognitoUserId });
}

// Each leg given replaces that leg; legs left out stay as they are.
export async function updateExperience({ cognitoUserId, orgId, experienceId, changes }) {
  return invokeApp('cwf-experiences-lambda', `/api/experiences/${experienceId}`, changes, { cognitoUserId, orgId }, { method: 'PUT', id: experienceId });
}

export async function deleteExperience({ cognitoUserId, orgId, experienceId }) {
  return invokeApp('cwf-experiences-lambda', `/api/experiences/${experienceId}`, {}, { cognitoUserId, orgId }, { method: 'DELETE', id: experienceId });
}

// Metrics are added through the metrics service, as on the tool's page. It
// files them under the caller's primary org, whatever org is asked for.
export async function createMetric({ cognitoUserId, toolId, metric }) {
  return (await invokeApp('cwf-metrics-lambda', `/api/tools/${toolId}/metrics`, metric, { cognitoUserId }, { id: toolId })).metric;
}

// Expectation models are saved through the state-space service, which
// validates them, one row per version, and linked to the asset they are about.
export async function createModel({ cognitoUserId, orgId, definition }) {
  return (await invokeApp('cwf-state-space-lambda', '/api/state-space-models', { model_definition: definition }, { cognitoUserId, orgId })).data;
}

export async function linkModel({ cognitoUserId, orgId, modelId, entityType, entityId }) {
  return (await invokeApp('cwf-state-space-lambda', `/api/state-space-models/${modelId}/associations`,
    { entity_type: entityType, entity_id: entityId }, { cognitoUserId, orgId }, { id: modelId })).data;
}

// The app stores policy as rich text (HTML); spoken plans arrive as plain text.
export function policyToHtml(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.trim().split(/\n\s*\n/).map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}
