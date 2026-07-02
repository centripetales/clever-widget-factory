/**
 * Embedding Source Composition Functions
 * 
 * This module provides functions to compose natural language descriptions
 * from entity fields for embedding generation. Each entity type has specific
 * logic for combining relevant fields into a single text string.
 * 
 * The composed text is used as the embedding_source for generating vector
 * embeddings via AWS Bedrock Titan models.
 * 
 * Design principles:
 * - Include fields that provide semantic meaning
 * - Avoid categorical labels or codes
 * - Filter out null/undefined/empty values
 * - Join fields with '. ' for natural language flow
 */

/**
 * Compose embedding source for a part
 * 
 * Parts include name, description (physical characteristics), and policy
 * (use case, benefits, operational context).
 * 
 * @param {Object} part - Part entity
 * @param {string} part.name - Part name
 * @param {string} [part.description] - Physical/anatomical description
 * @param {string} [part.policy] - Use case, benefits, operational context
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composePartEmbeddingSource({
 *   name: 'Banana Wine',
 *   description: 'Fermented banana beverage',
 *   policy: 'Rich in potassium and B vitamins. May support heart health.'
 * })
 * // Returns: "Banana Wine. Fermented banana beverage. Rich in potassium and B vitamins. May support heart health."
 */
function composePartEmbeddingSource(part) {
  const parts = [
    part.name,
    part.description,
    part.policy
  ].filter(Boolean);
  
  return parts.join('. ');
}

/**
 * Compose embedding source for a tool
 * 
 * Tools include name and description (physical characteristics and usage).
 * 
 * @param {Object} tool - Tool entity
 * @param {string} tool.name - Tool name
 * @param {string} [tool.description] - Tool description
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composeToolEmbeddingSource({
 *   name: 'Hand Drill',
 *   description: 'Manual drilling tool with adjustable chuck'
 * })
 * // Returns: "Hand Drill. Manual drilling tool with adjustable chuck"
 */
function composeToolEmbeddingSource(tool) {
  const parts = [
    tool.name,
    tool.description
  ].filter(Boolean);
  
  return parts.join('. ');
}

/**
 * Compose embedding source for an action
 * 
 * Actions include description, evidence_description (what was done),
 * policy (lessons learned, best practices), and observations (field notes).
 * 
 * @param {Object} action - Action entity
 * @param {string} [action.description] - Action description
 * @param {string} [action.evidence_description] - Evidence of what was done
 * @param {string} [action.policy] - Lessons learned, best practices
 * @param {string} [action.observations] - Field observations
 * @param {string} [action.expected_state] - Expected outcome (S') for the action
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composeActionEmbeddingSource({
 *   description: 'Applied compost to banana plants',
 *   evidence_description: 'Spread 2 inches of compost around base',
 *   policy: 'Organic matter improves soil structure',
 *   observations: 'Plants showed improved vigor after 2 weeks',
 *   expected_state: 'Healthy banana plants with improved soil nutrients'
 * })
 * // Returns: "Applied compost to banana plants. Spread 2 inches of compost around base. Organic matter improves soil structure. Plants showed improved vigor after 2 weeks. Healthy banana plants with improved soil nutrients"
 */
function composeActionEmbeddingSource(action) {
  const parts = [
    action.title,
    action.description,
    action.evidence_description,
    action.policy,
    action.observations,
    action.expected_state
  ].filter(Boolean);
  
  return parts.join('. ');
}

/**
 * Compose embedding source for an issue
 * 
 * Issues include title, description, and resolution_notes.
 * 
 * @param {Object} issue - Issue entity
 * @param {string} [issue.title] - Issue title
 * @param {string} [issue.description] - Issue description
 * @param {string} [issue.resolution_notes] - Resolution notes
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composeIssueEmbeddingSource({
 *   title: 'Banana wine fermentation stopped',
 *   description: 'Fermentation ceased after 3 days',
 *   resolution_notes: 'Added more yeast and increased temperature'
 * })
 * // Returns: "Banana wine fermentation stopped. Fermentation ceased after 3 days. Added more yeast and increased temperature"
 */
function composeIssueEmbeddingSource(issue) {
  const parts = [
    issue.title,
    issue.description,
    issue.resolution_notes
  ].filter(Boolean);
  
  return parts.join('. ');
}

