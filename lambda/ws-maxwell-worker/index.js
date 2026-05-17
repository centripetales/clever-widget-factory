/**
 * Maxwell Worker Lambda — async Bedrock Agent invocation
 *
 * This Lambda is invoked asynchronously (InvocationType: 'Event') by the
 * ws-message-router when a maxwell:chat message arrives. It handles the
 * long-running Bedrock Agent call (30-60+ seconds) and streams response
 * chunks back to the client via API Gateway Management API postToConnection.
 *
 * This architecture avoids the API Gateway WebSocket 29-second integration
 * timeout on the $default route by returning immediately from the router
 * and doing the heavy work here.
 *
 * Event shape (from message-router):
 * {
 *   connectionId: string,
 *   payload: { message: string, sessionId?: string, sessionAttributes?: object },
 *   endpoint: string,          // e.g. "https://{api-id}.execute-api.{region}.amazonaws.com/{stage}"
 *   organizationId: string
 * }
 *
 * Message types sent to client:
 * - maxwell:progress          — trace events (agent activity indicators)
 * - maxwell:response_chunk    — partial response text from Bedrock Agent
 * - maxwell:response_complete — full reply with sessionId and trace data
 * - maxwell:error             — error with code and user-friendly message
 */

const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const fs = require('fs');
const path = require('path');

// --- Bedrock Agent configuration ---
const bedrockClient = new BedrockAgentRuntimeClient({
  region: process.env.BEDROCK_REGION,
});
const AGENT_ID = process.env.MAXWELL_AGENT_ID;
const AGENT_ALIAS_ID = process.env.MAXWELL_AGENT_ALIAS_ID;

// --- Prompt loading (same pattern as lambda/maxwell-chat/index.js) ---
const PROMPT_SET = 'sonnet46';
const PROMPTS_DIR = path.join(__dirname, 'prompts', PROMPT_SET);
console.log(`[MAXWELL-WORKER] Loading prompt set: ${PROMPT_SET} from ${PROMPTS_DIR}`);

const loadPrompt = (name) => {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8').trim();
  } catch (e) {
    console.warn(`[MAXWELL-WORKER] Failed to load prompt ${name} from set ${PROMPT_SET}:`, e.message);
    return '';
  }
};

const TONE_PROMPT = loadPrompt('tone.txt');
const STORAGE_PROMPT = loadPrompt('storage.txt');
const QUANTITATIVE_PROMPT = loadPrompt('quantitative.txt');
const GENERAL_PROMPT = loadPrompt('general.txt');

// --- Keyword detection (same as maxwell-chat) ---
const STORAGE_KEYWORDS = /\b(store|storage|where.*put|where.*keep|organize|location|shelf|shed|toolbox|cabinet)\b/i;
const QUANTITATIVE_KEYWORDS = /\b(roi|cost|revenue|profit|price|expense|budget|investment|how much|per month|per day|per week|earnings|income|margin|break.?even|spend|spent|purchase|purchased|bought|transaction|payment|balance)\b/i;

/**
 * Detect question type and return the appropriate prompt fragment.
 */
function detectPromptMode(message) {
  if (STORAGE_PROMPT && STORAGE_KEYWORDS.test(message)) return STORAGE_PROMPT;
  if (QUANTITATIVE_PROMPT && QUANTITATIVE_KEYWORDS.test(message)) return QUANTITATIVE_PROMPT;
  return GENERAL_PROMPT;
}

/**
 * Build the full instruction prefix for the message.
 */
function buildInstructionPrefix(message) {
  const modePrompt = detectPromptMode(message);
  return `[Instructions: ${TONE_PROMPT}\n\n${modePrompt}]\n\n`;
}

