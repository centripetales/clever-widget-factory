const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

// The shared layer sits at /opt/nodejs in Lambda; here it is read from the repo.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const local = request.replace(/^\/opt\/nodejs\//, `${path.join(__dirname, '../layers/cwf-common-nodejs/nodejs')}/`);
  return resolve.call(this, local, ...rest);
};

const pg = require('pg');

const ORG = '00000000-0000-0000-0000-000000000001';
const OTHER_ORG = '00000000-0000-0000-0000-000000000002';
const POLICY = '11111111-1111-1111-1111-111111111111';
const OBS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OBS_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EXP = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

// Capture every SQL call instead of hitting a database.
let queries;
let rows;
const query = async (sql, params) => {
  queries.push({ sql, params });
  return { rows: rows(sql) };
};
mock.method(pg.Pool.prototype, 'query', query);
mock.method(pg.Pool.prototype, 'connect', async () => ({ query, release() {} }));

const { handler } = require('./index');

const call = async (httpMethod, body, id) => {
  const response = await handler({
    httpMethod,
    path: id ? `/api/policies/${id}` : '/api/policies',
    pathParameters: id ? { id } : undefined,
    body: JSON.stringify(body),
    requestContext: { authorizer: {
      organization_id: ORG, cognito_user_id: 'cognito-1', permissions: '["data:write:all"]',
      accessible_organization_ids: JSON.stringify([ORG, OTHER_ORG]),
    } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

const ran = (pattern) => queries.filter((q) => pattern.test(q.sql));
const saved = { id: POLICY, title: 'Grease bearings', status: 'active', observation_ids: [OBS_A], experience_ids: [EXP] };

// What the database holds: the sources linked now, and the ids that exist
const database = ({ linked = { state_id: [], experience_id: [] }, existing = [OBS_A, OBS_B, EXP] } = {}) => (sql) => {
  const current = sql.match(/^SELECT (state_id|experience_id) AS id FROM policy_sources/);
  if (current) return linked[current[1]].map((id) => ({ id }));
  if (/FROM states s\s+WHERE|FROM experiences WHERE/.test(sql)) return existing.map((id) => ({ id }));
  if (/^\s*(INSERT INTO policy \(|UPDATE policy)/.test(sql)) return [{ id: POLICY }];
  if (/FROM policy WHERE id = \$1$/.test(sql)) return [saved];
  return [];
};

beforeEach(() => {
  queries = [];
  rows = database();
});

describe('creating a policy', () => {
  test('is active unless said otherwise, and links its sources in one transaction', async () => {
    const { status, body } = await call('POST', {
      title: 'Grease bearings', description_text: 'Grease them monthly.', observation_ids: [OBS_A, OBS_A], experience_ids: [EXP],
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.policy, saved);
    assert.strictEqual(ran(/INSERT INTO policy \(/)[0].params[3], 'active');
    assert.deepStrictEqual(ran(/INSERT INTO policy_sources \(policy_id, state_id\)/)[0].params, [POLICY, [OBS_A]]);
    assert.deepStrictEqual(ran(/INSERT INTO policy_sources \(policy_id, experience_id\)/)[0].params, [POLICY, [EXP]]);
    assert.deepStrictEqual(queries[0].sql, 'BEGIN');
    assert.deepStrictEqual(queries.at(-1).sql, 'COMMIT');
  });

  test('needs no sources', async () => {
    const { status } = await call('POST', { title: 'Grease bearings', description_text: 'Grease them monthly.' });
    assert.strictEqual(status, 200);
    assert.strictEqual(ran(/policy_sources \(policy_id/).length, 0);
  });

  test('looks for sources in all the caller orgs', async () => {
    await call('POST', { title: 't', description_text: 'd', observation_ids: [OBS_A] });
    assert.deepStrictEqual(ran(/FROM states s\s+WHERE/)[0].params, [[OBS_A], [ORG, OTHER_ORG]]);
  });

  test('is undone when a source is not an observation of theirs', async () => {
    rows = database({ existing: [] });
    const { status, body } = await call('POST', { title: 't', description_text: 'd', observation_ids: [OBS_A] });
    assert.strictEqual(status, 400);
    assert.match(body.error, /No observation aaaaaaaa/);
    assert.deepStrictEqual(queries.at(-1).sql, 'ROLLBACK');
    assert.strictEqual(ran(/INSERT INTO policy_sources/).length, 0);
  });

  test('refuses a draft and anything but lists of ids', async () => {
    assert.strictEqual((await call('POST', { title: 't', description_text: 'd', status: 'draft' })).status, 400);
    assert.strictEqual((await call('POST', { title: 't', description_text: 'd', experience_ids: ['nope'] })).status, 400);
    assert.strictEqual(queries.length, 0);
  });
});

describe('changing a policy', () => {
  test('adds and removes only the sources that changed, leaving the other kind alone', async () => {
    rows = database({ linked: { state_id: [OBS_A], experience_id: [EXP] } });
    const { status } = await call('PUT', { observation_ids: [OBS_B] }, POLICY);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(ran(/DELETE FROM policy_sources/).map((q) => q.params), [[POLICY, [OBS_A]]]);
    assert.deepStrictEqual(ran(/INSERT INTO policy_sources/).map((q) => q.params), [[POLICY, [OBS_B]]]);
    assert.strictEqual(ran(/experience_id AS id FROM policy_sources/).length, 0);
  });

  test('touches no source already linked, even one that can no longer be read', async () => {
    rows = database({ linked: { state_id: [OBS_A], experience_id: [] }, existing: [] });
    const { status } = await call('PUT', { observation_ids: [OBS_A] }, POLICY);
    assert.strictEqual(status, 200);
    assert.strictEqual(ran(/DELETE FROM policy_sources|INSERT INTO policy_sources/).length, 0);
  });

  test('changes only the fields given', async () => {
    await call('PUT', { status: 'deprecated' }, POLICY);
    const [update] = ran(/UPDATE policy SET/);
    assert.match(update.sql, /UPDATE policy SET status = \$3, updated_at = NOW\(\)/);
    assert.deepStrictEqual(update.params, [POLICY, ORG, 'deprecated']);
    assert.strictEqual(ran(/policy_sources WHERE policy_id = \$1 AND/).length, 0);
  });

  test('links nothing to a policy of another organization', async () => {
    rows = () => [];
    const { status } = await call('PUT', { observation_ids: [OBS_A] }, POLICY);
    assert.strictEqual(status, 404);
    assert.strictEqual(ran(/policy_sources \(policy_id/).length, 0);
    assert.deepStrictEqual(queries.at(-1).sql, 'ROLLBACK');
  });
});
