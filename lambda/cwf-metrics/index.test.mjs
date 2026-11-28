/**
 * Tests for the metrics service's handling of a part's Inventory metric.
 * Run with: node --test index.test.mjs
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';

// The service opens its pool when it loads, so the database is faked first.
let calls = [];
let answers = [];
pg.Pool.prototype.connect = async () => ({
  query: async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const found = answers.find((a) => sql.includes(a.when));
    return { rows: found ? found.rows : [] };
  },
  release: () => {},
});
const { handler } = await import('./index.mjs');

const event = (httpMethod, body) => ({
  httpMethod,
  path: '/api/tools/part-1/metrics' + (httpMethod === 'POST' ? '' : '/metric-1'),
  pathParameters: { id: 'part-1', ...(httpMethod === 'POST' ? {} : { metric_id: 'metric-1' }) },
  requestContext: { authorizer: { organization_id: 'org-a' } },
  body: body ? JSON.stringify(body) : undefined,
});
const ran = (start) => calls.some((c) => c.sql.startsWith(start));
const inventory = { when: 'SELECT value_type, name, entity_type', rows: [{ value_type: 'number', name: 'Inventory', entity_type: 'part', readings: '2' }] };

describe('the Inventory metric of a part', () => {
  beforeEach(() => { calls = []; answers = []; });

  test('cannot be deleted', async () => {
    answers = [{ when: 'SELECT name, entity_type FROM metrics', rows: [{ name: 'Inventory', entity_type: 'part' }] }];
    const res = await handler(event('DELETE'));
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /cannot be deleted/);
    assert.ok(!ran('DELETE FROM metrics'));
  });

  test('cannot be renamed', async () => {
    answers = [inventory];
    const res = await handler(event('PUT', { name: 'Quantity', value_type: 'number' }));
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /renamed or disabled/);
    assert.ok(!ran('UPDATE metrics'));
  });

  test('cannot be disabled', async () => {
    answers = [inventory];
    const res = await handler(event('PUT', { name: 'Inventory', value_type: 'number', active: false }));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!ran('UPDATE metrics'));
  });

  test('can have its other details changed', async () => {
    answers = [inventory, { when: 'UPDATE metrics', rows: [{ metric_id: 'metric-1', name: 'Inventory' }] }];
    const res = await handler(event('PUT', { name: 'Inventory', unit: 'kg', details: 'How much there is', value_type: 'number' }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(ran('UPDATE metrics'));
  });

  test('is a name no other metric of the part can take', async () => {
    answers = [{ when: 'SELECT value_type, name, entity_type', rows: [{ value_type: 'number', name: 'Weight', entity_type: 'part', readings: '0' }] }];
    const res = await handler(event('PUT', { name: 'inventory', value_type: 'number' }));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!ran('UPDATE metrics'));
  });

  test('is not created by hand on a part', async () => {
    answers = [{ when: 'SELECT 1 FROM parts', rows: [{ '?column?': 1 }] }];
    const res = await handler(event('POST', { name: ' Inventory ', value_type: 'number' }));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!ran('INSERT INTO metrics'));
  });
});

describe('other metrics', () => {
  beforeEach(() => { calls = []; answers = []; });

  test('a part metric with another name is changed and deleted as before', async () => {
    answers = [
      { when: 'SELECT value_type, name, entity_type', rows: [{ value_type: 'number', name: 'Weight', entity_type: 'part', readings: '0' }] },
      { when: 'UPDATE metrics', rows: [{ metric_id: 'metric-1', name: 'Mass' }] },
    ];
    assert.strictEqual((await handler(event('PUT', { name: 'Mass', value_type: 'number' }))).statusCode, 200);

    calls = [];
    answers = [
      { when: 'SELECT name, entity_type FROM metrics', rows: [{ name: 'Weight', entity_type: 'part' }] },
      { when: 'DELETE FROM metrics', rows: [{ metric_id: 'metric-1' }] },
    ];
    assert.strictEqual((await handler(event('DELETE'))).statusCode, 200);
  });

  test('a metric is deleted by what it is about, whatever that is', async () => {
    answers = [
      { when: 'SELECT name, entity_type FROM metrics', rows: [{ name: 'Wait at checkout', entity_type: 'organization' }] },
      { when: 'DELETE FROM metrics', rows: [{ metric_id: 'metric-1' }] },
    ];
    assert.strictEqual((await handler(event('DELETE'))).statusCode, 200);
    const removed = calls.find((c) => c.sql.startsWith('DELETE FROM metrics'));
    assert.match(removed.sql, /entity_id::text = \$2\) AND organization_id = \$3/);
    assert.deepStrictEqual(removed.params, ['metric-1', 'part-1', 'org-a']);
  });

  test('a tool metric named Inventory is not locked', async () => {
    answers = [
      { when: 'SELECT name, entity_type FROM metrics', rows: [{ name: 'Inventory', entity_type: 'tool' }] },
      { when: 'DELETE FROM metrics', rows: [{ metric_id: 'metric-1' }] },
    ];
    assert.strictEqual((await handler(event('DELETE'))).statusCode, 200);
  });
});
