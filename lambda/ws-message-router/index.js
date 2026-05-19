/**
 * WebSocket $default route handler for API Gateway WebSocket API
 *
 * Runs for every incoming WebSocket message (the $default route catches all
 * messages that don't match a specific route key).
 *
 * Responsibilities:
 * 1. Parse event.body as JSON
 * 2. Route by message.type to the appropriate handler
 * 3. Return structured error responses for invalid input
 *
 * Supported message types:
 * - maxwell:chat → delegates to maxwellChatHandler (Task 4.3)
 * - ping         → responds with pong
 * - unknown      → responds with UNKNOWN_TYPE error
 *
 * All responses use the JSON envelope format:
 *   { type: string, payload: object, timestamp: ISO 8601 string }
 */

const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { handleMaxwellChat } = require('./maxwellChatHandler');

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
 * Send a message back to the client via API Gateway Management API.
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
 * Handle ping messages — respond with pong.
 */
async function handlePing(apiGwClient, connectionId) {
  const envelope = buildEnvelope('pong', {});
  await postToConnection(apiGwClient, connectionId, envelope);
  return { statusCode: 200 };
}

/**
 * Handle unrecognized message types.
 */
async function handleUnknownType(apiGwClient, connectionId, type) {
  const envelope = buildEnvelope('error', {
    code: 'UNKNOWN_TYPE',
    message: `Unrecognized message type: ${type}`,
  });
  await postToConnection(apiGwClient, connectionId, envelope);
  return { statusCode: 200 };
}

exports.handler = async (event) => {
  console.log('[WS-ROUTER] Event:', JSON.stringify(event, null, 2));

  const { connectionId } = event.requestContext;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGwClient = new ApiGatewayManagementApiClient({ endpoint, region: 'us-west-2' });

  // 1. Parse the message body
  let message;
  try {
    message = JSON.parse(event.body);
  } catch {
    console.warn('[WS-ROUTER] Invalid JSON from connection:', connectionId);
    const envelope = buildEnvelope('error', {
      code: 'INVALID_JSON',
      message: 'Message body is not valid JSON',
    });
    await postToConnection(apiGwClient, connectionId, envelope);
    return { statusCode: 400 };
  }

  // 2. Route by message type
  const { type, payload } = message;

  switch (type) {
    case 'maxwell:chat': {
      // Validate required payload fields for maxwell:chat
      if (!payload || !payload.message) {
        console.warn('[WS-ROUTER] Missing payload fields for maxwell:chat:', connectionId);
        const envelope = buildEnvelope('error', {
          code: 'MISSING_PAYLOAD',
          message: 'maxwell:chat requires payload with "message" field',
        });
        await postToConnection(apiGwClient, connectionId, envelope);
        return { statusCode: 400 };
      }
      return handleMaxwellChat(connectionId, payload, event);
    }

    case 'ping': {
      return handlePing(apiGwClient, connectionId);
    }

    default: {
      return handleUnknownType(apiGwClient, connectionId, type);
    }
  }
};

// Export helpers for testing
exports.buildEnvelope = buildEnvelope;
exports.postToConnection = postToConnection;
