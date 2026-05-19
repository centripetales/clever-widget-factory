/**
 * Sari-Sari Agent Chat Lambda
 *
 * Thin proxy that receives HTTP requests from the frontend,
 * invokes the Sari-Sari Bedrock Agent, extracts products from
 * the delimiter-based response, and returns the existing
 * frontend response shape: { response, products, conversationHistory, sessionId }
 */

const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');

const client = new BedrockAgentRuntimeClient({ region: process.env.BEDROCK_REGION });

const AGENT_ID = process.env.SARI_SARI_AGENT_ID;
const AGENT_ALIAS_ID = process.env.SARI_SARI_AGENT_ALIAS_ID;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

/**
 * Extract inline <!-- PRODUCT <id> --> markers from agent response.
 * Returns { text, productIds } — text has markers stripped, productIds is the ordered list of IDs found.
 */
function extractProducts(responseText) {
  const markerRegex = /<!--\s*(?:PRODUCT\s+)?([\w-]{36})\s*-->/g;
  const productIds = [];
  let match;

  while ((match = markerRegex.exec(responseText)) !== null) {
    productIds.push(match[1]);
  }

  // Strip markers from displayed text
  const cleanText = responseText.replace(/\s*<!--\s*(?:PRODUCT\s+)?[\w-]{36}\s*-->/g, '').trim();

  return { text: cleanText, productIds };
}

/**
 * Transform a product from the action group / agent format to the frontend shape.
 * Maps cost_per_unit → price, current_quantity → stock_level, derives in_stock and status_label.
 */
function transformProduct(product) {
  const currentQuantity = product.current_quantity ?? 0;
  return {
    id: product.id || null,
    name: product.name || '',
    description: product.description || '',
    price: parseFloat(product.cost_per_unit ?? product.price ?? 0),
    stock_level: currentQuantity,
    in_stock: currentQuantity > 0,
    status_label: currentQuantity > 0 ? 'In stock' : 'Out of stock',
    similarity_score: product.similarity_score ?? 0,
    unit: product.unit || '',
    image_url: product.image_url || '',
  };
}

/**
 * Fallback: extract product search results from Bedrock Agent trace events.
 * When the LLM skips the <!-- PRODUCTS --> delimiter, we can still get the
 * structured product data from the action group invocation output in the trace.
 */
function extractProductsFromTrace(traceEvents) {
  for (const event of traceEvents) {
    const output = event?.trace?.orchestrationTrace?.observation?.actionGroupInvocationOutput?.text;
    if (!output) continue;
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed.results) && parsed.results.length > 0) {
        return parsed.results;
      }
    } catch (e) {
      // Not valid JSON, skip
    }
  }
  return [];
}

/**
 * Append user message and assistant response to conversation history,
 * then cap at 6 messages (last 3 exchanges).
 */
function buildConversationHistory(existingHistory, userMessage, assistantResponse) {
  const updated = [
    ...(existingHistory || []),
    { role: 'user', content: userMessage },
    { role: 'assistant', content: assistantResponse },
  ];
  return updated.slice(-6);
}

exports.handler = async (event) => {
  console.log('Sari-Sari agent chat event:', JSON.stringify(event, null, 2));

  // --- 2.2: Auth context extraction ---
  const authContext = getAuthorizerContext(event);
  if (!authContext.organization_id) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized: No organization context' }),
    };
  }

  // --- 2.2: Request body parsing & validation ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  const { message, sessionId, conversationHistory } = body;

  if (!message) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'message is required' }),
    };
  }

  // --- 2.2 / 2.3: Agent env var check ---
  if (!AGENT_ID || !AGENT_ALIAS_ID) {
    console.error('Missing SARI_SARI_AGENT_ID or SARI_SARI_AGENT_ALIAS_ID env vars');
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Agent not configured' }),
    };
  }

  // --- 2.2: Session ID generation ---
  const effectiveSessionId = sessionId || `sari-sari-session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  // --- 2.3: Forward organization_id as stringified session attribute ---
  const stringifiedAttributes = {
    organization_id: String(authContext.organization_id),
  };

  const command = new InvokeAgentCommand({
    agentId: AGENT_ID,
    agentAliasId: AGENT_ALIAS_ID,
    sessionId: effectiveSessionId,
    inputText: message,
    enableTrace: true,
    sessionState: {
      sessionAttributes: stringifiedAttributes,
    },
  });

  try {
    // --- 2.3: Invoke agent and collect streamed response ---
    const agentResponse = await client.send(command);

    let fullResponse = '';
    const traceEvents = [];
    for await (const chunk of agentResponse.completion) {
      if (chunk.chunk?.bytes) {
        fullResponse += new TextDecoder().decode(chunk.chunk.bytes);
      }
      if (chunk.trace) {
        traceEvents.push(chunk.trace);
      }
    }

    console.log('Raw agent response:', fullResponse);
    console.log('Products delimiter found:', fullResponse.includes('<!-- PRODUCT'));

    // --- 2.4 / 2.5: Extract inline product IDs, match against trace data ---
    const { text, productIds } = extractProducts(fullResponse);

    // Build a lookup of all products from the action group trace output
    const allTraceProducts = extractProductsFromTrace(traceEvents);
    const productLookup = new Map();
    for (const p of allTraceProducts) {
      if (p.id) productLookup.set(p.id, p);
    }

    // Only include products the agent actually referenced via inline markers
    let products;
    if (productIds.length > 0) {
      products = productIds
        .filter(id => productLookup.has(id))
        .map(id => transformProduct(productLookup.get(id)));
      console.log(`Matched ${products.length} of ${productIds.length} inline product markers`);
    } else {
      // No inline markers found — don't show any product cards
      products = [];
      console.log('No inline <!-- PRODUCT id --> markers found in agent response');
    }

    // --- 2.6: Build conversation history ---
    const updatedHistory = buildConversationHistory(conversationHistory, message, text);

    // --- 2.7: Return the frontend-expected shape ---
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        response: text,
        products,
        conversationHistory: updatedHistory,
        sessionId: effectiveSessionId,
      }),
    };
  } catch (err) {
    console.error('Bedrock Agent error:', err);

    // --- 2.3: Error handling ---
    if (err.name === 'ThrottlingException') {
      return {
        statusCode: 429,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Store assistant is busy, please try again' }),
      };
    }
    if (err.name === 'ServiceQuotaExceededException' || err.$metadata?.httpStatusCode === 504) {
      return {
        statusCode: 504,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Store assistant took too long to respond' }),
      };
    }

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal error communicating with store assistant' }),
    };
  }
};

// Export helpers for independent testing
module.exports = {
  handler: exports.handler,
  extractProducts,
  extractProductsFromTrace,
  transformProduct,
  buildConversationHistory,
};
