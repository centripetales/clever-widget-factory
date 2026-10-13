/**
 * Integration tests for cache invalidation flow (broadcastInvalidation)
 *
 * Tests the broadcastInvalidation utility logic using mock-based unit tests.
 * Since the Lambda layer depends on paths (/opt/nodejs/db) that can't be
 * resolved in a local test environment, we replicate the handler logic here
 * and test it with mocked dependencies.
 *
 * This follows the same pattern as ws-connection-lifecycle.test.ts and
 * ws-maxwell-chat.test.ts.
 *
 * Validates: Requirements 3.1, 3.2, 6.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockDbClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface MockApiGwClient {
  send: ReturnType<typeof vi.fn>;
}

interface BroadcastParams {
  entityType: string;
  entityId: string;
  mutationType: string;
  organizationId: string;
  excludeConnectionId?: string | null;
}

interface BroadcastDeps {
  dbClient: MockDbClient;
  apiGwClient: MockApiGwClient;
  wsEndpoint: string | undefined;
}

// ---------------------------------------------------------------------------
// Replicated broadcastInvalidation logic
// (mirrors lambda/layers/cwf-common-nodejs/nodejs/broadcastInvalidation.js)
// ---------------------------------------------------------------------------

/**
 * Broadcast a cache invalidation event to all active WebSocket connections
 * in the given organization. Accepts injected dependencies for testability.
 */
