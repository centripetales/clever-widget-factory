/**
 * Pure utility functions for skill axis embedding operations.
 * Extracted for testability — no Lambda layer dependencies.
 */

/**
 * Compose the embedding source text for a single skill axis.
 * When `axis.description` is present and non-empty, it is returned as the sole
 * embedding source (the description already incorporates label context and growth
 * intent). When `description` is absent or whitespace-only, falls back to the
 * legacy behaviour: label joined with narrative (if present).
 * @param {{ label: string, description?: string }} axis
 * @param {string} [narrative]
 * @returns {string}
 */
function composeAxisEmbeddingSource(axis, narrative) {
  if (axis.description && axis.description.trim()) {
    return axis.description;
  }
  // Fallback: legacy behavior for profiles without description
  return [axis.label, narrative].filter(Boolean).join('. ');
}

module.exports = {
  composeAxisEmbeddingSource
};
