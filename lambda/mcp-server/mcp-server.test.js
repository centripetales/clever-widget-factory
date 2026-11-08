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
  if (command.input.FunctionName === 'cwf-experiences-lambda') {
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ id: event.pathParameters?.id || 'new-experience' }) })) };
  }
  if (command.input.FunctionName === 'cwf-metrics-lambda') {
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 201, body: JSON.stringify({ metric: {
      metric_id: 'metric-new', name: body.name, unit: body.unit ?? null, value_type: body.value_type, min_value: body.min_value ?? null, max_value: body.max_value ?? null,
    } }) })) };
  }
  if (command.input.FunctionName === 'cwf-state-space-lambda') {
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ data: { id: event.pathParameters?.id ? 'association-1' : 'model-1' } }) })) };
  }
  if (command.input.FunctionName === 'cwf-core-lambda') {
    return { Payload: Buffer.from(JSON.stringify({ statusCode: 201, body: JSON.stringify({ data: { id: 'h-1' }, part: { id: body.part_id, current_quantity: '8.000' } }) })) };
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

  test('get_observation_photos resolves bare S3 keys against the bucket', async () => {
    rows = [{ photo_url: 'mission-attachments/receipt.jpg' }, { photo_url: 'https://example.com/full.jpg' }];
    const fetched = [];
    const restore = mock.method(globalThis, 'fetch', async (url) => {
      fetched.push(url);
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });
    });
    const client = await connect(['org-a']);
    await client.callTool({ name: 'get_observation_photos', arguments: { observation_id: 'obs-1' } });
    restore.mock.restore();
    assert.deepStrictEqual(fetched, ['https://cwf-dev-assets.s3.us-west-2.amazonaws.com/mission-attachments/receipt.jpg', 'https://example.com/full.jpg']);
  });

  test('get_observation_photos names each photo with when it was taken and where, when known', async () => {
    rows = [
      { photo_url: 'photos/a.jpg', photo_description: 'Row 3', taken_at: '2026-10-05T09:30:00Z', gps_latitude: '10.5', gps_longitude: '123.25' },
      { photo_url: 'photos/b.jpg', photo_description: null, taken_at: null, gps_latitude: null, gps_longitude: null },
    ];
    const restore = mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }));
    const client = await connect(['org-a']);
    const result = await client.callTool({ name: 'get_observation_photos', arguments: { observation_id: 'obs-1' } });
    restore.mock.restore();
    assert.match(queries[0].sql, /photo_metadata_extractions pme WHERE pme\.photo_url = sp\.photo_url/);
    const texts = result.content.filter((c) => c.type === 'text').map((c) => c.text);
    assert.deepStrictEqual(texts, [
      'photo_url: photos/a.jpg\ntaken: Oct 5, 2026, 9:30 AM PHT\ngps: 10.5,123.25\nRow 3',
      'photo_url: photos/b.jpg',
    ]);
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

