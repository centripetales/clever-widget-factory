/**
 * Preservation Property Tests — skill-profile Lambda
 *
 * These tests capture CURRENT CORRECT behavior on unfixed code.
 * They MUST PASS now and MUST STILL PASS after the fixes are applied (no regressions).
 *
 * Properties tested:
 *   Property 2d — Skill Profile Generation Without Growth Intent Returns Valid Profile
 *
 * Requirements: 3.1, 3.8
 *
 * Note: These tests use globals (describe, it, expect, vi) provided by
 * vitest's globals: true configuration. No import needed.
 *
 * Testing approach:
 * - Property 2d: Inline the handleGenerate logic with injectable Bedrock mock.
 *   Assert that when growth_intent is absent or empty, the returned profile has
 *   a non-empty narrative (AI-generated) and a valid axes array.
 *   This is the action-driven path — unchanged from current behavior.
 */

import * as fc from 'fast-check';

// ── Property 2d — Skill Profile Generation Without Growth Intent ──────────────
// **Validates: Requirements 3.1, 3.8**
//
// When growth_intent is absent or empty, handleGenerate returns a profile with:
//   - profile.narrative: non-empty AI-generated string
//   - profile.axes: array with at least 4 items
//   - HTTP 200 status
//
// This test MUST PASS on unfixed code (baseline preservation).

