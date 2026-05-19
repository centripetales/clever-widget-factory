const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse, corsResponse } = require('/opt/nodejs/response');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');
const { fetchAiConfig, resolveAiConfig } = require('/opt/nodejs/aiConfigDefaults');

const sqs = new SQSClient({ region: 'us-west-2' });
const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

const { composeAxisEmbeddingSource } = require('/opt/nodejs/axisUtils');

const success = (data) => successResponse({ data });
const error = (message, statusCode = 500) => errorResponse(statusCode, message);

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const { httpMethod, path } = event;

  // Handle CORS preflight
  if (httpMethod === 'OPTIONS') {
    return corsResponse();
  }

  let authContext;
  let organizationId;

  try {
    authContext = getAuthorizerContext(event);
    organizationId = authContext?.organization_id;
  } catch (err) {
    console.error('Error getting authorizer context:', err);
    return error('Authorization context not available', 401);
  }

  if (!organizationId) {
    return error('Organization ID not found', 401);
  }

  try {
    // --- Profile Skills routes (must come BEFORE /api/skill-profiles/* to avoid conflicts) ---

    // GET /api/profile-skills — Fetch all profile skills for the authenticated user
    if (httpMethod === 'GET' && path === '/api/profile-skills') {
      return await handleGetProfileSkills(event, organizationId);
    }

    // POST /api/profile-skills/generate — Generate AI interpretation + axes from narrative (preview)
    if (httpMethod === 'POST' && path === '/api/profile-skills/generate') {
      return await handleGenerateProfileSkill(event, organizationId);
    }

    // POST /api/profile-skills/approve — Approve and store a profile skill as a state record
    if (httpMethod === 'POST' && path === '/api/profile-skills/approve') {
      return await handleApproveProfileSkill(event, organizationId);
    }

    // PUT /api/profile-skills/:id/toggle — Toggle active/inactive status
    if (httpMethod === 'PUT' && path.startsWith('/api/profile-skills/') && path.endsWith('/toggle')) {
      return await handleToggleProfileSkill(event, organizationId);
    }

    // DELETE /api/profile-skills/:id — Delete a profile skill permanently
    if (httpMethod === 'DELETE' && path.startsWith('/api/profile-skills/')) {
      return await handleDeleteProfileSkill(event, organizationId);
    }

    // --- Existing Skill Profiles routes ---

    // POST /api/skill-profiles/generate — Generate a skill profile preview (not stored)
    if (httpMethod === 'POST' && path === '/api/skill-profiles/generate') {
      return await handleGenerate(event, organizationId);
    }

    // POST /api/skill-profiles/approve — Approve and store a skill profile + queue embedding
    if (httpMethod === 'POST' && path === '/api/skill-profiles/approve') {
      return await handleApprove(event, organizationId);
    }

    // DELETE /api/skill-profiles/:actionId — Remove a skill profile from an action
    if (httpMethod === 'DELETE' && path.startsWith('/api/skill-profiles/')) {
      const actionId = path.split('/api/skill-profiles/')[1];
      if (!actionId) {
        return error('Action ID is required', 400);
      }
      return await handleDelete(actionId, organizationId);
    }

    return error('Not found', 404);

  } catch (err) {
    console.error('Error:', err);
    return error(err.message, 500);
  }
};

/**
 * GET /api/profile-skills
 * Fetch all profile skills for the authenticated user.
 * Requirements: 1.1, 1.7, 4.1, 4.4
 */
async function handleGetProfileSkills(event, organizationId) {
  const userId = getAuthorizerContext(event)?.user_id;
  if (!userId) {
    return error('User ID not found in authorizer context', 401);
  }

  const db = await getDbClient();
  try {
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    const result = await db.query(
      `SELECT s.id, s.state_text, s.captured_at
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'profile_skill_owner'
         AND sl.entity_id = '${userIdSafe}'
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[profile_skill]%'
       ORDER BY s.captured_at DESC`
    );

    const profileSkills = result.rows
      .map(row => {
        const parsed = parseProfileSkillStateText(row.state_text);
        if (!parsed) return null;
        return {
          id: row.id,
          captured_at: row.captured_at,
          ...parsed
        };
      })
      .filter(Boolean);

    return success(profileSkills);
  } finally {
    db.release();
  }
}

/**
 * POST /api/skill-profiles/generate
 * Generate a skill profile preview from action context. Nothing is persisted.
 * Requirements: 2.1, 2.2, 2.3, 2.7
 */
