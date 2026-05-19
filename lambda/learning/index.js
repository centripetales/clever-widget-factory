const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse, corsResponse } = require('/opt/nodejs/response');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');
const { composeStateEmbeddingSource } = require('/opt/nodejs/embedding-composition');
const { fetchAiConfig, resolveAiConfig } = require('/opt/nodejs/aiConfigDefaults');
const { resolveLensConfig, buildLensPool } = require('/opt/nodejs/lensDefaults');
const { filterCompletedKnowledgeStates, extractBestMatch, extractTopKMatches } = require('./evidenceUtils');
const { distributeMatchesToObjectives, composeAxisAwareEmbeddingSource } = require('./objectiveMatchUtils');
const { selectLenses, applyGapBoost, buildValuesLenses, buildLensPromptBlock, buildAssetContextBlock } = require('./lensUtils');
const { scoreToBloomLevel } = require('/opt/nodejs/bloomUtils');
const { computeBloomLevel, computeTaperingDecision } = require('./progressionModel');

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });
const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

// --- Model Configuration ---
// Set env vars MODEL_REASONING / MODEL_FAST on the Lambda. No fallbacks — missing config
// must fail loudly rather than silently using a wrong model.
//
// Available models (us-west-2 cross-region inference):
//   Haiku 4.5  — us.anthropic.claude-haiku-4-5-20251001-v1:0   ($1/$5 per MTok,  fastest)
//   Haiku 3.5  — us.anthropic.claude-3-5-haiku-20241022-v1:0   ($0.80/$4 per MTok, fast)
//   Sonnet 4.6 — us.anthropic.claude-sonnet-4-6                ($3/$15 per MTok,  fast)
//   Sonnet 4   — us.anthropic.claude-sonnet-4-20250514-v1:0    ($3/$15 per MTok,  moderate)
//
// Reasoning model: evaluation, capability scoring, objective generation (nuanced judgment)
const MODEL_REASONING = process.env.MODEL_REASONING;
if (!MODEL_REASONING) throw new Error('MODEL_REASONING env var is required');
//
// Fast model: quiz question generation (structured JSON, speed > depth)
const MODEL_FAST = process.env.MODEL_FAST;
if (!MODEL_FAST) throw new Error('MODEL_FAST env var is required');

// Legacy alias — points to reasoning model for backward compatibility
const OBJECTIVE_MODEL_ID = MODEL_REASONING;

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
    // Fetch AI config once per request for configurable Bedrock parameters
    const db = await getDbClient();
    let aiConfig;
    try {
      aiConfig = await fetchAiConfig(db, organizationId);
    } finally {
      db.release();
    }

    // Route dispatch based on HTTP method and path segments
    const segments = path.replace('/api/learning/', '').split('/');

    // GET /api/learning/:actionId/:userId/objectives
    if (httpMethod === 'GET' && segments.length === 3 && segments[2] === 'objectives') {
      const actionId = segments[0];
      const userId = segments[1];
      return await handleGetObjectives(actionId, userId, organizationId, aiConfig);
    }

    // GET /api/learning/:actionId/:userId/evaluation-status
    if (httpMethod === 'GET' && segments.length === 3 && segments[2] === 'evaluation-status') {
      const actionId = segments[0];
      const userId = segments[1];
      const queryParams = event.queryStringParameters || {};
      return await handleEvaluationStatus(actionId, userId, organizationId, queryParams);
    }

    // POST /api/learning/:actionId/quiz/generate
    if (httpMethod === 'POST' && segments.length === 3 && segments[1] === 'quiz' && segments[2] === 'generate') {
      const actionId = segments[0];
      const body = JSON.parse(event.body || '{}');
      return await handleQuizGenerate(actionId, body, organizationId);
    }

    // POST /api/learning/:actionId/quiz/evaluate
    if (httpMethod === 'POST' && segments.length === 3 && segments[1] === 'quiz' && segments[2] === 'evaluate') {
      const actionId = segments[0];
      const body = JSON.parse(event.body || '{}');
      return await handleEvaluate(actionId, body, organizationId, aiConfig);
    }

    // POST /api/learning/:actionId/verify
    if (httpMethod === 'POST' && segments.length === 2 && segments[1] === 'verify') {
      const actionId = segments[0];
      const body = JSON.parse(event.body || '{}');
      return await handleVerify(actionId, body, organizationId, aiConfig);
    }

    return error('Not found', 404);

  } catch (err) {
    console.error('Error:', err);
    return error(err.message, 500);
  }
};

/**
 * GET /api/learning/:actionId/:userId/objectives
 * Get or generate learning objectives for a user's gap axes on an action.
 * Requirements: 3.5.1, 3.5.2, 3.5.3, 3.5.4, 3.5.9, 5.1, 5.5
 */
