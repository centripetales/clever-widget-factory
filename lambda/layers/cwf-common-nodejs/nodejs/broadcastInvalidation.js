/**
 * Broadcast cache invalidation events to WebSocket connections
 *
 * Used by mutation Lambdas (cwf-core-lambda, cwf-actions-lambda, etc.) to
 * notify the active WebSocket connections of an organization — those
 * registered under it and those of its people — when an entity is created,
 * updated, or deleted.
 *
 * Gracefully degrades: if WS_API_ENDPOINT is not set, the function returns
 * silently so mutation Lambdas work without WebSocket infrastructure.
 *
 * Flow:
 * 1. Record the change in entity_changes table (for reconnection catch-up)
 * 2. Query active connections for the organization
 * 3. Send cache:invalidate message to each connection (excluding the mutator)
 * 4. Handle 410 GoneException by marking stale connections as disconnected
 */

const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { getDbClient } = require('./db');

/**
 * Broadcast a cache invalidation event to all active WebSocket connections
 * in the given organization.
 *
 * @param {Object} params
 * @param {string} params.entityType - The type of entity that changed (e.g. 'tool', 'action')
 * @param {string} params.entityId - The UUID of the entity that changed
 * @param {string} params.mutationType - One of 'created', 'updated', 'deleted'
 * @param {string} params.organizationId - The organization UUID
 * @param {string|null} [params.excludeConnectionId] - Connection ID of the mutator to exclude
 */
async function broadcastInvalidation({ entityType, entityId, mutationType, organizationId, excludeConnectionId }) {
  const wsEndpoint = process.env.WS_API_ENDPOINT;

  if (!wsEndpoint) {
    return; // WebSocket not configured — skip silently
  }

  const client = await getDbClient();

  try {
    // 1. Record the change for reconnection catch-up
    await client.query(
      `INSERT INTO entity_changes (entity_type, entity_id, mutation_type, organization_id, changed_by_connection_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [entityType, entityId, mutationType, organizationId, excludeConnectionId || null]
    );

    // 2. Get active connections for this organization: those registered under
    // it, and those of its people. A connection is registered under the
    // person's primary org, so someone working in another of their orgs (e.g.
    // an association like Positive Sum) is only reached through membership.
    const { rows: connections } = await client.query(
      `SELECT DISTINCT wc.connection_id FROM websocket_connections wc
       WHERE wc.disconnected_at IS NULL
         AND (wc.organization_id = $1
              OR wc.user_id::text IN (
                SELECT om.user_id::text FROM organization_members om
                WHERE om.organization_id = $1 AND om.is_active = true))`,
      [organizationId]
    );

    if (connections.length === 0) {
      console.log('[BROADCAST] No active connections for org:', organizationId);
      return;
    }

    // 3. Build the cache:invalidate message
    const apiGwClient = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });
    const message = JSON.stringify({
      type: 'cache:invalidate',
      payload: { entityType, entityId, mutationType },
      timestamp: new Date().toISOString()
    });

    // 4. Send to all connections except the mutator
    const targets = connections.filter(c => c.connection_id !== excludeConnectionId);

    if (targets.length === 0) {
      console.log('[BROADCAST] No targets after excluding mutator');
      return;
    }

    console.log('[BROADCAST] Sending to', targets.length, 'connections:', {
      entityType,
      entityId,
      mutationType,
      organizationId
    });

    const results = await Promise.allSettled(
      targets.map(async (conn) => {
        try {
          await apiGwClient.send(new PostToConnectionCommand({
            ConnectionId: conn.connection_id,
            Data: message
          }));
        } catch (err) {
          // 410 GoneException — connection is stale, mark as disconnected
          if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
            console.warn('[BROADCAST] Connection gone, marking disconnected:', conn.connection_id);
            await client.query(
              `UPDATE websocket_connections SET disconnected_at = NOW()
               WHERE connection_id = $1 AND disconnected_at IS NULL`,
              [conn.connection_id]
            );
            return;
          }
          console.error('[BROADCAST] Failed to send to connection:', conn.connection_id, err.message);
          throw err;
        }
      })
    );

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn('[BROADCAST] Some sends failed:', failed.length, 'of', targets.length);
    }
  } catch (error) {
    console.error('[BROADCAST] Error:', error);
    // Don't throw — broadcasting failures should not break the mutation
  } finally {
    client.release();
  }
}

module.exports = { broadcastInvalidation };
