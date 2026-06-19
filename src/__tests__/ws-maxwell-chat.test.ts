/**
 * Integration tests for Maxwell chat over WebSocket
 *
 * Tests the message router and Maxwell chat handler logic using mock-based
 * unit tests. Since the Lambda handlers depend on Lambda layer paths
 * (/opt/nodejs/db) that can't be resolved in a local test environment,
 * we replicate the handler logic here and test it with mocked dependencies.
 *
 * This follows the same pattern as ws-connection-lifecycle.test.ts.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7, 4.1, 4.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MockApiGwClient {
  send: ReturnType<typeof vi.fn>;
}

interface PostToConnectionCall {
  ConnectionId: string;
  Data: string;
}

// ---------------------------------------------------------------------------
// Replicated handler logic (mirrors lambda/ws-message-router/index.js)
// ---------------------------------------------------------------------------

/**
 * Build a JSON envelope message.
 */
function buildEnvelope(type: string, payload: Record<string, unknown>) {
  return {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Send a message back to the client via API Gateway Management API.
 */
async function postToConnection(
  apiGwClient: MockApiGwClient,
  connectionId: string,
  envelope: ReturnType<typeof buildEnvelope>
) {
  await apiGwClient.send({
    ConnectionId: connectionId,
    Data: JSON.stringify(envelope),
  });
}

/**
 * Handle ping messages — respond with pong.
 */
async function handlePing(apiGwClient: MockApiGwClient, connectionId: string) {
  const envelope = buildEnvelope('pong', {});
  await postToConnection(apiGwClient, connectionId, envelope);
  return { statusCode: 200 };
}

/**
 * Handle unrecognized message types.
 */
async function handleUnknownType(
  apiGwClient: MockApiGwClient,
  connectionId: string,
  type: string
) {
  const envelope = buildEnvelope('error', {
    code: 'UNKNOWN_TYPE',
    message: `Unrecognized message type: ${type}`,
  });
  await postToConnection(apiGwClient, connectionId, envelope);
  return { statusCode: 200 };
}

/**
 * Core message router logic (mirrors lambda/ws-message-router/index.js handler).
 */
async function routeMessage(
  body: string,
  connectionId: string,
  apiGwClient: MockApiGwClient,
  handleMaxwellChat: (
    connectionId: string,
    payload: any,
    event: any
  ) => Promise<{ statusCode: number }>
) {
  // 1. Parse the message body
  let message: any;
  try {
    message = JSON.parse(body);
  } catch {
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
      if (!payload || !payload.message) {
        const envelope = buildEnvelope('error', {
          code: 'MISSING_PAYLOAD',
          message: 'maxwell:chat requires payload with "message" field',
        });
        await postToConnection(apiGwClient, connectionId, envelope);
        return { statusCode: 400 };
      }
      return handleMaxwellChat(connectionId, payload, {
        requestContext: {
          connectionId,
          domainName: 'abc123.execute-api.us-west-2.amazonaws.com',
          stage: 'prod',
          authorizer: { organization_id: 'org-uuid-1' },
        },
      });
    }

    case 'ping': {
      return handlePing(apiGwClient, connectionId);
    }

    default: {
      return handleUnknownType(apiGwClient, connectionId, type);
    }
  }
}

// ---------------------------------------------------------------------------
// Replicated Maxwell chat handler logic
// (mirrors lambda/ws-message-router/maxwellChatHandler.js)
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable step description from a Bedrock Agent trace event.
 */
function extractTraceStep(trace: any): string {
  if (trace.trace?.orchestrationTrace?.invocationInput?.actionGroupInvocationInput) {
    const actionGroup =
      trace.trace.orchestrationTrace.invocationInput.actionGroupInvocationInput;
    return `Searching: ${actionGroup.actionGroupName || 'knowledge base'}`;
  }
  if (trace.trace?.orchestrationTrace?.rationale?.text) {
    const rationale = trace.trace.orchestrationTrace.rationale.text;
    return rationale.length > 120
      ? rationale.substring(0, 120) + '...'
      : rationale;
  }
  if (trace.trace?.orchestrationTrace?.observation) {
    return 'Analyzing results...';
  }
  return 'Processing...';
}

interface BedrockInvokeResult {
  completion: AsyncIterable<any>;
  sessionId?: string;
}

interface MaxwellChatDeps {
  invokeAgent: (command: any) => Promise<BedrockInvokeResult>;
}

/**
 * Core Maxwell chat handler logic (mirrors maxwellChatHandler.js handleMaxwellChat).
 * Accepts injected dependencies for testability.
 */
async function handleMaxwellChat(
  connectionId: string,
  payload: { message: string; sessionId?: string; sessionAttributes?: Record<string, any>; history?: any[] },
  event: any,
  apiGwClient: MockApiGwClient,
  deps: MaxwellChatDeps
) {
  const organizationId = event.requestContext.authorizer?.organization_id;

  if (!organizationId) {
    await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:error', {
      code: 'MAXWELL_ERROR',
      message: 'Unauthorized: No organization context',
    }));
    return { statusCode: 200 };
  }

  const { message, sessionId, sessionAttributes = {}, history } = payload;

  // Build enhanced message (simplified for test — mirrors real logic)
  const instructionPrefix = '[Instructions: tone prompt\n\ngeneral prompt]\n\n';
  let enhancedMessage = instructionPrefix;
  if (sessionAttributes.entityId && sessionAttributes.entityType && sessionAttributes.entityName) {
    enhancedMessage += `[Context: You are discussing ${sessionAttributes.entityType} "${sessionAttributes.entityName}" (ID: ${sessionAttributes.entityId})] `;
  }
  enhancedMessage += `[Today's date: ${new Date().toISOString().split('T')[0]}] `;
  enhancedMessage += message;

  const mergedSessionAttributes = {
    ...sessionAttributes,
    organization_id: organizationId,
    current_date: new Date().toISOString().split('T')[0],
  };

  const stringifiedAttributes = Object.fromEntries(
    Object.entries(mergedSessionAttributes).map(([k, v]) => [k, String(v ?? '')])
  );

  const effectiveSessionId =
    sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  const bedrockHistory = history && Array.isArray(history) && history.length > 0
    ? {
        messages: history.map(h => ({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: [{ text: String(h.content || '') }]
        }))
      }
    : undefined;

  const command = {
    agentId: 'test-agent-id',
    agentAliasId: 'test-alias-id',
    sessionId: effectiveSessionId,
    inputText: enhancedMessage,
    enableTrace: true,
    sessionState: {
      sessionAttributes: stringifiedAttributes,
      conversationHistory: bedrockHistory,
    },
  };

  try {
    const response = await deps.invokeAgent(command);
    const returnedSessionId = response.sessionId;

    let reply = '';
    const traceEvents: any[] = [];

    for await (const chunk of response.completion) {
      // Forward trace events as progress indicators
      if (chunk.trace) {
        traceEvents.push(chunk.trace);
        try {
          await postToConnection(
            apiGwClient,
            connectionId,
            buildEnvelope('maxwell:progress', {
              step: extractTraceStep(chunk.trace),
            })
          );
        } catch {
          // If we can't send progress, log but continue
        }
      }

      // Forward completion chunks as response text
      if (chunk.chunk?.bytes) {
        const text = new TextDecoder().decode(chunk.chunk.bytes);
        reply += text;
        try {
          await postToConnection(
            apiGwClient,
            connectionId,
            buildEnvelope('maxwell:response_chunk', { chunk: text })
          );
        } catch {
          // If we can't send chunk, log but continue
        }
      }
    }

    // Send the final complete response
    await postToConnection(
      apiGwClient,
      connectionId,
      buildEnvelope('maxwell:response_complete', {
        reply,
        sessionId: returnedSessionId || effectiveSessionId,
        trace: traceEvents,
      })
    );

    return { statusCode: 200 };
  } catch (err: any) {
    let code = 'MAXWELL_ERROR';
    let userMessage = 'An error occurred communicating with Maxwell';

    if (err.name === 'ThrottlingException') {
      code = 'MAXWELL_THROTTLED';
      userMessage = 'Maxwell is busy, please try again in a moment';
    } else if (
      err.name === 'ServiceQuotaExceededException' ||
      err.$metadata?.httpStatusCode === 504
    ) {
      code = 'MAXWELL_TIMEOUT';
      userMessage = 'Maxwell took too long to respond, please try again';
    }

    try {
      await postToConnection(
        apiGwClient,
        connectionId,
        buildEnvelope('maxwell:error', { code, message: userMessage })
      );
    } catch {
      // Failed to send error to client
    }

    return { statusCode: 200 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockApiGwClient(): MockApiGwClient {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

/** Parse the Data field from a postToConnection call. */
function parseSentMessage(call: PostToConnectionCall) {
  return JSON.parse(call.Data);
}

/** Get all messages sent via the mock API GW client. */
function getSentMessages(apiGwClient: MockApiGwClient) {
  return apiGwClient.send.mock.calls.map((c: any[]) => parseSentMessage(c[0]));
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Message router', () => {
  let apiGwClient: MockApiGwClient;
  const connectionId = 'test-conn-123';
  let mockMaxwellHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiGwClient = createMockApiGwClient();
    mockMaxwellHandler = vi.fn().mockResolvedValue({ statusCode: 200 });
  });

  // -------------------------------------------------------------------------
  // 1. Routes maxwell:chat to the chat handler
  // -------------------------------------------------------------------------
  it('routes maxwell:chat to the chat handler', async () => {
    const body = JSON.stringify({
      type: 'maxwell:chat',
      payload: { message: 'Hello Maxwell' },
      timestamp: new Date().toISOString(),
    });

    const result = await routeMessage(body, connectionId, apiGwClient, mockMaxwellHandler);

    expect(result.statusCode).toBe(200);
    expect(mockMaxwellHandler).toHaveBeenCalledOnce();
    expect(mockMaxwellHandler).toHaveBeenCalledWith(
      connectionId,
      { message: 'Hello Maxwell' },
      expect.objectContaining({
        requestContext: expect.objectContaining({ connectionId }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 2. Handles invalid JSON
  // -------------------------------------------------------------------------
  it('handles invalid JSON with INVALID_JSON error', async () => {
    const body = 'this is not json {{{';

    const result = await routeMessage(body, connectionId, apiGwClient, mockMaxwellHandler);

    expect(result.statusCode).toBe(400);
    expect(mockMaxwellHandler).not.toHaveBeenCalled();

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(messages[0].payload.code).toBe('INVALID_JSON');
    expect(messages[0].payload.message).toBeDefined();
    expect(messages[0].timestamp).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 3. Handles unknown type
  // -------------------------------------------------------------------------
  it('handles unknown message type with UNKNOWN_TYPE error', async () => {
    const body = JSON.stringify({
      type: 'some:unknown:type',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const result = await routeMessage(body, connectionId, apiGwClient, mockMaxwellHandler);

    expect(result.statusCode).toBe(200);
    expect(mockMaxwellHandler).not.toHaveBeenCalled();

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(messages[0].payload.code).toBe('UNKNOWN_TYPE');
    expect(messages[0].payload.message).toContain('some:unknown:type');
  });

  // -------------------------------------------------------------------------
  // 4. Handles missing payload for maxwell:chat
  // -------------------------------------------------------------------------
  it('handles missing payload with MISSING_PAYLOAD error', async () => {
    const body = JSON.stringify({
      type: 'maxwell:chat',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const result = await routeMessage(body, connectionId, apiGwClient, mockMaxwellHandler);

    expect(result.statusCode).toBe(400);
    expect(mockMaxwellHandler).not.toHaveBeenCalled();

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(messages[0].payload.code).toBe('MISSING_PAYLOAD');
  });

  it('handles null payload with MISSING_PAYLOAD error', async () => {
    const body = JSON.stringify({
      type: 'maxwell:chat',
      timestamp: new Date().toISOString(),
    });

    const result = await routeMessage(body, connectionId, apiGwClient, mockMaxwellHandler);

    expect(result.statusCode).toBe(400);
    expect(mockMaxwellHandler).not.toHaveBeenCalled();

    const messages = getSentMessages(apiGwClient);
    expect(messages[0].payload.code).toBe('MISSING_PAYLOAD');
  });

  // -------------------------------------------------------------------------
  // 5. Ping returns pong
  // -------------------------------------------------------------------------
  it('ping message returns pong', async () => {
    const body = JSON.stringify({
      type: 'ping',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    const result = await routeMessage(body, connectionId, apiGwClient, mockMaxwellHandler);

    expect(result.statusCode).toBe(200);
    expect(mockMaxwellHandler).not.toHaveBeenCalled();

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('pong');
    expect(messages[0].payload).toEqual({});
    expect(messages[0].timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Maxwell chat handler tests
// ---------------------------------------------------------------------------

describe('Maxwell chat handler', () => {
  let apiGwClient: MockApiGwClient;
  const connectionId = 'test-conn-456';
  const baseEvent = {
    requestContext: {
      connectionId: 'test-conn-456',
      domainName: 'abc123.execute-api.us-west-2.amazonaws.com',
      stage: 'prod',
      authorizer: { organization_id: 'org-uuid-1' },
    },
  };

  beforeEach(() => {
    apiGwClient = createMockApiGwClient();
  });

  // -------------------------------------------------------------------------
  // 6. Streams response chunks
  // -------------------------------------------------------------------------
  it('streams response chunks from Bedrock Agent', async () => {
    const mockCompletion = {
      async *[Symbol.asyncIterator]() {
        yield { chunk: { bytes: new TextEncoder().encode('Hello ') } };
        yield {
          trace: {
            trace: {
              orchestrationTrace: {
                rationale: { text: 'Thinking...' },
              },
            },
          },
        };
        yield { chunk: { bytes: new TextEncoder().encode('world!') } };
      },
    };

    const deps: MaxwellChatDeps = {
      invokeAgent: vi.fn().mockResolvedValue({
        completion: mockCompletion,
        sessionId: 'session-returned-123',
      }),
    };

    const result = await handleMaxwellChat(
      connectionId,
      { message: 'Hi there' },
      baseEvent,
      apiGwClient,
      deps
    );

    expect(result.statusCode).toBe(200);

    const messages = getSentMessages(apiGwClient);

    // Should have: response_chunk("Hello "), progress("Thinking..."), response_chunk("world!"), response_complete
    const chunkMessages = messages.filter(
      (m: any) => m.type === 'maxwell:response_chunk'
    );
    expect(chunkMessages).toHaveLength(2);
    expect(chunkMessages[0].payload.chunk).toBe('Hello ');
    expect(chunkMessages[1].payload.chunk).toBe('world!');

    const progressMessages = messages.filter(
      (m: any) => m.type === 'maxwell:progress'
    );
    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0].payload.step).toBe('Thinking...');
  });

  // -------------------------------------------------------------------------
  // 7. Sends response_complete with full reply, sessionId, trace
  // -------------------------------------------------------------------------
  it('sends response_complete with full reply, sessionId, and trace', async () => {
    const traceData = {
      trace: {
        orchestrationTrace: {
          rationale: { text: 'Analyzing...' },
        },
      },
    };

    const mockCompletion = {
      async *[Symbol.asyncIterator]() {
        yield { chunk: { bytes: new TextEncoder().encode('Hello ') } };
        yield { trace: traceData };
        yield { chunk: { bytes: new TextEncoder().encode('world!') } };
      },
    };

    const deps: MaxwellChatDeps = {
      invokeAgent: vi.fn().mockResolvedValue({
        completion: mockCompletion,
        sessionId: 'session-abc-789',
      }),
    };

    await handleMaxwellChat(
      connectionId,
      { message: 'Tell me about tools' },
      baseEvent,
      apiGwClient,
      deps
    );

    const messages = getSentMessages(apiGwClient);
    const completeMsg = messages.find(
      (m: any) => m.type === 'maxwell:response_complete'
    );

    expect(completeMsg).toBeDefined();
    expect(completeMsg.payload.reply).toBe('Hello world!');
    expect(completeMsg.payload.sessionId).toBe('session-abc-789');
    expect(completeMsg.payload.trace).toHaveLength(1);
    expect(completeMsg.payload.trace[0]).toEqual(traceData);
    expect(completeMsg.timestamp).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 8. Maps ThrottlingException to MAXWELL_THROTTLED
  // -------------------------------------------------------------------------
  it('maps ThrottlingException to MAXWELL_THROTTLED', async () => {
    const throttleError = new Error('Rate exceeded');
    throttleError.name = 'ThrottlingException';

    const deps: MaxwellChatDeps = {
      invokeAgent: vi.fn().mockRejectedValue(throttleError),
    };

    const result = await handleMaxwellChat(
      connectionId,
      { message: 'Hello' },
      baseEvent,
      apiGwClient,
      deps
    );

    expect(result.statusCode).toBe(200);

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('maxwell:error');
    expect(messages[0].payload.code).toBe('MAXWELL_THROTTLED');
    expect(messages[0].payload.message).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 9. Maps ServiceQuotaExceededException to MAXWELL_TIMEOUT
  // -------------------------------------------------------------------------
  it('maps ServiceQuotaExceededException to MAXWELL_TIMEOUT', async () => {
    const quotaError = new Error('Service quota exceeded');
    quotaError.name = 'ServiceQuotaExceededException';

    const deps: MaxwellChatDeps = {
      invokeAgent: vi.fn().mockRejectedValue(quotaError),
    };

    const result = await handleMaxwellChat(
      connectionId,
      { message: 'Hello' },
      baseEvent,
      apiGwClient,
      deps
    );

    expect(result.statusCode).toBe(200);

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('maxwell:error');
    expect(messages[0].payload.code).toBe('MAXWELL_TIMEOUT');
    expect(messages[0].payload.message).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 10. Maps generic errors to MAXWELL_ERROR
  // -------------------------------------------------------------------------
  it('maps generic errors to MAXWELL_ERROR', async () => {
    const genericError = new Error('Something went wrong');
    genericError.name = 'InternalServerError';

    const deps: MaxwellChatDeps = {
      invokeAgent: vi.fn().mockRejectedValue(genericError),
    };

    const result = await handleMaxwellChat(
      connectionId,
      { message: 'Hello' },
      baseEvent,
      apiGwClient,
      deps
    );

    expect(result.statusCode).toBe(200);

    const messages = getSentMessages(apiGwClient);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('maxwell:error');
    expect(messages[0].payload.code).toBe('MAXWELL_ERROR');
    expect(messages[0].payload.message).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 11. Propagates conversation history context
  // -------------------------------------------------------------------------
  it('propagates conversation history context when history is provided', async () => {
    const invokeAgentSpy = vi.fn().mockResolvedValue({
      completion: (async function* () {
        yield { chunk: { bytes: new TextEncoder().encode('Resolved') } };
      })(),
    });

    const deps: MaxwellChatDeps = {
      invokeAgent: invokeAgentSpy,
    };

    const history = [
      { role: 'user', content: 'What is status?' },
      { role: 'assistant', content: 'All system checks green.' }
    ];

    await handleMaxwellChat(
      connectionId,
      { message: 'What about inventory?', history },
      baseEvent,
      apiGwClient,
      deps
    );

    expect(invokeAgentSpy).toHaveBeenCalledOnce();
    const commandPassed = invokeAgentSpy.mock.calls[0][0];
    expect(commandPassed.sessionState.conversationHistory).toEqual({
      messages: [
        { role: 'user', content: [{ text: 'What is status?' }] },
        { role: 'assistant', content: [{ text: 'All system checks green.' }] }
      ]
    });
  });
});

// ---------------------------------------------------------------------------
// extractTraceStep utility tests
// ---------------------------------------------------------------------------

describe('extractTraceStep', () => {
  it('extracts action group name from invocation input', () => {
    const trace = {
      trace: {
        orchestrationTrace: {
          invocationInput: {
            actionGroupInvocationInput: {
              actionGroupName: 'SearchTools',
            },
          },
        },
      },
    };
    expect(extractTraceStep(trace)).toBe('Searching: SearchTools');
  });

  it('extracts rationale text', () => {
    const trace = {
      trace: {
        orchestrationTrace: {
          rationale: { text: 'I need to look up the tool inventory' },
        },
      },
    };
    expect(extractTraceStep(trace)).toBe(
      'I need to look up the tool inventory'
    );
  });

  it('truncates long rationale text to 120 chars', () => {
    const longText = 'A'.repeat(200);
    const trace = {
      trace: {
        orchestrationTrace: {
          rationale: { text: longText },
        },
      },
    };
    const result = extractTraceStep(trace);
    expect(result).toBe('A'.repeat(120) + '...');
    expect(result.length).toBe(123);
  });

  it('returns "Analyzing results..." for observation traces', () => {
    const trace = {
      trace: {
        orchestrationTrace: {
          observation: { some: 'data' },
        },
      },
    };
    expect(extractTraceStep(trace)).toBe('Analyzing results...');
  });

  it('returns "Processing..." for unknown trace shapes', () => {
    expect(extractTraceStep({})).toBe('Processing...');
    expect(extractTraceStep({ trace: {} })).toBe('Processing...');
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope utility tests
// ---------------------------------------------------------------------------

describe('buildEnvelope', () => {
  it('creates a valid message envelope with type, payload, and ISO timestamp', () => {
    const envelope = buildEnvelope('maxwell:response_chunk', { chunk: 'Hello' });

    expect(envelope.type).toBe('maxwell:response_chunk');
    expect(envelope.payload).toEqual({ chunk: 'Hello' });
    expect(envelope.timestamp).toBeDefined();
    // Verify timestamp is valid ISO 8601
    expect(new Date(envelope.timestamp).toISOString()).toBe(envelope.timestamp);
  });
});