async function handleGetObjectives(actionId, userId, organizationId, aiConfig) {
  const db = await getDbClient();
  try {
    const actionIdSafe = escapeLiteral(actionId);
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    // 1. Fetch action with skill_profile; return 404 if no approved profile
    const actionResult = await db.query(
      `SELECT id, title, description, expected_state, skill_profile
       FROM actions
       WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    if (!actionResult.rows || actionResult.rows.length === 0) {
      return error('Action not found', 404);
    }

    const action = actionResult.rows[0];
    const skillProfile = action.skill_profile;

    if (!skillProfile || !skillProfile.approved_at) {
      return error('No approved skill profile found for this action', 404);
    }

    // 2. Build axes from the skill profile — treat all axes as potential learning axes.
    //    The frontend determines which are gaps based on the capability Lambda's data.
    const allAxes = skillProfile.axes.map(axis => ({
      axisKey: axis.key,
      axisLabel: axis.label,
      requiredLevel: Math.max(0, Math.min(5, Math.round(axis.required_level))),
      currentLevel: 0 // Placeholder — frontend uses capability Lambda for actual levels
    }));

    // 4. Check for existing learning objective states for this action + user.
    //    Use a pg advisory lock keyed on (action, user) to prevent concurrent requests
    //    from both seeing zero objectives and both generating a duplicate set.
    const lockKey = Math.abs(
      (actionId + userId).split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)
    );
    await db.query(`SELECT pg_advisory_xact_lock(${lockKey})`);

    const existingObjectivesResult = await db.query(
      `SELECT s.id, s.state_text, s.captured_at
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'action' AND sl.entity_id = '${actionIdSafe}'
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[learning_objective]%'
         AND s.state_text LIKE '%user=${userIdSafe}%'
       ORDER BY s.captured_at ASC`
    );

    // Group existing objectives by axis key
    const existingByAxis = {};
    for (const row of existingObjectivesResult.rows) {
      const parsed = parseLearningObjectiveStateText(row.state_text);
      if (parsed) {
        if (!existingByAxis[parsed.axisKey]) {
          existingByAxis[parsed.axisKey] = [];
        }
        existingByAxis[parsed.axisKey].push({
          id: row.id,
          text: parsed.objectiveText,
          axisKey: parsed.axisKey
        });
      }
    }

    // 5. For each axis without existing objectives, generate via Bedrock and store.
    //    The advisory lock above ensures only one request runs this section at a time.
    const axesNeedingGeneration = allAxes.filter(
      (axis) => !existingByAxis[axis.axisKey] || existingByAxis[axis.axisKey].length === 0
    );

    if (axesNeedingGeneration.length > 0) {
      const generatedObjectives = await generateObjectivesViaBedrock(
        action, skillProfile, axesNeedingGeneration
      );

      for (const obj of generatedObjectives) {
        const stateText = composeLearningObjectiveStateText(
          obj.axisKey, actionId, userId, obj.text
        );

        const insertResult = await db.query(
          `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
           VALUES ('${orgIdSafe}', '${escapeLiteral(stateText)}', '${userIdSafe}', NOW())
           RETURNING id`
        );
        const stateId = insertResult.rows[0].id;

        await db.query(
          `INSERT INTO state_links (state_id, entity_type, entity_id)
           VALUES ('${escapeLiteral(stateId)}', 'action', '${actionIdSafe}')`
        );

        if (!existingByAxis[obj.axisKey]) {
          existingByAxis[obj.axisKey] = [];
        }
        existingByAxis[obj.axisKey].push({
          id: stateId,
          text: obj.text,
          axisKey: obj.axisKey
        });

        // 6. Queue embedding for each new objective state (fire-and-forget)
        queueObjectiveEmbedding(stateId, stateText, organizationId)
          .catch(err => console.error('Failed to queue objective embedding:', err));
      }
    }

    // 7. Fetch knowledge states for status derivation
    //    Knowledge states are linked to learning objectives via state_links entity_type='learning_objective'
    const allObjectiveIds = [];
    for (const objectives of Object.values(existingByAxis)) {
      for (const obj of objectives) {
        allObjectiveIds.push(obj.id);
      }
    }

    let knowledgeStatesByObjective = {};
    if (allObjectiveIds.length > 0) {
      const objectiveIdsList = allObjectiveIds.map(id => `'${escapeLiteral(id)}'`).join(',');
      const knowledgeResult = await db.query(
        `SELECT sl.entity_id as objective_id, s.state_text
         FROM states s
         INNER JOIN state_links sl ON sl.state_id = s.id
         WHERE sl.entity_type = 'learning_objective'
           AND sl.entity_id IN (${objectiveIdsList})
           AND s.organization_id = '${orgIdSafe}'
         ORDER BY s.captured_at ASC`
      );

      for (const row of knowledgeResult.rows) {
        if (!knowledgeStatesByObjective[row.objective_id]) {
          knowledgeStatesByObjective[row.objective_id] = [];
        }
        knowledgeStatesByObjective[row.objective_id].push(row.state_text);
      }
    }

    // 8. Semantic evidence tagging via vector similarity search
    //    Primary path: one query per axis using skill_axis embeddings (4-6 queries)
    //    Fallback path: one query per objective (15-25 queries) if no skill_axis embeddings exist
    const similarityByObjective = {};

    // 8a. Check if skill_axis embeddings exist for this action
    let usePerAxisPath = false;
    if (allObjectiveIds.length > 0) {
      try {
        const axisEmbeddingCheck = await db.query(
          `SELECT COUNT(*) as cnt FROM unified_embeddings
           WHERE entity_type = 'skill_axis'
             AND action_id = $1
             AND organization_id = $2`,
          [actionId, organizationId]
        );
        usePerAxisPath = parseInt(axisEmbeddingCheck.rows[0].cnt, 10) > 0;
      } catch (err) {
        console.warn('Failed to check for skill_axis embeddings, falling back to per-objective:', err.message);
      }
    }

    if (usePerAxisPath) {
      // 8b. Per-axis similarity search: one query per axis, then distribute to objectives
      console.log(`Using per-axis similarity search for action ${actionId} (${allAxes.length} axes)`);
      const allAxisMatches = [];

      for (const axis of allAxes) {
        try {
          const simResult = await db.query(
            `SELECT ue.entity_id, ue.embedding_source,
                    (1 - (ue.embedding <=> (SELECT embedding FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1 AND axis_key = $2 LIMIT 1))) as similarity
             FROM unified_embeddings ue
             INNER JOIN states s ON s.id::text = ue.entity_id
             WHERE ue.entity_type = 'state'
               AND ue.organization_id = $3
               AND s.captured_by = $4
               AND s.state_text LIKE '%which was the correct answer%'
             ORDER BY similarity DESC
             LIMIT 10`,
            [actionId, axis.axisKey, organizationId, userId]
          );

          for (const row of simResult.rows) {
            allAxisMatches.push({
              entity_id: row.entity_id,
              embedding_source: row.embedding_source,
              similarity: parseFloat(row.similarity)
            });
          }
        } catch (err) {
          console.warn('Vector similarity search failed for axis', axis.axisKey, ':', err.message);
        }
      }

      // Build objectives list for distribution (all objectives across all axes)
      const allObjectivesForDistribution = [];
      for (const objectives of Object.values(existingByAxis)) {
        for (const obj of objectives) {
          allObjectivesForDistribution.push({ id: obj.id, text: obj.text });
        }
      }

      // Distribute axis matches to individual objectives by text comparison
      const distributedMatches = distributeMatchesToObjectives(allAxisMatches, allObjectivesForDistribution);

      for (const objectiveId of allObjectiveIds) {
        similarityByObjective[objectiveId] = distributedMatches.get(objectiveId) || [];
      }
    } else {
      // 8c. Fallback: per-objective similarity search (backward compatibility)
      console.log(`Using per-objective similarity search for action ${actionId} (${allObjectiveIds.length} objectives, no skill_axis embeddings)`);
      for (const objectiveId of allObjectiveIds) {
        try {
          const simResult = await db.query(
            `SELECT ue.entity_id, ue.embedding_source,
                    (1 - (ue.embedding <=> (SELECT embedding FROM unified_embeddings WHERE entity_type = 'state' AND entity_id = $1 LIMIT 1))) as similarity
             FROM unified_embeddings ue
             INNER JOIN states s ON s.id::text = ue.entity_id
             WHERE ue.entity_type = 'state'
               AND ue.organization_id = $2
               AND s.captured_by = $3
               AND s.state_text LIKE '%which was the correct answer%'
               AND ue.entity_id != $1
             ORDER BY similarity DESC
             LIMIT 5`,
            [objectiveId, organizationId, userId]
          );

          similarityByObjective[objectiveId] = simResult.rows.map(r => ({
            similarity: parseFloat(r.similarity),
            embedding_source: r.embedding_source
          }));
        } catch (err) {
          console.warn('Vector similarity search failed for objective', objectiveId, ':', err.message);
          similarityByObjective[objectiveId] = [];
        }
      }
    }

    // 9. Build response grouped by axis with semantic evidence, continuous scores, and progression levels
    const axes = allAxes.map((gap) => {
      const axisObjectives = existingByAxis[gap.axisKey] || [];

      // Collect all knowledge states for this axis and derive per-axis metrics
      let totalRecognitionObjectives = axisObjectives.length;
      let correctRecognitionCount = 0;
      const allAxisOpenFormStates = [];

      for (const obj of axisObjectives) {
        const knowledgeStates = knowledgeStatesByObjective[obj.id] || [];
        for (const stateText of knowledgeStates) {
          // Count correct recognition answers
          if (stateText.includes('which was the correct answer')) {
            correctRecognitionCount++;
          }
          // Parse open-form states for progression/score derivation
          const parsed = parseOpenFormStateText(stateText);
          if (parsed) {
            allAxisOpenFormStates.push(parsed);
          }
        }
      }

      // Derive recognition completion for progression level
      const recognitionComplete = totalRecognitionObjectives > 0 &&
        correctRecognitionCount >= totalRecognitionObjectives;

      // Compute continuous score and progression level for this axis
      const continuousScore = computeContinuousScore(
        allAxisOpenFormStates, totalRecognitionObjectives, correctRecognitionCount
      );
      const { currentLevel: progressionLevel } = deriveProgressionLevel(
        allAxisOpenFormStates, recognitionComplete
      );

      const objectives = axisObjectives.map((obj) => {
        const knowledgeStates = knowledgeStatesByObjective[obj.id] || [];
        const { status, completionType } = deriveObjectiveStatusFromStates(knowledgeStates);

        const simResults = similarityByObjective[obj.id] || [];
        const bestMatch = extractBestMatch(simResults);
        const priorLearning = extractTopKMatches(simResults, 5);

        return {
          id: obj.id,
          text: obj.text,
          similarityScore: bestMatch.similarityScore,
          matchedObjectiveText: bestMatch.matchedObjectiveText,
          priorLearning,
          status,
          completionType
        };
      });

      return {
        axisKey: gap.axisKey,
        axisLabel: gap.axisLabel,
        requiredLevel: gap.requiredLevel,
        currentLevel: gap.currentLevel,
        continuousScore,
        progressionLevel,
        objectives
      };
    });

    return success({ axes });
  } finally {
    db.release();
  }
}

/**
 * Fetch capability levels for a user on an action's skill axes.
 * Uses a lightweight approach: checks for existing capability evidence
 * via the action_skill_profile embedding similarity search, then uses
 * Bedrock to score if evidence exists. Falls back to zero levels if
 * no embedding or evidence is found.
 */
async function fetchCapabilityLevels(db, actionIdSafe, userIdSafe, orgIdSafe, skillProfile) {
  const levels = {};
  for (const axis of skillProfile.axes) {
    levels[axis.key] = 0;
  }

  try {
    // Check for action_skill_profile embedding
    const embeddingResult = await db.query(
      `SELECT embedding FROM unified_embeddings
       WHERE entity_type = 'action_skill_profile'
         AND entity_id = '${actionIdSafe}'
         AND organization_id = '${orgIdSafe}'
       LIMIT 1`
    );

    if (!embeddingResult.rows || embeddingResult.rows.length === 0) {
      // No embedding yet — return zero levels
      return levels;
    }

    const skillProfileEmbedding = embeddingResult.rows[0].embedding;

    // Vector similarity search for observation evidence
    const OBSERVATION_LIMIT = 50;
    const observationSearchResult = await db.query(
      `SELECT entity_id,
              (1 - (embedding <=> '${skillProfileEmbedding}'::vector)) as similarity
       FROM unified_embeddings
       WHERE entity_type = 'state'
         AND organization_id = '${orgIdSafe}'
       ORDER BY embedding <=> '${skillProfileEmbedding}'::vector
       LIMIT ${OBSERVATION_LIMIT}`
    );

    const candidateStateIds = observationSearchResult.rows.map(r => r.entity_id);
    if (candidateStateIds.length === 0) {
      return levels;
    }

    // Filter to observations linked to actions where the target user is involved
    const stateIdsList = candidateStateIds.map(id => `'${escapeLiteral(id)}'`).join(',');
    const filteredResult = await db.query(
      `SELECT DISTINCT s.id as state_id, s.state_text, s.captured_at,
              a.title as action_title
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'action'
       INNER JOIN actions a ON a.id = sl.entity_id
       WHERE s.id IN (${stateIdsList})
         AND s.organization_id = '${orgIdSafe}'
         AND (
           a.assigned_to = '${userIdSafe}'
           OR a.created_by = '${userIdSafe}'
           OR '${userIdSafe}' = ANY(a.participants)
         )`
    );

    if (filteredResult.rows.length === 0) {
      return levels;
    }

    // Build similarity map
    const similarityMap = {};
    for (const row of observationSearchResult.rows) {
      similarityMap[row.entity_id] = parseFloat(row.similarity);
    }

    // Build evidence list for Bedrock
    const allEvidence = filteredResult.rows.map(obs => {
      const recencyWeight = computeRecencyWeight(obs.captured_at);
      const relevanceScore = (similarityMap[obs.state_id] || 0) * recencyWeight;
      return {
        observation_id: obs.state_id,
        action_title: obs.action_title || '',
        text_excerpt: (obs.state_text || '').substring(0, 500),
        captured_at: obs.captured_at,
        relevance_score: Math.round(relevanceScore * 100) / 100
      };
    });

    allEvidence.sort((a, b) => b.relevance_score - a.relevance_score);

    // Call Bedrock for lightweight capability scoring
    const capabilityResult = await callBedrockForCapabilityLevels(skillProfile, allEvidence, aiConfig);

    for (const axisResult of capabilityResult.axes) {
      if (levels.hasOwnProperty(axisResult.key)) {
        levels[axisResult.key] = Math.max(0, Math.min(5, Math.round(axisResult.level)));
      }
    }
  } catch (err) {
    console.error('Error fetching capability levels, defaulting to zero:', err);
  }

  return levels;
}

/**
 * Call Bedrock to get lightweight capability level scores.
 * Similar to the capability Lambda's approach but returns only levels.
 */
async function callBedrockForCapabilityLevels(skillProfile, evidence, aiConfig) {
  if (!aiConfig) {
    aiConfig = resolveAiConfig(null);
  }

  const axesDescription = skillProfile.axes.map(a =>
    `- ${a.key} ("${a.label}"): required level ${a.required_level}`
  ).join('\n');

  const evidenceSummary = evidence.slice(0, 20).map((e, i) =>
    `${i + 1}. Action: "${e.action_title}" | Text: ${e.text_excerpt}`
  ).join('\n');

  const prompt = `You are a skill assessment expert. Analyze the evidence and score each skill axis on Bloom's taxonomy (0-5 integers).

SKILL LEVEL SCALE:
  0 = No exposure, 1 = Remember, 2 = Understand, 3 = Apply, 4 = Analyze, 5 = Create

AXES:
${axesDescription}

EVIDENCE:
${evidenceSummary || 'No evidence available.'}

Return ONLY a JSON object with:
{ "axes": [{ "key": "<axis_key>", "level": <integer 0-5> }] }

No markdown, no code fences, no explanation.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 500,
    temperature: aiConfig.quiz_temperature,
    messages: [{ role: 'user', content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: OBJECTIVE_MODEL_ID,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('Failed to parse Bedrock capability levels response:', text);
    return { axes: skillProfile.axes.map(a => ({ key: a.key, level: 0 })) };
  }
}

/**
 * Generate learning objectives for gap axes via Bedrock Sonnet.
 * Returns an array of { axisKey, text } objects.
 */
async function generateObjectivesViaBedrock(action, skillProfile, gapAxes) {
  const gapAxesDescription = gapAxes.map(g => {
    const skillAxis = skillProfile.axes.find(a => a.key === g.axisKey);
    return `- ${g.axisKey} ("${g.axisLabel}"): current level ${g.currentLevel}, required level ${g.requiredLevel}${skillAxis?.description ? `, description: ${skillAxis.description}` : ''}`;
  }).join('\n');

  const prompt = `You are a learning design expert. Generate specific learning objectives for a person who needs to close skill gaps before performing an action.

ACTION CONTEXT:
- Title: ${action.title || 'Untitled'}
- Description: ${action.description || 'No description'}
- Expected Outcome (S'): ${action.expected_state || 'Not specified'}

SKILL PROFILE NARRATIVE:
${skillProfile.narrative || 'No narrative available.'}

GAP AXES (person needs to improve on these):
${gapAxesDescription}

INSTRUCTIONS:
- For each gap axis, generate 3-6 learning objectives
- Each objective should describe what the person needs to UNDERSTAND (Bloom's level 2) — focus on "why" rather than "how to"
- Use the action's expected outcome (S') as the primary driver — what does the person need to understand to achieve the desired outcome?
- Objectives should be specific, measurable, and relevant to the action context
- Write objectives as clear, concise statements starting with an action verb (e.g., "Understand why...", "Explain how...", "Identify the relationship between...")

Return ONLY a JSON object with:
{
  "objectives": [
    { "axisKey": "<axis_key>", "text": "<objective text>" }
  ]
}

No markdown, no code fences, no explanation.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2000,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: OBJECTIVE_MODEL_ID,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);
    // Validate and filter to only requested axes
    const validAxisKeys = new Set(gapAxes.map(g => g.axisKey));
    return (parsed.objectives || []).filter(obj =>
      obj.axisKey && obj.text && validAxisKeys.has(obj.axisKey)
    );
  } catch (parseErr) {
    console.error('Failed to parse Bedrock objectives response:', text);
    // Return a minimal fallback objective per axis
    return gapAxes.map(g => ({
      axisKey: g.axisKey,
      text: `Understand the key concepts of ${g.axisLabel} required for this action`
    }));
  }
}

/**
 * Compose a learning objective state_text in the canonical format.
 * Mirrors the frontend composeLearningObjectiveStateText function.
 */
function composeLearningObjectiveStateText(axisKey, actionId, userId, objectiveText) {
  return `[learning_objective] axis=${axisKey} action=${actionId} user=${userId} | ${objectiveText}`;
}

/**
 * Parse a learning objective state_text, extracting axis key, action ID, user ID, and text.
 * Returns null if format doesn't match.
 */
function parseLearningObjectiveStateText(stateText) {
  const match = stateText.match(
    /^\[learning_objective\] axis=(\S+) action=(\S+) user=(\S+) \| (.+)$/
  );
  if (!match) return null;
  return {
    axisKey: match[1],
    actionId: match[2],
    userId: match[3],
    objectiveText: match[4]
  };
}

/**
 * Queue embedding generation for a new learning objective state via SQS.
 * Uses the same pipeline as the states Lambda.
 */
async function queueObjectiveEmbedding(stateId, stateText, organizationId) {
  const embeddingSource = composeStateEmbeddingSource({
    entity_names: [],
    state_text: stateText,
    photo_descriptions: [],
    metrics: []
  });

  if (!embeddingSource || !embeddingSource.trim()) {
    console.log('Empty embedding source for objective state', stateId, '— skipping SQS send');
    return;
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: EMBEDDINGS_QUEUE_URL,
    MessageBody: JSON.stringify({
      entity_type: 'state',
      entity_id: stateId,
      embedding_source: embeddingSource,
      organization_id: organizationId
    })
  }));

  console.log('Queued embedding for objective state', stateId);
}

/**
 * Derive objective status and completion type from knowledge state texts.
 * Mirrors the frontend deriveObjectiveStatus logic.
 */
function deriveObjectiveStatusFromStates(knowledgeStateTexts) {
  if (knowledgeStateTexts.length === 0) {
    return { status: 'not_started', completionType: null };
  }

  // Check for correct first-attempt quiz answer
  for (const text of knowledgeStateTexts) {
    if (text.includes('which was the correct answer')) {
      return { status: 'completed', completionType: 'quiz' };
    }
  }

  // Check for demonstration
  for (const text of knowledgeStateTexts) {
    if (text.startsWith('Demonstrated learning objective')) {
      return { status: 'completed', completionType: 'demonstrated' };
    }
  }

  return { status: 'in_progress', completionType: null };
}

// --- Bloom's Progression Constants and Functions (server-side JS equivalents) ---

/** Bloom's level mapping for each question type */
const BLOOM_LEVEL_MAP = {
  recognition: 1,
  bridging: 1,
  self_explanation: 2,
  application: 3,
  analysis: 4,
  synthesis: 5,
};

/** Score thresholds for advancing past each open-form question type */
const ADVANCEMENT_THRESHOLDS = {
  self_explanation: 2.0,
  application: 3.0,
  analysis: 4.0,
};

/** Open-form question types in progression order (after Recognition) */
const OPEN_FORM_PROGRESSION = [
  'bridging',
  'self_explanation',
  'application',
  'analysis',
  'synthesis',
];

/**
 * Map a question type to its Bloom's taxonomy level.
 * Returns 0 for invalid types.
 */
function questionTypeToBloomLevel(questionType) {
  return BLOOM_LEVEL_MAP[questionType] ?? 0;
}

/**
 * Parse an open-form knowledge state text back to its component fields.
 * Server-side JS equivalent of the frontend parseOpenFormStateText.
 * Returns null if the text doesn't match the open-form format.
 */
function parseOpenFormStateText(stateText) {
  const corePattern =
    /^For learning objective '(.+?)' and (\S+) question '(.+?)', I responded: '(.+?)'\. Ideal answer: '(.+?)'\. Evaluation: (.+)$/s;

  const match = stateText.match(corePattern);
  if (!match) return null;

  const objectiveText = match[1];
  const questionType = match[2];
  const questionText = match[3];
  const responseText = match[4];
  const idealAnswer = match[5];
  const evaluationPart = match[6];

  if (evaluationPart === 'pending.') {
    return {
      objectiveText, questionType, questionText, responseText, idealAnswer,
      evaluationStatus: 'pending', continuousScore: null, reasoning: null,
    };
  }

  if (evaluationPart === 'error.') {
    return {
      objectiveText, questionType, questionText, responseText, idealAnswer,
      evaluationStatus: 'error', continuousScore: null, reasoning: null,
    };
  }

  // Match evaluation with optional [bloom: ...] suffix
  const evalPattern = /^(sufficient|insufficient) \(score: ([\d.]+)\)\. (.+?)\.(?:\s*\[bloom: level=(\d+), demonstrated=(.*?), nextHint=(.*?)\])?$/s;
  const evalMatch = evaluationPart.match(evalPattern);
  if (!evalMatch) return null;

  const continuousScore = parseFloat(evalMatch[2]);
  const result = {
    objectiveText, questionType, questionText, responseText, idealAnswer,
    evaluationStatus: evalMatch[1],
    continuousScore,
    reasoning: evalMatch[3],
  };

  // Extract structured Bloom feedback fields if present
  if (evalMatch[4] != null) {
    result.demonstratedLevel = parseInt(evalMatch[4], 10);
    result.conceptDemonstrated = (evalMatch[5] || '').replace(/\\]/g, ']');
    result.nextLevelHint = (evalMatch[6] || '').replace(/\\]/g, ']');
  } else {
    // Fallback: derive demonstratedLevel from score for older states
    result.demonstratedLevel = scoreToBloomLevel(continuousScore);
    result.conceptDemonstrated = null;
    result.nextLevelHint = null;
  }

  return result;
}

/**
 * Check if at least one sufficient evaluation exists for a given question type.
 */
function hasSufficientForType(openFormStates, questionType) {
  return openFormStates.some(
    (state) => state.questionType === questionType && state.evaluationStatus === 'sufficient'
  );
}

/**
 * Check if a level is complete — sufficient evaluation with score meeting threshold.
 */
function isLevelComplete(openFormStates, questionType) {
  const threshold = ADVANCEMENT_THRESHOLDS[questionType];
  if (threshold === undefined) {
    return hasSufficientForType(openFormStates, questionType);
  }
  return openFormStates.some(
    (state) =>
      state.questionType === questionType &&
      state.evaluationStatus === 'sufficient' &&
      state.continuousScore !== null &&
      state.continuousScore >= threshold
  );
}

/**
 * Derive the current progression level for an axis from knowledge states.
 * Server-side JS equivalent of the frontend deriveProgressionLevel.
 *
 * @param {Array} openFormStates - Parsed open-form knowledge states for this axis
 * @param {boolean} recognitionComplete - Whether all Recognition objectives are answered correctly
 * @returns {{ currentLevel: string, bloomLevel: number }}
 */
function deriveProgressionLevel(openFormStates, recognitionComplete) {
  if (!recognitionComplete) {
    return { currentLevel: 'recognition', bloomLevel: 1 };
  }

  if (!hasSufficientForType(openFormStates, 'bridging')) {
    return { currentLevel: 'bridging', bloomLevel: 1 };
  }

  for (let i = 1; i < OPEN_FORM_PROGRESSION.length; i++) {
    const currentType = OPEN_FORM_PROGRESSION[i];
    const previousType = OPEN_FORM_PROGRESSION[i - 1];

    if (!isLevelComplete(openFormStates, previousType)) {
      return {
        currentLevel: previousType,
        bloomLevel: questionTypeToBloomLevel(previousType),
      };
    }

    if (!hasSufficientForType(openFormStates, currentType)) {
      return {
        currentLevel: currentType,
        bloomLevel: questionTypeToBloomLevel(currentType),
      };
    }
  }

  return { currentLevel: 'synthesis', bloomLevel: 5 };
}

/**
 * Compute continuous Bloom's score for an axis from all knowledge states.
 * Server-side JS equivalent of the frontend computeContinuousScore.
 *
 * @param {Array} openFormStates - Parsed open-form knowledge states for this axis
 * @param {number} totalRecognitionObjectives - Total recognition objectives for the axis
 * @param {number} correctRecognitionCount - Count of correct recognition answers for the axis
 * @returns {number} Continuous score clamped to [0.0, 5.0]
 */
function computeContinuousScore(openFormStates, totalRecognitionObjectives, correctRecognitionCount) {
  // 1. Recognition score: proportion of correct first-attempt answers, capped at 1.0
  const recognitionScore =
    totalRecognitionObjectives > 0
      ? Math.min(1.0, correctRecognitionCount / totalRecognitionObjectives)
      : 0;

  // 2. Bridging score: 1.0 if bridging is complete
  const bridgingScore = hasSufficientForType(openFormStates, 'bridging')
    ? 1.0
    : 0;

  // 3. Open-form max: highest continuous score from evaluated (non-pending, non-error) states
  let openFormMax = 0;
  for (const state of openFormStates) {
    if (
      state.continuousScore !== null &&
      state.evaluationStatus !== 'pending' &&
      state.evaluationStatus !== 'error'
    ) {
      openFormMax = Math.max(openFormMax, state.continuousScore);
    }
  }

  // Return the maximum of all computed scores, clamped to [0.0, 5.0]
  return Math.min(5.0, Math.max(recognitionScore, bridgingScore, openFormMax));
}

/**
 * Compute recency weight for an observation based on its capture date.
 * Matches the capability Lambda's recency weighting.
 */
function computeRecencyWeight(capturedAt) {
  const now = new Date();
  const captured = new Date(capturedAt);
  const daysDiff = (now - captured) / (1000 * 60 * 60 * 24);

  if (daysDiff <= 30) return 1.0;
  if (daysDiff <= 90) return 0.7;
  if (daysDiff <= 180) return 0.4;
  return 0.2;
}

/**
 * POST /api/learning/:actionId/quiz/generate
 * Generate a round of quiz questions for selected learning objectives.
 * Extended for Bloom's progression: derives question type per objective from knowledge states.
 * Requirements: 1.1, 1.6, 2.1, 3.1, 4.1, 4.2, 4.3, 4.4, 4.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 8.7, 8.8
 */
async function handleQuizGenerate(actionId, body, organizationId) {
  const { userId, axisKey, objectiveIds, previousAnswers } = body;
  const t0 = Date.now();

  // Validate required fields
  if (!userId || !axisKey || !objectiveIds || !Array.isArray(objectiveIds) || objectiveIds.length === 0) {
    return error('At least one learning objective must be selected.', 400);
  }

  const db = await getDbClient();
  try {
    const actionIdSafe = escapeLiteral(actionId);
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    // 1. Fetch action context (title, description, expected_state, skill_profile)
    const actionResult = await db.query(
      `SELECT id, title, description, expected_state, skill_profile
       FROM actions
       WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    if (!actionResult.rows || actionResult.rows.length === 0) {
      return error('Action not found', 404);
    }

    const action = actionResult.rows[0];
    const skillProfile = action.skill_profile;

    if (!skillProfile || !skillProfile.approved_at) {
      return error('No approved skill profile found for this action', 404);
    }

    // Read growth_intent from the skill profile JSONB (stored at approve time)
    const growthIntent = skillProfile.growth_intent || null;

    // Find the target axis from the skill profile
    const targetAxis = skillProfile.axes.find(a => a.key === axisKey);
    if (!targetAxis) {
      return error('Axis not found in skill profile', 404);
    }

    // 2. Fetch the learning objective texts for the requested IDs
    const objectiveIdsList = objectiveIds.map(id => `'${escapeLiteral(id)}'`).join(',');
    const objectivesResult = await db.query(
      `SELECT s.id, s.state_text
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'action' AND sl.entity_id = '${actionIdSafe}'
         AND s.id IN (${objectiveIdsList})
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[learning_objective]%'`
    );

    if (!objectivesResult.rows || objectivesResult.rows.length === 0) {
      return error('Learning objectives not found for this action.', 404);
    }

    const objectives = objectivesResult.rows.map(row => {
      const parsed = parseLearningObjectiveStateText(row.state_text);
      return {
        id: row.id,
        text: parsed ? parsed.objectiveText : row.state_text
      };
    });

    // 3. Fetch ALL learning objectives for this axis to determine Recognition completion
    const allAxisObjectivesResult = await db.query(
      `SELECT s.id, s.state_text
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'action' AND sl.entity_id = '${actionIdSafe}'
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[learning_objective]%'
         AND s.state_text LIKE '%axis=${escapeLiteral(axisKey)}%'`
    );

    const allAxisObjectiveIds = allAxisObjectivesResult.rows.map(r => r.id);

    // 4. Fetch existing knowledge states for the user on this axis
    let knowledgeStatesForAxis = {};
    if (allAxisObjectiveIds.length > 0) {
      const allAxisObjIdsList = allAxisObjectiveIds.map(id => `'${escapeLiteral(id)}'`).join(',');
      const knowledgeResult = await db.query(
        `SELECT sl.entity_id as objective_id, s.state_text
         FROM states s
         INNER JOIN state_links sl ON sl.state_id = s.id
         WHERE sl.entity_type = 'learning_objective'
           AND sl.entity_id IN (${allAxisObjIdsList})
           AND s.organization_id = '${orgIdSafe}'
         ORDER BY s.captured_at ASC`
      );

      for (const row of knowledgeResult.rows) {
        if (!knowledgeStatesForAxis[row.objective_id]) {
          knowledgeStatesForAxis[row.objective_id] = [];
        }
        knowledgeStatesForAxis[row.objective_id].push(row.state_text);
      }
    }

    // 5. Determine Recognition completion: all axis objectives have a correct first-attempt answer
    const recognitionComplete = allAxisObjectiveIds.every(objId => {
      const states = knowledgeStatesForAxis[objId] || [];
      return states.some(text => text.includes('which was the correct answer'));
    });

    // 6. Parse open-form knowledge states for progression derivation
    const openFormStates = [];
    for (const states of Object.values(knowledgeStatesForAxis)) {
      for (const stateText of states) {
        const parsed = parseOpenFormStateText(stateText);
        if (parsed) {
          openFormStates.push(parsed);
        }
      }
    }

    // 7. Derive progression level for this axis
    const progression = deriveProgressionLevel(openFormStates, recognitionComplete);
    const questionType = progression.currentLevel;
    const bloomLevel = progression.bloomLevel;

    console.log(`Progression for axis ${axisKey}: questionType=${questionType}, bloomLevel=${bloomLevel}, recognitionComplete=${recognitionComplete}`);

    // 8. Build lens pool and select lenses for question framing diversity
    let lensBlock = '';
    let assetBlock = '';

    // Fetch organization settings (strategic_attributes) and ai_config (lens_config)
    const orgResult = await db.query(
      `SELECT settings, ai_config FROM organizations WHERE id = '${orgIdSafe}'`
    );
    const orgRow = orgResult.rows?.[0];
    const strategicAttributes = orgRow?.settings?.strategic_attributes || [];
    const rawLensConfig = orgRow?.ai_config?.lens_config || null;

    // Resolve lens config and build the full lens pool
    const resolvedLensConfig = resolveLensConfig(rawLensConfig);
    const lensPool = buildLensPool(resolvedLensConfig, strategicAttributes);

    // Fetch capability gap for the target axis from the current user's profile
    let capabilityGap = null;
    const cachedProfileResult = await db.query(
      `SELECT s.state_text
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'capability_profile'
         AND sl.entity_id = '${actionIdSafe}'
         AND s.captured_by = '${userIdSafe}'
         AND s.state_text LIKE '[capability_profile]%'
         AND s.organization_id = '${orgIdSafe}'
       ORDER BY s.captured_at DESC
       LIMIT 1`
    );

    if (cachedProfileResult.rows?.length > 0) {
      const stateText = cachedProfileResult.rows[0].state_text;
      const pipeIndex = stateText.indexOf(' | ');
      if (pipeIndex !== -1) {
        const profileJson = JSON.parse(stateText.substring(pipeIndex + 3));
        const axisData = profileJson.axes?.find(a => a.key === axisKey);
        if (axisData && typeof axisData.level === 'number' && typeof targetAxis.required_level === 'number') {
          capabilityGap = targetAxis.required_level - axisData.level;
        }
      }
    }

    // Select 2–3 lenses via weighted random sampling with optional gap boost
    const selectedLenses = selectLenses(lensPool, capabilityGap, resolvedLensConfig.gap_boost_rules);
    lensBlock = buildLensPromptBlock(selectedLenses);

    const tDbDone = Date.now();
    console.log(`[TIMING] DB queries + lens selection: ${tDbDone - t0}ms`);

    // Fetch cross-domain asset context for enriched prompts
    const assetDescriptions = await fetchAssetContext(db, actionId, axisKey, organizationId);
    assetBlock = buildAssetContextBlock(assetDescriptions);

    const tAssetDone = Date.now();
    console.log(`[TIMING] fetchAssetContext (vector search): ${tAssetDone - tDbDone}ms`);

    // 8b. Fetch active profile skills and build Profile_Skill_Lens context block
    let profileSkillBlock = '';
    try {
      const profileSkills = await fetchActiveProfileSkills(db, userIdSafe, orgIdSafe);
      if (profileSkills.length > 0) {
        // Filter: include skill if at least one axis is not fully tapered
        const activeProfileSkills = profileSkills.filter(skill => {
          return skill.axes.some(axis => {
            const { shouldTaper, reinforcementProbability } = computeTaperingDecision(
              axis.progression_history, axis.bloom_level
            );
            return !shouldTaper || Math.random() < reinforcementProbability;
          });
        });

        profileSkillBlock = buildProfileSkillPromptBlock(activeProfileSkills);
      }
    } catch (err) {
      console.warn('Failed to fetch profile skills for quiz generation, proceeding without:', err.message);
    }

    // 9. Generate questions based on the derived question type
    let validatedQuestions;

    if (questionType === 'recognition') {
      // Recognition: use existing multiple-choice generation flow unchanged
      const questions = await generateQuizViaBedrock(
        action,
        targetAxis,
        objectives,
        { observations: [], photoUrls: [] },
        [],
        knowledgeStatesForAxis,
        previousAnswers || [],
        lensBlock,
        assetBlock,
        profileSkillBlock
      );

      validatedQuestions = validateQuizQuestions(questions, objectiveIds);

      // Add progression fields to Recognition questions
      validatedQuestions = validatedQuestions.map(q => ({
        ...q,
        questionType: 'recognition',
        bloomLevel: 1,
        idealAnswer: null,
      }));
    } else {
      // Open-form questions (bridging, self_explanation, application, analysis, synthesis)
      const questions = await generateOpenFormQuizViaBedrock(
        action,
        targetAxis,
        objectives,
        questionType,
        bloomLevel,
        openFormStates,
        previousAnswers || [],
        lensBlock,
        assetBlock,
        growthIntent,
        profileSkillBlock
      );

      validatedQuestions = validateOpenFormQuestions(questions, objectiveIds, questionType, bloomLevel);
    }

    const tBedrockDone = Date.now();
    console.log(`[TIMING] Bedrock quiz generation (${MODEL_FAST}): ${tBedrockDone - tAssetDone}ms`);
    console.log(`[TIMING] Total handleQuizGenerate: ${tBedrockDone - t0}ms (db=${tDbDone - t0}ms, asset=${tAssetDone - tDbDone}ms, bedrock=${tBedrockDone - tAssetDone}ms)`);

    return success({ questions: validatedQuestions });
  } finally {
    db.release();
  }
}

/**
 * Fetch evidence observations (photos + text) from capability assessment for quiz context.
 * Uses the same vector similarity approach as the capability Lambda.
 */
async function fetchEvidenceObservations(db, actionIdSafe, userIdSafe, orgIdSafe) {
  const evidence = { observations: [], photoUrls: [] };

  try {
    // Fetch action_skill_profile embedding for similarity search
    const embeddingResult = await db.query(
      `SELECT embedding FROM unified_embeddings
       WHERE entity_type = 'action_skill_profile'
         AND entity_id = '${actionIdSafe}'
         AND organization_id = '${orgIdSafe}'
       LIMIT 1`
    );

    if (!embeddingResult.rows || embeddingResult.rows.length === 0) {
      return evidence;
    }

    const skillProfileEmbedding = embeddingResult.rows[0].embedding;

    // Vector similarity search for observation evidence
    const OBSERVATION_LIMIT = 30;
    const observationSearchResult = await db.query(
      `SELECT entity_id,
              (1 - (embedding <=> '${skillProfileEmbedding}'::vector)) as similarity
       FROM unified_embeddings
       WHERE entity_type = 'state'
         AND organization_id = '${orgIdSafe}'
       ORDER BY embedding <=> '${skillProfileEmbedding}'::vector
       LIMIT ${OBSERVATION_LIMIT}`
    );

    const candidateStateIds = observationSearchResult.rows.map(r => r.entity_id);
    if (candidateStateIds.length === 0) {
      return evidence;
    }

    // Filter to observations linked to actions where the target user is involved
    const stateIdsList = candidateStateIds.map(id => `'${escapeLiteral(id)}'`).join(',');
    const filteredResult = await db.query(
      `SELECT DISTINCT s.id as state_id, s.state_text, s.captured_at
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'action'
       INNER JOIN actions a ON a.id = sl.entity_id
       WHERE s.id IN (${stateIdsList})
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text NOT LIKE '[learning_objective]%'
         AND (
           a.assigned_to = '${userIdSafe}'
           OR a.created_by = '${userIdSafe}'
           OR '${userIdSafe}' = ANY(a.participants)
         )`
    );

    if (filteredResult.rows.length === 0) {
      return evidence;
    }

    // Fetch photos for these observations
    const relevantStateIds = filteredResult.rows.map(r => r.state_id);
    const relevantStateIdsList = relevantStateIds.map(id => `'${escapeLiteral(id)}'`).join(',');

    const photosResult = await db.query(
      `SELECT state_id, photo_url, photo_description, photo_order
       FROM state_photos
       WHERE state_id IN (${relevantStateIdsList})
       ORDER BY state_id, photo_order`
    );

    // Group photos by state_id
    const photosByState = {};
    for (const photo of photosResult.rows) {
      if (!photosByState[photo.state_id]) {
        photosByState[photo.state_id] = [];
      }
      photosByState[photo.state_id].push({
        url: photo.photo_url,
        description: photo.photo_description
      });
    }

    // Build similarity map
    const similarityMap = {};
    for (const row of observationSearchResult.rows) {
      similarityMap[row.entity_id] = parseFloat(row.similarity);
    }

    // Build evidence list sorted by relevance
    evidence.observations = filteredResult.rows.map(obs => {
      const recencyWeight = computeRecencyWeight(obs.captured_at);
      const relevanceScore = (similarityMap[obs.state_id] || 0) * recencyWeight;
      const photos = photosByState[obs.state_id] || [];

      // Collect S3 photo URLs for the prompt
      for (const photo of photos) {
        if (photo.url) {
          evidence.photoUrls.push(photo.url);
        }
      }

      return {
        text: (obs.state_text || '').substring(0, 500),
        photos: photos.map(p => ({
          url: p.url,
          description: p.description
        })),
        relevanceScore: Math.round(relevanceScore * 100) / 100
      };
    });

    evidence.observations.sort((a, b) => b.relevanceScore - a.relevanceScore);
  } catch (err) {
    console.error('Error fetching evidence observations for quiz:', err);
  }

  return evidence;
}

/**
 * Fetch organization tool inventory for quiz context.
 * Returns a simplified list of tool names, categories, and descriptions.
 */
async function fetchToolInventory(db, orgIdSafe) {
  try {
    const toolsResult = await db.query(
      `SELECT name, category, description
       FROM tools
       WHERE organization_id = '${orgIdSafe}'
         AND status != 'removed'
       ORDER BY name
       LIMIT 100`
    );

    return toolsResult.rows.map(t => ({
      name: t.name,
      category: t.category,
      description: (t.description || '').substring(0, 200)
    }));
  } catch (err) {
    console.error('Error fetching tool inventory:', err);
    return [];
  }
}

/**
 * Fetch cross-domain asset context via vector similarity search.
 * Finds the top 10 most similar assets to the skill axis embedding,
 * then randomly selects up to 3 for prompt enrichment.
 *
 * @param {object} db - Database client
 * @param {string} actionId - Current action ID (excluded from results)
 * @param {string} axisKey - Target skill axis key
 * @param {string} organizationId - Organization ID for scoping
 * @returns {Promise<Array<{entity_type: string, entity_id: string, description: string}>>} 0–3 asset descriptions
 */
async function fetchAssetContext(db, actionId, axisKey, organizationId) {
  try {
    const actionIdSafe = escapeLiteral(actionId);
    const orgIdSafe = escapeLiteral(organizationId);

    // Vector similarity query: find top 10 assets similar to the skill axis embedding
    const result = await db.query(
      `SELECT ue.entity_type, ue.entity_id, ue.embedding_source,
              (1 - (ue.embedding <=> (
                SELECT embedding FROM unified_embeddings
                WHERE entity_type = 'skill_axis'
                  AND action_id = $1
                  AND axis_key = $2
                LIMIT 1
              ))) as similarity
       FROM unified_embeddings ue
       WHERE ue.entity_type IN ('action', 'part', 'tool', 'policy')
         AND ue.organization_id = '${orgIdSafe}'
         AND NOT (ue.entity_type = 'action' AND ue.entity_id = '${actionIdSafe}')
       ORDER BY similarity DESC
       LIMIT 10`,
      [actionId, axisKey]
    );

    if (!result.rows || result.rows.length === 0) {
      return [];
    }

    const topResults = result.rows;

    // Randomly select up to 3 from the top 10 using Fisher-Yates partial shuffle
    const count = Math.min(3, topResults.length);
    for (let i = topResults.length - 1; i > topResults.length - 1 - count; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [topResults[i], topResults[j]] = [topResults[j], topResults[i]];
    }

    const selected = topResults.slice(topResults.length - count);

    return selected.map(row => ({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      description: row.embedding_source || '',
    }));
  } catch (err) {
    console.warn('Warning: Failed to fetch asset context for quiz enrichment:', err.message);
    return [];
  }
}

/**
 * Fetch existing knowledge states for the given objective IDs.
 * Returns knowledge state texts grouped by objective ID.
 */
async function fetchKnowledgeStatesForObjectives(db, objectiveIds, orgIdSafe) {
  const knowledgeByObjective = {};

  if (objectiveIds.length === 0) return knowledgeByObjective;

  try {
    const objectiveIdsList = objectiveIds.map(id => `'${escapeLiteral(id)}'`).join(',');
    const result = await db.query(
      `SELECT sl.entity_id as objective_id, s.state_text
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'learning_objective'
         AND sl.entity_id IN (${objectiveIdsList})
         AND s.organization_id = '${orgIdSafe}'
       ORDER BY s.captured_at ASC`
    );

    for (const row of result.rows) {
      if (!knowledgeByObjective[row.objective_id]) {
        knowledgeByObjective[row.objective_id] = [];
      }
      knowledgeByObjective[row.objective_id].push(row.state_text);
    }
  } catch (err) {
    console.error('Error fetching knowledge states:', err);
  }

  return knowledgeByObjective;
}

/**
 * Generate quiz questions via Bedrock Sonnet.
 * Builds a structured prompt with action context, evidence, tools, and previous answers.
 */
async function generateQuizViaBedrock(action, targetAxis, objectives, evidenceData, toolInventory, knowledgeStates, previousAnswers, lensBlock, assetBlock, profileSkillBlock = '') {
  // Build the objectives section
  const objectivesSection = objectives.map(obj => {
    const pastStates = knowledgeStates[obj.id] || [];
    const pastSummary = pastStates.length > 0
      ? `\n    Past quiz history: ${pastStates.length} previous answer(s)`
      : '';
    return `  - ID: ${obj.id}\n    Objective: ${obj.text}${pastSummary}`;
  }).join('\n');

  // Build evidence observations section (limit to top 10 for prompt size)
  const topEvidence = evidenceData.observations.slice(0, 10);
  const evidenceSection = topEvidence.length > 0
    ? topEvidence.map((obs, i) => {
        const photoInfo = obs.photos.length > 0
          ? `\n    Photos: ${obs.photos.map(p => p.description || 'Photo available').join(', ')}`
          : '';
        return `  ${i + 1}. Observation: ${obs.text}${photoInfo}`;
      }).join('\n')
    : '  No evidence observations available.';

  // Build photo URLs section for photo-based questions
  const availablePhotos = [];
  for (const obs of topEvidence) {
    for (const photo of obs.photos) {
      if (photo.url && availablePhotos.length < 5) {
        const s3Url = photo.url.startsWith('http')
          ? photo.url
          : `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${photo.url}`;
        availablePhotos.push({
          url: s3Url,
          description: photo.description || 'Evidence photo'
        });
      }
    }
  }

  const photoSection = availablePhotos.length > 0
    ? `\nAVAILABLE PHOTOS FOR PHOTO-BASED QUESTIONS:\n${availablePhotos.map((p, i) => `  ${i + 1}. URL: ${p.url}\n     Description: ${p.description}`).join('\n')}`
    : '\nNo photos available — generate concept-based and tool-based questions only.';

  // Build tool inventory section
  const requiredTools = action.skill_profile?.required_tools || [];
  const toolSection = toolInventory.length > 0
    ? `Required tools for this action: ${requiredTools.length > 0 ? requiredTools.join(', ') : 'Not specified'}\nOrganization tool inventory (${toolInventory.length} tools):\n${toolInventory.slice(0, 20).map(t => `  - ${t.name} (${t.category || 'uncategorized'})${t.description ? ': ' + t.description : ''}`).join('\n')}`
    : 'No tool inventory available.';

  // Build previous wrong answers section
  const wrongAnswersSection = previousAnswers.filter(a => !a.wasCorrect).length > 0
    ? `\nPREVIOUS WRONG ANSWERS (address these misconceptions with new questions from different angles):\n${previousAnswers.filter(a => !a.wasCorrect).map(a =>
        `  - Objective: ${a.objectiveId}\n    Question: ${a.questionText}\n    Wrong answer chosen: "${a.selectedAnswer}"\n    Correct answer was: "${a.correctAnswer}"\n    Misconception to address: The person thought "${a.selectedAnswer}" — generate a question that helps them understand why "${a.correctAnswer}" is correct.`
      ).join('\n')}`
    : '';

  const prompt = `You are an expert learning assessment designer. Generate multiple-choice quiz questions to test a person's understanding of specific learning objectives related to a work action.

ACTION CONTEXT:
- Title: ${action.title || 'Untitled'}
- Description: ${action.description || 'No description'}
- Expected Outcome (S'): ${action.expected_state || 'Not specified'}
  The expected outcome is the PRIMARY DRIVER for all questions. Questions should orient the person toward understanding WHY the desired outcome matters.

SKILL AXIS: ${targetAxis.label} (${targetAxis.key})
${targetAxis.description ? `Axis Description: ${targetAxis.description}` : ''}

LEARNING OBJECTIVES TO COVER (generate at least one question per objective):
${objectivesSection}

EVIDENCE OBSERVATIONS FROM PAST WORK:
${evidenceSection}
${photoSection}

TOOLS AND EQUIPMENT:
${toolSection}
${wrongAnswersSection}
${lensBlock ? '\n' + lensBlock + '\n' : ''}${profileSkillBlock ? '\n' + profileSkillBlock + '\n' : ''}${assetBlock ? '\n' + assetBlock + '\n' : ''}
INSTRUCTIONS:
1. Generate at least one question per learning objective listed above.
2. Each question MUST have exactly 4 answer options with explanations for each option.
3. Generate three types of questions:
   - "concept": Questions probing the "why" behind practices (most common)
   - "photo": Questions referencing evidence photos (only if photos are available — use the exact photoUrl provided)
   - "tool": Questions about tools and equipment relevant to the skill axis
4. For photo-based questions, set the photoUrl field to the exact URL from the AVAILABLE PHOTOS section.
5. Each explanation should teach — explain WHY the option is correct or incorrect.
6. Questions should test understanding (Bloom's level 2), not just recall.
7. Make wrong options plausible but clearly distinguishable with good explanations.
8. DO NOT use any policy content as source material.
9. Vary the correctIndex across questions (don't always put the correct answer in the same position).

Return ONLY a JSON object with:
{
  "questions": [
    {
      "objectiveId": "<objective_id from the list above>",
      "type": "concept" | "photo" | "tool",
      "text": "<question text>",
      "photoUrl": "<exact photo URL or null>",
      "options": [
        { "index": 0, "text": "<option text>", "explanation": "<why this is correct/incorrect>" },
        { "index": 1, "text": "<option text>", "explanation": "<why this is correct/incorrect>" },
        { "index": 2, "text": "<option text>", "explanation": "<why this is correct/incorrect>" },
        { "index": 3, "text": "<option text>", "explanation": "<why this is correct/incorrect>" }
      ],
      "correctIndex": <0-3>
    }
  ]
}

No markdown, no code fences, no explanation outside the JSON.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2000,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }]
  };

  console.log(`[MODEL] generateQuizViaBedrock using: ${MODEL_FAST}, prompt=${prompt.length} chars`);
  const command = new InvokeModelCommand({
    modelId: MODEL_FAST,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);
    return parsed.questions || [];
  } catch (parseErr) {
    console.error('Failed to parse Bedrock quiz response:', text);
    throw new Error('Failed to generate quiz questions — AI returned invalid format');
  }
}

/**
 * Generate open-form quiz questions via Bedrock Sonnet.
 * Produces question prompt + ideal reference answer for each objective.
 * Used for bridging, self_explanation, application, analysis, and synthesis question types.
 *
 * Requirements: 3.1, 6.3, 6.4, 6.5, 6.7
 */
async function generateOpenFormQuizViaBedrock(action, targetAxis, objectives, questionType, bloomLevel, previousOpenFormStates, previousAnswers, lensBlock, assetBlock, growthIntent = null, profileSkillBlock = '') {
  // Build question type instructions based on the current progression level
  const questionTypeInstructions = {
    bridging: `Generate a BRIDGING question for the entire axis. This is a single open-ended question asking the learner to connect the concepts they've learned to their specific action context. Example framing: "Now that you've reviewed these concepts, what from this area do you see as worth adopting for this action, and why?"
The question should reference the action context and ask the learner to make connections between the concepts and their work.`,
    self_explanation: `Generate SELF-EXPLANATION questions (Bloom's Level 2 — Understand). Each question should ask the learner to explain a concept in their own words. Example framings:
- "Explain in your own words why..."
- "What does this mean in your own words?"
- "Describe how... works and why it matters"
Focus on the "why" behind concepts, not just recall.`,
    application: `Generate APPLICATION questions (Bloom's Level 3 — Apply). Each question should present a scenario and ask the learner to transfer knowledge to a novel context. Example framings:
- "How would you apply this in [new situation]?"
- "Given this scenario, what approach would you take and why?"
- "If you encountered [situation], how would you use what you know about [concept]?"
Focus on practical transfer to new contexts.`,
    analysis: `Generate ANALYSIS questions (Bloom's Level 4 — Analyze). Each question should ask the learner to evaluate tradeoffs between approaches. Example framings:
- "Compare these two methods and explain the tradeoffs"
- "What are the advantages and disadvantages of [approach] vs [approach]?"
- "Evaluate why [approach A] might be preferred over [approach B] in this context"
Focus on critical evaluation and comparison.`,
    synthesis: `Generate SYNTHESIS questions (Bloom's Level 5 — Create). Each question should ask the learner to construct, design, or teach. Example framings:
- "Design a procedure for..."
- "How would you teach this concept to someone new?"
- "Create a plan that combines [concept A] and [concept B] to achieve [goal]"
Focus on creative construction and integration of knowledge.`,
  };

  const typeInstruction = questionTypeInstructions[questionType] || questionTypeInstructions.self_explanation;

  // Build previous open-form responses section for context
  const previousResponsesSection = previousOpenFormStates.length > 0
    ? `\nPREVIOUS OPEN-FORM RESPONSES (use these to target gaps and avoid repetition):\n${previousOpenFormStates.slice(0, 5).map((state, i) => {
        const evalInfo = state.evaluationStatus === 'sufficient'
          ? `Evaluation: sufficient (score: ${state.continuousScore})`
          : state.evaluationStatus === 'insufficient'
            ? `Evaluation: insufficient (score: ${state.continuousScore}) — ${state.reasoning || 'No reasoning'}`
            : `Evaluation: ${state.evaluationStatus}`;
        return `  ${i + 1}. Type: ${state.questionType}\n     Question: ${state.questionText}\n     Response: ${state.responseText.substring(0, 200)}\n     ${evalInfo}`;
      }).join('\n')}`
    : '';

  // Build previous wrong answers section (from Recognition phase)
  const wrongAnswersSection = (previousAnswers || []).filter(a => !a.wasCorrect).length > 0
    ? `\nPREVIOUS WRONG ANSWERS FROM RECOGNITION PHASE (address these misconceptions):\n${previousAnswers.filter(a => !a.wasCorrect).map(a =>
        `  - Objective: ${a.objectiveId}\n    Question: ${a.questionText}\n    Misconception: chose "${a.selectedAnswer}" instead of "${a.correctAnswer}"`
      ).join('\n')}`
    : '';

  const objectivesSection = objectives.map(obj =>
    `  - ID: ${obj.id}\n    Objective: ${obj.text}`
  ).join('\n');

  // Determine if we should use the teach-apply prompt path
  const useTeachApply = growthIntent && typeof growthIntent === 'string' && growthIntent.trim().length > 0;

  // Build the teach-apply instruction block when growth intent is present
  const teachApplyBlock = useTeachApply
    ? `
GROWTH INTENT: ${growthIntent.trim().substring(0, 500)}

TEACH-THEN-APPLY FORMAT:
This learner has stated a growth direction. Each question MUST follow the teach-then-apply pattern:
1. TEACH: Present a real concept, framework, or research finding relevant to the growth intent and the skill axis. Name the concept and its author/originator. This is a short teaching moment — 1-2 sentences introducing the idea.
2. APPLY: Then ask the learner how they would apply this concept to their specific action context (described above). The action is the practice ground, not the learning subject.

The ideal answer should demonstrate the taught concept applied to the action context.

For each question, you MUST also generate:
- "conceptName": the name of the concept/framework being taught (e.g., "Trust Equation", "Active Listening Model", "Situational Leadership")
- "conceptAuthor": the author or originator of the concept (e.g., "Maister", "Rogers", "Hersey & Blanchard"). Use null if no specific author is attributable.

Example teach-apply question: "The Trust Equation (Maister) defines trust as (Credibility + Reliability + Intimacy) / Self-Orientation. Considering your team coordination work, how would you reduce self-orientation in your next interaction with a stakeholder who has concerns about the project timeline?"
`
    : '';

  const prompt = useTeachApply
    ? `You are an expert learning designer who teaches concepts through real-world application. Generate open-form quiz questions that TEACH a concept first, then ask the learner to APPLY it to their work context.

ACTION CONTEXT (the learner's practice ground — where they apply what they learn):
- Title: ${action.title || 'Untitled'}
- Description: ${action.description || 'No description'}
- Expected Outcome (S'): ${action.expected_state || 'Not specified'}

SKILL AXIS: ${targetAxis.label} (${targetAxis.key})
${targetAxis.description ? `Axis Description: ${targetAxis.description}` : ''}

QUESTION TYPE: ${questionType} (Bloom's Level ${bloomLevel})
${typeInstruction}
${teachApplyBlock}
LEARNING OBJECTIVES TO COVER:
${objectivesSection}
${previousResponsesSection}
${wrongAnswersSection}
${lensBlock ? '\n' + lensBlock + '\n' : ''}${profileSkillBlock ? '\n' + profileSkillBlock + '\n' : ''}${assetBlock ? '\n' + assetBlock + '\n' : ''}
HIGH-CEILING QUESTION DESIGN:
- Each question must ask ONE clear thing. No compound questions, no "and also consider..." tacked on.
- Keep questions short — the teaching moment is 1-2 sentences, the application prompt is 1-2 sentences.
- The depth comes from the learner's answer, not the question's complexity.
- Craft questions that are open-ended enough for responses ranging from basic recall to expert-level synthesis.
- Avoid questions with a single correct answer or a narrow expected response.
- Favor questions that invite depth of reasoning, not breadth of coverage. One focused angle, explored deeply.

IDEAL ANSWER REFERENCE:
- Generate a level 4–5 reference answer that demonstrates the taught concept applied to the action context with expert-level reasoning.
- The evaluator uses this to score across the full 0–5 continuum, so the reference must represent the ceiling, not the floor.

INSTRUCTIONS:
1. ${questionType === 'bridging' ? 'Generate ONE bridging question for the entire axis (not per objective). Pick the first objective ID as the objectiveId.' : 'Generate one question per learning objective.'}
2. Each question MUST teach a real concept/framework first, then ask the learner to apply it.
3. For each question, generate an IDEAL REFERENCE ANSWER based on the taught concept applied to the action context.
4. The ideal answer should be thorough but concise (2-4 sentences for self_explanation, 3-5 sentences for application/analysis/synthesis).
5. The ideal answer should model the kind of thinking expected at this Bloom's level:
   - Self-Explanation: Clear "why" reasoning showing understanding of the taught concept
   - Application: Specific transfer of the taught concept to the action context with reasoning
   - Analysis: Explicit comparison of the taught concept with alternatives, evaluating tradeoffs
   - Synthesis: Coherent design integrating the taught concept with other frameworks
6. Questions should be growth-oriented — frame them as learning opportunities, not tests.
7. If previous responses were insufficient, teach a different concept that approaches the same objective from a new angle.

Return ONLY a JSON object with:
{
  "questions": [
    {
      "objectiveId": "<objective_id from the list above>",
      "text": "<teach concept first, then ask to apply>",
      "idealAnswer": "<ideal reference answer based on taught concept applied to action context>",
      "conceptName": "<name of the concept/framework taught>",
      "conceptAuthor": "<author/originator of the concept, or null>"
    }
  ]
}

No markdown, no code fences, no explanation outside the JSON.`
    : `You are an expert learning assessment designer. Generate open-form quiz questions with ideal reference answers to assess a person's understanding at a specific Bloom's taxonomy level.

ACTION CONTEXT:
- Title: ${action.title || 'Untitled'}
- Description: ${action.description || 'No description'}
- Expected Outcome (S'): ${action.expected_state || 'Not specified'}

SKILL AXIS: ${targetAxis.label} (${targetAxis.key})
${targetAxis.description ? `Axis Description: ${targetAxis.description}` : ''}

QUESTION TYPE: ${questionType} (Bloom's Level ${bloomLevel})
${typeInstruction}

LEARNING OBJECTIVES TO COVER:
${objectivesSection}
${previousResponsesSection}
${wrongAnswersSection}
${lensBlock ? '\n' + lensBlock + '\n' : ''}${profileSkillBlock ? '\n' + profileSkillBlock + '\n' : ''}${assetBlock ? '\n' + assetBlock + '\n' : ''}
HIGH-CEILING QUESTION DESIGN:
- Each question must ask ONE clear thing. No compound questions, no "and also consider..." tacked on.
- Keep questions short — one or two sentences max. The depth comes from the learner's answer, not the question's complexity.
- Craft questions that are open-ended enough for responses ranging from basic recall to expert-level synthesis.
- Avoid questions with a single correct answer or a narrow expected response.
- Avoid yes/no framings, list-based questions, and questions that cap the learner's expression at a specific knowledge level.
- Favor questions that invite depth of reasoning, not breadth of coverage. One focused angle, explored deeply.

IDEAL ANSWER REFERENCE:
- Generate a level 4–5 reference answer that demonstrates expert-level reasoning.
- The evaluator uses this to score across the full 0–5 continuum, so the reference must represent the ceiling, not the floor.

INSTRUCTIONS:
1. ${questionType === 'bridging' ? 'Generate ONE bridging question for the entire axis (not per objective). Pick the first objective ID as the objectiveId.' : 'Generate one question per learning objective.'}
2. For each question, also generate an IDEAL REFERENCE ANSWER that demonstrates the expected depth for this Bloom's level.
3. The ideal answer should be thorough but concise (2-4 sentences for self_explanation, 3-5 sentences for application/analysis/synthesis).
4. The ideal answer should model the kind of thinking expected at this Bloom's level:
   - Self-Explanation: Clear "why" reasoning showing understanding of underlying principles
   - Application: Specific transfer to a concrete context with reasoning
   - Analysis: Explicit comparison of tradeoffs with evidence-based evaluation
   - Synthesis: Coherent design or teaching approach integrating multiple concepts
5. Questions should be growth-oriented — frame them as opportunities to demonstrate understanding, not tests.
6. If previous responses were insufficient, generate questions that approach the same concepts from a different angle.

Return ONLY a JSON object with:
{
  "questions": [
    {
      "objectiveId": "<objective_id from the list above>",
      "text": "<question prompt text>",
      "idealAnswer": "<ideal reference answer text>"
    }
  ]
}

No markdown, no code fences, no explanation outside the JSON.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4000,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }]
  };

  console.log(`[MODEL] generateOpenFormQuizViaBedrock using: ${MODEL_FAST}`);
  const command = new InvokeModelCommand({
    modelId: MODEL_FAST,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);
    return parsed.questions || [];
  } catch (parseErr) {
    console.error('Failed to parse Bedrock open-form quiz response:', text);
    throw new Error('Failed to generate open-form quiz questions — AI returned invalid format');
  }
}

/**
 * Validate and normalize open-form quiz question structure.
 * Ensures each question has required fields including idealAnswer.
 * Assigns unique IDs and adds questionType/bloomLevel fields.
 */
function validateOpenFormQuestions(questions, requestedObjectiveIds, questionType, bloomLevel) {
  const validObjectiveIds = new Set(requestedObjectiveIds);
  const validated = [];

  for (const q of questions) {
    // Skip questions that don't map to a requested objective
    if (!q.objectiveId || !validObjectiveIds.has(q.objectiveId)) {
      console.warn('Skipping open-form question with invalid objectiveId:', q.objectiveId);
      continue;
    }

    // Validate idealAnswer is present
    const idealAnswer = q.idealAnswer && typeof q.idealAnswer === 'string' && q.idealAnswer.trim().length > 0
      ? q.idealAnswer.trim()
      : `An ideal response would demonstrate understanding of the learning objective at Bloom's level ${bloomLevel}.`;

    if (!q.idealAnswer || !q.idealAnswer.trim()) {
      console.warn('Open-form question missing idealAnswer, using fallback for objective:', q.objectiveId);
    }

    validated.push({
      id: `q-${require('crypto').randomUUID()}`,
      objectiveId: q.objectiveId,
      type: 'concept',
      questionType: questionType,
      bloomLevel: bloomLevel,
      text: q.text || '',
      photoUrl: null,
      options: null,
      correctIndex: null,
      idealAnswer: idealAnswer,
      conceptName: (q.conceptName && typeof q.conceptName === 'string' && q.conceptName.trim()) ? q.conceptName.trim() : null,
      conceptAuthor: (q.conceptAuthor && typeof q.conceptAuthor === 'string' && q.conceptAuthor.trim()) ? q.conceptAuthor.trim() : null,
    });
  }

  return validated;
}

/**
 * Validate and normalize quiz question structure.
 * Ensures each question has required fields and maps to a requested objective.
 * Assigns unique IDs to each question.
 */
function validateQuizQuestions(questions, requestedObjectiveIds) {
  const validObjectiveIds = new Set(requestedObjectiveIds);
  const validated = [];

  for (const q of questions) {
    // Skip questions that don't map to a requested objective
    if (!q.objectiveId || !validObjectiveIds.has(q.objectiveId)) {
      console.warn('Skipping question with invalid objectiveId:', q.objectiveId);
      continue;
    }

    // Validate options — must have exactly 4
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      console.warn('Skipping question with invalid options count:', q.options?.length);
      continue;
    }

    // Validate correctIndex
    const correctIndex = typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex <= 3
      ? q.correctIndex
      : 0;

    // Normalize options to ensure each has index, text, and explanation
    const options = q.options.map((opt, i) => ({
      index: typeof opt.index === 'number' ? opt.index : i,
      text: opt.text || `Option ${i + 1}`,
      explanation: opt.explanation || ''
    }));

    // Ensure each option has a valid explanation
    const hasExplanations = options.every(opt => opt.explanation && opt.explanation.length > 0);
    if (!hasExplanations) {
      console.warn('Question has options missing explanations, proceeding with available data');
    }

    validated.push({
      id: `q-${require('crypto').randomUUID()}`,
      objectiveId: q.objectiveId,
      type: ['concept', 'photo', 'tool'].includes(q.type) ? q.type : 'concept',
      text: q.text || '',
      photoUrl: q.photoUrl || null,
      options,
      correctIndex
    });
  }

  return validated;
}

/**
 * POST /api/learning/:actionId/quiz/evaluate
 * Trigger asynchronous evaluation of an open-form response.
 * The handler performs the evaluation synchronously within the Lambda invocation
 * but returns 202 to indicate the result will be available later via polling.
 * Requirements: 3.5, 3.6, 7.1, 7.2, 7.3, 7.4, 7.5
 */
async function handleEvaluate(actionId, body, organizationId, aiConfig) {
  const { stateId, responseText, idealAnswer, questionType, objectiveText, questionText, growthIntent, conceptName, conceptAuthor } = body;

  // Validate required fields
  if (!stateId || !responseText || !idealAnswer || !questionType || !objectiveText || !questionText) {
    return error('Missing required fields: stateId, responseText, idealAnswer, questionType, objectiveText, questionText', 400);
  }

  // Return 202 immediately — from the frontend's perspective this is fire-and-forget.
  // The evaluation work happens synchronously in this Lambda invocation, but the
  // frontend doesn't wait for the result. It polls via evaluation-status later.
  const db = await getDbClient();
  try {
    const orgIdSafe = escapeLiteral(organizationId);
    const stateIdSafe = escapeLiteral(stateId);

    // Verify the state exists and belongs to this organization
    const stateResult = await db.query(
      `SELECT id, state_text, captured_by FROM states
       WHERE id = '${stateIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    if (!stateResult.rows || stateResult.rows.length === 0) {
      return error('Knowledge state not found', 404);
    }

    const currentStateText = stateResult.rows[0].state_text;
    const stateCapturedBy = stateResult.rows[0].captured_by;

    // Look up the axis label for this knowledge state via its linked learning objective
    // Also extract userId from the linked objective for profile skill progression
    let axisLabel = null;
    let linkedObjectiveUserId = null;
    try {
      const objectiveLinkResult = await db.query(
        `SELECT s.state_text
         FROM state_links sl
         INNER JOIN states s ON s.id::text = sl.entity_id
         WHERE sl.state_id = '${stateIdSafe}'
           AND sl.entity_type = 'learning_objective'
         LIMIT 1`
      );
      if (objectiveLinkResult.rows.length > 0) {
        const parsedObj = parseLearningObjectiveStateText(objectiveLinkResult.rows[0].state_text);
        if (parsedObj) {
          linkedObjectiveUserId = parsedObj.userId || null;
          if (parsedObj.axisKey) {
            // Look up axis label from the action's skill profile
            const actionResult = await db.query(
              `SELECT skill_profile FROM actions
               WHERE id = '${escapeLiteral(actionId)}' AND organization_id = '${orgIdSafe}'`
            );
            if (actionResult.rows.length > 0 && actionResult.rows[0].skill_profile) {
              const axis = actionResult.rows[0].skill_profile.axes?.find(a => a.key === parsedObj.axisKey);
              if (axis) {
                axisLabel = axis.label;
              }
            }
          }
        }
      }
    } catch (axisErr) {
      console.warn('Failed to look up axis label for evaluation embedding:', axisErr.message);
    }

    // Call Bedrock to evaluate the response
    let evaluation;
    try {
      evaluation = await callBedrockForEvaluation(responseText, idealAnswer, questionType, objectiveText, questionText, aiConfig, growthIntent || null, conceptName || null, conceptAuthor || null);
    } catch (bedrockErr) {
      console.error('Bedrock evaluation failed for state', stateId, ':', bedrockErr.message);

      // Mark state as error
      const errorStateText = appendEvaluationErrorToStateTextServer(currentStateText);
      await db.query(
        `UPDATE states SET state_text = '${escapeLiteral(errorStateText)}'
         WHERE id = '${stateIdSafe}' AND organization_id = '${orgIdSafe}'`
      );

      // Re-queue embedding for the error-updated state text
      queueEvaluationEmbedding(stateId, errorStateText, organizationId, axisLabel)
        .catch(err => console.error('Failed to queue embedding after evaluation error:', err));

      // Still return 202 — the error is recorded in the state, frontend will see it via polling
      return {
        statusCode: 202,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({ message: 'Evaluation queued' })
      };
    }

    // Update the knowledge state with evaluation results
    const updatedStateText = appendEvaluationToStateTextServer(currentStateText, evaluation);
    await db.query(
      `UPDATE states SET state_text = '${escapeLiteral(updatedStateText)}'
       WHERE id = '${stateIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    // Re-queue embedding generation for the updated state text
    queueEvaluationEmbedding(stateId, updatedStateText, organizationId, axisLabel)
      .catch(err => console.error('Failed to queue embedding after evaluation:', err));

    console.log(`Evaluation complete for state ${stateId}: score=${evaluation.score}, sufficient=${evaluation.sufficient}`);

    // Update profile skill progression after successful evaluation
    // Use demonstratedLevel from evaluation, fall back to scoreToBloomLevel
    const userId = linkedObjectiveUserId || stateCapturedBy;
    if (userId) {
      try {
        const demonstratedLevel = evaluation.demonstratedLevel != null
          ? evaluation.demonstratedLevel
          : scoreToBloomLevel(evaluation.score);
        await updateProfileSkillProgression(db, userId, organizationId, actionId, stateId, demonstratedLevel);
      } catch (progressionErr) {
        console.error('Failed to update profile skill progression for state', stateId, ':', progressionErr.message);
      }
    }

    return {
      statusCode: 202,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({ message: 'Evaluation queued' })
    };
  } finally {
    db.release();
  }
}

/**
 * GET /api/learning/:actionId/:userId/evaluation-status
 * Check evaluation status for one or more knowledge states.
 * Requirements: 7.6
 */
async function handleEvaluationStatus(actionId, userId, organizationId, queryParams) {
  const stateIdsParam = queryParams.stateIds;
  if (!stateIdsParam || typeof stateIdsParam !== 'string' || stateIdsParam.trim().length === 0) {
    return error('stateIds query parameter is required (comma-separated UUIDs)', 400);
  }

  const stateIds = stateIdsParam.split(',').map(id => id.trim()).filter(id => id.length > 0);
  if (stateIds.length === 0) {
    return error('stateIds query parameter must contain at least one UUID', 400);
  }

  const db = await getDbClient();
  try {
    const orgIdSafe = escapeLiteral(organizationId);
    const stateIdsList = stateIds.map(id => `'${escapeLiteral(id)}'`).join(',');

    // Fetch knowledge states by IDs, scoped to organization
    const result = await db.query(
      `SELECT id, state_text
       FROM states
       WHERE id IN (${stateIdsList})
         AND organization_id = '${orgIdSafe}'`
    );

    // Build a map of found states for quick lookup
    const foundStates = {};
    for (const row of result.rows) {
      foundStates[row.id] = row.state_text;
    }

    // Build evaluations array
    const evaluations = stateIds.map(stateId => {
      const stateText = foundStates[stateId];

      // State not found in DB
      if (!stateText) {
        return { stateId, status: 'not_found' };
      }

      // Try to parse as open-form state text
      const parsed = parseOpenFormStateText(stateText);
      if (!parsed) {
        return { stateId, status: 'unknown' };
      }

      // Map evaluation status to response format
      if (parsed.evaluationStatus === 'pending') {
        return { stateId, status: 'pending' };
      }

      if (parsed.evaluationStatus === 'error') {
        return { stateId, status: 'error' };
      }

      if (parsed.evaluationStatus === 'sufficient' || parsed.evaluationStatus === 'insufficient') {
        const evalResult = {
          stateId,
          status: 'evaluated',
          score: parsed.continuousScore,
          sufficient: parsed.evaluationStatus === 'sufficient',
          reasoning: parsed.reasoning,
        };

        // Include structured Bloom feedback fields when available
        if (parsed.demonstratedLevel != null) {
          evalResult.demonstratedLevel = parsed.demonstratedLevel;
        }
        if (parsed.conceptDemonstrated != null) {
          evalResult.conceptDemonstrated = parsed.conceptDemonstrated;
        }
        if (parsed.nextLevelHint != null) {
          evalResult.nextLevelHint = parsed.nextLevelHint;
        }

        return evalResult;
      }

      return { stateId, status: 'unknown' };
    });

    return success({ evaluations });
  } finally {
    db.release();
  }
}

/**
 * Call Bedrock to evaluate an open-form response against the ideal answer.
 * Returns { score, sufficient, reasoning, demonstratedLevel, conceptDemonstrated, nextLevelHint }
 * with score on a continuous Bloom's scale [0.0, 5.0].
 *
 * When growthIntent is present with conceptName/conceptAuthor, the evaluation prompt includes
 * concept-aware context assessing how well the learner understood and applied the taught concept.
 * When growthIntent is absent, existing evaluation behavior is preserved.
 *
 * For ALL evaluations, structured Bloom feedback fields are requested and returned.
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.6, 6.7, 6.8
 */
async function callBedrockForEvaluation(responseText, idealAnswer, questionType, objectiveText, questionText, aiConfig, growthIntent = null, conceptName = null, conceptAuthor = null) {
  if (!aiConfig) {
    aiConfig = resolveAiConfig(null);
  }

  const bloomLevel = questionTypeToBloomLevel(questionType);

  // Build concept-aware context block when growth intent is active
  let conceptContextBlock = '';
  if (growthIntent && conceptName) {
    const authorRef = conceptAuthor ? ` (${conceptAuthor})` : '';
    conceptContextBlock = `
GROWTH INTENT: ${growthIntent}
CONCEPT BEING ASSESSED: ${conceptName}${authorRef}

CONCEPT-AWARE EVALUATION:
- Assess how well the learner understood the taught concept "${conceptName}" and applied it to the action context.
- The learner was taught this concept as part of their self-directed growth intent. Evaluate whether they grasped the core idea and could connect it to their work.
`;
  }

  const prompt = `You are an expert learning evaluator. Assess a learner's open-form response against an ideal answer, scoring on a continuous Bloom's taxonomy scale.

LEARNING OBJECTIVE: ${objectiveText}

QUESTION TYPE: ${questionType} (Bloom's Level ${bloomLevel})
QUESTION: ${questionText}
${conceptContextBlock}
LEARNER'S RESPONSE:
${responseText}

IDEAL REFERENCE ANSWER:
${idealAnswer}

EVALUATION INSTRUCTIONS:
1. Score the response on a continuous Bloom's scale from 0.0 to 5.0, where:
   - 0.0-0.9: No meaningful understanding demonstrated
   - 1.0-1.9: Basic recall/recognition only
   - 2.0-2.9: Understanding — can explain "why" in own words
   - 3.0-3.9: Application — can transfer knowledge to new contexts
   - 4.0-4.9: Analysis — can evaluate tradeoffs and compare approaches
   - 5.0: Synthesis — can design, create, or teach the concept

2. The score should reflect the ACTUAL depth demonstrated, regardless of the question type asked.
   A strong response to a Level 2 question that shows Level 4 thinking should score 4.0+.

3. Determine sufficiency: the response is "sufficient" if the score meets or exceeds the question type's Bloom's level (${bloomLevel}.0).

4. Provide a brief reasoning summary (1-2 sentences) explaining what the response demonstrates and any gaps.

5. Provide structured Bloom's feedback:
   - "demonstratedLevel": integer 1-5 indicating the Bloom's taxonomy level the response reached (1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Create).
   - "conceptDemonstrated": a second-person summary of what the learner showed they understand or can do (e.g., "You showed you can apply the concept by..."). Keep it to 1-2 sentences.
   - "nextLevelHint": when demonstratedLevel is below 5, describe what the next Bloom's level would look like for this topic (e.g., "To reach Analyze: compare this approach with an alternative and evaluate tradeoffs"). When demonstratedLevel is 5, return an empty string "".

Return ONLY a JSON object with:
{
  "score": <decimal 0.0-5.0>,
  "sufficient": <true|false>,
  "reasoning": "<1-2 sentence explanation>",
  "demonstratedLevel": <integer 1-5>,
  "conceptDemonstrated": "<what the learner showed>",
  "nextLevelHint": "<hint for next level, or empty string if level 5>"
}

No markdown, no code fences, no explanation outside the JSON.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 800,
    temperature: aiConfig.quiz_temperature,
    messages: [{ role: 'user', content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: OBJECTIVE_MODEL_ID,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('Failed to parse Bedrock evaluation response:', text);
    throw new Error('Bedrock returned invalid evaluation format');
  }

  // Validate and clamp score to [0.0, 5.0]
  let score = parseFloat(parsed.score);
  if (isNaN(score)) {
    throw new Error('Bedrock evaluation missing valid score');
  }
  if (score < 0.0 || score > 5.0) {
    console.warn(`Evaluation score ${score} outside [0.0, 5.0], clamping`);
    score = Math.max(0.0, Math.min(5.0, score));
  }

  const sufficient = typeof parsed.sufficient === 'boolean' ? parsed.sufficient : score >= bloomLevel;
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
    ? parsed.reasoning.trim()
    : 'Evaluation completed';

  // Derive demonstratedLevel: use Bedrock's value if valid, otherwise fall back to scoreToBloomLevel
  let demonstratedLevel = parseInt(parsed.demonstratedLevel, 10);
  if (isNaN(demonstratedLevel) || demonstratedLevel < 1 || demonstratedLevel > 5) {
    demonstratedLevel = scoreToBloomLevel(score);
  }

  // Derive conceptDemonstrated: use Bedrock's value if present, otherwise generate a generic fallback
  const conceptDemonstrated = typeof parsed.conceptDemonstrated === 'string' && parsed.conceptDemonstrated.trim().length > 0
    ? parsed.conceptDemonstrated.trim()
    : `You demonstrated ${bloomLevelToLabel(demonstratedLevel)}-level thinking in your response.`;

  // Derive nextLevelHint: use Bedrock's value if present, otherwise generate a generic fallback
  let nextLevelHint;
  if (demonstratedLevel >= 5) {
    nextLevelHint = '';
  } else if (typeof parsed.nextLevelHint === 'string' && parsed.nextLevelHint.trim().length > 0) {
    nextLevelHint = parsed.nextLevelHint.trim();
  } else {
    const nextLabel = bloomLevelToLabel(demonstratedLevel + 1);
    nextLevelHint = `To reach ${nextLabel}: deepen your response to show ${nextLabel.toLowerCase()}-level thinking.`;
  }

  return { score, sufficient, reasoning, demonstratedLevel, conceptDemonstrated, nextLevelHint };
}
/**
 * Map a Bloom's level integer (1-5) to its human-readable label.
 * Used as a local fallback for generating generic feedback text.
 */
function bloomLevelToLabel(level) {
  const labels = { 1: 'Remember', 2: 'Understand', 3: 'Apply', 4: 'Analyze', 5: 'Create' };
  return labels[level] || 'Unknown';
}

/**
 * Server-side equivalent of appendEvaluationToStateText.
 * Replaces "Evaluation: pending." with the evaluation result.
 * Includes structured Bloom feedback fields when available.
 */
function appendEvaluationToStateTextServer(stateText, evaluation) {
  const sufficiency = evaluation.sufficient ? 'sufficient' : 'insufficient';
  let replacement = `Evaluation: ${sufficiency} (score: ${evaluation.score}). ${evaluation.reasoning}.`;

  // Append structured Bloom feedback if available
  if (evaluation.demonstratedLevel != null) {
    const demonstrated = (evaluation.conceptDemonstrated || '').replace(/]/g, '\\]');
    const nextHint = (evaluation.nextLevelHint || '').replace(/]/g, '\\]');
    replacement += ` [bloom: level=${evaluation.demonstratedLevel}, demonstrated=${demonstrated}, nextHint=${nextHint}]`;
  }

  return stateText.replace('Evaluation: pending.', replacement);
}

/**
 * Server-side equivalent of appendEvaluationErrorToStateText.
 * Replaces "Evaluation: pending." with "Evaluation: error."
 */
function appendEvaluationErrorToStateTextServer(stateText) {
  return stateText.replace('Evaluation: pending.', 'Evaluation: error.');
}

/**
 * Queue embedding generation for an updated evaluation state via SQS.
 * Uses the same pipeline as the states Lambda.
 * When axisLabel is provided, prepends it to the embedding source for better axis-level matching.
 */
async function queueEvaluationEmbedding(stateId, stateText, organizationId, axisLabel) {
  let embeddingSource = composeStateEmbeddingSource({
    entity_names: [],
    state_text: stateText,
    photo_descriptions: [],
    metrics: []
  });

  if (!embeddingSource || !embeddingSource.trim()) {
    console.log('Empty embedding source for evaluation state', stateId, '— skipping SQS send');
    return;
  }

  // Prepend axis label for improved per-axis similarity matching
  if (axisLabel) {
    embeddingSource = composeAxisAwareEmbeddingSource(axisLabel, embeddingSource);
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: EMBEDDINGS_QUEUE_URL,
    MessageBody: JSON.stringify({
      entity_type: 'state',
      entity_id: stateId,
      embedding_source: embeddingSource,
      organization_id: organizationId
    })
  }));

  console.log('Queued embedding for evaluation state', stateId);
}

/**
 * POST /api/learning/:actionId/verify
 * Verify which learning objectives an observation demonstrates.
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */
async function handleVerify(actionId, body, organizationId, aiConfig) {
  const { observationId, selfAssessedObjectiveIds, userId } = body;

  // Validate required fields
  if (!observationId || !userId) {
    return error('observationId and userId are required', 400);
  }

  if (!Array.isArray(selfAssessedObjectiveIds)) {
    return error('selfAssessedObjectiveIds must be an array', 400);
  }

  const db = await getDbClient();
  try {
    const actionIdSafe = escapeLiteral(actionId);
    const observationIdSafe = escapeLiteral(observationId);
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    // 1. Fetch observation from states table (text)
    const observationResult = await db.query(
      `SELECT s.id, s.state_text, s.captured_by, s.captured_at
       FROM states s
       WHERE s.id = '${observationIdSafe}'
         AND s.organization_id = '${orgIdSafe}'`
    );

    if (!observationResult.rows || observationResult.rows.length === 0) {
      return error('Observation not found', 404);
    }

    const observation = observationResult.rows[0];

    // 2. Fetch observation photos from state_photos
    const photosResult = await db.query(
      `SELECT photo_url, photo_description, photo_order
       FROM state_photos
       WHERE state_id = '${observationIdSafe}'
       ORDER BY photo_order`
    );

    const observationPhotos = photosResult.rows.map(p => ({
      url: p.photo_url,
      description: p.photo_description
    }));

    // 3. Fetch learning objectives for this action
    const objectivesResult = await db.query(
      `SELECT s.id, s.state_text
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'action' AND sl.entity_id = '${actionIdSafe}'
         AND s.organization_id = '${orgIdSafe}'
         AND s.state_text LIKE '[learning_objective]%'
         AND s.state_text LIKE '%user=${userIdSafe}%'
       ORDER BY s.captured_at ASC`
    );

    if (!objectivesResult.rows || objectivesResult.rows.length === 0) {
      return error('No learning objectives found for this action and user', 404);
    }

    const objectives = objectivesResult.rows.map(row => {
      const parsed = parseLearningObjectiveStateText(row.state_text);
      return {
        id: row.id,
        text: parsed ? parsed.objectiveText : row.state_text,
        axisKey: parsed ? parsed.axisKey : null
      };
    });

    // Look up axis labels from the action's skill profile for embedding enrichment
    let axisLabelMap = {};
    try {
      const actionResult = await db.query(
        `SELECT skill_profile FROM actions
         WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}'`
      );
      if (actionResult.rows.length > 0 && actionResult.rows[0].skill_profile?.axes) {
        for (const axis of actionResult.rows[0].skill_profile.axes) {
          axisLabelMap[axis.key] = axis.label;
        }
      }
    } catch (axisErr) {
      console.warn('Failed to look up axis labels for demonstration embeddings:', axisErr.message);
    }

    // 4. Call Bedrock Sonnet to evaluate which objectives the observation demonstrates
    const aiEvaluatedIds = await evaluateObservationViaBedrock(
      observation,
      observationPhotos,
      objectives,
      aiConfig
    );

    // 5. Compare self-assessment vs AI evaluation
    const result = compareAssessments(selfAssessedObjectiveIds, aiEvaluatedIds);

    // 6. For each confirmed objective, create a demonstration knowledge state
    for (const confirmedId of result.confirmed) {
      const objective = objectives.find(o => o.id === confirmedId);
      if (!objective) continue;

      const stateText = `Demonstrated learning objective '${objective.text}' via observation. Both self-assessed and AI-confirmed.`;

      await db.query('BEGIN');
      try {
        const insertResult = await db.query(
          `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
           VALUES ('${orgIdSafe}', '${escapeLiteral(stateText)}', '${userIdSafe}', NOW())
           RETURNING id`
        );
        const stateId = insertResult.rows[0].id;

        // Create state_link to the learning objective
        await db.query(
          `INSERT INTO state_links (state_id, entity_type, entity_id)
           VALUES ('${escapeLiteral(stateId)}', 'learning_objective', '${escapeLiteral(confirmedId)}')`
        );

        await db.query('COMMIT');

        // 7. Explicitly await SQS queueing for each new demonstration state
        const axisLabel = objective.axisKey ? axisLabelMap[objective.axisKey] : null;
        try {
          await queueDemonstrationEmbedding(stateId, stateText, organizationId, axisLabel || null);
          console.log('Successfully queued demonstration embedding for state', stateId);
        } catch (err) {
          console.error('Failed to queue demonstration embedding:', err);
        }
      } catch (insertErr) {
        await db.query('ROLLBACK');
        throw insertErr;
      }
    }

    // 8. Return verification results
    return success({
      confirmed: result.confirmed,
      unconfirmed: result.unconfirmed,
      aiDetected: result.aiDetected
    });
  } finally {
    db.release();
  }
}

/**
 * Call Bedrock Sonnet to evaluate which learning objectives an observation demonstrates.
 * Returns an array of objective IDs that the AI determines are demonstrated.
 */
async function evaluateObservationViaBedrock(observation, photos, objectives, aiConfig) {
  if (!aiConfig) {
    aiConfig = resolveAiConfig(null);
  }

  const objectivesList = objectives.map(obj =>
    `  - ID: ${obj.id}\n    Objective: ${obj.text}`
  ).join('\n');

  const photoDescriptions = photos
    .filter(p => p.description)
    .map((p, i) => `  ${i + 1}. ${p.description}`)
    .join('\n');

  const photoSection = photoDescriptions
    ? `\nPHOTO DESCRIPTIONS:\n${photoDescriptions}`
    : '\nNo photos attached to this observation.';

  const prompt = `You are an expert skill evaluator. Analyze an observation and determine which learning objectives it demonstrates.

OBSERVATION TEXT:
${observation.state_text || 'No text provided.'}
${photoSection}

LEARNING OBJECTIVES TO EVALUATE:
${objectivesList}

INSTRUCTIONS:
- For each learning objective, determine if the observation provides evidence that the person understands or can demonstrate that objective.
- Be reasonably generous — if the observation shows practical application or understanding related to the objective, include it.
- Only exclude objectives where the observation provides no relevant evidence at all.
- Return the IDs of objectives that the observation demonstrates.

Return ONLY a JSON object with:
{ "demonstratedObjectiveIds": ["<objective_id_1>", "<objective_id_2>"] }

If no objectives are demonstrated, return:
{ "demonstratedObjectiveIds": [] }

No markdown, no code fences, no explanation.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    temperature: aiConfig.quiz_temperature,
    messages: [{ role: 'user', content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: OBJECTIVE_MODEL_ID,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);
    // Validate that returned IDs are from the objectives list
    const validIds = new Set(objectives.map(o => o.id));
    return (parsed.demonstratedObjectiveIds || []).filter(id => validIds.has(id));
  } catch (parseErr) {
    console.error('Failed to parse Bedrock verification response:', text);
    return [];
  }
}

/**
 * Compare self-assessment against AI evaluation.
 * Returns { confirmed, unconfirmed, aiDetected }.
 */
function compareAssessments(selfAssessedIds, aiEvaluatedIds) {
  const selfSet = new Set(selfAssessedIds);
  const aiSet = new Set(aiEvaluatedIds);

  const confirmed = [];
  const unconfirmed = [];
  const aiDetected = [];

  // confirmed = intersection(self, ai)
  for (const id of selfSet) {
    if (aiSet.has(id)) {
      confirmed.push(id);
    } else {
      unconfirmed.push(id);
    }
  }

  // aiDetected = ai - self
  for (const id of aiSet) {
    if (!selfSet.has(id)) {
      aiDetected.push(id);
    }
  }

  return { confirmed, unconfirmed, aiDetected };
}

/**
 * Queue embedding generation for a new demonstration knowledge state via SQS.
 * Uses the same pipeline as the states Lambda.
 * When axisLabel is provided, prepends it to the embedding source for better axis-level matching.
 */
async function queueDemonstrationEmbedding(stateId, stateText, organizationId, axisLabel) {
  let embeddingSource = composeStateEmbeddingSource({
    entity_names: [],
    state_text: stateText,
    photo_descriptions: [],
    metrics: []
  });

  if (!embeddingSource || !embeddingSource.trim()) {
    console.log('Empty embedding source for demonstration state', stateId, '— skipping SQS send');
    return;
  }

  // Prepend axis label for improved per-axis similarity matching
  if (axisLabel) {
    embeddingSource = composeAxisAwareEmbeddingSource(axisLabel, embeddingSource);
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: EMBEDDINGS_QUEUE_URL,
    MessageBody: JSON.stringify({
      entity_type: 'state',
      entity_id: stateId,
      embedding_source: embeddingSource,
      organization_id: organizationId
    })
  }));

  console.log('Queued embedding for demonstration state', stateId);
}

// --- Profile Skill Helpers ---

/**
 * Fetch active profile skills for a user.
 * Queries states joined with state_links to find profile skills owned by the user,
 * parses each state_text, and filters for active ones.
 *
 * @param {object} db - Database client (already acquired, caller manages release)
 * @param {string} userId - Escaped user ID
 * @param {string} organizationId - Escaped organization ID
 * @returns {Promise<Array>} Array of parsed active profile skill objects, each including the state `id`
 */
async function fetchActiveProfileSkills(db, userId, organizationId) {
  const result = await db.query(
    `SELECT s.id, s.state_text
     FROM states s
     INNER JOIN state_links sl ON sl.state_id = s.id
     WHERE sl.entity_type = 'profile_skill_owner'
       AND sl.entity_id = '${userId}'
       AND s.organization_id = '${organizationId}'
       AND s.state_text LIKE '[profile_skill]%'`
  );

  const activeSkills = [];
  for (const row of result.rows) {
    const match = row.state_text.match(/^\[profile_skill\] \| (.+)$/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.active === true) {
        activeSkills.push({ id: row.id, ...parsed });
      }
    } catch (e) {
      console.warn('Failed to parse profile skill state_text for state', row.id, ':', e.message);
    }
  }

  return activeSkills;
}

/**
 * Build the Profile_Skill_Lens context block for the quiz generation prompt.
 * Structured as a separate section distinct from org-level lenses.
 *
 * @param {Array} profileSkills - Active profile skills with axes and bloom levels
 * @returns {string} Prompt text block
 */
function buildProfileSkillPromptBlock(profileSkills) {
  if (!profileSkills || profileSkills.length === 0) return '';

  const skillBlocks = profileSkills.map((skill, i) => {
    const axesDescription = skill.axes.map(axis =>
      `    - ${axis.label} (current Bloom's level: ${axis.bloom_level}/5): ${axis.description}`
    ).join('\n');

    return `  Area of Focus ${i + 1}: ${skill.ai_interpretation?.concept_label || 'Personal Growth Area'}
    Narrative: ${skill.original_narrative.substring(0, 300)}
    Source: ${skill.ai_interpretation?.source_attribution || 'Personal insight'}
    Direction: ${skill.ai_interpretation?.learning_direction || 'General growth'}
    Concept Axes:
${axesDescription}`;
  }).join('\n\n');

  return `LEARNER AREAS OF FOCUS (self-directed learning lenses — weave these concepts into questions where relevant):
${skillBlocks}

For each area of focus axis, frame questions at a depth appropriate to the learner's current Bloom's level for that axis. Lower levels (0-2) should introduce and explain the concept; higher levels (3-5) should ask for application, analysis, or synthesis of the concept in the action context.`;
}

/**
 * Parse a profile skill state_text, extracting the profile skill JSON data.
 * Returns null if the format doesn't match.
 *
 * @param {string} stateText - The raw state_text from the states table
 * @returns {object|null} Parsed profile skill object, or null
 */
function parseProfileSkillStateText(stateText) {
  const match = stateText.match(/^\[profile_skill\] \| (.+)$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

/**
 * Compose a profile skill state_text from the profile skill data.
 * User ownership is tracked via captured_by and state_links, not in state_text.
 *
 * @param {object} profileSkillData - The profile skill data object
 * @returns {string} Composed state_text in the format: [profile_skill] | {json}
 */
function composeProfileSkillStateText(profileSkillData) {
  return `[profile_skill] | ${JSON.stringify(profileSkillData)}`;
}

/**
 * Update progression for all active profile skills after a quiz evaluation.
 *
 * For each active profile skill, appends a progression event to every axis's
 * progression_history, recomputes bloom_level via the Progression_Model, and
 * persists the updated state record.
 *
 * @param {object} db - Database client (already acquired, caller manages release)
 * @param {string} userId - Raw (unescaped) user ID
 * @param {string} organizationId - Raw (unescaped) organization ID
 * @param {string} actionId - The action the quiz was for
 * @param {string} knowledgeStateId - The quiz knowledge state ID
 * @param {number} demonstratedLevel - Bloom's level from evaluation (1-5)
 */
async function updateProfileSkillProgression(db, userId, organizationId, actionId, knowledgeStateId, demonstratedLevel) {
  const orgIdSafe = escapeLiteral(organizationId);
  const userIdSafe = escapeLiteral(userId);

  // Fetch active profile skills for this user
  const profileSkillsResult = await db.query(
    `SELECT s.id, s.state_text
     FROM states s
     INNER JOIN state_links sl ON sl.state_id = s.id
     WHERE sl.entity_type = 'profile_skill_owner'
       AND sl.entity_id = '${userIdSafe}'
       AND s.organization_id = '${orgIdSafe}'
       AND s.state_text LIKE '[profile_skill]%'`
  );

  for (const row of profileSkillsResult.rows) {
    const parsed = parseProfileSkillStateText(row.state_text);
    if (!parsed || !parsed.active) continue;

    // Create progression event
    const event = {
      demonstrated_level: demonstratedLevel,
      action_id: actionId,
      state_id: knowledgeStateId,
      timestamp: new Date().toISOString()
    };

    // Append to each axis's progression_history
    let updated = false;
    for (const axis of parsed.axes) {
      axis.progression_history.push(event);
      axis.bloom_level = computeBloomLevel(axis.progression_history);
      updated = true;
    }

    if (updated) {
      const updatedStateText = composeProfileSkillStateText(parsed);
      await db.query(
        `UPDATE states SET state_text = '${escapeLiteral(updatedStateText)}'
         WHERE id = '${escapeLiteral(row.id)}' AND organization_id = '${orgIdSafe}'`
      );
    }
  }
}

// Re-export pure functions from evidenceUtils for testing
exports.filterCompletedKnowledgeStates = filterCompletedKnowledgeStates;
exports.extractBestMatch = extractBestMatch;
exports.extractTopKMatches = extractTopKMatches;

// Re-export lens functions for testing
exports.selectLenses = selectLenses;
exports.applyGapBoost = applyGapBoost;
exports.buildValuesLenses = buildValuesLenses;

// Re-export quiz generation functions for testing
exports.generateOpenFormQuizViaBedrock = generateOpenFormQuizViaBedrock;
exports.validateOpenFormQuestions = validateOpenFormQuestions;

// Re-export evaluation function for testing
exports.callBedrockForEvaluation = callBedrockForEvaluation;

// Re-export profile skill helpers for testing and integration
exports.fetchActiveProfileSkills = fetchActiveProfileSkills;
exports.buildProfileSkillPromptBlock = buildProfileSkillPromptBlock;
exports.updateProfileSkillProgression = updateProfileSkillProgression;
exports.parseProfileSkillStateText = parseProfileSkillStateText;
exports.composeProfileSkillStateText = composeProfileSkillStateText;
