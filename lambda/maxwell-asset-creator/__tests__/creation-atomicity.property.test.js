import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// Mock @aws-sdk/client-sqs
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  SendMessageCommand: vi.fn(),
}));

// Import the db mock (resolved via Module._resolveFilename in vitest.setup.js)
const db = require('/opt/nodejs/db');
const { handler } = require('../index.js');

// Reusable mock DB client with vi.fn() spies
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

function buildEvent({ assetType, name, description, imageUrl, photoDescription, sessionAttributes }) {
  const parameters = [
    { name: 'asset_type', value: assetType },
    { name: 'name', value: name },
  ];
  if (description) parameters.push({ name: 'description', value: description });
  if (imageUrl) parameters.push({ name: 'image_url', value: imageUrl });
  if (photoDescription) parameters.push({ name: 'photo_description', value: photoDescription });

  return {
    actionGroup: 'MaxwellAssetCreator',
    apiPath: '/create-asset',
    httpMethod: 'POST',
    parameters,
    sessionAttributes: sessionAttributes || {
      organization_id: 'org-123',
      cognito_user_id: 'user-456',
    },
  };
}

function parseResponseBody(result) {
  return JSON.parse(result.response.responseBody['application/json'].body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  db.__setMockClient(mockClient);
});

/**
 * **Validates: Requirements 5.5, 5.6, 7.7**
 *
 * Property 4: Initial State Creation Integrity
 *
 * For ANY valid asset creation request, if ANY database query within the
 * transaction fails, then:
 * 1. ROLLBACK is called (not COMMIT)
 * 2. No partial records exist (the handler returns 500)
 * 3. The client connection is always released
 */
describe('Feature: maxwell-asset-creation-skill, Property 4: Initial State Creation Integrity', () => {
  // Transaction steps after BEGIN:
  // 0: tool/part INSERT
  // 1: state INSERT
  // 2: state_photo INSERT (only if image_url provided)
  // 3: state_link INSERT

  const failStepArb = fc.integer({ min: 0, max: 3 });

  const paramsArb = fc.record({
    assetType: fc.constantFrom('tool', 'part'),
    name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
    description: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    imageUrl: fc.constant('https://example.com/photo.jpg'), // Always provide image_url so step 2 (state_photo) is reachable
    photoDescription: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
  });

  it('rolls back and returns 500 when any transaction step fails', async () => {
    await fc.assert(
      fc.asyncProperty(failStepArb, paramsArb, async (failAtStep, params) => {
        // Reset mocks for each iteration
        mockClient.query.mockReset();
        mockClient.release.mockReset();
        db.__setMockClient(mockClient);

        // Track call count to determine which query to fail
        let queryCallCount = 0;

        mockClient.query.mockImplementation((sql) => {
          // BEGIN is always the first call - let it succeed
          if (sql === 'BEGIN') {
            return Promise.resolve({ rows: [] });
          }

          // ROLLBACK and COMMIT are control flow - let them succeed
          if (sql === 'ROLLBACK' || sql === 'COMMIT') {
            return Promise.resolve({ rows: [] });
          }

          // Count data-modifying queries (after BEGIN, before COMMIT/ROLLBACK)
          const currentStep = queryCallCount;
          queryCallCount++;

          if (currentStep === failAtStep) {
            return Promise.reject(new Error(`Simulated failure at step ${failAtStep}`));
          }

          // Succeed with appropriate response
          // State INSERT returns id (needed for subsequent queries)
          if (currentStep === 1) {
            return Promise.resolve({ rows: [{ id: 'state-uuid-123' }] });
          }

          return Promise.resolve({ rows: [{ id: 'asset-uuid-456' }] });
        });

        const event = buildEvent({
          assetType: params.assetType,
          name: params.name,
          description: params.description,
          imageUrl: params.imageUrl,
          photoDescription: params.photoDescription,
        });

        const result = await handler(event);

        // Assert 1: ROLLBACK was called (not COMMIT)
        const allCalls = mockClient.query.mock.calls.map((c) => c[0]);
        expect(allCalls).toContain('ROLLBACK');
        expect(allCalls).not.toContain('COMMIT');

        // Assert 2: Response is 500
        expect(result.response.httpStatusCode).toBe(500);
        const body = parseResponseBody(result);
        expect(body.error).toBe('Failed to create asset');

        // Assert 3: Client connection is always released
        expect(mockClient.release).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 100 },
    );
  });
});