async function handleGenerate(event, organizationId) {
  const body = JSON.parse(event.body || '{}');
  const { action_id, action_context, growth_intent } = body;

  if (!action_id) {
    return error('action_id is required', 400);
  }

  const ctx = action_context || {};
  const title = (ctx.title || '').trim();
  const description = (ctx.description || '').trim();
  const expectedState = (ctx.expected_state || '').trim();

  // Requirement 2.7: at least one of title, description, or expected_state must be non-empty
  if (!title && !description && !expectedState) {
    return error('Insufficient context to generate skill profile. Add a title, description, or expected state.', 400);
  }

  // Extract optional growth intent (Requirement 1.4, 2.1)
  const growthIntent = (typeof growth_intent === 'string' ? growth_intent.trim() : '') || null;

  // Fetch organization AI config (falls back to defaults on error or missing config)
  const db = await getDbClient();
  let aiConfig;
  try {
    aiConfig = await fetchAiConfig(db, organizationId);
  } finally {
    db.release();
  }

  const prompt = buildSkillProfilePrompt(ctx, false, aiConfig, growthIntent);

  let profile;
  try {
    profile = await callBedrockForSkillProfile(prompt);
  } catch (err) {
    console.error('Bedrock call failed:', err);
    return error('AI service temporarily unavailable. Please try again.', 503);
  }

  // Validate the AI response structure; retry once with a stricter prompt if malformed
  if (!isValidSkillProfile(profile, aiConfig)) {
    console.warn('First attempt returned malformed profile, retrying with stricter prompt');
    const stricterPrompt = buildSkillProfilePrompt(ctx, true, aiConfig, growthIntent);
    try {
      profile = await callBedrockForSkillProfile(stricterPrompt);
    } catch (err) {
      console.error('Bedrock retry failed:', err);
      return error('AI service temporarily unavailable. Please try again.', 503);
    }

    if (!isValidSkillProfile(profile, aiConfig)) {
      console.error('Second attempt also returned malformed profile:', JSON.stringify(profile));
      return error('Failed to generate valid profile.', 500);
    }
  }

  // Preserve user's growth intent as the narrative — user controls what their skill profile says
  if (growthIntent) { profile.narrative = growthIntent; }

  // Return preview — no approved_at/approved_by, nothing persisted
  return success(profile);
}

