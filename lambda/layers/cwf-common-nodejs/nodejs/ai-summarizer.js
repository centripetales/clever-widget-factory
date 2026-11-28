/**
 * AI Summarization for Embedding Generation
 * 
 * Standardizes entity descriptions using Claude Haiku to create
 * consistent, semantic representations for embedding generation.
 * 
 * Benefits:
 * - Reduces noise from verbose observations
 * - Standardizes format across entities
 * - Improves cross-entity semantic similarity
 * - Extracts key semantic concepts
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });
const MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';

/**
 * Summarize action for embedding generation
 * 
 * Takes verbose action data and creates a concise, standardized summary
 * that captures: what was done, how it was done, why it matters, and what was learned.
 * 
 * @param {Object} action - Action data
 * @param {string} action.description - What the action is about
 * @param {string} [action.evidence_description] - Evidence of what was done
 * @param {string} [action.policy] - Lessons learned / best practices
 * @param {string} [action.observations] - Detailed observations (can be verbose)
 * @param {Array<string>} [action.assets] - Related assets (tools, parts used)
 * @returns {Promise<string>} - Standardized summary for embedding
 */
async function summarizeAction(action) {
  const prompt = `Summarize this farm/workshop action into a concise, factual description.

Action Details:
- Description: ${action.description || 'N/A'}
- Evidence: ${action.evidence_description || 'N/A'}
- Plan and lessons: ${action.policy || 'N/A'}
- Observations: ${action.observations || 'N/A'}
${action.assets && action.assets.length > 0 ? `- Assets Used: ${action.assets.join(', ')}` : ''}

Create a 2-3 sentence summary that captures:
1. WHAT was done (the core activity)
2. HOW it was implemented (key methods/tools/steps)
3. WHAT happened (outcomes, results, next steps if mentioned)

Rules:
- Be purely factual - only state what is explicitly mentioned
- Do NOT add editorial commentary, lessons, or interpretations
- Do NOT add phrases like "highlighting the importance of" or "demonstrates"
- Use natural language but stay objective

Summary:`;

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 200,
    temperature: 0.3, // Lower temperature for consistency
    messages: [{ role: "user", content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    body: JSON.stringify(payload),
    contentType: 'application/json',
    accept: 'application/json'
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  
  if (responseBody.content?.[0]?.text) {
    return responseBody.content[0].text.trim();
  }
  
  throw new Error('Invalid response from Bedrock summarization');
}

/**
 * Summarize issue for embedding generation
 * 
 * @param {Object} issue - Issue data
 * @param {string} issue.title - Issue title
 * @param {string} [issue.description] - Issue description
 * @param {string} [issue.resolution_notes] - How it was resolved
 * @returns {Promise<string>} - Standardized summary
 */
async function summarizeIssue(issue) {
  const prompt = `Summarize this issue into a concise, factual description.

Issue Details:
- Title: ${issue.title || 'N/A'}
- Description: ${issue.description || 'N/A'}
- Resolution: ${issue.resolution_notes || 'N/A'}

Create a 2-3 sentence summary that captures:
1. WHAT the problem was
2. HOW it was resolved (if applicable)
3. WHAT the outcome was

Rules:
- Be purely factual - only state what is explicitly mentioned
- Do NOT add editorial commentary or interpretations
- Do NOT add phrases like "highlighting" or "demonstrates"
- Use natural language but stay objective

Summary:`;

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 150,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    body: JSON.stringify(payload),
    contentType: 'application/json',
    accept: 'application/json'
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  
  if (responseBody.content?.[0]?.text) {
    return responseBody.content[0].text.trim();
  }
  
  throw new Error('Invalid response from Bedrock summarization');
}

/**
 * Determine if entity should use AI summarization
 * 
 * @param {string} entityType - Entity type
 * @param {Object} data - Entity data
 * @returns {boolean} - Whether to use AI summarization
 */
function shouldSummarize(entityType, data) {
  // Actions with observations should be summarized
  if (entityType === 'action' && data.observations && data.observations.length > 100) {
    return true;
  }
  
  // Issues with long descriptions should be summarized
  if (entityType === 'issue' && data.description && data.description.length > 200) {
    return true;
  }
  
  // Parts and tools don't need summarization (already concise)
  return false;
}

module.exports = {
  summarizeAction,
  summarizeIssue,
  shouldSummarize
};
