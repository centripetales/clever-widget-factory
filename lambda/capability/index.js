const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse, corsResponse } = require('/opt/nodejs/response');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');
const { fetchAiConfig, resolveAiConfig } = require('/opt/nodejs/aiConfigDefaults');
const { determineEvidenceTypeEnriched } = require('./capabilityUtils');
const { composeCapabilityProfileStateText, parseCapabilityProfileStateText, computeEvidenceHash, determineCacheAction } = require('./cacheUtils');
const { composeAxisEmbeddingSource } = require('/opt/nodejs/axisUtils');

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });
const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

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
    // GET /api/capability/:actionId              — Individual capability (userId from auth context)
    // GET /api/capability/:actionId?force=true   — Force rescore
    if (httpMethod === 'GET' && path.startsWith('/api/capability/')) {
      const segments = path.replace('/api/capability/', '').split('/');
      const actionId = segments[0];

      if (!actionId) {
        return error('Invalid path. Expected /api/capability/:actionId', 400);
      }

      const queryParams = event.queryStringParameters || {};
      const forceRescore = queryParams.force === 'true';

      // userId always comes from auth context — the logged-in user is always the subject
      const userId = authContext.user_id;
      if (!userId) {
        return error('User identity not found in auth context', 401);
      }

      return await handleIndividualCapability(actionId, userId, organizationId, forceRescore);
    }

    return error('Not found', 404);

  } catch (err) {
    console.error('Error:', err);
    return error(err.message, 500);
  }
};

/**
 * GET /api/capability/:actionId/:userId
 * Compute capability profile for one person relative to an action.
 * Always uses per-axis evidence retrieval flow, generating skill_axis
 * embeddings on-the-fly if they don't exist yet.
 * Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
 */
