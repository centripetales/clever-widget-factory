import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @aws-sdk/client-sqs (resolved from node_modules, vi.mock works fine)
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  SendMessageCommand: vi.fn(),
}));

// Note: crypto.randomUUID is a Node built-in that cannot be reliably mocked in CJS
// Tests assert on response structure rather than specific UUID values

// Import the db mock (resolved via Module._resolveFilename in vitest.setup.js)
const db = require('/opt/nodejs/db');
const { handler } = require('../index.js');

// Reusable mock DB client with vi.fn() spies
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

function buildEvent({ apiPath = '/create-asset', httpMethod = 'POST', parameters = [], requestBody, sessionAttributes = {} }) {
  const event = {
    actionGroup: 'MaxwellAssetCreator',
    apiPath,
    httpMethod,
    parameters,
    sessionAttributes,
  };
  if (requestBody) {
    event.requestBody = requestBody;
  }
  return event;
}

function parseResponseBody(result) {
  return JSON.parse(result.response.responseBody['application/json'].body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  mockClient.query.mockResolvedValue({ rows: [] });
  db.__setMockClient(mockClient);
});

describe('createAsset - parameter validation', () => {
  it('returns 400 when asset_type is missing', async () => {
    const event = buildEvent({
      parameters: [{ name: 'name', value: 'Hammer' }],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(400);
    expect(body.error).toContain('asset_type');
  });

  it('returns 400 when asset_type is invalid (not "tool" or "part")', async () => {
    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'vehicle' },
        { name: 'name', value: 'Truck' },
      ],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(400);
    expect(body.error).toContain('asset_type');
  });

  it('returns 400 when name is missing', async () => {
    const event = buildEvent({
      parameters: [{ name: 'asset_type', value: 'tool' }],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(400);
    expect(body.error).toContain('name');
  });

  it('returns 400 when organization_id is missing from session attributes', async () => {
    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'tool' },
        { name: 'name', value: 'Hammer' },
      ],
      sessionAttributes: {},
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(400);
    expect(body.error).toContain('organization_id');
  });
});

