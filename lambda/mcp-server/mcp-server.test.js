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
// The authorizer answers with the person's context, as API Gateway would pass it.
let invocations;
mock.method(LambdaClient.prototype, 'send', async (command) => {
  const event = JSON.parse(Buffer.from(command.input.Payload).toString());
  if (command.input.FunctionName === 'cwf-api-authorizer') {
    return { Payload: Buffer.from(JSON.stringify({
      organization_id: 'org-a', cognito_user_id: event.contextFor, user_role: 'admin',
      accessible_organization_ids: '["org-a","org-b"]', permissions: '["data:write","data:write:all"]',
    })) };
  }
  invocations.push({ functionName: command.input.FunctionName, event });
  const body = JSON.parse(event.body);
  if (command.input.FunctionName === 'cwf-states-lambda') {
    if (event.httpMethod === 'PUT' && event.pathParameters.id === 'not-mine') {
      return { Payload: Buffer.from(JSON.stringify({ statusCode: 403, body: JSON.stringify({ error: 'You do not have permission to edit this state' }) })) };
    }
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ id: event.pathParameters?.id || 'new-observation' }) })) };
  }
  if (event.httpMethod === 'PUT') {
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ data: { id: event.pathParameters.id, title: body.title ?? 'Old title' } }) })) };
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