describe('adjust_stock', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('sends the change to the parts service in the part org and reports the new quantity', async () => {
    rows = [{ id: 'part-1', name: 'Steel Wool', unit: 'kg', organization_id: 'org-b' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'adjust_stock', arguments: { part_id: 'part-1', change: 3, reason: 'Bought 3 kg' } });
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-core-lambda');
    assert.strictEqual(event.httpMethod, 'POST');
    assert.strictEqual(event.path, '/api/parts_history');
    assert.strictEqual(event.headers['X-Organization-Id'], 'org-b');
    assert.deepStrictEqual(JSON.parse(event.body), { part_id: 'part-1', quantity_change: 3, change_reason: 'Bought 3 kg' });
    assert.deepStrictEqual(JSON.parse(result.content[0].text), { part: 'Steel Wool', change: 3, current_quantity: 8, unit: 'kg' });
  });

  test('a part outside the caller orgs or a read-only connection changes nothing', async () => {
    rows = [];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.strictEqual((await client.callTool({ name: 'adjust_stock', arguments: { part_id: 'x', change: 1, reason: 'r' } })).isError, true);
    const reader = await connect(['org-a'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1' });
    assert.strictEqual((await reader.callTool({ name: 'adjust_stock', arguments: { part_id: 'x', change: 1, reason: 'r' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
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

describe('search_claims asset_id', () => {
  test('a System covers everything it is made of, from while each was part of it, in both modes', async () => {
    const client = await connect(['org-a']);
    await client.callTool({ name: 'search_claims', arguments: { date_from: '2026-10-01', asset_id: 'goats-1' } });
    assert.match(queries[0].sql, /WITH RECURSIVE members/);
    assert.match(queries[0].sql, /SELECT \$5::text, '-infinity'/);
    assert.match(queries[0].sql, /s\.captured_at BETWEEN mb\.from_at AND mb\.to_at/);
    assert.strictEqual(queries[0].params[4], 'goats-1');
    queries = [];
    await client.callTool({ name: 'search_claims', arguments: { date_from: '2026-10-01' } });
    assert.strictEqual(queries[0].params[4], null);
  });

  test('observations without a claim are found by their own text and shown with it', async () => {
    rows = [
      { similarity: 0.61, state_id: 'o-1', claim_text: null, text_start: 'She mated with our new buck.', captured_at: '2026-09-19T02:00:00Z', has_photos: false },
      { similarity: 0.55, state_id: 'o-2', claim_text: 'Doe showed signs of heat', text_start: 'restless', captured_at: '2026-10-01T02:00:00Z', has_photos: true },
    ];
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'search_claims', arguments: { query: 'goat in heat', asset_id: 'goats-1' } })).content[0].text);
    assert.strictEqual(reply[0].text, 'She mated with our new buck.');
    assert.strictEqual('claim' in reply[0], false);
    assert.strictEqual(reply[1].claim, 'Doe showed signs of heat');
    assert.strictEqual('text' in reply[1], false);
    assert.match(queries[0].sql, /entity_type IN \('claim_perspective', 'state'\)/);
    assert.match(queries[0].sql, /NOT LIKE '\[%'/);
  });
});

describe('get_asset', () => {
  test('a tool: details, area, accountable person, actions, edits and recent observations as claims', async () => {
    rows = (sql) => {
      if (sql.includes('FROM tools t')) return [{
        type: 'tool', area: 'Tool Shed', accountable_person: 'Mae',
        fields: { name: 'Inverter', description: 'Growatt 5kW', serial_number: null, parent_structure_id: 'shed-1', created_at: '2026-01-01T00:00:00Z', image_url: 'photos/inv.jpg' },
      }];
      if (sql.includes('FROM state_links sl')) return [
        { observation_id: 'o-2', captured_at: '2026-11-02T00:00:00Z', captured_by: 'Mae', claim: 'Fan is loud', text_start: 'long note', has_photos: true, total: '12' },
        { observation_id: 'o-1', captured_at: '2026-11-01T00:00:00Z', captured_by: 'Mae', claim: null, text_start: 'Checked wiring', has_photos: false, total: '12' },
      ];
      if (sql.includes('FROM actions a')) return [{ action_id: 'a-1', title: 'Clean fan', status: 'in_progress', updated_at: '2026-11-03T00:00:00Z' }];
      if (sql.includes('FROM asset_history')) return [{ change_type: 'updated', field_changed: 'description', old_value: 'Growatt', new_value: 'Growatt 5kW', changed_at: '2026-11-03T00:00:00Z', changed_by: 'Mae' }];
      return [];
    };
    const client = await connect(['org-a', 'org-b']);
    const reply = JSON.parse((await client.callTool({ name: 'get_asset', arguments: { asset_id: 'tool-1' } })).content[0].text);
    assert.deepStrictEqual(queries[0].params, ['tool-1', ['org-a', 'org-b']]);
    assert.strictEqual(reply.type, 'tool');
    assert.strictEqual(reply.description, 'Growatt 5kW');
    assert.strictEqual('serial_number' in reply, false);
    assert.strictEqual(reply.area, 'Tool Shed');
    assert.strictEqual(reply.area_id, 'shed-1');
    assert.strictEqual(reply.accountable_person, 'Mae');
    assert.match(reply.photo, /^https:\/\/.*\/photos\/inv\.jpg$/);
    assert.strictEqual(reply.actions[0].title, 'Clean fan');
    assert.strictEqual(reply.recent_edits[0].field_changed, 'description');
    assert.strictEqual(reply.observation_count, 12);
    assert.strictEqual(reply.recent_observations[0].claim, 'Fan is loud');
    assert.strictEqual('text_start' in reply.recent_observations[0], false);
    assert.strictEqual(reply.recent_observations[1].text_start, 'Checked wiring');
  });

  test('a part shows quantities and recent stock changes', async () => {
    rows = (sql) => {
      if (sql.includes('FROM tools t')) return [{ type: 'part', fields: { name: 'Steel Wool', current_quantity: 3, minimum_quantity: 5, unit: 'kg', legacy_storage_vicinity: 'Shed' } }];
      if (sql.includes('FROM parts_history')) return [{ quantity_change: '-2.000', new_quantity: '3.000', change_reason: 'Used', changed_at: '2026-11-03T00:00:00Z', changed_by: 'Mae' }];
      return [];
    };
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'get_asset', arguments: { asset_id: 'part-1' } })).content[0].text);
    assert.strictEqual(reply.current_quantity, 3);
    assert.strictEqual(reply.storage_vicinity, 'Shed');
    assert.deepStrictEqual(reply.recent_stock_changes[0].quantity_change, -2);
    assert.strictEqual(reply.observation_count, 0);
    assert.strictEqual(queries.some((q) => q.sql.includes('FROM actions a')), false);
  });

  test('an asset outside the caller orgs is not found', async () => {
    rows = [];
    const client = await connect(['org-a']);
    const result = await client.callTool({ name: 'get_asset', arguments: { asset_id: 'x' } });
    assert.strictEqual(result.isError, true);
  });
});

describe('create_asset and update_asset', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };
  const db = (role, extra = {}) => (sql) => {
    if (sql.includes('SELECT role')) return role ? [{ role }] : [];
    if (sql.includes('category = ANY')) return extra.area ? [{ id: extra.area }] : [];
    if (sql.includes('user_id IS NOT NULL')) return [{ user_id: 'user-mae', full_name: 'Mae Santos' }];
    if (sql.includes('UNION ALL')) return extra.asset ? [extra.asset] : [];
    return [];
  };

  test('creates a part in the primary org with its area and accountable person', async () => {
    rows = db('admin', { area: 'shed-1' });
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'create_asset', arguments: {
      type: 'part', name: 'Steel Wool', current_quantity: 4, unit: 'kg', area_id: 'shed-1', accountable_person: 'Mae',
    } });
    assert.strictEqual(result.isError, undefined);
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-core-lambda');
    assert.strictEqual(event.httpMethod, 'POST');
    assert.strictEqual(event.path, '/api/parts');
    assert.strictEqual(event.headers['X-Organization-Id'], undefined);
    assert.deepStrictEqual(JSON.parse(event.body), {
      name: 'Steel Wool', unit: 'kg', parent_structure_id: 'shed-1', accountable_person_id: 'user-mae', current_quantity: 4,
    });
    assert.deepStrictEqual(queries.find((q) => q.sql.includes('SELECT role')).params, ['cognito-1', 'org-a']);
  });

  test('refused, with nothing created: wrong-type fields, not an area, a contributor choosing who is accountable, a viewer, read-only', async () => {
    const attempts = [
      [db('admin'), { type: 'tool', name: 'Drill', unit: 'kg' }],
      [db('admin'), { type: 'part', name: 'Wool', serial_number: 'X1' }],
      [db('admin'), { type: 'tool', name: 'Drill', current_quantity: 1 }],
      [db('admin'), { type: 'tool', name: 'Drill', area_id: 'not-an-area' }],
      [db('contributor'), { type: 'tool', name: 'Drill', accountable_person: 'Mae' }],
      [db('viewer'), { type: 'tool', name: 'Drill' }],
    ];
    for (const [r, args] of attempts) {
      rows = r;
      const client = await connect(['org-a'], 'Stefan Hamilton', writer);
      assert.strictEqual((await client.callTool({ name: 'create_asset', arguments: args })).isError, true, JSON.stringify(args));
    }
    const reader = await connect(['org-a'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1' });
    assert.strictEqual((await reader.callTool({ name: 'create_asset', arguments: { type: 'tool', name: 'Drill' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('update sends only the fields given, null clearing, in the asset org', async () => {
    rows = db('contributor', { asset: { type: 'tool', id: 'tool-1', organization_id: 'org-b' } });
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'update_asset', arguments: { asset_id: 'tool-1', description: 'Growatt 5kW', area_id: null } });
    assert.strictEqual(result.isError, undefined);
    const [{ event }] = invocations;
    assert.strictEqual(event.httpMethod, 'PUT');
    assert.strictEqual(event.path, '/api/tools/tool-1');
    assert.strictEqual(event.headers['X-Organization-Id'], 'org-b');
    assert.deepStrictEqual(JSON.parse(event.body), { description: 'Growatt 5kW', parent_structure_id: null });
    assert.deepStrictEqual(JSON.parse(result.content[0].text).changed, ['description', 'area_id']);
  });

  test('nothing to change, or an asset outside the caller orgs, changes nothing', async () => {
    rows = db('admin');
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.strictEqual((await client.callTool({ name: 'update_asset', arguments: { asset_id: 'tool-1' } })).isError, true);
    assert.strictEqual((await client.callTool({ name: 'update_asset', arguments: { asset_id: 'x', name: 'New' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });
});

describe('Systems', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('get_asset shows current and former Systems and components with dates, and rolls up their observations', async () => {
    rows = (sql) => {
      if (sql.includes('FROM tools t')) return [{ type: 'tool', fields: { name: 'Solar System', category: 'System' } }];
      if (sql.includes("p.entity_type = 'part_of' AND p.entity_id::text = $1")) return [
        { asset_id: 'inv-0', type: 'tool', name: 'Old Inverter', since: '2025-01-01T00:00:00Z', until: '2026-10-01T00:00:00Z' },
        { asset_id: 'inv-1', type: 'tool', name: 'Hybrid Inverter', since: '2026-10-01T00:00:00Z', until: null },
      ];
      if (sql.includes("m.entity_id::text = $1")) return [{ asset_id: 'elec-1', name: 'Electrical System', since: '2025-01-01T00:00:00Z', until: null }];
      if (sql.includes('WITH RECURSIVE members')) return [
        { observation_id: 'o-1', captured_at: '2026-09-02T00:00:00Z', captured_by: 'Mae', claim: 'Panel voltage at night', from_components: ['Old Inverter (former component)'], has_photos: false, total: '3' },
      ];
      return [];
    };
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'get_asset', arguments: { asset_id: 'solar-1' } })).content[0].text);
    assert.deepStrictEqual(reply.part_of.map((p) => p.name), ['Electrical System']);
    assert.strictEqual('formerly_part_of' in reply, false);
    assert.deepStrictEqual(reply.components.map((c) => [c.name, 'until' in c]), [['Hybrid Inverter', false]]);
    assert.strictEqual(reply.former_components[0].name, 'Old Inverter');
    assert.match(reply.former_components[0].until, /Oct 1, 2026/);
    assert.deepStrictEqual(reply.recent_observations[0].from_components, ['Old Inverter (former component)']);
    assert.strictEqual(reply.observation_count, 3);
    // Observations count only while each component was part of it.
    const rollup = queries.find((q) => q.sql.includes('WITH RECURSIVE members')).sql;
    assert.match(rollup, /s\.captured_at BETWEEN mb\.from_at AND mb\.to_at/);
    assert.match(rollup, /e\.entity_type = 'ends'/);
  });

  const linkDb = ({ category = 'System', above = ['solar-1'], current = [], only } = {}) => (sql) => {
    if (sql.includes('SELECT id::text AS id, name, category FROM tools')) return [{ id: 'solar-1', name: 'Solar System', category }];
    if (sql.includes('UNION ALL')) return [
      { type: 'tool', id: 'inv-1', name: 'Hybrid Inverter' },
      { type: 'part', id: 'bat-1', name: 'Battery' },
      { type: 'tool', id: 'elec-1', name: 'Electrical System' },
    ].filter((m) => !only || only.includes(m.id));
    if (sql.includes('WITH RECURSIVE up')) return above.map((id) => ({ id }));
    if (sql.includes("p.entity_type = 'part_of' AND p.entity_id::text = $1")) return current.map((member_id) => ({
      member_id, observation_id: `join-${member_id}`, organization_id: 'org-a', captured_at: '2026-01-01T00:00:00+08:00',
    }));
    return [];
  };

  test('link_assets records an observation per new component, linked to it and part_of the System', async () => {
    rows = linkDb({ above: ['solar-1', 'elec-1'], current: ['bat-1'] });
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'link_assets', arguments: {
      system_id: 'solar-1', member_ids: ['inv-1', 'bat-1', 'elec-1'], note: 'Installed 2025.',
    } })).content[0].text);
    assert.deepStrictEqual(reply.results.map((r) => r.result.split(':')[0]), ['linked', 'already part of it', 'not linked']);
    assert.strictEqual(invocations.length, 1);
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-states-lambda');
    assert.deepStrictEqual(JSON.parse(event.body), {
      state_text: 'Hybrid Inverter is part of Solar System. Installed 2025.',
      photos: [],
      links: [{ entity_type: 'tool', entity_id: 'inv-1' }, { entity_type: 'part_of', entity_id: 'solar-1' }],
    });
  });

  test('link_assets backdates new components, and re-dates ones already in it', async () => {
    rows = linkDb({ above: ['solar-1'], current: ['bat-1'], only: ['inv-1', 'bat-1'] });
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'link_assets', arguments: {
      system_id: 'solar-1', member_ids: ['inv-1', 'bat-1'], since: '2025-03-15',
    } })).content[0].text);
    assert.deepStrictEqual(reply.results.map((r) => r.result), ['linked, since 2025-03-15', 'already part of it; now since 2025-03-15']);
    const [created, redated] = invocations;
    assert.strictEqual(JSON.parse(created.event.body).captured_at, '2025-03-15T00:00:00+08:00');
    assert.strictEqual(redated.event.httpMethod, 'PUT');
    assert.strictEqual(redated.event.path, '/api/states/join-bat-1');
    assert.deepStrictEqual(JSON.parse(redated.event.body), { captured_at: '2025-03-15T00:00:00+08:00' });
  });

  test('link_assets leaves a component alone when it already joined that day, and refuses a future date', async () => {
    rows = linkDb({ above: ['solar-1'], current: ['bat-1'], only: ['bat-1'] });
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'link_assets', arguments: { system_id: 'solar-1', member_ids: ['bat-1'], since: '2026-01-01' } })).content[0].text);
    assert.deepStrictEqual(reply.results.map((r) => r.result), ['already part of it']);
    assert.strictEqual((await client.callTool({ name: 'link_assets', arguments: { system_id: 'solar-1', member_ids: ['inv-1'], since: '2999-01-01' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('link_assets refuses an asset that is not a System, or components not found', async () => {
    rows = linkDb({ category: 'Infrastructure' });
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.match((await client.callTool({ name: 'link_assets', arguments: { system_id: 'solar-1', member_ids: ['inv-1'] } })).content[0].text, /not a System/);
    rows = linkDb();
    assert.strictEqual((await client.callTool({ name: 'link_assets', arguments: { system_id: 'solar-1', member_ids: ['nope'] } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('unlink_assets backdates the end to the close of that day, but not before it joined', async () => {
    rows = [
      { observation_id: 'o-9', captured_at: '2025-03-15T00:00:00+08:00', type: 'tool', member_id: 'goat-1', name: 'Nanny', system: 'Goats' },
      { observation_id: 'o-8', captured_at: '2025-06-01T00:00:00+08:00', type: 'tool', member_id: 'goat-2', name: 'Billy', system: 'Goats' },
    ];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'unlink_assets', arguments: {
      system_id: 'goats-1', member_ids: ['goat-1', 'goat-2'], until: '2025-05-01', reason: 'Sold',
    } })).content[0].text);
    assert.deepStrictEqual(reply.results.map((r) => r.result.split(':')[0]), ['taken out', 'not taken out']);
    assert.strictEqual(invocations.length, 1);
    assert.strictEqual(JSON.parse(invocations[0].event.body).captured_at, '2025-05-01T23:59:59+08:00');
    assert.strictEqual((await client.callTool({ name: 'unlink_assets', arguments: { system_id: 'goats-1', member_ids: ['goat-1'], until: '2999-01-01' } })).isError, true);
  });

  test('unlink_assets ends the current membership with an observation on the component, deleting nothing', async () => {
    rows = [{ observation_id: 'o-9', type: 'tool', member_id: 'inv-0', name: 'Old Inverter', system: 'Solar System' }];
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'unlink_assets', arguments: {
      system_id: 'solar-1', member_ids: ['inv-0', 'bat-1'], reason: 'It showed panel voltage at night.',
    } })).content[0].text);
    assert.deepStrictEqual(reply.results.map((r) => r.result), ['taken out', 'is not part of it']);
    assert.match(queries[0].sql, /NOT EXISTS \(SELECT 1 FROM state_links e WHERE e\.entity_type = 'ends'/);
    const [{ event }] = invocations;
    assert.strictEqual(event.httpMethod, 'POST');
    assert.deepStrictEqual(JSON.parse(event.body), {
      state_text: 'Old Inverter removed from Solar System. It showed panel voltage at night.',
      photos: [],
      links: [{ entity_type: 'tool', entity_id: 'inv-0' }, { entity_type: 'ends', entity_id: 'o-9' }],
    });
  });
});

describe('experiences', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };

  test('search_experiences filters by asset, components and date, with a label per component', async () => {
    rows = (sql) => {
      if (sql.includes('FROM experiences e')) return [{ experience_id: 'x-1', type: 'tool', asset_id: 'pond-1', asset: 'Azolla Pond', created_at: '2026-11-01T00:00:00Z', written_by: 'Mae', total: '4' }];
      if (sql.includes('FROM experience_components ec')) return [
        { experience_id: 'x-1', component_type: 'initial_state', label: 'Pond 30% covered' },
        { experience_id: 'x-1', component_type: 'action', label: 'Added ash' },
        { experience_id: 'x-1', component_type: 'final_state', label: 'Pond 80% covered' },
      ];
      return [];
    };
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'search_experiences', arguments: {
      asset_id: 'pond-1', observation_ids: ['o-1'], date_from: '2026-10-01', date_to: '2026-11-07',
    } })).content[0].text);
    assert.deepStrictEqual(queries[0].params, [['org-a'], 'pond-1', ['o-1'], [], '2026-10-01', '2026-11-07', 10]);
    assert.strictEqual(reply.total, 4);
    assert.deepStrictEqual(reply.experiences[0].asset, { asset_id: 'pond-1', type: 'tool', name: 'Azolla Pond' });
    assert.deepStrictEqual(reply.experiences[0].actions, ['Added ash']);
    assert.deepStrictEqual(reply.experiences[0].final_states, ['Pond 80% covered']);
  });

  test('get_experience shows each leg in order, with readings and the person\'s rewrite of an action claim', async () => {
    rows = (sql) => {
      if (sql.includes('FROM experiences e')) return [{ id: 'x-1', type: 'tool', asset_id: 'pond-1', asset: 'Azolla Pond', created_at: '2026-11-01T00:00:00Z', metadata: { action_claim_edits: { 'a-1': 'Spread 2 kg of ash' } }, written_by: 'Mae' }];
      if (sql.includes('FROM experience_components ec')) return [
        { component_type: 'initial_state', observation_id: 'o-1', captured_at: '2026-10-01T00:00:00Z', text: 'Thin cover', observation_claim: 'Pond 30% covered', has_photos: true },
        { component_type: 'action', action_id: 'a-1', title: 'Add ash', status: 'completed', completed_at: '2026-10-02T00:00:00Z', action_type: 'treatment', action_claim: 'Added ash' },
        { component_type: 'final_state', observation_id: 'o-2', captured_at: '2026-10-20T00:00:00Z', text: 'Thick cover', observation_claim: null, has_photos: false },
      ];
      if (sql.includes('FROM metric_snapshots')) return [{ observation_id: 'o-2', name: 'Coverage', value: '80', unit: '%' }];
      return [];
    };
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'get_experience', arguments: { experience_id: 'x-1' } })).content[0].text);
    assert.strictEqual(reply.initial_states[0].claim, 'Pond 30% covered');
    assert.strictEqual(reply.actions[0].claim, 'Added ash');
    assert.strictEqual(reply.actions[0].claim_as_rewritten_here, 'Spread 2 kg of ash');
    assert.deepStrictEqual(reply.final_states[0].readings, [{ name: 'Coverage', value: '80', unit: '%' }]);
    assert.strictEqual('claim' in reply.final_states[0], false);
    assert.strictEqual(reply.link, 'https://stargazer-farm.com/experiences/x-1');
    rows = [];
    assert.strictEqual((await client.callTool({ name: 'get_experience', arguments: { experience_id: 'nope' } })).isError, true);
  });

  test('create_experience writes it up through the experiences service on the asset', async () => {
    rows = (sql) => {
      if (sql.includes("SELECT 'tool' AS type")) return [{ type: 'tool', id: 'pond-1', name: 'Azolla Pond' }];
      if (sql.includes('FROM states WHERE')) return [{ id: 'o-1' }, { id: 'a-1' }];
      return [];
    };
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'create_experience', arguments: { asset_id: 'pond-1', initial_state_ids: ['o-1'], action_ids: ['a-1'] } });
    assert.strictEqual(JSON.parse(result.content[0].text).experience_id, 'new-experience');
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-experiences-lambda');
    assert.strictEqual(event.path, '/api/experiences');
    assert.deepStrictEqual(JSON.parse(event.body), { entity_type: 'tool', entity_id: 'pond-1', initial_state_ids: ['o-1'], action_ids: ['a-1'], final_state_ids: [] });
  });

  test('create_experience refuses observations or actions outside the caller orgs, and a read-only connection', async () => {
    rows = (sql) => (sql.includes("SELECT 'tool' AS type") ? [{ type: 'tool', id: 'pond-1', name: 'Azolla Pond' }] : []);
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.match((await client.callTool({ name: 'create_experience', arguments: { asset_id: 'pond-1', final_state_ids: ['o-9'] } })).content[0].text, /o-9/);
    const reader = await connect(['org-a'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1' });
    assert.strictEqual((await reader.callTool({ name: 'create_experience', arguments: { asset_id: 'pond-1' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('update_experience sends only the legs given and claim rewrites, in the experience org', async () => {
    rows = (sql) => {
      if (sql.includes('FROM experiences e')) return [{ id: 'x-1', organization_id: 'org-b', action_ids: ['a-1'] }];
      if (sql.includes('FROM states WHERE')) return [{ id: 'o-2' }];
      return [];
    };
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'update_experience', arguments: {
      experience_id: 'x-1', final_state_ids: ['o-2'], action_claim_rewrites: { 'a-1': 'Spread 2 kg of ash' },
    } })).content[0].text);
    assert.deepStrictEqual(reply.changed, ['final_state_ids', 'action_claim_rewrites']);
    const [{ event }] = invocations;
    assert.strictEqual(event.httpMethod, 'PUT');
    assert.strictEqual(event.path, '/api/experiences/x-1');
    assert.strictEqual(event.headers['X-Organization-Id'], 'org-b');
    assert.deepStrictEqual(JSON.parse(event.body), { final_state_ids: ['o-2'], action_claim_edits: { 'a-1': 'Spread 2 kg of ash' } });
  });

  test('update_experience refuses a rewrite of an action not in it, or nothing to change', async () => {
    rows = (sql) => (sql.includes('FROM experiences e') ? [{ id: 'x-1', organization_id: 'org-a', action_ids: ['a-1'] }] : []);
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.match((await client.callTool({ name: 'update_experience', arguments: { experience_id: 'x-1', action_claim_rewrites: { 'a-9': 'x' } } })).content[0].text, /a-9/);
    assert.strictEqual((await client.callTool({ name: 'update_experience', arguments: { experience_id: 'x-1' } })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('delete_experience deletes through the experiences service in its org; unknown ones are refused', async () => {
    rows = [{ id: 'x-1', organization_id: 'org-b' }];
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    await client.callTool({ name: 'delete_experience', arguments: { experience_id: 'x-1' } });
    const [{ event }] = invocations;
    assert.strictEqual(event.httpMethod, 'DELETE');
    assert.strictEqual(event.path, '/api/experiences/x-1');
    assert.strictEqual(event.headers['X-Organization-Id'], 'org-b');
    rows = [];
    assert.strictEqual((await client.callTool({ name: 'delete_experience', arguments: { experience_id: 'nope' } })).isError, true);
    assert.strictEqual(invocations.length, 1);
  });

  test('create_experience needs no asset, and takes photos picked from its actions', async () => {
    rows = (sql) => {
      if (sql.includes('FROM states WHERE')) return [{ id: 'o-1' }, { id: 'a-1' }];
      if (sql.includes('FROM state_links sl JOIN state_photos')) return [{ action_id: 'a-1', photo_url: 'photos/stake.jpg' }];
      return [];
    };
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'create_experience', arguments: {
      initial_state_ids: ['o-1'], action_ids: ['a-1'], action_photos: { 'a-1': ['photos/stake.jpg'] },
    } })).content[0].text);
    assert.strictEqual(reply.asset, null);
    assert.strictEqual(queries.some((q) => q.sql.includes("SELECT 'tool' AS type")), false);
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body), {
      initial_state_ids: ['o-1'], action_ids: ['a-1'], final_state_ids: [], action_photo_inclusions: { 'a-1': ['photos/stake.jpg'] },
    });
  });

  test('photos can only be picked from an action in the experience, from its own observations', async () => {
    rows = (sql) => {
      if (sql.includes('FROM states WHERE')) return [{ id: 'a-1' }];
      if (sql.includes('FROM state_links sl JOIN state_photos')) return [{ action_id: 'a-1', photo_url: 'photos/stake.jpg' }];
      return [];
    };
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    assert.match((await client.callTool({ name: 'create_experience', arguments: { action_ids: ['a-1'], action_photos: { 'a-1': ['photos/other.jpg'] } } })).content[0].text, /other\.jpg/);
    assert.match((await client.callTool({ name: 'create_experience', arguments: { action_ids: ['a-1'], action_photos: { 'a-2': [] } } })).content[0].text, /not in it: a-2/);
    assert.strictEqual(invocations.length, 0);
  });

  test('get_experience lists each action\'s photos and whether they are included; no asset is shown as null', async () => {
    rows = (sql) => {
      if (sql.includes('FROM experiences e')) return [{ id: 'x-2', type: null, asset_id: null, asset: null, created_at: '2026-11-01T00:00:00Z', metadata: { action_photo_inclusions: { 'a-1': ['photos/stake.jpg'] } }, written_by: 'Stefan' }];
      if (sql.includes('FROM experience_components ec')) return [{ component_type: 'action', action_id: 'a-1', title: 'Spread gypsum by the stake', status: 'completed' }];
      if (sql.includes("sl.entity_type = 'action' AND sl.entity_id::text = ANY")) return [
        { action_id: 'a-1', observation_id: 'o-5', photo_url: 'photos/stake.jpg', photo_description: 'Stake at row 3', taken_at: '2026-10-05T09:30:00Z', gps_latitude: '10.123456', gps_longitude: '123.654321' },
        { action_id: 'a-1', observation_id: 'o-5', photo_url: 'photos/bag.jpg', photo_description: null },
      ];
      return [];
    };
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'get_experience', arguments: { experience_id: 'x-2' } })).content[0].text);
    assert.strictEqual(reply.asset, null);
    assert.deepStrictEqual(reply.actions[0].photos, [
      { observation_id: 'o-5', photo_url: 'photos/stake.jpg', description: 'Stake at row 3', taken_at_manila: 'Oct 5, 2026, 9:30 AM PHT', gps: '10.123456,123.654321', included: true },
      { observation_id: 'o-5', photo_url: 'photos/bag.jpg', included: false },
    ]);
  });

  test('update_experience replaces an action\'s photo pick', async () => {
    rows = (sql) => {
      if (sql.includes('FROM experiences e')) return [{ id: 'x-2', organization_id: 'org-a', action_ids: ['a-1'] }];
      if (sql.includes('FROM state_links sl JOIN state_photos')) return [{ action_id: 'a-1', photo_url: 'photos/bag.jpg' }];
      return [];
    };
    const client = await connect(['org-a'], 'Stefan Hamilton', writer);
    const reply = JSON.parse((await client.callTool({ name: 'update_experience', arguments: { experience_id: 'x-2', action_photos: { 'a-1': ['photos/bag.jpg'] } } })).content[0].text);
    assert.deepStrictEqual(reply.changed, ['action_photos']);
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body), { action_photo_inclusions: { 'a-1': ['photos/bag.jpg'] } });
  });

  test('get_asset lists its recent experiences and how many it has', async () => {
    rows = (sql) => {
      if (sql.includes('FROM tools t')) return [{ type: 'tool', fields: { name: 'Azolla Pond' } }];
      if (sql.includes('FROM experiences e')) return [{ experience_id: 'x-1', type: 'tool', asset_id: 'pond-1', asset: 'Azolla Pond', created_at: '2026-11-01T00:00:00Z', written_by: 'Mae', total: '5' }];
      return [];
    };
    const client = await connect(['org-a']);
    const reply = JSON.parse((await client.callTool({ name: 'get_asset', arguments: { asset_id: 'pond-1' } })).content[0].text);
    assert.strictEqual(reply.experience_count, 5);
    assert.strictEqual(reply.recent_experiences[0].experience_id, 'x-1');
    assert.strictEqual('asset' in reply.recent_experiences[0], false);
  });
});