describe('getCategories handler', () => {
  it('returns 400 when organization_id is missing', async () => {
    const event = buildEvent({
      apiPath: '/get-categories',
      httpMethod: 'GET',
      sessionAttributes: {},
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(400);
    expect(body.error).toContain('organization_id');
  });

  it('returns 200 with list of categories on success', async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ category: 'Hand Tools' }, { category: 'Power Tools' }],
    });

    const event = buildEvent({
      apiPath: '/get-categories',
      httpMethod: 'GET',
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(200);
    expect(body.categories).toEqual(['Hand Tools', 'Power Tools']);
  });

  it('returns 500 on database error', async () => {
    mockClient.query.mockRejectedValueOnce(new Error('connection refused'));

    const event = buildEvent({
      apiPath: '/get-categories',
      httpMethod: 'GET',
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(500);
    expect(body.error).toContain('Failed to retrieve categories');
  });
});

describe('getImageMetadata handler', () => {
  it('returns 400 when neither photo_url nor filename is provided', async () => {
    const event = buildEvent({
      apiPath: '/get-image-metadata',
      httpMethod: 'GET',
      parameters: [],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(400);
    expect(body.error).toContain('photo_url or filename');
  });

  it('returns 200 with has_gps: false when no metadata found', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const event = buildEvent({
      apiPath: '/get-image-metadata',
      httpMethod: 'GET',
      parameters: [{ name: 'photo_url', value: 'photo123.jpg' }],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(200);
    expect(body.has_gps).toBe(false);
    expect(body.message).toContain('No metadata found');
  });

  it('returns 200 with GPS data when metadata exists', async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{
        gps_latitude: 14.5995,
        gps_longitude: 120.9842,
        gps_altitude: 25.0,
        captured_at: '2025-01-15T10:30:00Z',
        device_make: 'Apple',
        device_model: 'iPhone 15',
      }],
    });

    const event = buildEvent({
      apiPath: '/get-image-metadata',
      httpMethod: 'GET',
      parameters: [{ name: 'photo_url', value: 'photo123.jpg' }],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(200);
    expect(body.has_gps).toBe(true);
    expect(body.gps_latitude).toBe(14.5995);
    expect(body.gps_longitude).toBe(120.9842);
    expect(body.gps_altitude).toBe(25.0);
    expect(body.captured_at).toBe('2025-01-15T10:30:00Z');
    expect(body.device).toBe('Apple iPhone 15');
  });

  it('extracts filename from full S3 URL correctly', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const event = buildEvent({
      apiPath: '/get-image-metadata',
      httpMethod: 'GET',
      parameters: [{ name: 'photo_url', value: 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/uploads/photo123.jpg' }],
      sessionAttributes: { organization_id: 'org-1' },
    });

    await handler(event);

    // The SQL should use just 'photo123.jpg' extracted from the full URL
    const sqlCall = mockClient.query.mock.calls[0][0];
    expect(sqlCall).toContain('photo123.jpg');
    expect(sqlCall).not.toContain('https://');
  });

  it('returns 500 on database error', async () => {
    mockClient.query.mockRejectedValueOnce(new Error('connection timeout'));

    const event = buildEvent({
      apiPath: '/get-image-metadata',
      httpMethod: 'GET',
      parameters: [{ name: 'photo_url', value: 'photo123.jpg' }],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(500);
    expect(body.error).toContain('Failed to retrieve image metadata');
  });
});

describe('createAsset - success cases', () => {
  it('successfully creates a tool with all fields and returns 201', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'test-uuid-1234' }] }) // INSERT tool
      .mockResolvedValueOnce({ rows: [{ id: 'state-id-1' }] }) // INSERT state
      .mockResolvedValueOnce({ rows: [] }) // INSERT state_photo
      .mockResolvedValueOnce({ rows: [] }) // INSERT state_link
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'tool' },
        { name: 'name', value: 'Cordless Drill' },
        { name: 'description', value: 'DeWalt 20V cordless drill' },
        { name: 'storage_location', value: 'Workshop Shelf A' },
        { name: 'serial_number', value: 'DW-12345' },
        { name: 'status', value: 'available' },
        { name: 'is_location', value: 'false' },
        { name: 'image_url', value: 'https://cwf-dev-assets.s3.amazonaws.com/drill.jpg' },
        { name: 'policy', value: 'Return after use; charge battery' },
        { name: 'initial_condition_text', value: 'New cordless drill in good condition' },
        { name: 'photo_description', value: 'Yellow cordless drill on workbench' },
      ],
      sessionAttributes: { organization_id: 'org-1', cognito_user_id: 'user-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(201);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Cordless Drill');
    expect(body.asset_type).toBe('tool');
  });

  it('successfully creates a part with all fields and returns 201', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'test-uuid-1234' }] }) // INSERT part
      .mockResolvedValueOnce({ rows: [{ id: 'state-id-2' }] }) // INSERT state
      .mockResolvedValueOnce({ rows: [] }) // INSERT state_photo
      .mockResolvedValueOnce({ rows: [] }) // INSERT state_link
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'part' },
        { name: 'name', value: 'Neem Oil' },
        { name: 'description', value: 'Organic cold-pressed neem oil 500ml' },
        { name: 'storage_location', value: 'Supply Shed' },
        { name: 'current_quantity', value: '12' },
        { name: 'minimum_quantity', value: '5' },
        { name: 'unit', value: 'bottles' },
        { name: 'sellable', value: 'true' },
        { name: 'cost_per_unit', value: '8.50' },
        { name: 'image_url', value: 'https://cwf-dev-assets.s3.amazonaws.com/neem.jpg' },
        { name: 'policy', value: 'Store in cool dry place' },
        { name: 'initial_condition_text', value: 'New stock of neem oil received' },
        { name: 'photo_description', value: 'Bottles of neem oil on shelf' },
      ],
      sessionAttributes: { organization_id: 'org-1', cognito_user_id: 'user-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(201);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Neem Oil');
    expect(body.asset_type).toBe('part');
  });

  it('calls COMMIT on successful creation', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'test-uuid-1234' }] }) // INSERT tool
      .mockResolvedValueOnce({ rows: [{ id: 'state-id-1' }] }) // INSERT state
      .mockResolvedValueOnce({ rows: [] }) // INSERT state_link
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'tool' },
        { name: 'name', value: 'Hammer' },
      ],
      sessionAttributes: { organization_id: 'org-1', cognito_user_id: 'user-1' },
    });

    await handler(event);

    const queryCalls = mockClient.query.mock.calls.map(c => c[0]);
    expect(queryCalls).toContain('BEGIN');
    expect(queryCalls).toContain('COMMIT');
    expect(queryCalls).not.toContain('ROLLBACK');
  });
});

describe('createAsset - error handling', () => {
  it('returns 500 when database INSERT fails during createAsset', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('duplicate key'));

    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'tool' },
        { name: 'name', value: 'Hammer' },
      ],
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(500);
    expect(body.error).toContain('Failed to create asset');
  });

  it('transaction is rolled back on error (ROLLBACK called)', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('constraint violation'));

    const event = buildEvent({
      parameters: [
        { name: 'asset_type', value: 'tool' },
        { name: 'name', value: 'Hammer' },
      ],
      sessionAttributes: { organization_id: 'org-1' },
    });

    await handler(event);

    const queryCalls = mockClient.query.mock.calls.map(c => c[0]);
    expect(queryCalls).toContain('ROLLBACK');
  });

  it('returns 404 for unknown apiPath', async () => {
    const event = buildEvent({
      apiPath: '/unknown-path',
      httpMethod: 'GET',
      sessionAttributes: { organization_id: 'org-1' },
    });

    const result = await handler(event);
    const body = parseResponseBody(result);

    expect(result.response.httpStatusCode).toBe(404);
    expect(body.error).toContain('Unknown apiPath');
  });
});
