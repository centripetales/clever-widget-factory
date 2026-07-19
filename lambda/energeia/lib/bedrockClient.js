const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-west-2'
});

const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const VALID_BOUNDARY_TYPES = new Set(['internal', 'external']);

/** Default weights: pure oikonomia (maintenance/exploitation) */
const DEFAULT_WEIGHTS = { dynamis: 0, oikonomia: 1, techne: 0 };

/**
 * Validate and normalize an energy weights object from Claude.
 * - Returns DEFAULT_WEIGHTS if input is missing, non-object, or all-zero.
 * - Clamps negative values to 0 (Req 1.8).
 * - Normalizes so values sum to 1.0 (Req 1.7).
 *
 * @param {unknown} raw - Raw value from Claude's response
 * @returns {{ dynamis: number, oikonomia: number, techne: number }}
 */
function validateAndNormalizeWeights(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WEIGHTS };

  const d = Math.max(0, Number(raw.dynamis)   || 0);
  const o = Math.max(0, Number(raw.oikonomia) || 0);
  const t = Math.max(0, Number(raw.techne)    || 0);
  const sum = d + o + t;

  // All-zero or near-zero — use default (Req 1.6)
  if (sum < 0.01) return { ...DEFAULT_WEIGHTS };

  return {
    dynamis:   d / sum,
    oikonomia: o / sum,
    techne:    t / sum,
  };
}

/**
 * Build the prompt for a single cluster.
 * Returns cluster title, description, boundary_type, and per-action energy weight
 * vectors in a single JSON response.
 *
 * @param {string[]} actionTitles - All deduplicated action titles in the cluster
 * @param {number} clusterId
 * @returns {string}
 */
function buildClaudePrompt(actionTitles, clusterId) {
  const textList = actionTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');

  // Build example map with weight objects for the first two titles
  const exampleEntries = actionTitles.slice(0, 2).map(t =>
    `    "${t}": { "dynamis": 0.2, "oikonomia": 0.7, "techne": 0.1 }`
  );
  const exampleMap = `{\n${exampleEntries.join(',\n')}\n  }`;

  return (
    `You are analyzing a cluster of organizational actions to infer the emergent role or theme they represent.\n\n` +
    `Here are all ${actionTitles.length} actions in cluster ${clusterId}:\n${textList}\n\n` +
    `Identify the common thread across ALL of these actions — not just the most prominent ones.\n` +
    `If the actions are diverse, name the broader organizational function they collectively serve.\n\n` +
    `Also classify the cluster boundary:\n` +
    `- "internal" if it represents core operations of the organization (e.g. Poultry Care, Agriculture, Food Production, Equipment Maintenance)\n` +
    `- "external" if it represents interactions with outside entities (e.g. Compliance, Government, Vendors, Purchases, Reporting, Certification)\n\n` +
    `Also assign each action an energy weight distribution across three Aristotelian types (with RL equivalent):\n` +
    `- "dynamis"   — Exploration. Activities that expand capability, revenue, or reach. The Spark.\n` +
    `- "oikonomia" — Exploitation. Activities that sustain existing operations. The Hearth.\n` +
    `- "techne"    — Meta-Policy. Activities that improve how work is done. The Tool.\n\n` +
    `For each action, return a weight object { "dynamis": 0.0–1.0, "oikonomia": 0.0–1.0, "techne": 0.0–1.0 }\n` +
    `where the three values sum to 1.0. Most actions will have one dominant type but may have meaningful\n` +
    `secondary components (e.g. a training activity might be 0.6 techne, 0.3 dynamis, 0.1 oikonomia).\n\n` +
    `Respond with ONLY a JSON object (no markdown, no explanation) in this exact format:\n` +
    `{\n` +
    `  "title": "<2-4 word role title>",\n` +
    `  "description": "<one sentence describing what this cluster does>",\n` +
    `  "boundary_type": "internal" or "external",\n` +
    `  "action_energy_map": ${exampleMap}\n` +
    `}\n\n` +
    `The action_energy_map must contain an entry for every action title listed above.\n` +
    `Each entry must be a weight object with "dynamis", "oikonomia", and "techne" keys summing to 1.0.\n` +
    `Examples of good titles: "Farm Operations", "Compliance & Admin", "Food Production", "Infrastructure Planning".\n` +
    `Avoid naming the cluster after a single specific task — the title should fit all actions in the list.`
  );
}

/**
 * Label a single cluster via Claude. Returns the result or a fallback on error.
 */
async function labelCluster(cluster) {
  try {
    const prompt = buildClaudePrompt(cluster.actionTitles, cluster.id);

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 768,
      messages: [{ role: 'user', content: prompt }]
    });

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(body)
    });

    const response = await client.send(command);
    const responseText = Buffer.from(response.body).toString('utf-8');
    const parsed = JSON.parse(responseText);

    const text = parsed.content?.[0]?.text || '';
    // Strip markdown code fences if Claude wraps the JSON in them
    const cleanedText = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const label = JSON.parse(cleanedText);

    console.log(`[bedrockClient] Cluster ${cluster.id}: Claude returned ${Object.keys(label.action_energy_map || {}).length} energy map entries for ${cluster.actionTitles.length} action titles`);

    const boundaryType = VALID_BOUNDARY_TYPES.has(label.boundary_type)
      ? label.boundary_type
      : 'internal';

    const actionEnergyMap = {};
    let matchCount = 0;
    for (const title of cluster.actionTitles) {
      const raw = label.action_energy_map?.[title];
      if (raw) matchCount++;
      actionEnergyMap[title] = validateAndNormalizeWeights(raw);
    }
    console.log(`[bedrockClient] Cluster ${cluster.id}: ${matchCount}/${cluster.actionTitles.length} titles matched in action_energy_map`);
    if (matchCount === 0 && cluster.actionTitles.length > 0) {
      console.log(`[bedrockClient] Cluster ${cluster.id}: Expected keys sample:`, cluster.actionTitles.slice(0, 3));
      console.log(`[bedrockClient] Cluster ${cluster.id}: Got keys sample:`, Object.keys(label.action_energy_map || {}).slice(0, 3));
    }

    return {
      id: cluster.id,
      title: label.title || `Cluster ${cluster.id}`,
      description: label.description || 'A group of related actions.',
      boundary_type: boundaryType,
      action_energy_map: actionEnergyMap,
    };
  } catch (err) {
    console.error(`[bedrockClient] Failed to label cluster ${cluster.id}:`, err.message);
    const actionEnergyMap = {};
    for (const title of cluster.actionTitles) {
      actionEnergyMap[title] = { ...DEFAULT_WEIGHTS };
    }
    return {
      id: cluster.id,
      title: `Cluster ${cluster.id}`,
      description: 'A group of related actions.',
      boundary_type: 'internal',
      action_energy_map: actionEnergyMap,
    };
  }
}

/**
 * Label clusters using Claude via AWS Bedrock.
 * All clusters are labeled concurrently via Promise.all to stay within
 * the API Gateway 29s timeout.
 *
 * @param {Array<{ id: number, actionTitles: string[] }>} clusters
 * @returns {Promise<Array<{
 *   id: number,
 *   title: string,
 *   description: string,
 *   boundary_type: 'internal' | 'external',
 *   action_energy_map: Record<string, { dynamis: number, oikonomia: number, techne: number }>
 * }>>}
 */
async function labelClusters(clusters) {
  return Promise.all(clusters.map(labelCluster));
}

module.exports = { labelClusters, buildClaudePrompt, validateAndNormalizeWeights };