describe('expectation models', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };
  const pond = { id: 'tool-1', name: 'Azolla Pond', organization_id: 'org-b', accountable_person_id: 'user-1', role: 'contributor', user_id: 'user-1' };
  const coverageMetric = { metric_id: 'metric-1', tool_id: 'tool-1', name: 'Coverage %', unit: '%' };
  const proposal = {
    asset_id: 'tool-1', name: 'Azolla coverage', description: 'Covers the pond in about 3 weeks',
    anchor: '2026-09-01', time_step_days: 1, horizon_days: 30,
    variables: { coverage: { name: 'Coverage', unit: '%', distribution: 'normal', params: { mean: '100 / (1 + exp(-(t - 15) / 3))', sd: 5 }, min: 0, max: 100, metric_id: 'metric-1' } },
    rationale: 'Logistic growth from the farm\'s earlier ponds',
    evidence: { summary: '12 readings, Aug–Oct', observation_ids: ['obs-1'] },
  };
  // Answers set_model's checks in the order it asks them.
  const answers = ({ tool = pond, observations = [{ id: 'obs-1' }], versions = [] } = {}) => (sql) =>
    sql.includes('FROM tools t') ? [tool]
      : sql.includes('FROM metrics') ? [coverageMetric]
      : sql.includes('FROM states s JOIN state_links') ? observations
      : sql.includes('FROM state_space_models') ? versions
      : [];

  test('set_model saves the next version through the state-space service and links it to the tool', async () => {
    rows = answers({ versions: [{ version: '1' }] });
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'set_model', arguments: proposal });
    assert.strictEqual(result.isError, undefined, result.content[0].text);
    const [save, link] = invocations;
    assert.strictEqual(save.functionName, 'cwf-state-space-lambda');
    assert.strictEqual(save.event.path, '/api/state-space-models');
    assert.strictEqual(save.event.headers['X-Organization-Id'], 'org-b');
    const { model_definition: saved } = JSON.parse(save.event.body);
    assert.strictEqual(saved.kind, 'expectation');
    assert.deepStrictEqual(saved.model_metadata, { name: 'Azolla coverage', version: '2', author: 'Stefan Hamilton', description: 'Covers the pond in about 3 weeks' });
    assert.deepStrictEqual(saved.evidence, { summary: '12 readings, Aug–Oct', observation_ids: ['obs-1'], experience_ids: [] });
    assert.strictEqual(link.event.path, '/api/state-space-models/model-1/associations');
    assert.deepStrictEqual(JSON.parse(link.event.body), { entity_type: 'tool', entity_id: 'tool-1' });
    const reply = JSON.parse(result.content[0].text);
    assert.strictEqual(reply.version, '2');
    assert.strictEqual(reply.basis, 'farm readings');
    assert.strictEqual(reply.expected.coverage[0].date, '2026-09-01');
  });

  test('set_model is refused without someone accountable, for others, for evidence from elsewhere, and for formulas that do not run', async () => {
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const cases = [
      [answers({ tool: { ...pond, accountable_person_id: null } }), proposal, /No one is accountable/],
      [answers({ tool: { ...pond, user_id: 'user-2' } }), proposal, /Only the person accountable/],
      [answers({ observations: [] }), proposal, /Not evidence for this model: observation obs-1/],
      [answers(), { ...proposal, variables: { coverage: { ...proposal.variables.coverage, metric_id: 'metric-9' } } }, /Not metrics of Azolla Pond: metric-9/],
      [answers(), { ...proposal, variables: { coverage: { ...proposal.variables.coverage, params: { mean: 'grow(t)', sd: 5 } } } }, /can't be simulated/],
    ];
    for (const [answer, args, message] of cases) {
      rows = answer;
      const result = await client.callTool({ name: 'set_model', arguments: args });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, message);
    }
    assert.strictEqual(invocations.length, 0);
  });

  test('leadership can set a model for a tool someone else is accountable for; a read-only connection cannot', async () => {
    rows = answers({ tool: { ...pond, user_id: 'user-2', role: 'leadership' } });
    const client = await connect(['org-b'], 'Stefan Hamilton', writer);
    assert.strictEqual((await client.callTool({ name: 'set_model', arguments: proposal })).isError, undefined);
    invocations = [];
    const reader = await connect(['org-b'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1' });
    assert.strictEqual((await reader.callTool({ name: 'set_model', arguments: proposal })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });

  test('get_model judges each reading by the version in force when it was taken', async () => {
    const definition = (version, mean) => ({
      kind: 'expectation', model_metadata: { name: 'Azolla coverage', version, author: 'Stefan Hamilton', description: 'd' },
      anchor: '2026-09-01', time_step_days: 1, horizon_days: 30,
      variables: { coverage: { name: 'Coverage', distribution: 'normal', params: { mean, sd: 5 }, metric_id: 'metric-1' } },
      rationale: 'r', evidence: { summary: 's', observation_ids: [], experience_ids: [] },
    });
    rows = (sql) => sql.includes('FROM tools') ? [{ id: 'tool-1', name: 'Azolla Pond' }]
      : sql.includes('FROM state_space_models') ? [
        { id: 'm1', name: 'Azolla coverage', version: '1', model_definition: definition('1', 20), created_at: '2026-09-05T00:00:00Z' },
        { id: 'm2', name: 'Azolla coverage', version: '2', model_definition: definition('2', 60), created_at: '2026-09-20T00:00:00Z' },
      ]
      : sql.includes('FROM metric_snapshots') ? [
        { observation_id: 'o1', captured_at: '2026-09-02T00:00:00Z', value: '20', captured_by: 'Lester' },
        { observation_id: 'o2', captured_at: '2026-09-25T00:00:00Z', value: '21', captured_by: 'Lester' },
      ]
      : [];
    const client = await connect(['org-a'], 'Stefan Hamilton');
    const result = await client.callTool({ name: 'get_model', arguments: { asset_id: 'tool-1' } });
    const [model] = JSON.parse(result.content[0].text).models;
    assert.strictEqual(model.version, '2');
    assert.deepStrictEqual(model.versions.map((v) => v.version), ['1', '2']);
    assert.strictEqual(model.basis, 'borrowed (no farm readings cited)');
    const [before, after] = model.variables.coverage.readings;
    assert.match(before.note, /evidence, not a test/);
    assert.strictEqual(after.version, '2');
    assert.strictEqual(after.position, 'below the middle 80%');
    assert.ok(queries.every((q) => !q.sql.includes('organization_id') || JSON.stringify(q.params).includes('org-a')));
  });

  test('set_model saves inputs, and a formula can use them', async () => {
    rows = answers();
    const client = await connect(['org-b'], 'Stefan Hamilton', writer);
    const inputs = { area: { label: 'Area', unit: 'm²', value: 8, min: 8, max: 40000 } };
    const result = await client.callTool({ name: 'set_model', arguments: {
      ...proposal, inputs,
      variables: { ...proposal.variables, value: { name: 'Value/day', distribution: 'fixed', params: { value: 'coverage / 100 * area * 0.25' } } },
    } });
    assert.strictEqual(result.isError, undefined, result.content[0].text);
    assert.deepStrictEqual(JSON.parse(invocations[0].event.body).model_definition.inputs, inputs);
  });

  test('get_model without a tool lists the latest version of every model, within the caller orgs', async () => {
    rows = (sql) => sql.includes('FROM state_space_models') ? [{
      name: 'Azolla coverage', version: '2', created_at: '2026-11-08T08:05:00Z', tool_id: 'tool-1', tool: 'Azolla Pond',
      model_definition: {
        model_metadata: { description: 'Doubles about every 6 days' },
        variables: { coverage: { name: 'Coverage %' } },
        inputs: { area: { label: 'Area' } },
      },
    }] : [];
    const client = await connect(['org-a'], 'Stefan Hamilton');
    const reply = JSON.parse((await client.callTool({ name: 'get_model', arguments: {} })).content[0].text);
    assert.deepStrictEqual(reply.models, [{
      name: 'Azolla coverage', tool: 'Azolla Pond', tool_id: 'tool-1', version: '2', approved_at_manila: 'Nov 8, 2026, 4:05 PM PHT',
      description: 'Doubles about every 6 days', variables: ['Coverage %'], inputs: ['Area'],
    }]);
    assert.deepStrictEqual(queries[0].params, [['org-a']]);
  });

  test('get_metric_history lists readings oldest first and the tool\'s actions, within the caller orgs', async () => {
    rows = (sql) => sql.includes('FROM metrics m') ? [{ ...coverageMetric, tool_name: 'Azolla Pond', value_type: 'number', min_value: null }]
      : sql.includes('FROM metric_snapshots') ? [{ observation_id: 'o1', captured_at: '2026-09-02T00:00:00Z', value: '20', captured_by: 'Lester', claim: 'Pond a fifth covered' }]
      : sql.includes('FROM actions') ? [{ action_id: 'a1', title: 'Restock pond', status: 'completed', created_at: '2026-09-01T00:00:00Z', completed_at: null }]
      : [];
    const client = await connect(['org-a'], 'Stefan Hamilton');
    const reply = JSON.parse((await client.callTool({ name: 'get_metric_history', arguments: { metric_id: 'metric-1' } })).content[0].text);
    assert.deepStrictEqual(reply.metric, { metric_id: 'metric-1', name: 'Coverage %', tool: 'Azolla Pond', tool_id: 'tool-1', unit: '%', value_type: 'number' });
    assert.strictEqual(reply.readings[0].claim, 'Pond a fifth covered');
    assert.strictEqual(reply.actions[0].title, 'Restock pond');
    assert.match(queries.find((q) => q.sql.includes('FROM metric_snapshots')).sql, /ORDER BY s\.captured_at$/m);
    assert.ok(queries.every((q) => JSON.stringify(q.params).includes('org-a')));
  });
});

describe('create_metric', () => {
  const writer = { cognitoUserId: 'cognito-1', canWrite: true };
  const container = { id: 'tool-2', name: "Stefan's Azolla Container", organization_id: 'org-a' };
  const answers = ({ tool = container, role = 'contributor', metrics = [] } = {}) => (sql) =>
    sql.includes('FROM tools t') ? [tool] : sql.includes('SELECT role') ? [{ role }] : sql.includes('FROM metrics') ? metrics : [];
  const rootLength = { asset_id: 'tool-2', name: 'Root length', unit: 'cm', min_value: 0, details: 'Longest root of 5 fronds, measured with a ruler' };

  test('adds the metric through the metrics service on the tool', async () => {
    rows = answers();
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const result = await client.callTool({ name: 'create_metric', arguments: rootLength });
    const [{ functionName, event }] = invocations;
    assert.strictEqual(functionName, 'cwf-metrics-lambda');
    assert.strictEqual(event.path, '/api/tools/tool-2/metrics');
    assert.deepStrictEqual(event.pathParameters, { id: 'tool-2' });
    assert.deepStrictEqual(JSON.parse(event.body), { name: 'Root length', unit: 'cm', value_type: 'number', min_value: 0, details: 'Longest root of 5 fronds, measured with a ruler' });
    const reply = JSON.parse(result.content[0].text);
    assert.strictEqual(reply.metric_id, 'metric-new');
    assert.strictEqual(reply.min_value, 0);
    assert.strictEqual('max_value' in reply, false);
  });

  test('is refused for a tool in another org, a name it already has, a viewer, or a read-only connection', async () => {
    const client = await connect(['org-a', 'org-b'], 'Stefan Hamilton', writer);
    const cases = [
      [answers({ tool: { ...container, organization_id: 'org-b' } }), /another of your organizations/],
      [answers({ metrics: [{ metric_id: 'metric-1', name: 'root length' }] }), /already has a metric "root length"/],
      [answers({ role: 'viewer' }), /Only contributors/],
    ];
    for (const [answer, message] of cases) {
      rows = answer;
      const result = await client.callTool({ name: 'create_metric', arguments: rootLength });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, message);
    }
    const reader = await connect(['org-a'], 'Stefan Hamilton', { cognitoUserId: 'cognito-1' });
    assert.strictEqual((await reader.callTool({ name: 'create_metric', arguments: rootLength })).isError, true);
    assert.strictEqual(invocations.length, 0);
  });
});
