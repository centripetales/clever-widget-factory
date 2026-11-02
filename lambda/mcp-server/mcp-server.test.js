import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) process.env[k] = '1';

const { default: mcpServer } = await import('./mcp-server.js');

// Capture every SQL call instead of hitting a database.
let queries;
let rows;
mock.method(pg.Client.prototype, 'connect', async () => {});
mock.method(pg.Client.prototype, 'end', async () => {});
mock.method(pg.Client.prototype, 'query', async (sql, params) => {
  queries.push({ sql, params });
  return { rows };
});

async function connect(accessibleOrgIds) {
  const server = mcpServer.create({ accessibleOrgIds });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => {
  queries = [];
  rows = [];
});

describe('organization scoping', () => {
  test('search_claims date mode filters by the caller orgs', async () => {
    const client = await connect(['org-a', 'org-b']);
    await client.callTool({ name: 'search_claims', arguments: { date_from: '2026-10-01' } });
    assert.strictEqual(queries.length, 1);
    assert.match(queries[0].sql, /s\.organization_id = ANY\(\$1::uuid\[\]\)/);
    assert.deepStrictEqual(queries[0].params[0], ['org-a', 'org-b']);
  });

  test('get_observation_photos only returns photos from the caller orgs', async () => {
    const client = await connect(['org-a']);
    const result = await client.callTool({ name: 'get_observation_photos', arguments: { observation_id: 'obs-in-org-b' } });
    assert.match(queries[0].sql, /s\.organization_id = ANY\(\$3::uuid\[\]\)/);
    assert.deepStrictEqual(queries[0].params[2], ['org-a']);
    // DB returns nothing for another org's observation
    assert.match(result.content[0].text, /No photos/);
  });

  for (const name of ['search_actions', 'search_financial_records']) {
    test(`${name} date mode filters by the caller orgs`, async () => {
      const client = await connect(['org-a', 'org-b']);
      await client.callTool({ name, arguments: { date_from: '2026-10-01' } });
      assert.strictEqual(queries.length, 1);
      assert.match(queries[0].sql, /organization_id = ANY\(\$1::uuid\[\]\)/);
      assert.deepStrictEqual(queries[0].params.slice(0, 3), [['org-a', 'org-b'], '2026-10-01', '2026-10-01']);
    });
  }

  test('a caller with no memberships gets an error and no query runs', async () => {
    const client = await connect([]);
    for (const [name, args] of [['search_claims', { query: 'azolla' }], ['get_observation_photos', { observation_id: 'x' }], ['search_actions', { query: 'azolla' }], ['search_financial_records', { query: 'feed' }]]) {
      const result = await client.callTool({ name, arguments: args });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /not an active member/);
    }
    assert.strictEqual(queries.length, 0);
  });
});

describe('search_financial_records', () => {
  test('negative amounts are money in, positive are money out', async () => {
    rows = [
      { id: 'r1', transaction_date: '2026-10-01', amount: '250.00', payment_method: 'Cash' },
      { id: 'r2', transaction_date: '2026-10-01', amount: '-1000.00', payment_method: 'Cash' },
    ];
    const client = await connect(['org-a']);
    const result = await client.callTool({ name: 'search_financial_records', arguments: { date_from: '2026-10-01' } });
    const records = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(records.map((r) => [r.direction, r.amount_php]), [['out', 250], ['in', 1000]]);
  });
});