/**
 * Compose embedding source for a policy
 * 
 * Policies include title and description_text (policy content).
 * 
 * @param {Object} policy - Policy entity
 * @param {string} [policy.title] - Policy title
 * @param {string} [policy.description_text] - Policy description/content
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composePolicyEmbeddingSource({
 *   title: 'Organic Pest Control',
 *   description_text: 'Use only natural pesticides like neem oil'
 * })
 * // Returns: "Organic Pest Control. Use only natural pesticides like neem oil"
 */
function composePolicyEmbeddingSource(policy) {
  const parts = [
    policy.title,
    policy.description_text
  ].filter(Boolean);
  
  return parts.join('. ');
}

/**
 * Compose embedding source for a state (observation)
 * 
 * States are composed from linked entity names, observation text,
 * photo descriptions, and metric snapshot values. Unlike other compose
 * functions that receive entity data directly, this function receives
 * pre-resolved data: linked entity names (resolved from state_links),
 * photo descriptions, and metric snapshots with display names and units.
 * 
 * @param {Object} state - Pre-resolved state data
 * @param {string[]} [state.entity_names] - Resolved names from linked entities
 * @param {string} [state.state_text] - Observation text
 * @param {string[]} [state.photo_descriptions] - Photo descriptions (nulls pre-filtered)
 * @param {Array<{display_name: string, value: number, unit?: string}>} [state.metrics] - Metric snapshots
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composeStateEmbeddingSource({
 *   entity_names: ['Banana Plant'],
 *   state_text: 'Leaves yellowing at tips, possible nutrient deficiency',
 *   photo_descriptions: ['Close-up of leaf damage'],
 *   metrics: [{ display_name: 'Girth', value: 45, unit: 'cm' }]
 * })
 * // Returns: "Banana Plant. Leaves yellowing at tips, possible nutrient deficiency. Close-up of leaf damage. Girth: 45 cm"
 */
function composeStateEmbeddingSource(state) {
  const parts = [];

  if (state.entity_names && state.entity_names.length > 0) {
    parts.push(...state.entity_names);
  }

  if (state.state_text) {
    const extracted = extractMaxwellText(state.state_text);
    if (extracted) {
      parts.push(extracted);
    } else {
      parts.push(state.state_text);
    }
  }

  if (state.photo_descriptions && state.photo_descriptions.length > 0) {
    parts.push(...state.photo_descriptions);
  }

  if (state.metrics && state.metrics.length > 0) {
    for (const m of state.metrics) {
      const metricStr = m.unit
        ? `${m.display_name}: ${m.value} ${m.unit}`
        : `${m.display_name}: ${m.value}`;
      parts.push(metricStr);
    }
  }

  return parts.filter(Boolean).join('. ');
}

/**
 * If state_text is a maxwell_interaction JSON string, extract only question + response.
 * Returns the extracted text or null if not a maxwell_interaction.
 */
function extractMaxwellText(stateText) {
  if (!stateText.includes('"maxwell_interaction"')) return null;

  try {
    const parsed = JSON.parse(stateText);
    if (parsed.type === 'maxwell_interaction') {
      const textParts = [];
      if (parsed.question) textParts.push(parsed.question);
      if (parsed.response) textParts.push(parsed.response);
      return textParts.join('. ') || null;
    }
  } catch {
    // Not valid JSON — treat as plain text
  }
  return null;
}

/**
 * Compose embedding source for a financial record
 * 
 * Financial records include description, category_tag (AI-generated),
 * and external_source_note (for externally-funded transactions).
 * 
 * @param {Object} record - Financial record entity
 * @param {string} record.description - Transaction description
 * @param {string} [record.category_tag] - AI-generated category tag
 * @param {string} [record.external_source_note] - External funding source note
 * @returns {string} - Composed embedding source text
 * 
 * @example
 * composeFinancialRecordEmbeddingSource({
 *   description: 'Nails and screws for fence repair',
 *   category_tag: 'Construction',
 *   external_source_note: null
 * })
 * // Returns: "Nails and screws for fence repair. Construction"
 */
function composeFinancialRecordEmbeddingSource(record) {
  const parts = [
    record.description,
    record.category_tag,
    record.external_source_note
  ].filter(Boolean);
  return parts.join('. ');
}

module.exports = {
  composePartEmbeddingSource,
  composeToolEmbeddingSource,
  composeActionEmbeddingSource,
  composeIssueEmbeddingSource,
  composePolicyEmbeddingSource,
  composeStateEmbeddingSource,
  composeFinancialRecordEmbeddingSource,
  extractMaxwellText
};