async function handleIndividualCapability(actionId, userId, organizationId, forceRescore = false) {
  const db = await getDbClient();
  try {
    const aiConfig = await fetchAiConfig(db, organizationId);
    const actionIdSafe = escapeLiteral(actionId);
    const userIdSafe = escapeLiteral(userId);
    const orgIdSafe = escapeLiteral(organizationId);

    // 1. Fetch action's skill_profile JSON; return 404 if no approved profile
    const actionResult = await db.query(
      `SELECT id, skill_profile FROM actions WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    if (!actionResult.rows || actionResult.rows.length === 0) {
      return error('Action not found', 404);
    }

    const action = actionResult.rows[0];
    const skillProfile = action.skill_profile;

    if (!skillProfile || !skillProfile.approved_at) {
      return error('No skill profile found for this action. Generate and approve one first.', 404);
    }

    // ── Cache-first logic ──
    // Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
    const cachedRow = await lookupCachedProfile(db, actionId, userId, organizationId);
    const evidenceStateIds = await fetchEvidenceStateIds(db, userId, organizationId);
    const learningCompletionCount = await fetchLearningCompletionCount(db, actionId, userId, organizationId);
    const currentHash = computeEvidenceHash(evidenceStateIds, learningCompletionCount);

    const parsedCached = cachedRow ? parseCapabilityProfileStateText(cachedRow.state_text) : null;
    const cacheAction = determineCacheAction(parsedCached, currentHash);

    if (cacheAction === 'hit' && !forceRescore) {
      // Cache hit — return stored profile immediately, no Bedrock call
      console.log(`Cache HIT for capability profile: action=${actionId} user=${userId}`);
      return success(parsedCached.profile);
    }

    if (forceRescore) {
      console.log(`Force RESCORE for capability profile: action=${actionId} user=${userId}`);
    } else if (cacheAction === 'stale') {
      console.log(`Cache STALE for capability profile: action=${actionId} user=${userId} (old hash=${parsedCached.evidenceHash}, new hash=${currentHash})`);
    } else {
      console.log(`Cache MISS for capability profile: action=${actionId} user=${userId}`);
    }

    // ── Compute profile via existing flow ──

    // Resolve user name from organization_members
    const userResult = await db.query(
      `SELECT full_name FROM organization_members WHERE user_id = '${userIdSafe}' AND organization_id = '${orgIdSafe}'`
    );
    const userName = userResult.rows?.[0]?.full_name || 'Unknown';

    // Ensure skill_axis embeddings exist (generates on-the-fly if missing)
    await ensurePerAxisEmbeddings(db, actionId, organizationId, skillProfile);

    // Always use per-axis evidence retrieval flow
    const computedResponse = await handlePerAxisCapability(db, actionId, userId, organizationId, skillProfile, userName, aiConfig);

    // ── Store/update cache after computation ──
    // Only cache successful responses (statusCode 200)
    try {
      const responseBody = JSON.parse(computedResponse.body);
      if (computedResponse.statusCode === 200 && responseBody.data) {
        const stateText = composeCapabilityProfileStateText(actionId, userId, currentHash, responseBody.data);

        if ((cacheAction === 'stale' || forceRescore) && cachedRow) {
          await updateCachedProfile(db, cachedRow.id, stateText);
          console.log(`Cache UPDATED for capability profile: action=${actionId} user=${userId}`);
        } else {
          await storeCachedProfile(db, actionId, userId, organizationId, stateText);
          console.log(`Cache STORED for capability profile: action=${actionId} user=${userId}`);
        }
      }
    } catch (cacheErr) {
      // Cache storage failure should not break the response
      console.error('Failed to store/update capability profile cache:', cacheErr);
    }

    return computedResponse;
  } finally {
    db.release();
  }
}

/**
 * Ensure skill_axis embeddings exist for an action. If missing, generate them
 * on-the-fly via SQS and wait for them to appear in unified_embeddings.
 *
 * Reuses composeAxisEmbeddingSource from axisUtils.js.
 *
 * @param {object} db - database client
 * @param {string} actionId
 * @param {string} organizationId
 * @param {object} skillProfile - the action's approved skill profile
 * @returns {Promise<void>}
 */
async function ensurePerAxisEmbeddings(db, actionId, organizationId, skillProfile) {
  // Check if skill_axis embeddings already exist
  const existingResult = await db.query(
    `SELECT entity_id FROM unified_embeddings
     WHERE entity_type = 'skill_axis'
       AND action_id = $1
       AND organization_id = $2`,
    [actionId, organizationId]
  );

  if (existingResult.rows && existingResult.rows.length > 0) {
    return; // Embeddings already exist
  }

  console.log(`No skill_axis embeddings found for action ${actionId}, generating on-the-fly`);

  // Queue SQS messages for each axis
  const axisEmbeddingPromises = skillProfile.axes.map(axis => {
    const embeddingSource = composeAxisEmbeddingSource(axis, skillProfile.narrative);

    return sqs.send(new SendMessageCommand({
      QueueUrl: EMBEDDINGS_QUEUE_URL,
      MessageBody: JSON.stringify({
        entity_type: 'skill_axis',
        action_id: actionId,
        axis_key: axis.key,
        embedding_source: embeddingSource,
        organization_id: organizationId
      })
    })).then(() => {
      console.log('Queued skill_axis embedding for action:', actionId, 'axis:', axis.key);
    }).catch(err => {
      console.error('Failed to queue skill_axis embedding for action:', actionId, 'axis:', axis.key, err);
    });
  });

  await Promise.all(axisEmbeddingPromises);

  // Poll unified_embeddings with short waits until all axis embeddings appear
  // 4 attempts with increasing waits to allow the embedding pipeline to process
  const expectedCount = skillProfile.axes.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Wait before checking (embeddings pipeline needs time to process)
    await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 3000));

    const checkResult = await db.query(
      `SELECT COUNT(*) as cnt FROM unified_embeddings
       WHERE entity_type = 'skill_axis'
         AND action_id = $1
         AND organization_id = $2`,
      [actionId, organizationId]
    );

    const count = parseInt(checkResult.rows[0].cnt, 10);
    if (count >= expectedCount) {
      console.log(`All ${expectedCount} skill_axis embeddings appeared for action ${actionId} after ${attempt + 1} poll(s)`);
      return;
    }

    console.log(`Waiting for skill_axis embeddings: ${count}/${expectedCount} found (attempt ${attempt + 1}/4)`);
  }

  throw new Error('Skill axis embeddings could not be generated. Please try again.');
}

/**
 * Per-axis evidence retrieval flow.
 * For each axis in the skill profile, runs a vector similarity search against
 * the user's learning-objective-linked states using the axis-specific embedding.
 * Collects top evidence_limit matches per axis with similarity scores, source text, and evidence type.
 * Requirements: 3.1, 3.3, 3.5, 3.9
 */
async function handlePerAxisCapability(db, actionId, userId, organizationId, skillProfile, userName, aiConfig) {
  const actionIdSafe = escapeLiteral(actionId);
  const userIdSafe = escapeLiteral(userId);
  const orgIdSafe = escapeLiteral(organizationId);

  // For each axis, run a per-axis vector similarity search
  const perAxisEvidence = {};
  let totalEvidenceCount = 0;

  for (const axis of skillProfile.axes) {
    try {
      // Per-axis vector search: find top evidence_limit states most similar to this axis embedding.
      // captured_by is the sole eligibility criterion — all user-authored states are included
      // regardless of action assignment or state_links. Prefix exclusions are explicit to match
      // the same pool used by fetchEvidenceStateIds for cache hash computation.
      const axisSearchResult = await db.query(
        `SELECT ue.entity_id, ue.embedding_source, s.state_text,
                (1 - (ue.embedding <=> (SELECT embedding FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1 AND axis_key = $2 LIMIT 1))) as similarity
         FROM unified_embeddings ue
         INNER JOIN states s ON s.id = ue.entity_id
         WHERE ue.entity_type = 'state'
           AND ue.organization_id = '${orgIdSafe}'
           AND s.captured_by = '${userIdSafe}'
           AND s.state_text NOT LIKE '[capability_profile]%'
           AND s.state_text NOT LIKE '[learning_objective]%'
         ORDER BY similarity DESC
         LIMIT ${aiConfig.evidence_limit}`,
        [actionId, axis.key]
      );

      const matches = (axisSearchResult.rows || []).map(row => {
        const stateText = row.state_text || '';
        const enrichedEvidence = determineEvidenceTypeEnriched(stateText);

        return {
          observation_id: row.entity_id,
          text_excerpt: stateText.substring(0, 500),
          similarity_score: Math.round(parseFloat(row.similarity) * 100) / 100,
          evidence_type: enrichedEvidence.type,
          question_type: enrichedEvidence.questionType,
          continuous_score: enrichedEvidence.continuousScore,
          evaluation_status: enrichedEvidence.evaluationStatus,
          source_action_title: '' // Will be resolved below
        };
      });

      // Resolve source action titles for the matched states
      if (matches.length > 0) {
        const matchStateIds = matches.map(m => `'${escapeLiteral(m.observation_id)}'`).join(',');
        const actionTitlesResult = await db.query(
          `SELECT DISTINCT s.id::text as state_id, COALESCE(a.title, '') as action_title
           FROM states s
           LEFT JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'action'
           LEFT JOIN actions a ON a.id = sl.entity_id
           WHERE s.id IN (${matchStateIds})`
        );

        const titleMap = {};
        for (const row of actionTitlesResult.rows) {
          titleMap[row.state_id] = row.action_title;
        }

        for (const match of matches) {
          match.source_action_title = titleMap[match.observation_id] || '';
        }
      }

      perAxisEvidence[axis.key] = matches;
      totalEvidenceCount += matches.length;
    } catch (axisErr) {
      console.error(`Error fetching per-axis evidence for axis ${axis.key} on action ${actionId}:`, axisErr);
      perAxisEvidence[axis.key] = [];
    }
  }

  // Fetch learning completion data
  const learningCompletionData = await fetchLearningCompletionData(db, actionIdSafe, userIdSafe, orgIdSafe, skillProfile);

  // If no evidence at all and no learning data, return zero profile
  if (totalEvidenceCount === 0 && learningCompletionData.length === 0) {
    return success(buildZeroCapabilityProfile(skillProfile, actionId, userId, userName));
  }

  // Send per-axis evidence to Bedrock for scoring with evidence types
  const capabilityResult = await callBedrockForPerAxisCapability(
    skillProfile, perAxisEvidence, userName, learningCompletionData, aiConfig
  );

  // Build response with per-axis evidence and narratives
  const axes = skillProfile.axes.map(skillAxis => {
    const aiAxis = capabilityResult.axes.find(a => a.key === skillAxis.key);
    const level = aiAxis ? Math.round(Math.max(0, Math.min(5, aiAxis.level)) * 10) / 10 : 0;
    const axisEvidence = perAxisEvidence[skillAxis.key] || [];

    return {
      key: skillAxis.key,
      label: skillAxis.label,
      level,
      evidence_count: axisEvidence.length,
      evidence: axisEvidence.slice(0, 5),
      axis_narrative: aiAxis?.axis_narrative || ''
    };
  });

  return success({
    user_id: userId,
    user_name: userName,
    action_id: actionId,
    narrative: capabilityResult.narrative || 'Capability assessment completed.',
    axes,
    total_evidence_count: totalEvidenceCount,
    computed_at: new Date().toISOString()
  });
}



/**
 * Determine evidence type from state text.
 * Quiz completions contain "which was the correct answer" — evidence_type = "quiz".
 * Everything else is an observation — evidence_type = "observation".
 */
function determineEvidenceType(stateText) {
  if (stateText && stateText.toLowerCase().includes('which was the correct answer')) {
    return 'quiz';
  }
  return 'observation';
}

/**
 * Build a zero-score capability profile when no relevant evidence is found.
 * Requirements: 3.8
 */
function buildZeroCapabilityProfile(skillProfile, actionId, userId, userName) {
  return {
    user_id: userId,
    user_name: userName,
    action_id: actionId,
    narrative: 'No relevant evidence found.',
    axes: skillProfile.axes.map(axis => ({
      key: axis.key,
      label: axis.label,
      level: 0.0,
      evidence_count: 0,
      evidence: []
    })),
    total_evidence_count: 0,
    computed_at: new Date().toISOString()
  };
}



/**
 * Call Bedrock Claude to synthesize capability levels from per-axis evidence.
 * Each axis has its own evidence list with evidence types (quiz vs observation).
 * Returns { narrative, axes: [{ key, level, axis_narrative }] }
 */
async function callBedrockForPerAxisCapability(skillProfile, perAxisEvidence, userName, learningCompletionData = [], aiConfig = null) {
  if (!aiConfig) {
    aiConfig = resolveAiConfig(null);
  }
  const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

  const axesDescription = skillProfile.axes.map(a =>
    `- ${a.key} ("${a.label}"): required level ${a.required_level}${a.description ? `\n  Concept: ${a.description}` : ''}`
  ).join('\n');

  // Build per-axis evidence sections
  const perAxisSections = skillProfile.axes.map(axis => {
    const evidence = perAxisEvidence[axis.key] || [];
    if (evidence.length === 0) {
      return `### Axis: ${axis.key} ("${axis.label}")
No evidence found for this axis.`;
    }

    const evidenceLines = evidence.map((e, i) => {
      // Build evidence tag based on question_type, continuous_score, and evaluation_status
      let tag;
      if (e.question_type === 'recognition') {
        tag = '[quiz:recognition]';
      } else if (e.question_type && e.question_type !== 'recognition') {
        if (e.evaluation_status === 'pending') {
          tag = `[quiz:${e.question_type}, pending]`;
        } else if (e.continuous_score != null) {
          tag = `[quiz:${e.question_type}, score:${e.continuous_score}, ${e.evaluation_status || 'sufficient'}]`;
        } else {
          tag = `[quiz:${e.question_type}]`;
        }
      } else if (e.evidence_type === 'observation') {
        tag = '[observation]';
      } else {
        tag = `[${e.evidence_type}]`;
      }

      return `${i + 1}. ${tag} ${e.text_excerpt} (similarity: ${e.similarity_score})${e.source_action_title ? ` | From: "${e.source_action_title}"` : ''}`;
    }).join('\n\n');

    return `### Axis: ${axis.key} ("${axis.label}")
${evidenceLines}`;
  }).join('\n\n');

  // Build learning completion section if data exists
  let learningSection = '';
  if (learningCompletionData.length > 0) {
    const learningLines = learningCompletionData.map(ld => {
      const openFormSummary = ld.openFormCompletions && ld.openFormCompletions.length > 0
        ? ld.openFormCompletions.map(of => `${of.questionType}, score:${of.score}`).join('; ')
        : null;
      const parts = [];
      if (ld.recognitionCount > 0) parts.push(`${ld.recognitionCount} recognition`);
      if (ld.openFormCompletions && ld.openFormCompletions.length > 0) {
        parts.push(`${ld.openFormCompletions.length} open-form [${openFormSummary}]`);
      }
      const typeSummary = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `- Axis "${ld.axisLabel}" (${ld.axisKey}): ${ld.completedObjectives} of ${ld.totalObjectives} objectives completed${typeSummary}.\n  Completed objectives: ${ld.objectiveTexts.join('; ')}`;
    }).join('\n');
    learningSection = `

LEARNING COMPLETION (training results):
${learningLines}

Recognition completions show the learner selected the correct answer from options — engaged exposure, not independent recall. Open-form completions show the learner produced their own reasoning at the depth indicated by the score.
Factor this data into your assessment alongside observation evidence.`;
  }

  const prompt = `You are a skill assessment expert. Analyze the following per-axis evidence for ${userName} and produce a capability assessment relative to the skill profile axes.

SKILL LEVEL SCALE (Bloom's Taxonomy — use decimal scores 0.0-5.0):
  0 = No exposure — no evidence of this skill
  1 = Remember — evidence shows they can recall facts and follow documented procedures
  2 = Understand — evidence shows they can explain why, not just how
  3 = Apply — evidence shows they can use knowledge in new situations without guidance
  4 = Analyze — evidence shows they can break down problems, evaluate tradeoffs
  5 = Create — evidence shows they can innovate, teach others, set standards
Use decimal values (e.g., 1.3, 2.7) to reflect partial progress between levels.

SKILL PROFILE:
${skillProfile.narrative}

AXES (each has a required level on the 0-5 Bloom's scale):
${axesDescription}

EVIDENCE TYPE INTERPRETATION:
- "recognition" (quiz): Multiple-choice correct answer. This is engaged exposure — the learner selected from options, not independent recall. Score recognition-only axes in the 0.3–0.7 range.
- "bridging" (quiz): Open-ended connection to action context. Demonstrates level 1 completion.
- "self_explanation" (quiz, score: 2.4): Open-form explanation. Score indicates demonstrated depth.
- "application" (quiz, score: 3.1): Scenario-based transfer. Score indicates demonstrated depth.
- "analysis" (quiz, score: 4.0): Tradeoff evaluation. Score indicates demonstrated depth.
- "synthesis" (quiz, score: 4.8): Design/teaching response. Score indicates demonstrated depth.
- "observation": Field observation. Bloom's level varies based on content.
- "pending": Open-form response awaiting evaluation. Include as evidence but note evaluation is in progress.

PER-AXIS EVIDENCE (each axis has its own evidence, sorted by similarity):
${perAxisSections}
${learningSection}

ASSESSMENT GUIDELINES:
- Score each axis as a DECIMAL from 0.0 to 5.0 using the Bloom's scale above. Use values like 1.3 or 2.7 to reflect partial progress between levels.
- Use the evidence type and continuous score to inform your scoring: recognition evidence guarantees at least level 1, open-form evidence with a score directly indicates demonstrated depth, observation evidence requires judgment based on text content.
- Evidence marked "pending" should be included but weighted less — evaluation is still in progress.
- Consider the similarity score — higher similarity means the evidence is more directly relevant to the axis.
- A person with no evidence and no learning for an axis should score 0.
- Be fair and evidence-based. Do not infer skills not demonstrated in the evidence.
- For each axis, write a brief narrative explaining what evidence supports the score and where the person's knowledge transfers from.

Produce a JSON object with:
1. "narrative": A 2-4 sentence overall assessment of ${userName}'s demonstrated capabilities. Be specific about strengths and gaps.
2. "axes": An array with one entry per skill axis, each containing:
   - "key": The axis key (must match exactly)
   - "level": A DECIMAL from 0.0 to 5.0 representing demonstrated capability on the Bloom's scale
   - "axis_narrative": A 1-2 sentence explanation of what evidence supports this score and where knowledge transfers from

Respond with ONLY the JSON object, no markdown formatting, no code fences, no explanation.`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2000,
    temperature: aiConfig.quiz_temperature,
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
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('Failed to parse Bedrock per-axis capability response:', text);
    return {
      narrative: 'Capability assessment could not be fully synthesized from available evidence.',
      axes: skillProfile.axes.map(a => ({ key: a.key, level: 0, axis_narrative: '' }))
    };
  }
}

/**
 * GET /api/capability/:actionId/organization
 * Compute organization-level capability profile for an action.
 * Requirements: 6.1, 6.2, 6.3, 6.6
 */
async function handleOrganizationCapability(actionId, organizationId, forceRescore = false) {
  const db = await getDbClient();
  try {
    const aiConfig = await fetchAiConfig(db, organizationId);
    const actionIdSafe = escapeLiteral(actionId);
    const orgIdSafe = escapeLiteral(organizationId);

    // 1. Fetch action's skill_profile JSON; return 404 if no approved profile
    const actionResult = await db.query(
      `SELECT id, skill_profile FROM actions WHERE id = '${actionIdSafe}' AND organization_id = '${orgIdSafe}'`
    );

    if (!actionResult.rows || actionResult.rows.length === 0) {
      return error('Action not found', 404);
    }

    const action = actionResult.rows[0];
    const skillProfile = action.skill_profile;

    if (!skillProfile || !skillProfile.approved_at) {
      return error('No skill profile found for this action. Generate and approve one first.', 404);
    }

    // ── Cache-first logic ──
    // Requirements: 4.1, 4.2, 4.3
    const cachedRow = await lookupCachedProfile(db, actionId, 'organization', organizationId);
    const evidenceStateIds = await fetchOrgEvidenceStateIds(db, organizationId);
    const learningCompletionCount = await fetchOrgLearningCompletionCount(db, actionId, organizationId);
    const currentHash = computeEvidenceHash(evidenceStateIds, learningCompletionCount);

    const parsedCached = cachedRow ? parseCapabilityProfileStateText(cachedRow.state_text) : null;
    const cacheAction = determineCacheAction(parsedCached, currentHash);

    if (cacheAction === 'hit' && !forceRescore) {
      // Cache hit — return stored profile immediately, no Bedrock call
      console.log(`Cache HIT for organization capability profile: action=${actionId}`);
      return success(parsedCached.profile);
    }

    if (forceRescore) {
      console.log(`Force RESCORE for organization capability profile: action=${actionId}`);
    } else if (cacheAction === 'stale') {
      console.log(`Cache STALE for organization capability profile: action=${actionId} (old hash=${parsedCached.evidenceHash}, new hash=${currentHash})`);
    } else {
      console.log(`Cache MISS for organization capability profile: action=${actionId}`);
    }

    // ── Compute profile via per-axis evidence retrieval ──

    // Ensure skill_axis embeddings exist (generates on-the-fly if missing)
    await ensurePerAxisEmbeddings(db, actionId, organizationId, skillProfile);

    // Per-axis evidence retrieval: same pattern as handlePerAxisCapability but without user scoping
    const perAxisEvidence = {};
    let totalEvidenceCount = 0;

    for (const axis of skillProfile.axes) {
      try {
        // Per-axis vector search: find top evidence_limit states most similar to this axis embedding (org-wide, no user filter)
        // INNER JOIN state_links restricts to learning-objective-linked states only (Req 3.2, 3.4)
        const axisSearchResult = await db.query(
          `SELECT ue.entity_id, ue.embedding_source, s.state_text,
                  (1 - (ue.embedding <=> (SELECT embedding FROM unified_embeddings WHERE entity_type = 'skill_axis' AND action_id = $1 AND axis_key = $2 LIMIT 1))) as similarity
           FROM unified_embeddings ue
           INNER JOIN states s ON s.id = ue.entity_id
           INNER JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'learning_objective'
           WHERE ue.entity_type = 'state'
             AND ue.organization_id = '${orgIdSafe}'
           ORDER BY similarity DESC
           LIMIT ${aiConfig.evidence_limit}`,
          [actionId, axis.key]
        );

        const matches = (axisSearchResult.rows || []).map(row => {
          const stateText = row.state_text || '';
          const enrichedEvidence = determineEvidenceTypeEnriched(stateText);

          return {
            observation_id: row.entity_id,
            text_excerpt: stateText.substring(0, 500),
            similarity_score: Math.round(parseFloat(row.similarity) * 100) / 100,
            evidence_type: enrichedEvidence.type,
            question_type: enrichedEvidence.questionType,
            continuous_score: enrichedEvidence.continuousScore,
            evaluation_status: enrichedEvidence.evaluationStatus,
            source_action_title: ''
          };
        });

        // Resolve source action titles for the matched states
        if (matches.length > 0) {
          const matchStateIds = matches.map(m => `'${escapeLiteral(m.observation_id)}'`).join(',');
          const actionTitlesResult = await db.query(
            `SELECT DISTINCT s.id::text as state_id, COALESCE(a.title, '') as action_title
             FROM states s
             LEFT JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'action'
             LEFT JOIN actions a ON a.id = sl.entity_id
             WHERE s.id IN (${matchStateIds})`
          );

          const titleMap = {};
          for (const row of actionTitlesResult.rows) {
            titleMap[row.state_id] = row.action_title;
          }

          for (const match of matches) {
            match.source_action_title = titleMap[match.observation_id] || '';
          }
        }

        perAxisEvidence[axis.key] = matches;
        totalEvidenceCount += matches.length;
      } catch (axisErr) {
        console.error(`Error fetching per-axis evidence for axis ${axis.key} on action ${actionId}:`, axisErr);
        perAxisEvidence[axis.key] = [];
      }
    }

    // Learning completions are user-scoped; pass empty array for org-level
    const learningCompletionData = [];

    // If no evidence at all, return zero profile
    if (totalEvidenceCount === 0) {
      return success(buildZeroCapabilityProfile(skillProfile, actionId, 'organization', 'Organization'));
    }

    // Send per-axis evidence to Bedrock for scoring with evidence types
    const capabilityResult = await callBedrockForPerAxisCapability(
      skillProfile, perAxisEvidence, 'Organization', learningCompletionData, aiConfig
    );

    // Build response with per-axis evidence and narratives
    const axes = skillProfile.axes.map(skillAxis => {
      const aiAxis = capabilityResult.axes.find(a => a.key === skillAxis.key);
      const level = aiAxis ? Math.round(Math.max(0, Math.min(5, aiAxis.level)) * 10) / 10 : 0;
      const axisEvidence = perAxisEvidence[skillAxis.key] || [];

      return {
        key: skillAxis.key,
        label: skillAxis.label,
        level,
        evidence_count: axisEvidence.length,
        evidence: axisEvidence.slice(0, 5),
        axis_narrative: aiAxis?.axis_narrative || ''
      };
    });

    const computedResponse = success({
      user_id: 'organization',
      user_name: 'Organization',
      action_id: actionId,
      narrative: capabilityResult.narrative || 'Organization capability assessment completed.',
      axes,
      total_evidence_count: totalEvidenceCount,
      computed_at: new Date().toISOString()
    });

    // ── Store/update cache after computation ──
    // Only cache successful responses (statusCode 200)
    try {
      const responseBody = JSON.parse(computedResponse.body);
      if (computedResponse.statusCode === 200 && responseBody.data) {
        const stateText = composeCapabilityProfileStateText(actionId, 'organization', currentHash, responseBody.data);

        if ((cacheAction === 'stale' || forceRescore) && cachedRow) {
          await updateCachedProfile(db, cachedRow.id, stateText);
          console.log(`Cache UPDATED for organization capability profile: action=${actionId}`);
        } else {
          await storeCachedProfile(db, actionId, 'organization', organizationId, stateText);
          console.log(`Cache STORED for organization capability profile: action=${actionId}`);
        }
      }
    } catch (cacheErr) {
      // Cache storage failure should not break the response
      console.error('Failed to store/update organization capability profile cache:', cacheErr);
    }

    return computedResponse;
  } finally {
    db.release();
  }
}

/**
 * Compute recency weight for an observation based on its capture date.
 * 0-30 days: 1.0, 30-90 days: 0.7, 90-180 days: 0.4, >180 days: 0.2
 * Requirements: 3.6
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
 * Detect whether a gap exists between requirement and capability levels.
 * Gap is detected when requirement - capability > threshold.
 * Requirements: 4.5
 */
function detectGap(requirementLevel, capabilityLevel, threshold = 1) {
  return (requirementLevel - capabilityLevel) > threshold;
}

/**
 * Build the vector similarity search SQL query for retrieving observation evidence.
 * Extracted from the inline SQL in handleIndividualCapability and handleOrganizationCapability.
 * Requirements: 3.6, 4.5
 */
function buildEvidenceQuery(skillProfileEmbedding, organizationId) {
  const OBSERVATION_LIMIT = 50;

  return `SELECT
        entity_id,
        embedding_source,
        (1 - (embedding <=> '${skillProfileEmbedding}'::vector)) as similarity
      FROM unified_embeddings
      WHERE entity_type = 'state'
        AND organization_id = '${organizationId}'
      ORDER BY embedding <=> '${skillProfileEmbedding}'::vector
      LIMIT ${OBSERVATION_LIMIT}`;
}

module.exports.computeRecencyWeight = computeRecencyWeight;
module.exports.detectGap = detectGap;
module.exports.determineEvidenceType = determineEvidenceType;

/**
 * Fetch learning completion data for a user on an action.
 * Returns an array of { axisKey, axisLabel, totalObjectives, completedObjectives, objectiveTexts }
 * for each axis that has learning objectives.
 *
 * Learning objectives are states with [learning_objective] prefix linked to the action.
 * Completion is determined by knowledge states linked to the objective that contain "correct answer".
 */
async function fetchLearningCompletionData(db, actionIdSafe, userIdSafe, orgIdSafe, skillProfile) {
  try {
    // Fetch all learning objectives for this user on this action
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
      return [];
    }

    // Parse objectives and group by axis
    const objectivesByAxis = {};
    const allObjectiveIds = [];
    for (const row of objectivesResult.rows) {
      const match = row.state_text.match(
        /^\[learning_objective\] axis=(\S+) action=\S+ user=\S+ \| (.+)$/
      );
      if (match) {
        const axisKey = match[1];
        const objectiveText = match[2];
        if (!objectivesByAxis[axisKey]) {
          objectivesByAxis[axisKey] = [];
        }
        objectivesByAxis[axisKey].push({ id: row.id, text: objectiveText });
        allObjectiveIds.push(row.id);
      }
    }

    if (allObjectiveIds.length === 0) return [];

    // Fetch knowledge states to determine which objectives are completed
    const objectiveIdsList = allObjectiveIds.map(id => `'${escapeLiteral(id)}'`).join(',');
    const knowledgeResult = await db.query(
      `SELECT sl.entity_id as objective_id, s.state_text
       FROM states s
       INNER JOIN state_links sl ON sl.state_id = s.id
       WHERE sl.entity_type = 'learning_objective'
         AND sl.entity_id IN (${objectiveIdsList})
         AND s.organization_id = '${orgIdSafe}'`
    );

    // Build set of completed objective IDs and classify each completion type.
    // An objective can have multiple knowledge states; we take the first
    // classification we find (recognition, open-form, or demonstration).
    const completedObjectiveIds = new Set();
    // Maps objective_id -> { type: 'recognition' | 'open_form' | 'demonstration', questionType?, score? }
    const objectiveClassification = {};
    for (const row of knowledgeResult.rows) {
      // Skip if already classified
      if (completedObjectiveIds.has(row.objective_id)) continue;

      const enriched = determineEvidenceTypeEnriched(row.state_text);

      if (enriched.type === 'quiz' && enriched.questionType === 'recognition') {
        completedObjectiveIds.add(row.objective_id);
        objectiveClassification[row.objective_id] = { type: 'recognition' };
      } else if (enriched.type === 'quiz' && enriched.questionType !== 'recognition' && enriched.questionType !== null) {
        completedObjectiveIds.add(row.objective_id);
        objectiveClassification[row.objective_id] = {
          type: 'open_form',
          questionType: enriched.questionType,
          score: enriched.continuousScore
        };
      } else if (row.state_text.startsWith('Demonstrated learning objective')) {
        // Demonstration completion — counts as completed but neither recognition nor open-form
        completedObjectiveIds.add(row.objective_id);
        objectiveClassification[row.objective_id] = { type: 'demonstration' };
      }
    }

    // Build per-axis learning completion data with type-aware counts
    const result = [];
    for (const [axisKey, objectives] of Object.entries(objectivesByAxis)) {
      const skillAxis = skillProfile.axes.find(a => a.key === axisKey);
      const completedObjectives = objectives.filter(o => completedObjectiveIds.has(o.id));

      let recognitionCount = 0;
      const openFormCompletions = [];
      for (const obj of completedObjectives) {
        const classification = objectiveClassification[obj.id];
        if (classification && classification.type === 'recognition') {
          recognitionCount++;
        } else if (classification && classification.type === 'open_form') {
          openFormCompletions.push({
            questionType: classification.questionType,
            score: classification.score
          });
        }
        // demonstration completions are counted in completedObjectives but not in either sub-category
      }

      result.push({
        axisKey,
        axisLabel: skillAxis?.label || axisKey,
        totalObjectives: objectives.length,
        completedObjectives: completedObjectives.length,
        objectiveTexts: completedObjectives.map(o => o.text),
        recognitionCount,
        openFormCompletions
      });
    }

    return result;
  } catch (err) {
    console.error('Error fetching learning completion data:', err);
    return [];
  }
}
module.exports.buildEvidenceQuery = buildEvidenceQuery;
module.exports.buildZeroCapabilityProfile = buildZeroCapabilityProfile;
module.exports.ensurePerAxisEmbeddings = ensurePerAxisEmbeddings;

/**
 * Fetch evidence state IDs for a user in an organization.
 * Returns a sorted array of state ID strings captured by this user,
 * excluding [capability_profile] and [learning_objective] prefixed states.
 * Used for computing the deterministic evidence hash.
 *
 * @param {object} db - database connection pool client
 * @param {string} userId - the user whose evidence to fetch
 * @param {string} orgId - the organization ID
 * @returns {Promise<string[]>} - sorted array of state ID strings
 */
async function fetchEvidenceStateIds(db, userId, orgId) {
  const userIdSafe = escapeLiteral(userId);
  const orgIdSafe = escapeLiteral(orgId);

  const result = await db.query(
    `SELECT s.id::text
     FROM states s
     WHERE s.captured_by = '${userIdSafe}'
       AND s.organization_id = '${orgIdSafe}'
       AND s.state_text NOT LIKE '[capability_profile]%'
       AND s.state_text NOT LIKE '[learning_objective]%'
     ORDER BY s.id`
  );

  return result.rows.map(row => row.id);
}

/**
 * Count completed learning objectives for a user on a specific action.
 * A learning objective is "completed" when there is a knowledge state containing
 * "which was the correct answer" linked to a learning objective for the action.
 *
 * @param {object} db - database connection pool client
 * @param {string} actionId - the action ID
 * @param {string} userId - the user ID
 * @param {string} orgId - the organization ID
 * @returns {Promise<number>} - count of completed learning objectives
 */
async function fetchLearningCompletionCount(db, actionId, userId, orgId) {
  const actionIdSafe = escapeLiteral(actionId);
  const userIdSafe = escapeLiteral(userId);
  const orgIdSafe = escapeLiteral(orgId);

  const result = await db.query(
    `SELECT COUNT(*) as completion_count
     FROM states s
     INNER JOIN state_links sl ON sl.state_id = s.id
     WHERE sl.entity_type = 'learning_objective'
       AND sl.entity_id IN (
         SELECT s2.id FROM states s2
         INNER JOIN state_links sl2 ON sl2.state_id = s2.id
         WHERE sl2.entity_type = 'action' AND sl2.entity_id = '${actionIdSafe}'
           AND s2.state_text LIKE '[learning_objective]%'
           AND s2.state_text LIKE '%user=' || '${userIdSafe}' || '%'
       )
       AND s.state_text LIKE '%which was the correct answer%'
       AND s.organization_id = '${orgIdSafe}'`
  );

  return parseInt(result.rows[0].completion_count, 10) || 0;
}

/**
 * Fetch ALL evidence state IDs in an organization (no user filter).
 * Used for computing the organization-level evidence hash.
 * Returns a sorted array of state ID strings, excluding [capability_profile]
 * and [learning_objective] prefixed states.
 *
 * @param {object} db - database connection pool client
 * @param {string} orgId - the organization ID
 * @returns {Promise<string[]>} - sorted array of state ID strings
 */
async function fetchOrgEvidenceStateIds(db, orgId) {
  const orgIdSafe = escapeLiteral(orgId);

  const result = await db.query(
    `SELECT s.id::text
     FROM states s
     WHERE s.organization_id = '${orgIdSafe}'
       AND s.state_text NOT LIKE '[capability_profile]%'
       AND s.state_text NOT LIKE '[learning_objective]%'
     ORDER BY s.id`
  );

  return result.rows.map(row => row.id);
}

/**
 * Count completed learning objectives across ALL users for a specific action.
 * Used for computing the organization-level evidence hash.
 * Sums completions across all users (no user filter on the learning objective states).
 *
 * @param {object} db - database connection pool client
 * @param {string} actionId - the action ID
 * @param {string} orgId - the organization ID
 * @returns {Promise<number>} - count of completed learning objectives across all users
 */
async function fetchOrgLearningCompletionCount(db, actionId, orgId) {
  const actionIdSafe = escapeLiteral(actionId);
  const orgIdSafe = escapeLiteral(orgId);

  const result = await db.query(
    `SELECT COUNT(*) as completion_count
     FROM states s
     INNER JOIN state_links sl ON sl.state_id = s.id
     WHERE sl.entity_type = 'learning_objective'
       AND sl.entity_id IN (
         SELECT s2.id FROM states s2
         INNER JOIN state_links sl2 ON sl2.state_id = s2.id
         WHERE sl2.entity_type = 'action' AND sl2.entity_id = '${actionIdSafe}'
           AND s2.state_text LIKE '[learning_objective]%'
       )
       AND s.state_text LIKE '%which was the correct answer%'
       AND s.organization_id = '${orgIdSafe}'`
  );

  return parseInt(result.rows[0].completion_count, 10) || 0;
}

module.exports.fetchEvidenceStateIds = fetchEvidenceStateIds;
module.exports.fetchLearningCompletionCount = fetchLearningCompletionCount;
module.exports.fetchOrgEvidenceStateIds = fetchOrgEvidenceStateIds;
module.exports.fetchOrgLearningCompletionCount = fetchOrgLearningCompletionCount;

/**
 * Look up a cached capability profile state for a given action + user + org.
 * Queries states + state_links for an existing [capability_profile] state
 * matching captured_by = userId and entity_type = 'capability_profile', entity_id = actionId.
 *
 * @param {object} db - database connection pool client
 * @param {string} actionId - the action ID
 * @param {string} userId - the user ID (or 'organization' for org profiles)
 * @param {string} orgId - the organization ID
 * @returns {Promise<{ id: string, state_text: string } | null>} - cached state row or null
 */
async function lookupCachedProfile(db, actionId, userId, orgId) {
  const actionIdSafe = escapeLiteral(actionId);
  const userIdSafe = escapeLiteral(userId);
  const orgIdSafe = escapeLiteral(orgId);

  const result = await db.query(
    `SELECT s.id, s.state_text
     FROM states s
     INNER JOIN state_links sl ON sl.state_id = s.id
     WHERE sl.entity_type = 'capability_profile'
       AND sl.entity_id = '${actionIdSafe}'
       AND s.captured_by = '${userIdSafe}'
       AND s.state_text LIKE '[capability_profile]%'
       AND s.organization_id = '${orgIdSafe}'
     LIMIT 1`
  );

  if (!result.rows || result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Store a new cached capability profile state and link it to the action.
 * INSERTs a new state row and a state_link with entity_type = 'capability_profile'.
 *
 * @param {object} db - database connection pool client
 * @param {string} actionId - the action ID to link to
 * @param {string} userId - the user ID (or 'organization' for org profiles)
 * @param {string} orgId - the organization ID
 * @param {string} stateText - the composed [capability_profile] state text
 * @returns {Promise<string>} - the new state ID
 */
async function storeCachedProfile(db, actionId, userId, orgId, stateText) {
  const actionIdSafe = escapeLiteral(actionId);
  const userIdSafe = escapeLiteral(userId);
  const orgIdSafe = escapeLiteral(orgId);
  const stateTextSafe = escapeLiteral(stateText);

  const insertResult = await db.query(
    `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
     VALUES ('${orgIdSafe}', '${stateTextSafe}', '${userIdSafe}', NOW())
     RETURNING id`
  );

  const stateId = insertResult.rows[0].id;
  const stateIdSafe = escapeLiteral(stateId);

  await db.query(
    `INSERT INTO state_links (state_id, entity_type, entity_id)
     VALUES ('${stateIdSafe}', 'capability_profile', '${actionIdSafe}')`
  );

  return stateId;
}

/**
 * Update an existing cached capability profile state's text and timestamp.
 * Used when the cache is stale and needs to be refreshed with a new profile.
 *
 * @param {object} db - database connection pool client
 * @param {string} existingStateId - the state ID to update
 * @param {string} stateText - the new composed [capability_profile] state text
 * @returns {Promise<void>}
 */
async function updateCachedProfile(db, existingStateId, stateText) {
  const existingStateIdSafe = escapeLiteral(existingStateId);
  const stateTextSafe = escapeLiteral(stateText);

  await db.query(
    `UPDATE states
     SET state_text = '${stateTextSafe}', updated_at = NOW()
     WHERE id = '${existingStateIdSafe}'`
  );
}

module.exports.lookupCachedProfile = lookupCachedProfile;
module.exports.storeCachedProfile = storeCachedProfile;
module.exports.updateCachedProfile = updateCachedProfile;
