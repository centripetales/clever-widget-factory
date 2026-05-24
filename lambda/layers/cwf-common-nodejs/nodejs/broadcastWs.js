/**
 * Broadcast an arbitrary WebSocket message to all active connections
 * in the given organization.
 *
 * Complements broadcastInvalidation.js — that helper is specific to
 * cache:invalidate messages. This helper sends any message type
 * (e.g. perspectives:processing, perspectives:complete).
 *
 * Gracefully degrades: if WS_API_ENDPOINT is not set, returns silently.
 */

const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { getDbClient } = require('./db');

/**
 * @param {Object} params
 * @param {string} params.type - WebSocket message type (e.g. 'perspectives:processing')
 * @param {Object} params.payload - Arbitrary payload object
 * @param {string} params.organizationId - The organization UUID to broadcast to
 * @param {string|null} [params.excludeConnectionId] - Connection to exclude (the sender)
 */
async function broadcastWs({ type, payload, organizationId, excludeConnectionId }) {
  const wsEndpoint = process.env.WS_API_ENDPOINT;
  if (!wsEndpoint) return; // WebSocket not configured — skip silently

  const client = await getDbClient();
  try {
    const { rows: connections } = await client.query(
      `SELECT connection_id FROM websocket_connections
       WHERE organization_id = $1 AND disconnected_at IS NULL`,
      [organizationId]
    );

    if (connections.length === 0) return;

    const targets = connections.filter(c => c.connection_id !== excludeConnectionId);
    if (targets.length === 0) return;

    const apiGwClient = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });
    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });

    await Promise.allSettled(
      targets.map(async (conn) => {
        try {
          await apiGwClient.send(new PostToConnectionCommand({
            ConnectionId: conn.connection_id,
            Data: message
          }));
        } catch (err) {
          if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
            await client.query(
              `UPDATE websocket_connections SET disconnected_at = NOW()
               WHERE connection_id = $1 AND disconnected_at IS NULL`,
              [conn.connection_id]
            );
          }
        }
      })
    );
  } catch (error) {
    console.error('[broadcastWs] Error:', error);
    // Don't throw — broadcast failures must not break the caller
  } finally {
    client.release();
  }
}

module.exports = { broadcastWs };
