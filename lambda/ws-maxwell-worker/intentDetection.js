/**
 * Asset creation keyword detection — extracted for testability.
 */
const ASSET_CREATION_KEYWORDS = /\b(add|create|register|new tool|new part|log this|add to inventory|track this)\b/i;

/**
 * Determine if a message with image attachment should activate asset creation mode.
 * @param {string} message - The user's message text
 * @param {boolean} hasImage - Whether an image is attached
 * @returns {boolean} true if asset creation mode should activate
 */
function shouldActivateAssetCreation(message, hasImage) {
  return hasImage && ASSET_CREATION_KEYWORDS.test(message);
}

module.exports = { ASSET_CREATION_KEYWORDS, shouldActivateAssetCreation };
