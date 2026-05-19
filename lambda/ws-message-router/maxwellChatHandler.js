/**
 * Maxwell Chat Handler — async worker delegation
 *
 * Instead of invoking Bedrock Agent directly (which takes 30-60+ seconds and
 * exceeds the API Gateway WebSocket 29-second integration timeout), this
 * handler sends an immediate progress message to the client and then invokes
 * the cwf-ws-maxwell-worker Lambda asynchronously (fire-and-forget).
 *
 * The worker Lambda handles the long-running Bedrock Agent call and streams
 * response chunks back to the client via postToConnection.
 *
 * Message types sent to client (from this handler):
 * - maxwell:progress — immediate "Connecting to Maxwell..." feedback
 * - maxwell:error    — validation errors (missing org context, etc.)
 *
 * Message types sent to client (from worker Lambda):
 * - maxwell:progress          — trace events (agent activity indicators)
 * - maxwell:response_chunk    — partial response text from Bedrock Agent
 * - maxwell:response_complete — full reply with sessionId and trace data
 * - maxwell:error             — error with code and user-friendly message
 */

const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambdaClient = new LambdaClient({ region: 'us-west-2' });

/**
 * Build a JSON envelope message.
 * @param {string} type - Message type identifier
 * @param {object} payload - Type-specific data
 * @returns {object} Envelope with type, payload, and timestamp
 */
function buildEnvelope(type, payload) {
  return {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Send a message to the client via API Gateway Management API.
 * @param {ApiGatewayManagementApiClient} apiGwClient
 * @param {string} connectionId
 * @param {object} envelope - The message envelope to send
 */
async function postToConnection(apiGwClient, connectionId, envelope) {
  await apiGwClient.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(envelope),
    })
  );
}

/**
 * Handle maxwell:chat messages by delegating to the async worker Lambda.
 *
 * 1. Sends an immediate maxwell:progress message so the user sees feedback
 * 2. Invokes cwf-ws-maxwell-worker asynchronously (InvocationType: 'Event')
 * 3. Returns { statusCode: 200 } immediately — well within the 29s timeout
 *
 * @param {string} connectionId - The WebSocket connection ID
 * @param {object} payload - The message payload ({ message, sessionId?, sessionAttributes? })
 * @param {object} event - The full API Gateway WebSocket event
 * @returns {object} Lambda response ({ statusCode })
 */
async function handleMaxwellChat(connectionId, payload, event) {
  console.log('[MAXWELL-WS] handleMaxwellChat (async delegation):', { connectionId, message: payload.message?.substring(0, 100) });

  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGwClient = new ApiGatewayManagementApiClient({ endpoint, region: 'us-west-2' });

  // Extract authorizer context
  const authContext = event.requestContext.authorizer || {};
  const organizationId = authContext.organization_id;

  if (!organizationId) {
    console.warn('[MAXWELL-WS] No organization context in authorizer');
    await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:error', {
      code: 'MAXWELL_ERROR',
      message: 'Unauthorized: No organization context',
    }));
    return { statusCode: 200 };
  }

  // 1. Send immediate progress feedback so the user sees something right away
  try {
    await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:progress', {
      step: 'Connecting to Maxwell...',
    }));
  } catch (progressErr) {
    console.warn('[MAXWELL-WS] Failed to send initial progress:', progressErr.message);
  }

  // 2. Invoke the worker Lambda asynchronously (fire-and-forget)
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: 'cwf-ws-maxwell-worker',
      InvocationType: 'Event', // async — returns 202 immediately
      Payload: JSON.stringify({
        connectionId,
        payload,
        endpoint,
        organizationId,
      }),
    }));
    console.log('[MAXWELL-WS] Worker Lambda invoked asynchronously');
  } catch (invokeErr) {
    console.error('[MAXWELL-WS] Failed to invoke worker Lambda:', invokeErr);
    await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:error', {
      code: 'MAXWELL_ERROR',
      message: 'Failed to start Maxwell processing',
    }));
  }

  // 3. Return immediately — well within the 29s API Gateway timeout
  return { statusCode: 200 };
}

module.exports = {
  handleMaxwellChat,
  // Exported for testing
  buildEnvelope,
};
