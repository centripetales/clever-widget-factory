import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { shouldActivateAssetCreation, ASSET_CREATION_KEYWORDS } from '../intentDetection.js';

/**
 * Property 1: Intent Detection Correctness
 * Validates: Requirements 1.1, 1.2, 1.3
 *
 * Tests that asset creation mode activates if and only if
 * both a keyword AND an image are present.
 */
describe('Feature: maxwell-asset-creation-skill, Property 1: Intent Detection Correctness', () => {
  const keywords = [
    'add',
    'create',
    'register',
    'new tool',
    'new part',
    'log this',
    'add to inventory',
    'track this',
  ];

  // Arbitrary that picks a random keyword from the list
  const keywordArb = fc.constantFrom(...keywords);

  // Arbitrary for random text that does NOT contain any keyword
  // Uses only digits and symbols that cannot accidentally form keywords
  const nonKeywordArb = fc.stringOf(
    fc.constantFrom(...'0123456789!@#$%^&*()-_=+[]{}|;:,.<>?/~`'.split('')),
    { minLength: 0, maxLength: 30 }
  );

  // Arbitrary for random prefix/suffix padding
  const paddingArb = fc.stringOf(
    fc.constantFrom(...'0123456789 !@#$%^&*()-_=+[]{}|;:,.<>?/~`'.split('')),
    { minLength: 0, maxLength: 20 }
  );

  it('any message with keyword + hasImage=true → returns true', () => {
    fc.assert(
      fc.property(paddingArb, keywordArb, paddingArb, (prefix, keyword, suffix) => {
        const message = `${prefix} ${keyword} ${suffix}`;
        expect(shouldActivateAssetCreation(message, true)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('any message with keyword + hasImage=false → returns false', () => {
    fc.assert(
      fc.property(paddingArb, keywordArb, paddingArb, (prefix, keyword, suffix) => {
        const message = `${prefix} ${keyword} ${suffix}`;
        expect(shouldActivateAssetCreation(message, false)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('any message without keyword + hasImage=true → returns false', () => {
    fc.assert(
      fc.property(nonKeywordArb, (message) => {
        // Verify the generated message truly has no keyword match
        fc.pre(!ASSET_CREATION_KEYWORDS.test(message));
        expect(shouldActivateAssetCreation(message, true)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('any message without keyword + hasImage=false → returns false', () => {
    fc.assert(
      fc.property(nonKeywordArb, (message) => {
        fc.pre(!ASSET_CREATION_KEYWORDS.test(message));
        expect(shouldActivateAssetCreation(message, false)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