async function broadcastInvalidation(
  params: BroadcastParams,
  deps: BroadcastDeps
) {
  const { entityType, entityId, mutationType, organizationId, excludeConnectionId } = params;
  const { dbClient, apiGwClient, wsEndpoint } = deps;

  if (!wsEndpoint) {
    return; // WebSocket not configured — skip silently
  }

  try {
    // 1. Record the change for reconnection catch-up
    await dbClient.query(
      `INSERT INTO entity_changes (entity_type, entity_id, mutation_type, organization_id, changed_by_connection_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [entityType, entityId, mutationType, organizationId, excludeConnectionId || null]
    );

    // 2. Get active connections for this organization: those registered under
    // it, and those of its people (a connection is registered under the
    // person's primary org).
    const { rows: connections } = await dbClient.query(
      `SELECT DISTINCT wc.connection_id FROM websocket_connections wc
       WHERE wc.disconnected_at IS NULL
         AND (wc.organization_id = $1
              OR wc.user_id::text IN (
                SELECT om.user_id::text FROM organization_members om
                WHERE om.organization_id = $1 AND om.is_active = true))`,
      [organizationId]
    );

    if (connections.length === 0) {
      return;
    }

    // 3. Build the cache:invalidate message
    const message = JSON.stringify({
      type: 'cache:invalidate',
      payload: { entityType, entityId, mutationType },
      timestamp: new Date().toISOString(),
    });

    // 4. Send to all connections except the mutator
    const targets = connections.filter(
      (c: any) => c.connection_id !== excludeConnectionId
    );

    if (targets.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      targets.map(async (conn: any) => {
        try {
          await apiGwClient.send({
            ConnectionId: conn.connection_id,
            Data: message,
          });
        } catch (err: any) {
          // 410 GoneException — connection is stale, mark as disconnected
          if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
            await dbClient.query(
              `UPDATE websocket_connections SET disconnected_at = NOW()
               WHERE connection_id = $1 AND disconnected_at IS NULL`,
              [conn.connection_id]
            );
            return;
          }
          throw err;
        }
      })
    );

    return results;
  } catch (error) {
    // Don't throw — broadcasting failures should not break the mutation
  } finally {
    dbClient.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDbClient(): MockDbClient {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function createMockApiGwClient(): MockApiGwClient {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

/** Parse the Data field from a send call. */
function parseSentMessage(call: { ConnectionId: string; Data: string }) {
  return JSON.parse(call.Data);
}

/** Get all messages sent via the mock API GW client. */
function getSentMessages(apiGwClient: MockApiGwClient) {
  return apiGwClient.send.mock.calls.map((c: any[]) => parseSentMessage(c[0]));
}

/** Get all connection IDs that received messages. */
function getSentConnectionIds(apiGwClient: MockApiGwClient): string[] {
  return apiGwClient.send.mock.calls.map((c: any[]) => c[0].ConnectionId);
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Mutation → entity_changes INSERT → broadcast to connected clients
// ---------------------------------------------------------------------------

describe('broadcastInvalidation — mutation flow', () => {
  let dbClient: MockDbClient;
  let apiGwClient: MockApiGwClient;

  beforeEach(() => {
    dbClient = createMockDbClient();
    apiGwClient = createMockApiGwClient();
  });

  it('inserts into entity_changes and sends cache:invalidate to all active connections', async () => {
    // Setup: 2 active connections in the org
    dbClient.query
      // INSERT entity_changes
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // SELECT active connections
      .mockResolvedValueOnce({
        rows: [
          { connection_id: 'conn-aaa' },
          { connection_id: 'conn-bbb' },
        ],
        rowCount: 2,
      });

    await broadcastInvalidation(
      {
        entityType: 'tool',
        entityId: 'tool-uuid-123',
        mutationType: 'updated',
        organizationId: 'org-uuid-1',
        excludeConnectionId: null,
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod' }
    );

    // Verify entity_changes INSERT
    expect(dbClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO entity_changes'),
      ['tool', 'tool-uuid-123', 'updated', 'org-uuid-1', null]
    );

    // Verify active connections query
    expect(dbClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM websocket_connections[\s\S]*organization_members/),
      ['org-uuid-1']
    );

    // Verify messages sent to both connections
    expect(apiGwClient.send).toHaveBeenCalledTimes(2);

    const connectionIds = getSentConnectionIds(apiGwClient);
    expect(connectionIds).toContain('conn-aaa');
    expect(connectionIds).toContain('conn-bbb');

    // Verify message format
    const messages = getSentMessages(apiGwClient);
    for (const msg of messages) {
      expect(msg.type).toBe('cache:invalidate');
      expect(msg.payload.entityType).toBe('tool');
      expect(msg.payload.entityId).toBe('tool-uuid-123');
      expect(msg.payload.mutationType).toBe('updated');
      expect(msg.timestamp).toBeDefined();
      expect(new Date(msg.timestamp).toISOString()).toBe(msg.timestamp);
    }

    // Verify client released
    expect(dbClient.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Organization isolation
// ---------------------------------------------------------------------------

describe('broadcastInvalidation — organization isolation', () => {
  let dbClient: MockDbClient;
  let apiGwClient: MockApiGwClient;

  beforeEach(() => {
    dbClient = createMockDbClient();
    apiGwClient = createMockApiGwClient();
  });

  it('only queries connections for the target organization', async () => {
    // Setup: connections query returns only org-1 connections
    // (the SQL WHERE clause filters by org_id — we verify the query param)
    dbClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT entity_changes
      .mockResolvedValueOnce({
        rows: [{ connection_id: 'conn-org1-a' }],
        rowCount: 1,
      }); // SELECT connections for org-1

    await broadcastInvalidation(
      {
        entityType: 'action',
        entityId: 'action-uuid-1',
        mutationType: 'created',
        organizationId: 'org-uuid-1',
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://ws.example.com/prod' }
    );

    // Verify the connections query is scoped to org-uuid-1
    const connectionsQuery = dbClient.query.mock.calls[1];
    expect(connectionsQuery[0]).toContain('organization_id = $1');
    expect(connectionsQuery[0]).toContain('disconnected_at IS NULL');
    expect(connectionsQuery[1]).toEqual(['org-uuid-1']);

    // Only org-1 connection receives the message
    expect(apiGwClient.send).toHaveBeenCalledTimes(1);
    expect(apiGwClient.send.mock.calls[0][0].ConnectionId).toBe('conn-org1-a');
  });
});

// ---------------------------------------------------------------------------
// 3. Mutator exclusion
// ---------------------------------------------------------------------------

describe('broadcastInvalidation — mutator exclusion', () => {
  let dbClient: MockDbClient;
  let apiGwClient: MockApiGwClient;

  beforeEach(() => {
    dbClient = createMockDbClient();
    apiGwClient = createMockApiGwClient();
  });

  it('excludes the originating connection from receiving the event', async () => {
    // Setup: 3 active connections, one is the mutator
    dbClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT entity_changes
      .mockResolvedValueOnce({
        rows: [
          { connection_id: 'conn-mutator' },
          { connection_id: 'conn-viewer-1' },
          { connection_id: 'conn-viewer-2' },
        ],
        rowCount: 3,
      });

    await broadcastInvalidation(
      {
        entityType: 'exploration',
        entityId: 'exp-uuid-1',
        mutationType: 'deleted',
        organizationId: 'org-uuid-1',
        excludeConnectionId: 'conn-mutator',
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://ws.example.com/prod' }
    );

    // Should send to 2 connections, not 3
    expect(apiGwClient.send).toHaveBeenCalledTimes(2);

    const connectionIds = getSentConnectionIds(apiGwClient);
    expect(connectionIds).toContain('conn-viewer-1');
    expect(connectionIds).toContain('conn-viewer-2');
    expect(connectionIds).not.toContain('conn-mutator');

    // Verify entity_changes records the mutator connection
    expect(dbClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO entity_changes'),
      ['exploration', 'exp-uuid-1', 'deleted', 'org-uuid-1', 'conn-mutator']
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Graceful degradation when WS_API_ENDPOINT is not set
// ---------------------------------------------------------------------------

describe('broadcastInvalidation — graceful degradation', () => {
  let dbClient: MockDbClient;
  let apiGwClient: MockApiGwClient;

  beforeEach(() => {
    dbClient = createMockDbClient();
    apiGwClient = createMockApiGwClient();
  });

  it('returns silently when wsEndpoint is not set', async () => {
    await broadcastInvalidation(
      {
        entityType: 'tool',
        entityId: 'tool-uuid-1',
        mutationType: 'updated',
        organizationId: 'org-uuid-1',
      },
      { dbClient, apiGwClient, wsEndpoint: undefined }
    );

    // No DB queries should be made
    expect(dbClient.query).not.toHaveBeenCalled();
    // No messages should be sent
    expect(apiGwClient.send).not.toHaveBeenCalled();
    // Client should NOT be released (never acquired)
    expect(dbClient.release).not.toHaveBeenCalled();
  });

  it('returns silently when wsEndpoint is empty string', async () => {
    await broadcastInvalidation(
      {
        entityType: 'tool',
        entityId: 'tool-uuid-1',
        mutationType: 'updated',
        organizationId: 'org-uuid-1',
      },
      { dbClient, apiGwClient, wsEndpoint: '' }
    );

    expect(dbClient.query).not.toHaveBeenCalled();
    expect(apiGwClient.send).not.toHaveBeenCalled();
    expect(dbClient.release).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. 410 GoneException handling
// ---------------------------------------------------------------------------

describe('broadcastInvalidation — 410 GoneException handling', () => {
  let dbClient: MockDbClient;
  let apiGwClient: MockApiGwClient;

  beforeEach(() => {
    dbClient = createMockDbClient();
    apiGwClient = createMockApiGwClient();
  });

  it('marks stale connections as disconnected on 410 GoneException (statusCode)', async () => {
    dbClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT entity_changes
      .mockResolvedValueOnce({
        rows: [
          { connection_id: 'conn-alive' },
          { connection_id: 'conn-stale' },
        ],
        rowCount: 2,
      })
      // UPDATE for stale connection
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // conn-alive succeeds, conn-stale returns 410
    const goneError: any = new Error('Gone');
    goneError.statusCode = 410;

    apiGwClient.send
      .mockImplementation((params: any) => {
        if (params.ConnectionId === 'conn-stale') {
          return Promise.reject(goneError);
        }
        return Promise.resolve(undefined);
      });

    await broadcastInvalidation(
      {
        entityType: 'part',
        entityId: 'part-uuid-1',
        mutationType: 'updated',
        organizationId: 'org-uuid-1',
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://ws.example.com/prod' }
    );

    // Verify the stale connection was marked as disconnected
    expect(dbClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE websocket_connections SET disconnected_at = NOW()'),
      ['conn-stale']
    );

    // Verify the alive connection still received the message
    expect(apiGwClient.send).toHaveBeenCalledTimes(2);
    expect(dbClient.release).toHaveBeenCalled();
  });

  it('marks stale connections as disconnected on 410 via $metadata.httpStatusCode', async () => {
    dbClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT entity_changes
      .mockResolvedValueOnce({
        rows: [{ connection_id: 'conn-gone' }],
        rowCount: 1,
      })
      // UPDATE for gone connection
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const goneError: any = new Error('Gone');
    goneError.$metadata = { httpStatusCode: 410 };

    apiGwClient.send.mockRejectedValue(goneError);

    await broadcastInvalidation(
      {
        entityType: 'action',
        entityId: 'action-uuid-1',
        mutationType: 'created',
        organizationId: 'org-uuid-1',
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://ws.example.com/prod' }
    );

    // Verify the gone connection was marked as disconnected
    expect(dbClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE websocket_connections SET disconnected_at = NOW()'),
      ['conn-gone']
    );

    expect(dbClient.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. No active connections
// ---------------------------------------------------------------------------

describe('broadcastInvalidation — no active connections', () => {
  let dbClient: MockDbClient;
  let apiGwClient: MockApiGwClient;

  beforeEach(() => {
    dbClient = createMockDbClient();
    apiGwClient = createMockApiGwClient();
  });

  it('returns without sending when no active connections exist', async () => {
    dbClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT entity_changes
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // No active connections

    await broadcastInvalidation(
      {
        entityType: 'experience',
        entityId: 'exp-uuid-1',
        mutationType: 'created',
        organizationId: 'org-uuid-1',
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://ws.example.com/prod' }
    );

    // entity_changes INSERT should still happen
    expect(dbClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO entity_changes'),
      ['experience', 'exp-uuid-1', 'created', 'org-uuid-1', null]
    );

    // No messages should be sent
    expect(apiGwClient.send).not.toHaveBeenCalled();

    // Client should be released
    expect(dbClient.release).toHaveBeenCalled();
  });

  it('returns without sending when all connections belong to the mutator', async () => {
    dbClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT entity_changes
      .mockResolvedValueOnce({
        rows: [{ connection_id: 'conn-mutator-only' }],
        rowCount: 1,
      });

    await broadcastInvalidation(
      {
        entityType: 'tool',
        entityId: 'tool-uuid-1',
        mutationType: 'updated',
        organizationId: 'org-uuid-1',
        excludeConnectionId: 'conn-mutator-only',
      },
      { dbClient, apiGwClient, wsEndpoint: 'https://ws.example.com/prod' }
    );

    // entity_changes INSERT should still happen
    expect(dbClient.query).toHaveBeenCalledTimes(2);

    // No messages sent — only connection is the mutator
    expect(apiGwClient.send).not.toHaveBeenCalled();

    expect(dbClient.release).toHaveBeenCalled();
  });
});