/**
 * Build the prompt for Bedrock Claude to generate a skill profile.
 * When growthIntent is provided, switches to concept-axis generation where the action
 * becomes a "practice ground" and axes are shaped by the learner's growth direction.
 * When growthIntent is absent, uses the existing action-driven prompt unchanged.
 *
 * @param {Object} ctx - Action context
 * @param {boolean} strict - Whether to use a stricter prompt (retry)
 * @param {Object|null} aiConfig - Resolved AI config (uses defaults if null)
 * @param {string|null} growthIntent - Optional growth intent text from the learner
 * @returns {string}
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
function buildSkillProfilePrompt(ctx, strict = false, aiConfig = null, growthIntent = null) {
  if (!aiConfig) {
    aiConfig = resolveAiConfig(null);
  }
  const parts = [];
  if (ctx.title) parts.push(`Title: ${ctx.title}`);
  if (ctx.description) parts.push(`Description: ${ctx.description}`);
  if (ctx.expected_state) parts.push(`Expected Outcome (S'): ${ctx.expected_state}`);
  if (ctx.policy) parts.push(`Policy: ${ctx.policy}`);
  if (ctx.asset_name) parts.push(`Asset: ${ctx.asset_name}`);
  if (ctx.required_tools && ctx.required_tools.length > 0) {
    parts.push(`Required Tools: ${ctx.required_tools.join(', ')}`);
  }

  const actionContext = parts.join('\n');

  const strictClause = strict
    ? `\nCRITICAL: You MUST return EXACTLY ${aiConfig.min_axes} to ${aiConfig.max_axes} axes. Each axis MUST have a non-empty "description" (2-4 sentences). Each required_level MUST be an INTEGER between 0 and 5 inclusive. Do NOT return fewer than ${aiConfig.min_axes} or more than ${aiConfig.max_axes} axes. Do NOT return levels outside 0-5. Failure to comply will cause an error.`
    : '';

  // Requirement 2.6: When no growth intent, use existing action-driven prompt unchanged
  if (!growthIntent || !growthIntent.trim()) {
    return `You are a skill assessment expert. Analyze the following action context and produce a JSON skill requirements profile.

Action Context:
${actionContext}

SKILL LEVEL SCALE (Bloom's Taxonomy — use integers 0-5):
  0 = No exposure needed
  1 = Remember — can recall facts and follow documented procedures
  2 = Understand — can explain why the procedure works, not just how
  3 = Apply — can use knowledge in new situations without step-by-step guidance
  4 = Analyze — can break down problems, evaluate tradeoffs between approaches
  5 = Create — can innovate new approaches, teach others, set standards

Most routine tasks require level 1-2. Tasks requiring judgment or adaptation require level 3. Only specialized or leadership tasks should require level 4-5.

Produce a JSON object with these fields:
1. "narrative": A 2-4 sentence natural language description of what capabilities this action demands.
2. "axes": An array of ${aiConfig.min_axes} to ${aiConfig.max_axes} skill axes, each with:
   - "key": A snake_case identifier (e.g., "regulatory_navigation")
   - "label": A human-readable label (e.g., "Regulatory Navigation")
   - "description": A 2-4 sentence rich description of the concept.
     Capture: the core concept, why it matters for this action, what
     understanding looks like, and at least one specific question it raises.
     Derive from the action context (title, description, expected outcome).
     Write about concepts and mechanisms — NOT about specific farm instances.
   - "required_level": An INTEGER from 0 to 5 using the Bloom's scale above. Be realistic — most axes should be 1-3.
3. "generated_at": The current UTC timestamp in ISO 8601 format.

The axes should be specific to THIS action — different actions should surface different skill dimensions.
${strictClause}
Respond with ONLY the JSON object, no markdown formatting, no code fences, no explanation.`;
  }

  // Requirements 2.1, 2.2, 2.3, 2.4, 2.5: Growth intent present — concept-axis generation prompt
  return `You are a learning design expert. A learner has stated a growth direction and is about to work on a specific action. Your job is to generate a concept-driven skill profile that uses the action as a practice ground for the learner's growth intent.

Growth Intent (what the learner wants to get better at):
${growthIntent.trim()}

Action Context (the practice ground — a concrete situation to apply learning to):
${actionContext}

INSTRUCTIONS:
- The action is NOT the learning subject. It is the practice ground where the learner will apply concepts from their growth intent.
- Generate ${aiConfig.min_axes} to ${aiConfig.max_axes} concept axes shaped by the growth intent. Each axis should represent a distinct concept area the learner can explore.
- Ground each axis in real frameworks, research, or established concepts relevant to the growth intent (e.g., for "trust building": Trust Equation by Maister, Psychological Safety by Edmondson, Active Listening by Rogers).
- Each axis should be a distinct concept area — do not overlap or repeat the same idea under different names.
- The narrative should explain how the growth intent connects to the action context and what the learner will explore across the axes.

SKILL LEVEL SCALE (Bloom's Taxonomy — use integers 0-5):
  0 = No exposure needed
  1 = Remember — can recall facts and follow documented procedures
  2 = Understand — can explain why the procedure works, not just how
  3 = Apply — can use knowledge in new situations without step-by-step guidance
  4 = Analyze — can break down problems, evaluate tradeoffs between approaches
  5 = Create — can innovate new approaches, teach others, set standards

Most concept axes for growth-intent profiles should be level 2-3 (understanding and applying concepts). Use level 4-5 only for advanced synthesis or leadership concepts.

Produce a JSON object with these fields:
1. "narrative": A 2-4 sentence description of how the growth intent connects to the action context and what the learner will explore. Frame the action as a practice ground for applying the concepts.
2. "axes": An array of ${aiConfig.min_axes} to ${aiConfig.max_axes} concept axes, each with:
   - "key": A snake_case identifier (e.g., "trust_building_frameworks")
   - "label": A human-readable label (e.g., "Trust Building Frameworks")
   - "description": A 2-4 sentence rich description of the concept.
     Capture: the core concept, why it matters for this action, what
     understanding looks like, and at least one specific question it raises.
     Ground the description in the learner's own growth intent words.
     Write about concepts and mechanisms — NOT about specific farm instances
     (no field names, soil sample IDs, or observation dates).
   - "required_level": An INTEGER from 0 to 5 using the Bloom's scale above. Be realistic — most axes should be 2-3.
3. "generated_at": The current UTC timestamp in ISO 8601 format.
${strictClause}
Respond with ONLY the JSON object, no markdown formatting, no code fences, no explanation.`;
}

/**
 * Call Bedrock Claude to generate a skill profile from the prompt.
 * @param {string} prompt
 * @returns {Promise<Object>} Parsed skill profile object
 */
async function callBedrockForSkillProfile(prompt) {
  const MODEL_ID = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    temperature: 0.4,
    messages: [{ role: 'user', content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    body: JSON.stringify(payload),
    contentType: 'application/json',
    accept: 'application/json'
  });

  const response = await bedrock.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  if (!responseBody.content?.[0]?.text) {
    throw new Error('Invalid response from Bedrock: missing content');
  }

  const text = responseBody.content[0].text.trim();

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  return JSON.parse(cleaned);
}

