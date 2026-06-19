const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');
const fs = require('fs');
const path = require('path');

const client = new BedrockAgentRuntimeClient({ region: process.env.BEDROCK_REGION });

const AGENT_ID = process.env.MAXWELL_AGENT_ID;
const AGENT_ALIAS_ID = process.env.MAXWELL_AGENT_ALIAS_ID;

// Load prompt fragments once at cold start
const PROMPT_SET = 'sonnet46';
const PROMPTS_DIR = path.join(__dirname, 'prompts', PROMPT_SET);


const loadPrompt = (name) => {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8').trim();
  } catch (e) {
    console.warn(`Failed to load prompt ${name} from set ${PROMPT_SET}:`, e.message);
    return '';
  }
};

const TONE_PROMPT = loadPrompt('tone.txt');
const STORAGE_PROMPT = loadPrompt('storage.txt');
const QUANTITATIVE_PROMPT = loadPrompt('quantitative.txt');
const GENERAL_PROMPT = loadPrompt('general.txt');

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

exports.handler = async (event) => {


  const authContext = getAuthorizerContext(event);
  if (!authContext.organization_id) {
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({ error: 'Unauthorized: No organization context' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({ error: 'Invalid request body' })
    };
  }

  const { message, sessionId, sessionAttributes = {}, history } = body;

  if (!message) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({ error: 'message is required' })
    };
  }

  // Build enhanced message with instruction prefix and entity context
  let enhancedMessage = buildInstructionPrefix(message);
  if (sessionAttributes.entityId && sessionAttributes.entityType && sessionAttributes.entityName) {
    let contextParts = [`You are discussing ${sessionAttributes.entityType} "${sessionAttributes.entityName}" (ID: ${sessionAttributes.entityId})`];
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
  enhancedMessage += message;

  if (!AGENT_ID || !AGENT_ALIAS_ID) {
    console.error('Missing MAXWELL_AGENT_ID or MAXWELL_AGENT_ALIAS_ID env vars');
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({ error: 'Agent not configured' })
    };
  }

  const mode = body.mode || 'deep';
  const targetAliasId = mode === 'quick'
    ? AGENT_ALIAS_ID
    : (process.env.MAXWELL_AGENT_ALIAS_ID_DEEP || 'XVS45ZMCA6');



  // Merge org context into session attributes so the tool Lambda can scope queries
  const mergedSessionAttributes = {
    ...sessionAttributes,
    policy: normalizeContextText(sessionAttributes.policy),
    implementation: normalizeContextText(sessionAttributes.implementation, 999999),
    organization_id: authContext.organization_id,
    current_date: new Date().toISOString().split('T')[0],
  };

  // Convert all session attribute values to strings (Bedrock requirement)
  const stringifiedAttributes = Object.fromEntries(
    Object.entries(mergedSessionAttributes).map(([k, v]) => [k, String(v ?? '')])
  );



  // Generate a session ID if not provided (Bedrock requires it)
  const effectiveSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  const bedrockHistory = history && Array.isArray(history) && history.length > 0
    ? {
        messages: history.map(h => ({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: [{ text: String(h.content || '') }]
        }))
      }
    : undefined;

  const command = new InvokeAgentCommand({
    agentId: AGENT_ID,
    agentAliasId: targetAliasId,
    sessionId: effectiveSessionId,
    inputText: enhancedMessage, // Use enhanced message with context
    enableTrace: true, // Enable trace for debugging
    sessionState: {
      sessionAttributes: stringifiedAttributes,
      conversationHistory: bedrockHistory,
    },
  });

  try {
    const t0 = Date.now();
    const response = await client.send(command);
    const returnedSessionId = response.sessionId;

    // Collect streamed chunks and trace events
    let reply = '';
    const traceEvents = [];
    let firstChunkTime = null;

    for await (const chunk of response.completion) {
      if (!firstChunkTime) firstChunkTime = Date.now();
      if (chunk.chunk?.bytes) {
        reply += new TextDecoder().decode(chunk.chunk.bytes);
      }
      if (chunk.trace) {
        traceEvents.push(chunk.trace);
      }
    }

    const tEnd = Date.now();


    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({
        reply,
        sessionId: returnedSessionId,
        trace: traceEvents // Include trace in response
      }),
    };
  } catch (err) {
    console.error('Bedrock Agent error:', err);

    if (err.name === 'ThrottlingException') {
      return {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({ error: 'Maxwell is busy, please try again' })
      };
    }
    if (err.name === 'ServiceQuotaExceededException' || err.$metadata?.httpStatusCode === 504) {
      return {
        statusCode: 504,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({ error: 'Maxwell took too long to respond' })
      };
    }

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({ error: 'Internal error communicating with Maxwell' })
    };
  }
};