function normalizeContextText(value, maxLength = 900) {
  if (!value) return '';
  const text = String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

/**
 * Build a JSON envelope message.
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
 * Extract a human-readable step description from a Bedrock Agent trace event.
 */
function extractTraceStep(trace) {
  if (trace.trace?.orchestrationTrace?.invocationInput?.actionGroupInvocationInput) {
    const actionGroup = trace.trace.orchestrationTrace.invocationInput.actionGroupInvocationInput;
    return `Searching: ${actionGroup.actionGroupName || 'knowledge base'}`;
  }
  if (trace.trace?.orchestrationTrace?.rationale?.text) {
    const rationale = trace.trace.orchestrationTrace.rationale.text;
    return rationale.length > 120 ? rationale.substring(0, 120) + '...' : rationale;
  }
  if (trace.trace?.orchestrationTrace?.observation) {
    return 'Analyzing results...';
  }
  return 'Processing...';
}

/**
 * Lambda handler — invoked asynchronously by ws-message-router.
 */
exports.handler = async (event) => {
  console.log('[MAXWELL-WORKER] Event:', JSON.stringify({
    connectionId: event.connectionId,
    organizationId: event.organizationId,
    message: event.payload?.message?.substring(0, 100),
  }));

  const { connectionId, payload, endpoint, organizationId } = event;
  const apiGwClient = new ApiGatewayManagementApiClient({ endpoint });

  // Validate organization context
  if (!organizationId) {
    console.warn('[MAXWELL-WORKER] No organization context');
    try {
      await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:error', {
        code: 'MAXWELL_ERROR',
        message: 'Unauthorized: No organization context',
      }));
    } catch (sendErr) {
      console.error('[MAXWELL-WORKER] Failed to send error:', sendErr.message);
    }
    return;
  }

  // Validate agent configuration
  if (!AGENT_ID || !AGENT_ALIAS_ID) {
    console.error('[MAXWELL-WORKER] Missing MAXWELL_AGENT_ID or MAXWELL_AGENT_ALIAS_ID env vars');
    try {
      await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:error', {
        code: 'MAXWELL_ERROR',
        message: 'Maxwell agent is not configured',
      }));
    } catch (sendErr) {
      console.error('[MAXWELL-WORKER] Failed to send error:', sendErr.message);
    }
    return;
  }

  const { message, sessionId, sessionAttributes = {} } = payload;

  // Build enhanced message with instruction prefix and entity context
  let enhancedMessage = buildInstructionPrefix(message);
  if (sessionAttributes.entityId && sessionAttributes.entityType && sessionAttributes.entityName) {
    const contextParts = [`You are discussing ${sessionAttributes.entityType} "${sessionAttributes.entityName}" (ID: ${sessionAttributes.entityId})`];
    const policyText = normalizeContextText(sessionAttributes.policy);
    if (policyText) {
      contextParts.push(`Description: ${policyText}`);
    }
    const implementationText = normalizeContextText(sessionAttributes.implementation, 600);
    if (implementationText) {
      contextParts.push(`Observations summary: ${implementationText}`);
    }
    enhancedMessage += `[Context: ${contextParts.join('. ')}] `;
  }
  enhancedMessage += `[Today's date: ${new Date().toISOString().split('T')[0]}] `;
  enhancedMessage += message;

  // Merge org context into session attributes so the tool Lambda can scope queries
  const mergedSessionAttributes = {
    ...sessionAttributes,
    policy: normalizeContextText(sessionAttributes.policy),
    implementation: normalizeContextText(sessionAttributes.implementation, 600),
    organization_id: organizationId,
    current_date: new Date().toISOString().split('T')[0],
  };

  // Convert all session attribute values to strings (Bedrock requirement)
  const stringifiedAttributes = Object.fromEntries(
    Object.entries(mergedSessionAttributes).map(([k, v]) => [k, String(v ?? '')])
  );

  console.log('[MAXWELL-WORKER] Session attributes:', JSON.stringify(stringifiedAttributes, null, 2));

  // Generate a session ID if not provided (Bedrock requires it)
  const effectiveSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  const command = new InvokeAgentCommand({
    agentId: AGENT_ID,
    agentAliasId: AGENT_ALIAS_ID,
    sessionId: effectiveSessionId,
    inputText: enhancedMessage,
    enableTrace: true,
    sessionState: {
      sessionAttributes: stringifiedAttributes,
    },
  });

  try {
    const t0 = Date.now();
    const response = await bedrockClient.send(command);
    const returnedSessionId = response.sessionId;

    let reply = '';
    const traceEvents = [];
    let firstChunkTime = null;

    for await (const chunk of response.completion) {
      if (!firstChunkTime) firstChunkTime = Date.now();
      // Forward trace events as progress indicators
      if (chunk.trace) {
        traceEvents.push(chunk.trace);
        try {
          await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:progress', {
            step: extractTraceStep(chunk.trace),
          }));
        } catch (traceErr) {
          console.warn('[MAXWELL-WORKER] Failed to send progress:', traceErr.message);
        }
      }

      // Forward completion chunks as response text
      if (chunk.chunk?.bytes) {
        const text = new TextDecoder().decode(chunk.chunk.bytes);
        reply += text;
        try {
          await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:response_chunk', {
            chunk: text,
          }));
        } catch (chunkErr) {
          console.warn('[MAXWELL-WORKER] Failed to send response chunk:', chunkErr.message);
        }
      }
    }

    const tEnd = Date.now();
    console.log(`[METRICS] Maxwell Worker - Total Time: ${tEnd - t0}ms, Time to first chunk: ${firstChunkTime ? firstChunkTime - t0 : 'N/A'}ms, Trace steps: ${traceEvents.length}`);

    // Send the final complete response
    // Note: trace events are already sent individually as maxwell:progress messages.
    // We omit the full trace array here to stay under the 128 KB WebSocket frame limit.
    // Only include trace count so the frontend knows how many steps occurred.
    await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:response_complete', {
      reply,
      sessionId: returnedSessionId || effectiveSessionId,
      traceCount: traceEvents.length,
    }));
  } catch (err) {
    console.error('[MAXWELL-WORKER] Bedrock Agent error:', err);

    let code = 'MAXWELL_ERROR';
    let userMessage = 'An error occurred communicating with Maxwell';

    if (err.name === 'ThrottlingException') {
      code = 'MAXWELL_THROTTLED';
      userMessage = 'Maxwell is busy, please try again in a moment';
    } else if (err.name === 'ServiceQuotaExceededException' || err.$metadata?.httpStatusCode === 504) {
      code = 'MAXWELL_TIMEOUT';
      userMessage = 'Maxwell took too long to respond, please try again';
    }

    try {
      await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:error', {
        code,
        message: userMessage,
      }));
    } catch (sendErr) {
      console.error('[MAXWELL-WORKER] Failed to send error to client:', sendErr.message);
    }
  }
};