/**
 * Validate that a skill profile has the correct structure.
 * - narrative: non-empty string
 * - axes: array within configured min/max range, each with non-empty key, label, and required_level in [0, 5]
 * - generated_at: non-empty string
 * @param {Object} profile
 * @param {Object|null} aiConfig - Resolved AI config (uses defaults if null)
 * @returns {boolean}
 */
function isValidSkillProfile(profile, aiConfig = null) {
  if (!aiConfig) {
    aiConfig = resolveAiConfig(null);
  }
  if (!profile || typeof profile !== 'object') return false;
  if (typeof profile.narrative !== 'string' || !profile.narrative.trim()) return false;
  if (typeof profile.generated_at !== 'string' || !profile.generated_at.trim()) return false;
  if (!Array.isArray(profile.axes)) return false;
  if (profile.axes.length < aiConfig.min_axes || profile.axes.length > aiConfig.max_axes) return false;

  for (const axis of profile.axes) {
    if (!axis || typeof axis !== 'object') return false;
    if (typeof axis.key !== 'string' || !axis.key.trim()) return false;
    if (typeof axis.label !== 'string' || !axis.label.trim()) return false;
    if (typeof axis.description !== 'string' || !axis.description.trim()) return false;
    if (typeof axis.required_level !== 'number') return false;
    if (axis.required_level < 0 || axis.required_level > 5) return false;
  }

  return true;
}

/**
 * POST /api/skill-profiles/approve
 * Approve and store a skill profile, then queue embedding generation.
 * Requirements: 2.5, 2.6, 2.8
 */
async function handleApprove(event, organizationId) {
  const body = JSON.parse(event.body || '{}');
  const { action_id, skill_profile, approved_by, growth_intent } = body;

  if (!action_id) {
    return error('action_id is required', 400);
  }
  if (!approved_by) {
    return error('approved_by is required', 400);
  }
  if (!skill_profile || typeof skill_profile !== 'object') {
    return error('skill_profile is required', 400);
  }

  // Fetch organization AI config for validation (falls back to defaults on error)
  const configDb = await getDbClient();
  let aiConfig;
  try {
    aiConfig = await fetchAiConfig(configDb, organizationId);
  } finally {
    configDb.release();
  }

  // Validate profile structure using existing validator
  if (!isValidSkillProfile(skill_profile, aiConfig)) {
    return error(`Invalid skill profile structure: requires non-empty narrative, generated_at, and ${aiConfig.min_axes}-${aiConfig.max_axes} axes each with non-empty key, label, and required_level in [0, 5]`, 400);
  }

  // Add approval metadata and growth intent to the profile (Requirements 1.5, 1.6)
  const approvedProfile = {
    ...skill_profile,
    growth_intent: growth_intent && typeof growth_intent === 'string' && growth_intent.trim() ? growth_intent.trim() : null,
    growth_intent_provided: !!(growth_intent && typeof growth_intent === 'string' && growth_intent.trim()),
    approved_at: new Date().toISOString(),
    approved_by
  };

  // Delete cached capability_profile states linked to this action before storing new profile.
  // This ensures the next capability read triggers a fresh computation against the new axes.
  const cacheDb = await getDbClient();
  try {
    const actionIdSafe = escapeLiteral(action_id);
    const orgIdSafe = escapeLiteral(organizationId);

    const stateIdsResult = await cacheDb.query(
      `SELECT s.id FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'capability_profile'
         AND sl.entity_id = '${actionIdSafe}'
         AND s.organization_id = '${orgIdSafe}'`
    );

    if (stateIdsResult.rows.length > 0) {
      const stateIds = stateIdsResult.rows.map(r => r.id);
      const stateIdList = stateIds.map(id => `'${escapeLiteral(id)}'`).join(',');

      // Delete states (CASCADE handles state_links cleanup)
      await cacheDb.query(
        `DELETE FROM states WHERE id IN (${stateIdList})`
      );

      // Clean up unified_embeddings for the deleted states
      const stateIdStrings = stateIds.map(id => `'${escapeLiteral(String(id))}'`).join(',');
      await cacheDb.query(
        `DELETE FROM unified_embeddings WHERE entity_type = 'state' AND entity_id IN (${stateIdStrings}) AND organization_id = '${orgIdSafe}'`
      );

      console.log('Deleted', stateIds.length, 'capability_profile cache states for action', action_id);
    }
  } catch (cacheErr) {
    console.error('Failed to delete capability_profile cache states during approve:', cacheErr);
  } finally {
    cacheDb.release();
  }

  // Store the profile as JSONB in actions.skill_profile
  const db = await getDbClient();
  let updatedAction;
  try {
    const profileJson = escapeLiteral(JSON.stringify(approvedProfile));
    const actionIdSafe = escapeLiteral(action_id);
    const orgIdSafe = escapeLiteral(organizationId);

    const result = await db.query(
      `UPDATE actions SET skill_profile = '${profileJson}'::jsonb, updated_at = NOW() WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}' RETURNING id, organization_id`
    );

    if (!result.rows || result.rows.length === 0) {
      return error('Action not found', 404);
    }

    updatedAction = result.rows[0];
  } finally {
    db.release();
  }

  // Delete existing skill_axis embeddings for this action before generating new ones
  const deleteDb = await getDbClient();
  try {
    await deleteDb.query(
      `DELETE FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1`,
      [updatedAction.id]
    );
    console.log('Deleted existing skill_axis embeddings for action', updatedAction.id);
  } catch (err) {
    console.error('Failed to delete existing skill_axis embeddings:', err);
  } finally {
    deleteDb.release();
  }

  // Generate per-axis embedding SQS messages — await all sends
  const axisEmbeddingPromises = approvedProfile.axes.map(axis => {
    const embeddingSource = composeAxisEmbeddingSource(axis, approvedProfile.narrative);

    return sqs.send(new SendMessageCommand({
      QueueUrl: EMBEDDINGS_QUEUE_URL,
      MessageBody: JSON.stringify({
        entity_type: 'skill_axis',
        action_id: updatedAction.id,
        axis_key: axis.key,
        embedding_source: embeddingSource,
        organization_id: updatedAction.organization_id
      })
    })).then(() => {
      console.log('Queued skill_axis embedding for action', updatedAction.id, 'axis', axis.key);
    }).catch(err => {
      console.error('Failed to queue skill_axis embedding for action', updatedAction.id, 'axis', axis.key, err);
    });
  });

  await Promise.all(axisEmbeddingPromises);

  // Retain existing action_skill_profile embedding for backward compatibility
  const axisLabels = approvedProfile.axes.map(a => a.label).join(', ');
  const wholeProfileEmbeddingSource = `${approvedProfile.narrative} ${axisLabels}`;

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: EMBEDDINGS_QUEUE_URL,
      MessageBody: JSON.stringify({
        entity_type: 'action_skill_profile',
        entity_id: updatedAction.id,
        embedding_source: wholeProfileEmbeddingSource,
        organization_id: updatedAction.organization_id
      })
    }));
    console.log('Queued action_skill_profile embedding for action', updatedAction.id);
  } catch (err) {
    console.error('Failed to queue action_skill_profile embedding:', err);
  }

  return success(approvedProfile);
}

