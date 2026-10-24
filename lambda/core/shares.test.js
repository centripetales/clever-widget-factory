/**
 * Tests for the shares routes' authorization.
 * Run with: node --test shares.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { handleShares } = require('./shares');

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ORG_C = 'cccccccc-0000-0000-0000-000000000003';
const USER = '11111111-0000-0000-0000-000000000009';

// A db client that answers each query from the first matching [pattern, rows]
// pair and records everything it was asked.
function fakeDb(answers = []) {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      const hit = answers.find(([pattern]) => pattern.test(sql));
      return { rows: hit ? hit[1] : [] };
    },
    release: () => {},
  };
  return { calls, getDbClient: async () => client };
}

const memberOfA = { userId: USER, organizationId: ORG_A, accessibleOrgIds: [ORG_A], readAll: false };
const writes = calls => calls.filter(c => /^\s*(INSERT|DELETE)/.test(c.sql));

describe('POST /shares', () => {
  const body = { entity_type: 'tool', entity_id: 't1', target_org_id: ORG_B };
  const post = (db, overrides = {}) =>
    handleShares({ httpMethod: 'POST', path: '/shares', body, auth: memberOfA, getDbClient: db.getDbClient, ...overrides });

  test('writes the entity org and the authenticated user, ignoring the body', async () => {
    const db = fakeDb([[/FROM tools/, [{ organization_id: ORG_A }]], [/FROM organizations/, [{}]]]);
    const result = await post(db, { body: { ...body, source_org_id: ORG_C, cognito_user_id: 'someone-else' } });
    assert.strictEqual(result.statusCode, 200);
    const insert = db.calls.find(c => /INSERT INTO states/.test(c.sql));
    assert.strictEqual(insert.params[1], ORG_A);
    assert.strictEqual(insert.params[3], USER);
    assert.strictEqual(writes(db.calls).length, 3);
  });

  test('refuses an entity in an org the caller cannot access', async () => {
    const db = fakeDb([[/FROM tools/, [{ organization_id: ORG_C }]], [/FROM organizations/, [{}]]]);
    assert.strictEqual((await post(db)).statusCode, 403);
    assert.strictEqual(writes(db.calls).length, 0);
  });

  test('refuses a missing entity, an unknown target org and an unknown entity type', async () => {
    const noEntity = fakeDb([[/FROM organizations/, [{}]]]);
    assert.strictEqual((await post(noEntity)).statusCode, 404);
    const noTarget = fakeDb([[/FROM tools/, [{ organization_id: ORG_A }]]]);
    assert.strictEqual((await post(noTarget)).statusCode, 400);
    const badType = fakeDb();
    assert.strictEqual((await post(badType, { body: { ...body, entity_type: 'organizations' } })).statusCode, 400);
    assert.strictEqual(writes([...noEntity.calls, ...noTarget.calls, ...badType.calls]).length, 0);
  });

  test('shares an observation, checking the org that owns it', async () => {
    const db = fakeDb([[/FROM states WHERE/, [{ organization_id: ORG_A }]], [/FROM organizations/, [{}]]]);
    const result = await post(db, { body: { ...body, entity_type: 'state', entity_id: 's9' } });
    assert.strictEqual(result.statusCode, 200);
    const link = db.calls.find(c => /INSERT INTO state_links/.test(c.sql) && c.params[1] === 'state');
    assert.strictEqual(link.params[2], 's9');
  });

  test('queues the observations already made on what was shared for reading', async () => {
    const db = fakeDb([[/FROM tools/, [{ organization_id: ORG_A }]], [/FROM organizations/, [{}]], [/sharing_agreement/, [{ id: 's1' }, { id: 's2' }]]]);
    const queued = [];
    const result = await post(db, { queueReadings: async (ids, org) => queued.push([ids, org]) });
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(queued, [[['s1', 's2'], ORG_A]]);
    const find = db.calls.find(c => /sharing_agreement/.test(c.sql));
    assert.deepStrictEqual(find.params, [ORG_A, 'tool', 't1', ORG_B]);
  });

  test('a share is made even when its observations cannot be queued', async () => {
    const db = fakeDb([[/FROM tools/, [{ organization_id: ORG_A }]], [/FROM organizations/, [{}]], [/sharing_agreement/, [{ id: 's1' }]]]);
    const result = await post(db, { queueReadings: async () => { throw new Error('queue down'); } });
    assert.strictEqual(result.statusCode, 200);
  });

  test('never writes a placeholder user id', async () => {
    const db = fakeDb([[/FROM tools/, [{ organization_id: ORG_A }]], [/FROM organizations/, [{}]]]);
    const result = await post(db, { auth: { ...memberOfA, userId: undefined } });
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(db.calls.length, 0);
  });
});

describe('DELETE /shares/{stateId}', () => {
  const del = db => handleShares({ httpMethod: 'DELETE', path: '/shares/s1', auth: memberOfA, getDbClient: db.getDbClient });

  test('deletes a share owned by an accessible org', async () => {
    const db = fakeDb([[/FROM states s/, [{ organization_id: ORG_A }]]]);
    assert.strictEqual((await del(db)).statusCode, 200);
    assert.strictEqual(writes(db.calls).length, 2);
  });

  test('only looks at states that carry an organization link', async () => {
    const db = fakeDb();
    assert.strictEqual((await del(db)).statusCode, 404);
    assert.match(db.calls[0].sql, /sl\.entity_type = 'organization'/);
    assert.strictEqual(writes(db.calls).length, 0);
  });

  test('refuses a share owned by another org', async () => {
    const db = fakeDb([[/FROM states s/, [{ organization_id: ORG_C }]]]);
    assert.strictEqual((await del(db)).statusCode, 403);
    assert.strictEqual(writes(db.calls).length, 0);
  });
});

describe('GET routes', () => {
  test('shared-with-me refuses an org_id the caller cannot access', async () => {
    const db = fakeDb();
    const result = await handleShares({ httpMethod: 'GET', path: '/shared-with-me', query: { org_id: ORG_C }, auth: memberOfA, getDbClient: db.getDbClient });
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(db.calls.length, 0);
  });

  test('shared-with-me defaults to the caller org', async () => {
    const db = fakeDb();
    const result = await handleShares({ httpMethod: 'GET', path: '/shared-with-me', auth: memberOfA, getDbClient: db.getDbClient });
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(db.calls[0].params, [ORG_A]);
  });

  test('listing an entity\'s shares is limited to the caller\'s orgs unless they read all', async () => {
    const scoped = fakeDb();
    await handleShares({ httpMethod: 'GET', path: '/shares/tool/t1', auth: memberOfA, getDbClient: scoped.getDbClient });
    assert.deepStrictEqual(scoped.calls[0].params, ['tool', 't1', [ORG_A]]);
    assert.match(scoped.calls[0].sql, /ANY\(\$3::text\[\]\)/);

    const all = fakeDb();
    await handleShares({ httpMethod: 'GET', path: '/shares/tool/t1', auth: { ...memberOfA, readAll: true }, getDbClient: all.getDbClient });
    assert.deepStrictEqual(all.calls[0].params, ['tool', 't1']);
  });

  test('other routes fall through', async () => {
    assert.strictEqual(await handleShares({ httpMethod: 'GET', path: '/shares', auth: memberOfA, getDbClient: fakeDb().getDbClient }), null);
  });
});