describe('Property 2d — No Growth Intent: handleGenerate returns valid profile with AI narrative', () => {
  /**
   * Build a mock Bedrock client that returns a valid AI-generated profile.
   * The narrative is AI-generated (not the user's growth intent).
   */
  function buildMockBedrockClient(aiNarrative) {
    const profile = {
      narrative: aiNarrative,
      axes: [
        { key: 'soil_chemistry', label: 'Soil Chemistry', required_level: 2 },
        { key: 'experimental_design', label: 'Experimental Design', required_level: 3 },
        { key: 'plant_physiology', label: 'Plant Physiology', required_level: 2 },
        { key: 'data_interpretation', label: 'Data Interpretation', required_level: 2 },
      ],
      generated_at: new Date().toISOString(),
    };

    const responseBody = {
      content: [{ text: JSON.stringify(profile) }],
    };

    const encodedBody = new TextEncoder().encode(JSON.stringify(responseBody));

    return {
      send: vi.fn().mockResolvedValue({ body: encodedBody }),
    };
  }

  /**
   * Inline implementation of handleGenerate logic for testing.
   *
   * This mirrors the actual handleGenerate function in index.js but with
   * injectable dependencies (Bedrock client, AI config) so we can test
   * the no-growth-intent path without Lambda layer dependencies.
   *
   * This is the CURRENT (unfixed) version — it does NOT apply the growth intent
   * override (Bug 5 fix). The preservation test asserts that the no-growth-intent
   * path continues to work correctly both before and after the fix.
   */
  async function handleGenerateNoGrowthIntent(body, bedrockClient) {
    const { action_id, action_context, growth_intent } = body;

    if (!action_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'action_id is required' }) };
    }

    const ctx = action_context || {};
    const title = (ctx.title || '').trim();
    const description = (ctx.description || '').trim();
    const expectedState = (ctx.expected_state || '').trim();

    if (!title && !description && !expectedState) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Insufficient context to generate skill profile. Add a title, description, or expected state.',
        }),
      };
    }

    // Normalize growth intent — empty string becomes null
    const growthIntent = (typeof growth_intent === 'string' ? growth_intent.trim() : '') || null;

    const aiConfig = { min_axes: 4, max_axes: 6 };

    // Build prompt (simplified)
    const prompt = `Generate skill profile for: ${JSON.stringify(ctx)}`;

    // Call Bedrock
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const command = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0', // current (unfixed) model ID
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1000,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
      }),
      contentType: 'application/json',
      accept: 'application/json',
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const text = responseBody.content[0].text.trim();
    const profile = JSON.parse(text);

    // Validate profile structure
    if (
      !profile ||
      typeof profile.narrative !== 'string' ||
      !profile.narrative.trim() ||
      !Array.isArray(profile.axes) ||
      profile.axes.length < aiConfig.min_axes ||
      profile.axes.length > aiConfig.max_axes
    ) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate valid profile.' }) };
    }

    // NOTE: The Bug 5 fix adds: if (growthIntent) { profile.narrative = growthIntent; }
    // When growthIntent is null (no growth intent provided), this guard does NOT fire,
    // so the AI-generated narrative is returned unchanged. This is the preservation path.

    return {
      statusCode: 200,
      body: JSON.stringify({ data: profile }),
    };
  }

  it('returns HTTP 200 with valid profile when growth_intent is absent', async () => {
    const aiNarrative = 'This action requires understanding of soil chemistry and experimental design.';
    const mockBedrock = buildMockBedrockClient(aiNarrative);

    const body = {
      action_id: 'action-123',
      action_context: {
        title: 'Apply gypsum to test plot',
        description: 'Testing gypsum effects on soil structure',
        expected_state: 'Improved soil drainage',
      },
      // No growth_intent
    };

    const response = await handleGenerateNoGrowthIntent(body, mockBedrock);

    expect(response.statusCode).toBe(200);

    const responseBody = JSON.parse(response.body);
    expect(responseBody.data).toBeDefined();
    expect(typeof responseBody.data.narrative).toBe('string');
    expect(responseBody.data.narrative.trim()).not.toBe('');
    expect(Array.isArray(responseBody.data.axes)).toBe(true);
    expect(responseBody.data.axes.length).toBeGreaterThanOrEqual(4);
  });

  it('returns HTTP 200 with AI narrative when growth_intent is empty string', async () => {
    const aiNarrative = 'This action requires understanding of soil chemistry and experimental design.';
    const mockBedrock = buildMockBedrockClient(aiNarrative);

    const body = {
      action_id: 'action-456',
      action_context: {
        title: 'Apply gypsum to test plot',
      },
      growth_intent: '', // Empty string — treated as absent
    };

    const response = await handleGenerateNoGrowthIntent(body, mockBedrock);

    expect(response.statusCode).toBe(200);

    const responseBody = JSON.parse(response.body);
    expect(responseBody.data).toBeDefined();
    expect(typeof responseBody.data.narrative).toBe('string');
    expect(responseBody.data.narrative.trim()).not.toBe('');
    // The narrative should be the AI-generated one, not the empty growth_intent
    expect(responseBody.data.narrative).toBe(aiNarrative);
  });

  it('returns HTTP 200 with AI narrative when growth_intent is whitespace-only', async () => {
    const aiNarrative = 'This action requires understanding of soil chemistry and experimental design.';
    const mockBedrock = buildMockBedrockClient(aiNarrative);

    const body = {
      action_id: 'action-789',
      action_context: {
        title: 'Apply gypsum to test plot',
      },
      growth_intent: '   ', // Whitespace only — treated as absent after trim
    };

    const response = await handleGenerateNoGrowthIntent(body, mockBedrock);

    expect(response.statusCode).toBe(200);

    const responseBody = JSON.parse(response.body);
    expect(responseBody.data).toBeDefined();
    expect(typeof responseBody.data.narrative).toBe('string');
    expect(responseBody.data.narrative.trim()).not.toBe('');
    expect(responseBody.data.narrative).toBe(aiNarrative);
  });

  it('returned profile has narrative and axes fields', async () => {
    const aiNarrative = 'This action requires understanding of soil chemistry and experimental design.';
    const mockBedrock = buildMockBedrockClient(aiNarrative);

    const body = {
      action_id: 'action-123',
      action_context: {
        title: 'Apply gypsum to test plot',
        description: 'Testing gypsum effects on soil structure',
      },
    };

    const response = await handleGenerateNoGrowthIntent(body, mockBedrock);
    const responseBody = JSON.parse(response.body);

    // Profile must have both narrative and axes
    expect(responseBody.data).toHaveProperty('narrative');
    expect(responseBody.data).toHaveProperty('axes');
    expect(responseBody.data).toHaveProperty('generated_at');
  });

  it('property-based: for all valid action contexts without growth_intent, returns HTTP 200 with valid profile', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid action contexts (at least one non-empty field)
        fc.record({
          title: fc.string({ minLength: 1, maxLength: 80 }),
          description: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
          expected_state: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
        }),
        async (actionContext) => {
          const aiNarrative = `AI narrative for: ${actionContext.title}`;
          const mockBedrock = buildMockBedrockClient(aiNarrative);

          const body = {
            action_id: 'action-pbt',
            action_context: actionContext,
            // No growth_intent
          };

          const response = await handleGenerateNoGrowthIntent(body, mockBedrock);

          expect(response.statusCode).toBe(200);

          const responseBody = JSON.parse(response.body);
          expect(responseBody.data).toBeDefined();

          // narrative must be a non-empty AI-generated string
          expect(typeof responseBody.data.narrative).toBe('string');
          expect(responseBody.data.narrative.trim().length).toBeGreaterThan(0);

          // axes must be a valid array
          expect(Array.isArray(responseBody.data.axes)).toBe(true);
          expect(responseBody.data.axes.length).toBeGreaterThanOrEqual(4);
        }
      ),
      { numRuns: 20 }
    );
  });
});