describe('update_action', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('sends only the changed fields to the actions service, in the action org', async () => {
    rows = [{ id: 'action-1', organization_id: 'org-b' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_action', arguments: { action_id: 'action-1', title: 'Share your farming practices' } });
    assert.deepStrictEqual(queries[0].params, ['action-1', ['org-a', 'org-b']]);
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-actions-lambda');
    assert.strictEqual(event.httpMethod, 'PUT');
    assert.strictEqual(event.path, '/api/actions/action-1');
    assert.strictEqual(event.headers['X-Organization-Id'], 'org-b');
    assert.strictEqual(event.requestContext.authorizer.cognito_user_id, 'cognito-1');
    assert.strictEqual(event.requestContext.authorizer.permissions, '["data:write","data:write:all"]');
    assert.deepStrictEqual(JSON.parse(event.body), { title: 'Share your farming practices' });
    assert.strictEqual(JSON.parse(result.content[0].text).title, 'Share your farming practices');
  });

  test('existing state and policy map to the app fields', async () => {
    rows = [{ id: 'action-1', organization_id: 'org-a' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'update_action', arguments: { action_id: 'action-1', existing_state: 'Bins leak', policy: 'Seal the seams.' } });
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body), { description: 'Bins leak', policy: '<p>Seal the seams.</p>' });
  });

  test('people, asset, tools, stock, status and sharing go to the app fields', async () => {
    rows = (sql) => sql.includes('FROM actions') ? [{ id: 'action-1', organization_id: 'org-a' }]
      : sql.includes('organization_members') ? [{ user_id: 'u-lester', full_name: 'Lester Paniel' }, { user_id: 'u-mae', full_name: 'Mae Dela Torre' }]
      : sql.includes('FROM tools') ? [{ id: 'tool-1' }, { id: 'tool-2' }]
      : [{ id: 'part-1', name: 'Beauveria' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_action', arguments: {
      action_id: 'action-1', assigned_to: 'Lester', participants: ['Mae'], asset_id: 'tool-1', required_tools: ['tool-2'],
      required_stock: [{ part_id: 'part-1', quantity: 2 }], status: 'in_progress', shared_with_partners: true,
    } });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body), {
      status: 'in_progress', shared_with_partners: true, assigned_to: 'u-lester', participants: ['u-mae'],
      asset_id: 'tool-1', required_tools: ['tool-2'], required_stock: [{ part_id: 'part-1', quantity: 2, part_name: 'Beauveria' }],
    });
  });

  test('a tool or part outside the caller orgs is refused', async () => {
    rows = (sql) => sql.includes('FROM actions') ? [{ id: 'action-1', organization_id: 'org-a' }] : [];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_action', arguments: { action_id: 'action-1', required_tools: ['other-tool'] } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('completing sends the status and completion time; the actions service uses up the stock', async () => {
    rows = [{ id: 'action-1', organization_id: 'org-a' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'update_action', arguments: { action_id: 'action-1', status: 'completed' } });
    const body = JSON.parse(invocations[0].event.body);
    assert.strictEqual(body.status, 'completed');
    assert.ok(!Number.isNaN(Date.parse(body.completed_at)));
  });

  test('nothing to change, an unknown action or a read-only connection change nothing', async () => {
    rows = [];
    const writerClient = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.strictEqual((await writerClient.callTool({ name: 'update_action', arguments: { action_id: 'action-1' } })).isError, true);
    assert.strictEqual((await writerClient.callTool({ name: 'update_action', arguments: { action_id: 'other-org-action', title: 'x' } })).isError, true);
    const reader = await connect(['org-a'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1' });
    assert.strictEqual((await reader.callTool({ name: 'update_action', arguments: { action_id: 'action-1', title: 'x' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });
});

describe('search_assets low_stock', () => {
  test('lists parts below their minimum in the caller orgs', async () => {
    rows = [{ asset_id: 'part-1', name: 'Tick buster Fipronil', current_quantity: '1', minimum_quantity: '3' }];
    const client = await connect(['org-a', 'org-b']);
    const result = await client.callTool({ name: 'search_assets', arguments: { low_stock: true } });
    assert.match(queries[0].sql, /p\.current_quantity < p\.minimum_quantity/);
    assert.deepStrictEqual(queries[0].params, [['org-a', 'org-b'], null, 100]);
    assert.strictEqual(JSON.parse(result.content[0].text)[0].name, 'Tick buster Fipronil');
  });

  test('a search without a query or low_stock is refused', async () => {
    const client = await connect(['org-a']);
    assert.strictEqual((await client.callTool({ name: 'search_assets', arguments: {} })).isError, true);
    assert.strictEqual(queries.length, 0);
  });
});

describe('add_observation', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('creates the observation on the action through the app, in the primary org, and returns the photo link', async () => {
    rows = [{ entity_type: 'action', entity_id: 'action-1', name: 'Mount the inverter' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'add_observation', arguments: {
      text: 'Lester mounted it.', links: [{ entity_type: 'action', entity_id: 'action-1' }],
    } });
    assert.deepStrictEqual(queries[0].params, [['action-1'], ['org-a', 'org-b']]);
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-states-lambda');
    assert.strictEqual(event.requestContext.authorizer.organization_id, 'org-a');
    assert.deepStrictEqual(event.headers, {});
    assert.strictEqual(event.requestContext.authorizer.cognito_user_id, 'cognito-1');
    assert.deepStrictEqual(JSON.parse(event.body), { state_text: 'Lester mounted it.', photos: [], links: [{ entity_type: 'action', entity_id: 'action-1' }] });
    const reply = JSON.parse(result.content[0].text);
    assert.strictEqual(reply.add_photos_link, 'https://stargazer-farm.com/observations/edit/new-observation');
    assert.strictEqual(reply.action_link, 'https://stargazer-farm.com/actions/action-1');
  });

  test('a standalone observation has no links and needs no lookup', async () => {
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'add_observation', arguments: { text: 'Rain overnight.', captured_at: '2026-11-02T06:00:00+08:00' } });
    assert.strictEqual(queries.length, 0);
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body), { state_text: 'Rain overnight.', captured_at: '2026-11-02T06:00:00+08:00', photos: [], links: [] });
  });

  test('links outside the caller orgs are refused and nothing is created', async () => {
    rows = [{ entity_type: 'tool', entity_id: 'tool-1', name: 'Azolla pond' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'add_observation', arguments: {
      text: 'x', links: [{ entity_type: 'tool', entity_id: 'tool-1' }, { entity_type: 'action', entity_id: 'other-org-action' }],
    } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /other-org-action/);
    assert.strictEqual(invocations.length, 0);
  });
});

describe('metrics', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };
  const coverage = { metric_id: 'metric-1', tool_id: 'tool-1', name: 'Coverage %', unit: '%', value_type: 'number', min_value: 0, max_value: 100 };

  test('search_assets lists a tool\'s metrics', async () => {
    rows = (sql) => sql.includes('FROM metrics') ? [coverage] : sql.includes('unified_embeddings') ? [] : [{ type: 'tool', id: 'tool-1', name: 'Azolla pond' }];
    const client = await connect(['org-a'], 'Stefan Hamilton');
    const [pond] = JSON.parse((await client.callTool({ name: 'search_assets', arguments: { query: 'azolla' } })).content[0].text);
    assert.deepStrictEqual(pond.metrics, [{ metric_id: 'metric-1', name: 'Coverage %', unit: '%', value_type: 'number', min_value: 0, max_value: 100 }]);
  });

  test('add_observation saves the readings through the snapshots service after the observation', async () => {
    rows = (sql) => sql.includes('FROM metrics') ? [coverage] : [{ entity_type: 'tool', entity_id: 'tool-1', name: 'Azolla pond' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'add_observation', arguments: {
      text: 'Pond is filling in.', links: [{ entity_type: 'tool', entity_id: 'tool-1' }], metrics: [{ metric_id: 'metric-1', value: 60 }],
    } });
    const [observation, snapshot] = invocations;
    assert.strictEqual(observation.functionName, 'cwf-states-lambda');
    assert.strictEqual(snapshot.functionName, 'cwf-snapshots-lambda');
    assert.strictEqual(snapshot.event.path, '/api/states/new-observation/snapshots');
    assert.strictEqual(snapshot.event.pathParameters.id, 'new-observation');
    assert.deepStrictEqual(JSON.parse(snapshot.event.body), { metric_id: 'metric-1', value: '60' });
    assert.deepStrictEqual(JSON.parse(result.content[0].text).metrics, [{ metric: 'Coverage %', value: '60', result: 'saved' }]);
  });

  test('a metric not on a linked tool is refused and nothing is created', async () => {
    rows = (sql) => sql.includes('FROM metrics') ? [] : [{ entity_type: 'tool', entity_id: 'tool-1', name: 'Azolla pond' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'add_observation', arguments: {
      links: [{ entity_type: 'tool', entity_id: 'tool-1' }], metrics: [{ metric_id: 'other-metric', value: '1' }],
    } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /other-metric/);
    assert.strictEqual(invocations.length, 0);
  });

  test('update_observation updates a reading already there, adds a new one, after the edit check', async () => {
    const depth = { ...coverage, metric_id: 'metric-2', name: 'Depth' };
    rows = (sql) => sql.includes('FROM metric_snapshots') ? [{ snapshot_id: 'snap-1', metric_id: 'metric-1' }]
      : sql.includes('FROM metrics') ? [coverage, depth]
      : [{ id: 'obs-1', organization_id: 'org-b', tool_ids: ['tool-1'] }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'update_observation', arguments: {
      observation_id: 'obs-1', metrics: [{ metric_id: 'metric-1', value: '70' }, { metric_id: 'metric-2', value: '12' }],
    } });
    const [edit, update, create] = invocations;
    assert.strictEqual(edit.functionName, 'cwf-states-lambda');
    assert.deepStrictEqual(JSON.parse(edit.event.body), {});
    assert.strictEqual(update.event.httpMethod, 'PUT');
    assert.strictEqual(update.event.pathParameters.snapshot_id, 'snap-1');
    assert.strictEqual(update.event.headers['X-Organization-Id'], 'org-b');
    assert.deepStrictEqual(JSON.parse(update.event.body), { value: '70' });
    assert.strictEqual(create.event.path, '/api/states/obs-1/snapshots');
    assert.deepStrictEqual(JSON.parse(create.event.body), { metric_id: 'metric-2', value: '12' });
  });

  test('someone who may not edit the observation changes no readings', async () => {
    rows = (sql) => sql.includes('FROM metric_snapshots') ? [] : sql.includes('FROM metrics') ? [coverage]
      : [{ id: 'not-mine', organization_id: 'org-a', tool_ids: ['tool-1'] }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_observation', arguments: { observation_id: 'not-mine', metrics: [{ metric_id: 'metric-1', value: '5' }] } });
    assert.strictEqual(result.isError, true);
    assert.ok(invocations.every((i) => i.functionName !== 'cwf-snapshots-lambda'));
  });
});

describe('update_observation', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('sends only the changed fields, in the observation org', async () => {
    rows = [{ id: 'obs-1', organization_id: 'org-b' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'update_observation', arguments: { observation_id: 'obs-1', text: ' Fixed typo. ' } });
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-states-lambda');
    assert.strictEqual(event.httpMethod, 'PUT');
    assert.strictEqual(event.pathParameters.id, 'obs-1');
    assert.strictEqual(event.headers['X-Organization-Id'], 'org-b');
    assert.deepStrictEqual(JSON.parse(event.body), { state_text: 'Fixed typo.' });
  });

  test('nothing to change or an unknown observation change nothing', async () => {
    rows = [];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.strictEqual((await client.callTool({ name: 'update_observation', arguments: { observation_id: 'obs-1' } })).isError, true);
    assert.strictEqual((await client.callTool({ name: 'update_observation', arguments: { observation_id: 'missing', text: 'x' } })).isError, true);
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
