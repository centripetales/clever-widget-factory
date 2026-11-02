import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { LambdaClient } from '@aws-sdk/client-lambda';
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
  return { rows: typeof rows === 'function' ? rows(sql) : rows };
});

async function connect(accessibleOrgIds, callerName, extra = {}) {
  const server = mcpServer.create({ accessibleOrgIds, callerName, ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

// Capture calls to the actions Lambda instead of invoking it.
let invocations;
mock.method(LambdaClient.prototype, 'send', async (command) => {
  const event = JSON.parse(Buffer.from(command.input.Payload).toString());
  invocations.push({ functionName: command.input.FunctionName, event });
  const body = JSON.parse(event.body);
  if (command.input.FunctionName === 'cwf-states-lambda') {
    if (event.httpMethod === 'PUT' && event.pathParameters.id === 'not-mine') {
      return { Payload: Buffer.from(JSON.stringify({ statusCode: 403, body: JSON.stringify({ error: 'You do not have permission to edit this state' }) })) };
    }
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ id: event.pathParameters?.id || 'new-observation' }) })) };
  }
  return { Payload: Buffer.from(JSON.stringify({ statusCode: 201, body: JSON.stringify({ data: { id: 'new-action', title: body.title, status: body.status } }) })) };
});

beforeEach(() => {
  queries = [];
  rows = [];
  invocations = [];
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

describe('search_actions list mode', () => {
  test('status alone lists every matching action in the caller orgs', async () => {
    const client = await connect(['org-a']);
    await client.callTool({ name: 'search_actions', arguments: { status: ['not_started', 'in_progress'] } });
    assert.strictEqual(queries.length, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /a\.organization_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(sql, /a\.status::text = ANY\(\$2::text\[\]\)/);
    assert.deepStrictEqual(params, [['org-a'], ['not_started', 'in_progress'], 100]);
  });

  test('person narrows to actions they are assigned to or take part in', async () => {
    const client = await connect(['org-a']);
    await client.callTool({ name: 'search_actions', arguments: { person: 'Lester' } });
    assert.match(queries[0].sql, /om\.full_name ILIKE '%' \|\| \$2 \|\| '%'/);
    assert.strictEqual(queries[0].params[1], 'Lester');
  });

  test('listed actions carry where they stand but not their policy', async () => {
    rows = [{ id: 'a1', title: 'Order sand', status: 'in_progress', policy: '<p>long</p>', created_at: '2026-10-01T00:00:00Z',
      latest_observation_at: '2026-10-30T02:00:00Z', latest_observation_claim: 'Sand ordered.' }];
    const client = await connect(['org-a']);
    const result = await client.callTool({ name: 'search_actions', arguments: { status: ['in_progress'] } });
    const [action] = JSON.parse(result.content[0].text);
    assert.strictEqual(action.policy, undefined);
    assert.strictEqual(action.latest_observation.claim, 'Sand ordered.');
  });
});

describe('caller', () => {
  test('Claude is told who it is talking to', async () => {
    const client = await connect(['org-a'], 'Stefan Hamilton');
    assert.match(client.getInstructions(), /You are talking with Stefan Hamilton/);
  });
});

describe('create_action', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('goes through the app\'s create as the caller, with names resolved to members', async () => {
    rows = [{ user_id: 'u-lester', full_name: 'Lester Paniel' }, { user_id: 'u-mae', full_name: 'Mae Dela Torre' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'create_action', arguments: {
      title: 'Waterproof the bamboo treatment bins', existing_state: 'Bins leak', expected_state: 'Bins hold water',
      policy: 'Dry the bins.\n\nApply two coats.', assigned_to: 'lester', participants: ['Mae'],
    } });
    assert.strictEqual(result.isError, undefined);
    assert.deepStrictEqual(queries[0].params, ['org-a']);
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-actions-lambda');
    assert.strictEqual(event.httpMethod, 'POST');
    assert.strictEqual(event.requestContext.authorizer.cognito_user_id, 'cognito-1');
    assert.strictEqual(event.requestContext.authorizer.organization_id, 'org-a');
    const body = JSON.parse(event.body);
    assert.strictEqual(body.status, 'not_started');
    assert.strictEqual(body.description, 'Bins leak');
    assert.strictEqual(body.policy, '<p>Dry the bins.</p><p>Apply two coats.</p>');
    assert.strictEqual(body.assigned_to, 'u-lester');
    assert.deepStrictEqual(body.participants, ['u-mae']);
    assert.match(result.content[0].text, /actions\/new-action/);
  });

  test('an ambiguous name is sent back to ask, and nothing is created', async () => {
    rows = [{ user_id: 'u1', full_name: 'Mae Dela Torre' }, { user_id: 'u2', full_name: 'Mae Santos' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'create_action', arguments: { title: 'X', assigned_to: 'Mae' } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /ask which one/);
    assert.strictEqual(invocations.length, 0);
  });

  test('a read-only connection cannot create', async () => {
    const client = await connect(['org-a'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1', canWrite: false });
    const result = await client.callTool({ name: 'create_action', arguments: { title: 'X' } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /reconnect/);
    assert.strictEqual(invocations.length, 0);
  });
});

describe('add_observation', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('creates the observation on the action through the app and returns the photo link', async () => {
    rows = [{ id: 'action-1', title: 'Mount the inverter', organization_id: 'org-b' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'add_observation', arguments: { action_id: 'action-1', text: 'Lester mounted it.' } });
    assert.deepStrictEqual(queries[0].params, ['action-1', ['org-a', 'org-b']]);
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-states-lambda');
    assert.strictEqual(event.requestContext.authorizer.organization_id, 'org-b');
    assert.strictEqual(event.requestContext.authorizer.cognito_user_id, 'cognito-1');
    assert.deepStrictEqual(JSON.parse(event.body), { state_text: 'Lester mounted it.', photos: [], links: [{ entity_type: 'action', entity_id: 'action-1' }] });
    const reply = JSON.parse(result.content[0].text);
    assert.strictEqual(reply.add_photos_link, 'https://stargazer-farm.com/observations/edit/new-observation');
  });

  test('an action outside the caller orgs is refused and nothing is created', async () => {
    rows = [];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'add_observation', arguments: { action_id: 'other-org-action', text: 'x' } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(invocations.length, 0);
  });
});

describe('update_observation_links', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };
  const data = (sql) => sql.includes('FROM actions')
    ? [{ entity_type: 'action', entity_id: 'mae-action', name: 'Make VCO' }]
    : [
      { id: 'obs-1', organization_id: 'org-a', links: [{ entity_type: 'tool', entity_id: 'tool-1' }] },
      { id: 'obs-2', organization_id: 'org-a', links: [{ entity_type: 'action', entity_id: 'mae-action' }] },
      { id: 'not-mine', organization_id: 'org-a', links: [] },
    ];

  test('adds links to each observation, keeping the others, and reports each result', async () => {
    rows = data;
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_observation_links', arguments: {
      observation_ids: ['obs-1', 'obs-2', 'not-mine', 'missing'], add: [{ entity_type: 'action', entity_id: 'mae-action' }],
    } });
    const reply = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(reply.results.map((r) => r.result.split(':')[0]), ['updated', 'no change', 'not changed', 'not found in your organizations']);
    assert.deepStrictEqual(invocations.map((i) => i.event.pathParameters.id), ['obs-1', 'not-mine']);
    const first = invocations[0].event;
    assert.strictEqual(first.httpMethod, 'PUT');
    assert.strictEqual(first.requestContext.authorizer.cognito_user_id, 'cognito-1');
    assert.deepStrictEqual(JSON.parse(first.body).links, [{ entity_type: 'tool', entity_id: 'tool-1' }, { entity_type: 'action', entity_id: 'mae-action' }]);
    assert.match(reply.results[2].result, /permission/);
  });

  test('removes a link and keeps the rest', async () => {
    rows = data;
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'update_observation_links', arguments: {
      observation_ids: ['obs-1'], remove: [{ entity_type: 'tool', entity_id: 'tool-1' }],
    } });
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body).links, []);
  });

  test('a link target outside the caller orgs stops everything', async () => {
    rows = (sql) => (sql.includes('FROM actions') ? [] : data(sql));
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_observation_links', arguments: {
      observation_ids: ['obs-1'], add: [{ entity_type: 'tool', entity_id: 'other-org-tool' }],
    } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(invocations.length, 0);
  });
});