/**
 * DELETE /api/skill-profiles/:actionId
 * Remove a skill profile from an action and delete its embedding.
 * Requirements: 2.4
 */
async function handleDelete(actionId, organizationId) {
  const db = await getDbClient();
  try {
    const actionIdSafe = escapeLiteral(actionId);
    const orgIdSafe = escapeLiteral(organizationId);

    // 1. Set skill_profile to NULL on the action
    const result = await db.query(
      `UPDATE actions SET skill_profile = NULL, updated_at = NOW() WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}' RETURNING id`
    );

    if (!result.rows || result.rows.length === 0) {
      return error('Action not found', 404);
    }

    // 2. Delete the corresponding action_skill_profile entry from unified_embeddings
    await db.query(
      `DELETE FROM unified_embeddings WHERE entity_type = 'action_skill_profile' AND entity_id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    // 3. Delete cached capability_profile states linked to this action
    try {
      const stateIdsResult = await db.query(
        `SELECT s.id FROM states s
         INNER JOIN state_links sl ON sl.state_id = s.id
         WHERE sl.entity_type = 'capability_profile'
           AND sl.entity_id = '${actionIdSafe}'
           AND s.organization_id = '${orgIdSafe}'`
      );

      if (stateIdsResult.rows.length > 0) {
        const stateIds = stateIdsResult.rows.map(r => r.id);
        const stateIdList = stateIds.map(id => `'${escapeLiteral(id)}'`).join(',');

        // Delete states (CASCADE handles state_links cleanup)
        await db.query(
          `DELETE FROM states WHERE id IN (${stateIdList})`
        );

        // Clean up unified_embeddings for the deleted states
        const stateIdStrings = stateIds.map(id => `'${escapeLiteral(String(id))}'`).join(',');
        await db.query(
          `DELETE FROM unified_embeddings WHERE entity_type = 'state' AND entity_id IN (${stateIdStrings}) AND organization_id = '${orgIdSafe}'`
        );

        console.log('Deleted', stateIds.length, 'capability_profile cache states for action', actionId);
      }
    } catch (cacheErr) {
      console.error('Failed to delete capability_profile cache states:', cacheErr);
    }

    return success({ deleted: true, action_id: actionId });
  } finally {
    db.release();
  }
}

/**
 * POST /api/profile-skills/generate
 * Generate AI interpretation and concept axes from a learner's narrative (preview, not stored).
 * Requirements: 1.3, 1.4, 1.5
 */
async function handleGenerateProfileSkill(event, organizationId) {
  const body = JSON.parse(event.body || '{}');
  const { narrative } = body;

  if (!narrative || typeof narrative !== 'string' || !narrative.trim()) {
    return error('narrative is required and must be a non-empty string', 400);
  }

  const prompt = buildProfileSkillGenerationPrompt(narrative.trim(), false);

  let result;
  try {
    result = await callBedrockForSkillProfile(prompt);
  } catch (err) {
    console.error('Bedrock call failed for profile skill generation:', err);
    return error('AI service temporarily unavailable. Please try again.', 503);
  }

  // Validate the AI response structure; retry once with a stricter prompt if malformed
  if (!isValidProfileSkillGeneration(result)) {
    console.warn('First attempt returned malformed profile skill generation, retrying with stricter prompt');
    const stricterPrompt = buildProfileSkillGenerationPrompt(narrative.trim(), true);
    try {
      result = await callBedrockForSkillProfile(stricterPrompt);
    } catch (err) {
      console.error('Bedrock retry failed for profile skill generation:', err);
      return error('AI service temporarily unavailable. Please try again.', 503);
    }

    if (!isValidProfileSkillGeneration(result)) {
      console.error('Second attempt also returned malformed profile skill generation:', JSON.stringify(result));
      return error('Failed to generate valid profile skill.', 500);
    }
  }

  // Return preview — nothing persisted
  return success({
    ai_interpretation: result.ai_interpretation,
    axes: result.axes
  });
}

/**
 * Build the Bedrock prompt for profile skill generation from a learner's narrative.
 * Extracts concept_label, source_attribution, learning_direction, and 3-5 concept axes.
 *
 * @param {string} narrative - The learner's original narrative text
 * @param {boolean} strict - Whether to use a stricter prompt (retry)
 * @returns {string}
 * Requirements: 1.3, 1.4, 1.5
 */
function buildProfileSkillGenerationPrompt(narrative, strict = false) {
  const strictClause = strict
    ? `\nCRITICAL: You MUST return EXACTLY 3 to 5 axes. Each axis MUST have a non-empty "key" (snake_case), "label", and "description". The ai_interpretation MUST have non-empty "concept_label", "source_attribution", and "learning_direction". Do NOT return fewer than 3 or more than 5 axes. Failure to comply will cause an error.`
    : '';

  return `You are a learning design expert. A learner has described a personal growth direction.
Your job is to extract the core concept and generate concept axes for structured learning.

LEARNER'S NARRATIVE:
${narrative}

INSTRUCTIONS:
1. Extract an AI interpretation with:
   - concept_label: A short name for the core concept (e.g., "Extreme Ownership")
   - source_attribution: Any referenced source, person, or origin (e.g., "Jocko Willink, Diary of a CEO"). Use "Personal insight" if no source is referenced.
   - learning_direction: 1-2 sentence summary of the growth direction

2. Generate 3-5 concept axes, each representing a distinct concept area grounded in real
   frameworks, research, or established concepts relevant to the narrative.
   Each axis has:
   - key: snake_case identifier
   - label: Human-readable label
   - description: 1-2 sentence description of the concept area
${strictClause}
Return ONLY a JSON object:
{
  "ai_interpretation": { "concept_label": "...", "source_attribution": "...", "learning_direction": "..." },
  "axes": [{ "key": "...", "label": "...", "description": "..." }]
}`;
}

/**
 * Validate that a profile skill generation response has the correct structure.
 * - ai_interpretation: object with non-empty concept_label, source_attribution, learning_direction
 * - axes: array of 3-5 items, each with non-empty key, label, description
 * @param {Object} result
 * @returns {boolean}
 */
function isValidProfileSkillGeneration(result) {
  if (!result || typeof result !== 'object') return false;

  // Validate ai_interpretation
  const ai = result.ai_interpretation;
  if (!ai || typeof ai !== 'object') return false;
  if (typeof ai.concept_label !== 'string' || !ai.concept_label.trim()) return false;
  if (typeof ai.source_attribution !== 'string' || !ai.source_attribution.trim()) return false;
  if (typeof ai.learning_direction !== 'string' || !ai.learning_direction.trim()) return false;

  // Validate axes
  if (!Array.isArray(result.axes)) return false;
  if (result.axes.length < 3 || result.axes.length > 5) return false;

  for (const axis of result.axes) {
    if (!axis || typeof axis !== 'object') return false;
    if (typeof axis.key !== 'string' || !axis.key.trim()) return false;
    if (typeof axis.label !== 'string' || !axis.label.trim()) return false;
    if (typeof axis.description !== 'string' || !axis.description.trim()) return false;
  }

  return true;
}

/**
 * POST /api/profile-skills/approve
 * Approve and store a profile skill as a state record, link to user, and queue embedding.
 * Requirements: 1.2, 1.3, 1.6, 1.8, 5.2
 */
async function handleApproveProfileSkill(event, organizationId) {
  const userId = getAuthorizerContext(event)?.user_id;
  if (!userId) {
    return error('User ID not found in authorizer context', 401);
  }

  const body = JSON.parse(event.body || '{}');
  const { narrative, ai_interpretation, axes } = body;

  if (!narrative || typeof narrative !== 'string' || !narrative.trim()) {
    return error('narrative is required and must be a non-empty string', 400);
  }

  // Build profile skill JSON (Req 1.2: preserve original narrative, Req 1.8: ai_interpretation can be null)
  const profileSkill = {
    original_narrative: narrative,
    ai_interpretation: ai_interpretation || null,
    axes: (axes || []).map(axis => ({
      ...axis,
      bloom_level: 0,
      progression_history: []
    })),
    active: true, // Req 5.2: default to active
    created_at: new Date().toISOString()
  };

  // Compose state_text using canonical format
  const stateText = composeProfileSkillStateText(profileSkill);

  const db = await getDbClient();
  let stateId;
  try {
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);
    const stateTextSafe = escapeLiteral(stateText);

    // INSERT into states table (Req 1.6)
    const insertResult = await db.query(
      `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
       VALUES ('${orgIdSafe}', '${stateTextSafe}', '${userIdSafe}', NOW())
       RETURNING id`
    );

    stateId = insertResult.rows[0].id;
    const stateIdSafe = escapeLiteral(stateId);

    // INSERT into state_links with profile_skill_owner → userId
    await db.query(
      `INSERT INTO state_links (state_id, entity_type, entity_id)
       VALUES ('${stateIdSafe}', 'profile_skill_owner', '${userIdSafe}')`
    );
  } finally {
    db.release();
  }

  // Queue embedding via SQS — compose embedding_source from narrative + concept label + axis labels
  const conceptLabel = ai_interpretation?.concept_label || '';
  const axisLabels = (axes || []).map(a => a.label).filter(Boolean).join(', ');
  const embeddingParts = [narrative, conceptLabel, axisLabels].filter(Boolean);
  const embeddingSource = embeddingParts.join(' ');

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: EMBEDDINGS_QUEUE_URL,
      MessageBody: JSON.stringify({
        entity_type: 'state',
        entity_id: stateId,
        embedding_source: embeddingSource,
        organization_id: organizationId
      })
    }));
    console.log('Queued profile skill embedding for state', stateId);
  } catch (err) {
    // Log warning but don't fail — embedding can be regenerated later
    console.error('Failed to queue profile skill embedding:', err);
  }

  // Return created profile skill with state ID (201 Created)
  return {
    statusCode: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    },
    body: JSON.stringify({
      data: {
        id: stateId,
        ...profileSkill
      }
    })
  };
}

/**
 * PUT /api/profile-skills/:id/toggle
 * Toggle the active/inactive status of a profile skill.
 * Requirements: 5.1, 5.3, 5.4
 */
async function handleToggleProfileSkill(event, organizationId) {
  const userId = getAuthorizerContext(event)?.user_id;
  if (!userId) {
    return error('User ID not found in authorizer context', 401);
  }

  // Extract state ID from path: /api/profile-skills/{id}/toggle
  const pathParts = event.path.split('/');
  const toggleIndex = pathParts.indexOf('toggle');
  const stateId = toggleIndex > 0 ? pathParts[toggleIndex - 1] : null;
  if (!stateId) {
    return error('Profile skill ID is required', 400);
  }

  const db = await getDbClient();
  try {
    const stateIdSafe = escapeLiteral(stateId);
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    // Fetch the state record
    const stateResult = await db.query(
      `SELECT s.id, s.state_text, s.captured_at
       FROM states s
       WHERE s.id = '${stateIdSafe}'
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[profile_skill]%'`
    );

    if (!stateResult.rows || stateResult.rows.length === 0) {
      return error('Profile skill not found', 404);
    }

    // Verify ownership via state_links (profile_skill_owner → userId)
    const ownerResult = await db.query(
      `SELECT 1 FROM state_links
       WHERE state_id = '${stateIdSafe}'
         AND entity_type = 'profile_skill_owner'
         AND entity_id = '${userIdSafe}'`
    );

    if (!ownerResult.rows || ownerResult.rows.length === 0) {
      return error('Not authorized to modify this profile skill', 403);
    }

    const row = stateResult.rows[0];

    // Parse state_text to get the profile skill data
    const parsed = parseProfileSkillStateText(row.state_text);
    if (!parsed) {
      return error('Failed to parse profile skill data', 500);
    }

    // Toggle the active flag (Req 5.1, 5.3, 5.4)
    parsed.active = !parsed.active;

    // Recompose state_text with the toggled value
    const updatedStateText = composeProfileSkillStateText(parsed);
    const updatedStateTextSafe = escapeLiteral(updatedStateText);

    // Update the states table
    await db.query(
      `UPDATE states SET state_text = '${updatedStateTextSafe}'
       WHERE id = '${stateIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    // Return updated profile skill with state ID
    return success({
      id: row.id,
      captured_at: row.captured_at,
      ...parsed
    });
  } finally {
    db.release();
  }
}

/**
 * DELETE /api/profile-skills/:id
 * Delete a profile skill permanently.
 * Requirements: 6.2
 */
async function handleDeleteProfileSkill(event, organizationId) {
  const userId = getAuthorizerContext(event)?.user_id;
  if (!userId) {
    return error('User ID not found in authorizer context', 401);
  }

  // Extract state ID from path: /api/profile-skills/{id}
  const pathParts = event.path.split('/');
  const stateId = pathParts[pathParts.length - 1];
  if (!stateId) {
    return error('Profile skill ID is required', 400);
  }

  const db = await getDbClient();
  try {
    const stateIdSafe = escapeLiteral(stateId);
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    // Fetch the state record to verify it exists
    const stateResult = await db.query(
      `SELECT s.id FROM states s
       WHERE s.id = '${stateIdSafe}'
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[profile_skill]%'`
    );

    if (!stateResult.rows || stateResult.rows.length === 0) {
      return error('Profile skill not found', 404);
    }

    // Verify ownership via state_links (profile_skill_owner → userId)
    const ownerResult = await db.query(
      `SELECT 1 FROM state_links
       WHERE state_id = '${stateIdSafe}'
         AND entity_type = 'profile_skill_owner'
         AND entity_id = '${userIdSafe}'`
    );

    if (!ownerResult.rows || ownerResult.rows.length === 0) {
      return error('Not authorized to delete this profile skill', 403);
    }

    // DELETE from states (CASCADE handles state_links deletion)
    await db.query(
      `DELETE FROM states WHERE id = '${stateIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    // DELETE from unified_embeddings where entity_type = 'state' and entity_id = stateId
    await db.query(
      `DELETE FROM unified_embeddings
       WHERE entity_type = 'state'
         AND entity_id = '${stateIdSafe}'
         AND organization_id = '${orgIdSafe}'`
    );

    return success({ deleted: true });
  } finally {
    db.release();
  }
}

/**
 * Compose a profile skill state_text in the canonical format.
 * Format: [profile_skill] | {serialized JSON}
 *
 * User ownership is tracked via captured_by on the states table and
 * state_links with entity_type='profile_skill_owner' — not in state_text.
 *
 * @param {Object} profileSkillData - The profile skill data object
 * @returns {string} The composed state_text
 */
function composeProfileSkillStateText(profileSkillData) {
  return `[profile_skill] | ${JSON.stringify(profileSkillData)}`;
}

/**
 * Parse a profile skill state_text, extracting the profile skill data object.
 * Returns null if format doesn't match.
 *
 * @param {string} stateText - The state_text to parse
 * @returns {object|null} Parsed profile skill data, or null
 */
function parseProfileSkillStateText(stateText) {
  const match = stateText.match(
    /^\[profile_skill\] \| (.+)$/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

// Export utility functions for testing
exports.composeAxisEmbeddingSource = composeAxisEmbeddingSource;
exports.buildSkillProfilePrompt = buildSkillProfilePrompt;
exports.composeProfileSkillStateText = composeProfileSkillStateText;
exports.parseProfileSkillStateText = parseProfileSkillStateText;
exports.buildProfileSkillGenerationPrompt = buildProfileSkillGenerationPrompt;
exports.isValidProfileSkillGeneration = isValidProfileSkillGeneration;
