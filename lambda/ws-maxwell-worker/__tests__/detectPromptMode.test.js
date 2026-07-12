import { describe, it, expect } from 'vitest';
import { ASSET_CREATION_KEYWORDS, shouldActivateAssetCreation } from '../intentDetection.js';

describe('ASSET_CREATION_KEYWORDS regex', () => {
  describe('positive cases — should match', () => {
    const positiveExamples = [
      'add this tool',
      'create a new part',
      'register this',
      'new tool',
      'new part from this photo',
      'log this item',
      'add to inventory',
      'track this',
      'Add This TOOL',
    ];

    it.each(positiveExamples)('matches "%s"', (message) => {
      expect(ASSET_CREATION_KEYWORDS.test(message)).toBe(true);
    });
  });

  describe('negative cases — should NOT match', () => {
    const negativeExamples = [
      'what is this?',
      'how much does this cost?',
      'where should I store this?',
      'describe this image',
      '',
    ];

    it.each(negativeExamples)('does not match "%s"', (message) => {
      expect(ASSET_CREATION_KEYWORDS.test(message)).toBe(false);
    });
  });
});

describe('shouldActivateAssetCreation', () => {
  it('returns true when keyword present and hasImage is true', () => {
    expect(shouldActivateAssetCreation('add this tool', true)).toBe(true);
  });

  it('returns false when keyword present but hasImage is false', () => {
    expect(shouldActivateAssetCreation('add this tool', false)).toBe(false);
  });

  it('returns false when no keyword but hasImage is true', () => {
    expect(shouldActivateAssetCreation('what is this?', true)).toBe(false);
  });

  it('returns false when no keyword and hasImage is false', () => {
    expect(shouldActivateAssetCreation('what is this?', false)).toBe(false);
  });
});
