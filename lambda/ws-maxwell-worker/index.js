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
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Bedrock Agent configuration ---
const bedrockClient = new BedrockAgentRuntimeClient({
  region: process.env.BEDROCK_REGION,
});
const AGENT_ID = process.env.MAXWELL_AGENT_ID;
const AGENT_ALIAS_ID = process.env.MAXWELL_AGENT_ALIAS_ID;

// --- Bedrock Runtime (direct InvokeModel for image analysis) ---
const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-west-2' });

// Helper to download image from S3 public URL and return base64 + mime type
function downloadPhoto(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download photo: HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64Data = buffer.toString('base64');
        let mimeType = 'image/jpeg';
        if (url.endsWith('.png')) mimeType = 'image/png';
        else if (url.endsWith('.webp')) mimeType = 'image/webp';
        resolve({ base64Data, mimeType });
      });
    }).on('error', reject);
  });
}

// Analyze image using direct InvokeModel (bypasses Bedrock Agent limitation)
async function analyzeImageForAssetCreation(imageUrl) {
  const imgData = await downloadPhoto(imageUrl);
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 800,
    temperature: 0.1,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: imgData.mimeType, data: imgData.base64Data }
        },
        {
          type: 'text',
          text: 'You are helping register this item as an asset. Describe what you see concisely: what the item is, brand/model if visible, serial numbers or text, physical condition, color, material, approximate size, and any visible storage context (shelf, room, toolbox). If this is a structure/container that could store other items, note that. Keep it under 200 words.'
        }
      ]
    }]
  };

  const command = new InvokeModelCommand({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  });

  const response = await bedrockRuntime.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));
  if (!result.content || result.content.length === 0) {
    throw new Error('Empty response from image analysis');
  }
  return {
    text: result.content[0].text,
    usage: result.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

// --- Prompt loading ---
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

// --- Skill prompts (Option C architecture) ---
const SKILL_GENERAL_QA = loadPrompt('skill-general-qa.txt');
const SKILL_COMPLIANCE = loadPrompt('skill-compliance-estimator.txt');
const SKILL_FINANCIAL = loadPrompt('skill-financial-analysis.txt');
const SKILL_ASSET_CREATION = loadPrompt('asset-creation.txt');
const SKILL_RIGHTS = loadPrompt('rights.txt');

// --- Keyword detection for skill routing ---
const COMPLIANCE_KEYWORDS = /\b(compliance|bir|sec|denr|arta|nwrb|sss|pagibig|philhealth|government|gov|permit|filing|regulation|regulatory)\b/i;
const FINANCIAL_KEYWORDS = /\b(roi|cost|revenue|profit|price|expense|budget|investment|how much|per month|per day|per week|earnings|income|margin|break.?even|spend|spent|purchase|purchased|bought|transaction|payment|balance|financial)\b/i;
const ASSET_CREATION_KEYWORDS = /\b(add|create|register|new tool|new part|log this|add to inventory|track this)\b/i;
const RIGHTS_KEYWORDS = /\b(rights?|file a|report|complain(t|ts)?|violat(e|ed|ion|ions)|charter|consumer|accountability|escalat(e|ion)|who do i report|dti|npc|dole|ntc|due process|red tape|anti.?red.?tape|citizen.?s?.?charter|refund|return policy|labor (code|law|rights)|tenant.?s?.?rights?|landlord)\b/i;

/**
 * Detect skill based on message intent. Returns the skill prompt to prepend.
 * Priority order matters — more specific skills take precedence.
 */
function detectSkill(message, hasImage) {
  // Asset creation: image + creation intent
  if (hasImage && SKILL_ASSET_CREATION && ASSET_CREATION_KEYWORDS.test(message)) return SKILL_ASSET_CREATION;
  // Compliance: government/regulatory questions
  if (SKILL_COMPLIANCE && COMPLIANCE_KEYWORDS.test(message)) return SKILL_COMPLIANCE;
  // Rights: consumer/labor rights
  if (SKILL_RIGHTS && RIGHTS_KEYWORDS.test(message)) return SKILL_RIGHTS;
  // Financial: cost/expense/revenue questions (only if not compliance)
  if (SKILL_FINANCIAL && FINANCIAL_KEYWORDS.test(message)) return SKILL_FINANCIAL;
  // Default: general Q&A
  return SKILL_GENERAL_QA;
}

/**
 * Build the instruction prefix for the message.
 */
function buildInstructionPrefix(message, hasImage) {
  const skill = detectSkill(message, hasImage);
  return `${skill}\n\n`;
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
    return `Searching: ${actionGroup.actionGroupName || 'knowledge base'}...`;
  }
  if (trace.trace?.orchestrationTrace?.rationale?.text) {
    const rationale = trace.trace.orchestrationTrace.rationale.text;
    return rationale.length > 120 ? rationale.substring(0, 120) + '...' : rationale;
  }
  if (trace.trace?.orchestrationTrace?.observation) {
    const obs = trace.trace.orchestrationTrace.observation;
    if (obs.actionGroupInvocationOutput?.text) {
      try {
        const body = JSON.parse(obs.actionGroupInvocationOutput.text);
        if (body && Array.isArray(body.observations)) {
          const logsCount = body.observations.length;
          let photosCount = 0;
          let metricsCount = 0;
          for (const item of body.observations) {
            if (Array.isArray(item.photos)) {
              photosCount += item.photos.length;
            }
            if (Array.isArray(item.metrics)) {
              metricsCount += item.metrics.length;
            }
          }
          return `Loaded ${logsCount} database logs, ${photosCount} photos, and ${metricsCount} metrics. Preparing report...`;
        }
      } catch (err) {
        console.error('[MAXWELL-WORKER] Telemetry trace JSON.parse failed:', err);
      }
    }
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

  const { connectionId, payload, endpoint, organizationId, cognitoUserId } = event;
  const apiGwClient = new ApiGatewayManagementApiClient({ endpoint, region: 'us-west-2' });

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

  const { message, sessionId, sessionAttributes = {}, history } = payload;
  const hasImage = !!payload.imageUrl;

  // Analyze any attached image directly via InvokeModel (Bedrock Agent can't see images)
  let imageAnalysis = null;
  let imageAnalysisUsage = null;
  if (hasImage) {
    try {
      console.log('[MAXWELL-WORKER] Analyzing attached image...');
      const analysisResult = await analyzeImageForAssetCreation(payload.imageUrl);
      imageAnalysis = analysisResult.text;
      imageAnalysisUsage = analysisResult.usage;
      console.log(`[MAXWELL-WORKER] Image analysis complete (${imageAnalysisUsage.input_tokens}in/${imageAnalysisUsage.output_tokens}out): ${imageAnalysis.substring(0, 100)}...`);
    } catch (err) {
      console.error('[MAXWELL-WORKER] Image analysis failed:', err.message);
    }
  }

  // Build enhanced message with instruction prefix and entity context
  let enhancedMessage = buildInstructionPrefix(message, hasImage);
  const isAssetCreation = hasImage && ASSET_CREATION_KEYWORDS.test(message);

  // Skip entity context for asset creation — the user is creating a new item,
  // not asking about the current entity. This saves significant tokens.
  if (!isAssetCreation && sessionAttributes.entityId && sessionAttributes.entityType && sessionAttributes.entityName) {
    const contextParts = [`You are discussing ${sessionAttributes.entityType} "${sessionAttributes.entityName}" (ID: ${sessionAttributes.entityId})`];
    const policyText = normalizeContextText(sessionAttributes.policy);
    if (policyText) {
      contextParts.push(`Description: ${policyText}`);
    }
    const implementationText = normalizeContextText(sessionAttributes.implementation, 999999);
    if (implementationText) {
      contextParts.push(`Observations summary: ${implementationText}`);
    }
    enhancedMessage += `[Context: ${contextParts.join('. ')}] `;
  }
  enhancedMessage += `[Today's date: ${new Date().toISOString().split('T')[0]}] `;
  if (imageAnalysis) {
    enhancedMessage += `[Image Analysis: ${imageAnalysis}] `;
  }
  enhancedMessage += message;
  if (payload.imageUrl) {
    enhancedMessage += ` [Image URL: ${payload.imageUrl}]`;
  }

  const mode = payload.mode || 'deep';
  const targetAliasId = mode === 'quick'
    ? AGENT_ALIAS_ID
    : (process.env.MAXWELL_AGENT_ALIAS_ID_DEEP || 'XVS45ZMCA6');

  console.log(`[MAXWELL-WORKER ROUTE] Mode: ${mode} -> Routing to Bedrock Agent Alias: ${targetAliasId}`);

  // Merge org context into session attributes so the tool Lambda can scope queries
  const mergedSessionAttributes = {
    ...sessionAttributes,
    policy: normalizeContextText(sessionAttributes.policy),
    implementation: normalizeContextText(sessionAttributes.implementation, 999999),
    organization_id: organizationId,
    cognito_user_id: cognitoUserId || '',
    current_date: new Date().toISOString().split('T')[0],
    ...(payload.imageUrl ? { image_url: payload.imageUrl } : {}),
  };

  // Convert all session attribute values to strings (Bedrock requirement)
  const stringifiedAttributes = Object.fromEntries(
    Object.entries(mergedSessionAttributes).map(([k, v]) => [k, String(v ?? '')])
  );

  console.log('[MAXWELL-WORKER] Session attributes:', JSON.stringify(stringifiedAttributes, null, 2));

  // Generate a session ID if not provided (Bedrock requires it)
  const effectiveSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  // Always send conversationHistory so the agent has full conversation context.
  // Bedrock Agent session memory is unreliable in async Lambda worker patterns
  // (each invocation may hit a different execution context, and the Bedrock
  // session state isn't guaranteed to persist between InvokeAgent calls even
  // with the same sessionId).
  const bedrockHistory = (history && Array.isArray(history) && history.length > 0)
    ? {
        messages: history.map(h => ({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: [{ text: String(h.content || '') }]
        }))
      }
    : undefined;

  // Build sessionState for Bedrock Agent
  const sessionState = {
    sessionAttributes: stringifiedAttributes,
    ...(bedrockHistory ? { conversationHistory: bedrockHistory } : {}),
  };

  const command = new InvokeAgentCommand({
    agentId: AGENT_ID,
    agentAliasId: targetAliasId,
    sessionId: effectiveSessionId,
    inputText: enhancedMessage,
    enableTrace: true,
    sessionState,
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

    const lightweightTrace = [];
    for (const t of traceEvents) {
      const ot = t.trace?.orchestrationTrace;
      if (!ot) continue;

      if (ot.invocationInput?.actionGroupInvocationInput) {
        const action = ot.invocationInput.actionGroupInvocationInput;
        lightweightTrace.push({
          event: 'Tool Call',
          actionGroup: action.actionGroupName || 'unknown',
          apiPath: action.apiPath,
          function: action.function
        });
      } else if (ot.invocationInput?.knowledgeBaseLookupInput) {
        lightweightTrace.push({
          event: 'Knowledge Base Query',
          query: ot.invocationInput.knowledgeBaseLookupInput.text
        });
      } else if (ot.rationale?.text) {
        lightweightTrace.push({
          event: 'Reasoning',
          text: ot.rationale.text.length > 200 ? ot.rationale.text.substring(0, 200) + '...' : ot.rationale.text
        });
      } else if (ot.observation?.actionGroupInvocationOutput?.text) {
        try {
          const body = JSON.parse(ot.observation.actionGroupInvocationOutput.text);
          lightweightTrace.push({
            event: 'Tool Result',
            records_loaded: Array.isArray(body.observations) ? body.observations.length : undefined,
            status: 'success'
          });
        } catch (e) {
          lightweightTrace.push({
            event: 'Tool Result',
            length: ot.observation.actionGroupInvocationOutput.text.length
          });
        }
      } else if (ot.observation?.knowledgeBaseLookupOutput) {
        lightweightTrace.push({
          event: 'Knowledge Base Result',
          references_found: ot.observation.knowledgeBaseLookupOutput.retrievedReferences?.length || 0
        });
      }
    }

    // Send the final complete response
    // We send a filtered lightweightTrace instead of the full trace array to stay under the 128 KB limit.
    // Extract token usage from trace events
    let inputTokens = 0;
    let outputTokens = 0;
    for (const t of traceEvents) {
      const usage = t.trace?.orchestrationTrace?.modelInvocationOutput?.metadata?.usage;
      if (usage) {
        inputTokens += usage.inputTokens || 0;
        outputTokens += usage.outputTokens || 0;
      }
    }

    // Add image analysis tokens if applicable
    if (imageAnalysisUsage) {
      inputTokens += imageAnalysisUsage.input_tokens || 0;
      outputTokens += imageAnalysisUsage.output_tokens || 0;
    }

    await postToConnection(apiGwClient, connectionId, buildEnvelope('maxwell:response_complete', {
      reply,
      sessionId: returnedSessionId || effectiveSessionId,
      traceCount: traceEvents.length,
      trace: lightweightTrace,
      inputTokens,
      outputTokens,
      durationMs: tEnd - t0,
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
